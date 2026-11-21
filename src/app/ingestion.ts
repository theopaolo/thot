import { readFile, mkdir, rm } from "node:fs/promises";
import { assembler, type Extraction } from "../core/document.ts";
import { extraireDocx } from "../core/docx.ts";
import { extraireHtml, extrairePearltrees } from "../core/html.ts";
import { extraireMarkdown } from "../core/markdown.ts";
import { cleLegende, type Modeles } from "../core/modeles.ts";
import { extrairePdf } from "../core/pdf.ts";
import { extrairePptx, type Note } from "../core/pptx.ts";
import { estAnglais, retirerSource, transaction } from "../core/recherche.ts";
import { journalSans, type Resultat, resultatSans } from "../core/reponse.ts";
import { oublierSource, revoirActivites } from "./activites.ts";
import { config, contenu } from "./config.ts";
import { type Db, maintenant } from "./db.ts";
import { type Audience, sha256 } from "./depot.ts";
import { filtreModification, parametresModification, type Compte } from "./comptes.ts";
import { type Affiliation, affiliations, nomTheme } from "./domaines.ts";
import { lireInstance } from "./instance.ts";
import {
  type Source,
  ecrireAtomique,
  lireSource,
  dossierRevision,
  jsonl,
  revisionEnAttente,
  enregistrer,
  lireDocument,
} from "./ingestion/revisions.ts";
import {
  type ImageRevision,
  cheminImage,
  lireInventaire,
  servirImages,
  retirer,
} from "./ingestion/images.ts";
import { type Meta, regroupement, reindexer, indexer } from "./ingestion/indexation.ts";

export * from "./ingestion/revisions.ts";
export * from "./ingestion/images.ts";
export * from "./ingestion/indexation.ts";

const VERROU_MS = 5 * 60_000;
const MAX_TENTATIVES = 3;
/**
 * Images légendées par extraction. Chaque légende est un appel payant d'au plus deux fois 90 s, et
 * le worker ne traite qu'un document à la fois. Les images suivantes sont importées sans légende.
 */
export const MAX_LEGENDES = 50;

const horodatage = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";

export type Job = { id: string; source_id: string; tentatives: number };

/**
 * Revendique le plus ancien travail en attente, ou un travail dont le verrou a expiré parce que
 * son worker est mort. Une seule instruction UPDATE: deux workers ne prennent pas le même.
 */
export function revendiquer(db: Db, maintenantMs = Date.now()): Job | undefined {
  const t = horodatage(maintenantMs);
  db.prepare(
    `UPDATE ingestion_jobs SET etat = 'failed', verrou_expire_le = NULL, maj_le = ?,
       erreur = 'Interrompu ${MAX_TENTATIVES} fois, abandonné.'
     WHERE etat IN ('extracting', 'enriching') AND verrou_expire_le < ? AND tentatives >= ?`,
  ).run(t, t, MAX_TENTATIVES);
  return db
    .prepare(
      `UPDATE ingestion_jobs SET etat = 'extracting', tentatives = tentatives + 1,
       verrou_expire_le = ?, maj_le = ?
     WHERE id = (SELECT id FROM ingestion_jobs
                 WHERE etat = 'received'
                    OR (etat IN ('extracting', 'enriching') AND verrou_expire_le < ?)
                 ORDER BY cree_le LIMIT 1)
     RETURNING id, source_id, tentatives`,
    )
    .get(horodatage(maintenantMs + VERROU_MS), t, t) as Job | undefined;
}

/**
 * La tentative qui tient le travail. Chaque revendication incrémente `tentatives` : une tentative
 * dont le travail a été repris, terminé ou supprimé avec sa source ne retrouve plus sa ligne.
 */
const TENU = "id = ? AND tentatives = ? AND etat IN ('extracting', 'enriching')";

/** Prolonge le verrou de la tentative. Rend `false` quand elle ne tient plus le travail. */
const prolonger = (db: Db, job: Job) =>
  db
    .prepare(`UPDATE ingestion_jobs SET verrou_expire_le = ? WHERE ${TENU}`)
    .run(horodatage(Date.now() + VERROU_MS), job.id, job.tentatives).changes > 0;

const REMPLACEE = "Tentative remplacée.";

async function extraire(s: Source): Promise<Extraction & { notes?: Note[] }> {
  const chemin = contenu(s.id, "original", s.fichier);
  if (s.format === "pdf") return await extrairePdf(chemin, s.profil);
  if (s.format === "html") {
    // Le pilote arts appliqués dépose des exports Pearltrees. Une autre lecture changerait le
    // texte de ses sources à la réextraction.
    const lire = s.profil === "arts-appliques" ? extrairePearltrees : extraireHtml;
    return lire(await readFile(chemin, "utf8"), s.titre);
  }
  if (s.format === "md") return extraireMarkdown(await readFile(chemin, "utf8"), s.titre);
  if (s.format === "docx") return await extraireDocx(await readFile(chemin), s.titre);
  if (s.format === "pptx") {
    const meta = JSON.parse(s.metadonnees) as { diapositives_masquees?: boolean };
    return extrairePptx(await readFile(chemin), meta.diapositives_masquees === true);
  }
  const extension = s.format;
  return {
    parties: [{ texte: s.titre, section: s.titre }],
    images: [
      {
        octets: await readFile(chemin),
        mime: extension === "jpg" ? "image/jpeg" : `image/${extension}`,
        extension,
      },
    ],
    avertissements: [],
  };
}

/** Change l'état du travail. Lève si la tentative ne le tient plus. */
function etat(db: Db, job: Job, etat: string, avertissements: string[], fin = false) {
  const { changes } = db
    .prepare(
      `UPDATE ingestion_jobs SET etat = ?, etape = ?, avertissements = ?, maj_le = ?,
         progression = ?, verrou_expire_le = CASE WHEN ? THEN NULL ELSE verrou_expire_le END
       WHERE ${TENU}`,
    )
    .run(
      etat,
      etat,
      JSON.stringify(avertissements),
      maintenant(),
      fin ? 1 : 0.5,
      fin ? 1 : 0,
      job.id,
      job.tentatives,
    );
  if (!changes) throw new Error(REMPLACEE);
}

/**
 * Extraction puis légendes. Un échec de légende devient un avertissement, pas un échec du travail.
 * La tentative prolonge son verrou tant qu'elle travaille : aucun autre worker ne reprend le
 * travail, et `supprimerSource` refuse la source. Une tentative qui a perdu le travail n'écrit
 * plus rien, ni fichier, ni ligne, ni échec.
 */
export async function traiter(db: Db, job: Job, modeles: Modeles) {
  const s = lireSource(db, job.source_id);
  // Appelé avant chaque écriture : elle se fait alors sous un verrou qui vient d'être prolongé.
  const tenir = () => {
    if (!prolonger(db, job)) throw new Error(REMPLACEE);
  };
  // Une extraction ou une légende peut durer plus longtemps que le verrou.
  const minuteur = setInterval(() => {
    try {
      prolonger(db, job);
    } catch (e) {
      console.error(`verrou du travail ${job.id}:`, e);
    }
  }, VERROU_MS / 4);
  try {
    tenir();
    const ext = await extraire(s);
    const doc = assembler(ext.parties);
    const avertissements = [...ext.avertissements];
    if (s.langue !== "fr" && !estAnglais(s.langue)) {
      avertissements.push("Langue non prise en charge pour la recherche : " + s.langue);
    }
    if (!doc.texte && !ext.images.length) avertissements.push("Aucun texte ni image extrait.");

    tenir();
    enregistrer(db, s, doc, ext.avertissements, ext.notes);
    // L'extraction vient de devenir la révision en attente, ou de confirmer la révision servie.
    const attente = revisionEnAttente(db, s.id);
    const n = attente?.n ?? s.revision;
    const dossier = dossierRevision(s.id, n);
    await mkdir(`${dossier}/assets`, { recursive: true });
    const servies = new Set(
      db
        .prepare("SELECT checksum FROM images WHERE source_id = ?")
        .all(s.id)
        .map((i) => i.checksum as string),
    );
    // Une image répétée dans le document entre une fois, à sa première place. Le fichier porte
    // le nom de ses octets : un nom ne désigne jamais d'autres octets, et une image que la source
    // sert déjà garde le sien.
    const parOctets = new Map<string, ImageRevision>();
    for (const img of ext.images) {
      const checksum = await sha256(img.octets);
      if (parOctets.has(checksum)) continue;
      const fichier = `${checksum}.${img.extension}`;
      if (!servies.has(checksum)) {
        tenir();
        ecrireAtomique(`${dossier}/assets/${fichier}`, img.octets);
      }
      parOctets.set(checksum, { checksum, fichier, mime: img.mime, section: img.section ?? null });
    }
    const images = [...parOctets.values()];
    tenir();
    if (!attente) retirer(transaction(db, () => servirImages(db, s.id, n, images)));
    etat(db, job, "enriching", avertissements);

    const aLegender: { chemin: string; mime: string; garder(l: string, m: string): void }[] =
      attente
        ? images
            .filter((i) => !servies.has(i.checksum))
            .map((i) => ({
              chemin: `${dossier}/assets/${i.fichier}`,
              mime: i.mime,
              garder: (legende, modele) => void Object.assign(i, { legende, modele }),
            }))
        : (
            db
              .prepare(
                `SELECT id, revision, fichier, mime FROM images
                 WHERE source_id = ? AND legende IS NULL AND legende_statut = 'unreviewed'
                 ORDER BY position`,
              )
              .all(s.id) as { id: string; revision: number; fichier: string; mime: string }[]
          ).map((i) => ({
            chemin: cheminImage(s.id, i),
            mime: i.mime,
            // Un enseignant a pu relire l'image pendant l'appel : sa légende l'emporte.
            garder: (legende, modele) =>
              void db
                .prepare(
                  `UPDATE images SET legende = ?, legende_origine = 'generated', modele = ?
                   WHERE id = ? AND legende IS NULL AND legende_statut = 'unreviewed'`,
                )
                .run(legende, modele, i.id),
          }));
    const reste = aLegender.length - MAX_LEGENDES;
    if (reste > 0) {
      avertissements.push(
        `${reste} image${reste > 1 ? "s" : ""} sans légende proposée : Thot en légende ${MAX_LEGENDES} par extraction.`,
      );
    }
    for (const img of aLegender.slice(0, MAX_LEGENDES)) {
      // Hors du `try` des légendes : un travail perdu s'arrête, il ne devient pas un avertissement.
      tenir();
      let legende;
      try {
        legende = await modeles.legender(await readFile(img.chemin), img.mime, s.profil);
      } catch (e) {
        avertissements.push(`Légende non produite: ${(e as Error).message}`);
        continue;
      }
      tenir();
      img.garder(legende.texte, legende.modele);
    }
    tenir();
    // Les images d'une révision en attente restent dans son dossier, avec leur légende proposée :
    // `statuer` les sert quand un enseignant la certifie, `ecarterRevision` les efface avec elle.
    if (attente) ecrireAtomique(`${dossier}/images.jsonl`, jsonl(images));
    // Une source déjà certifiée qu'on réingère se réindexe avec ses sections et légendes. Un
    // échec de l'index annule la fin du travail, qui passe alors en échec.
    transaction(db, () => {
      etat(db, job, "awaiting_review", avertissements, true);
      if (s.statut === "certifiee") reindexer(db, s.id);
    });
  } catch (e) {
    const { changes } = db
      .prepare(
        `UPDATE ingestion_jobs SET etat = 'failed', erreur = ?, verrou_expire_le = NULL, maj_le = ?
         WHERE ${TENU}`,
      )
      .run((e as Error).message, maintenant(), job.id, job.tentatives);
    if (!changes) console.error(`travail ${job.id} abandonné : ${(e as Error).message}`);
  } finally {
    clearInterval(minuteur);
  }
}

/**
 * Rejoue l'extraction d'une source extraite, après une amélioration de l'extracteur. Un texte
 * changé devient une révision en attente : les citations déjà données gardent la leur.
 */
export async function reextraire(db: Db, sourceId: string) {
  const s = lireSource(db, sourceId);
  const job = db.prepare("SELECT etat FROM ingestion_jobs WHERE source_id = ?").get(sourceId);
  if (
    !["html", "pdf", "md", "docx", "pptx"].includes(s.format) ||
    job?.etat !== "awaiting_review"
  ) {
    return "ignoree";
  }
  const ext = await extraire(s);
  const r = enregistrer(db, s, assembler(ext.parties), ext.avertissements, ext.notes);
  if (r === "mise_a_jour") indexer(db, s.id);
  return r;
}

const INFORMATIONS = ["date", "artiste", "mouvement"] as const;

const CONSIGNE_INFORMATIONS = `Tu lis la fiche d'un document de cours d'arts appliqués : titre,
nom de fichier, séquence, séance et début du texte. Relève l'œuvre qu'il présente :
- date : l'année ou la période de l'œuvre, par exemple « 1923 » ou « 1900-1913 » ;
- artiste : le ou les auteurs de l'œuvre, séparés par des virgules ;
- mouvement : le mouvement artistique, par exemple « Art nouveau ». La séquence le nomme
  souvent.

Recopie les mots de la fiche. Laisse le champ vide si la fiche ne le donne pas : n'utilise pas
ce que tu sais par ailleurs.

Réponds par un objet JSON seul : {"date": "", "artiste": "", "mouvement": ""}`;

const plier = (s: string) =>
  ` ${s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;

/**
 * Date, artiste et mouvement lus dans la sortie du modèle. Une valeur dont un morceau ne se lit
 * pas dans la fiche est inventée: elle reste vide.
 */
export function lireInformations(sortie: string, fiche: string): Record<string, string> {
  const brut = JSON.parse(sortie.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
  const lue = plier(fiche);
  return Object.fromEntries(
    INFORMATIONS.map((nom) => {
      const v = typeof brut[nom] === "string" ? brut[nom].trim().slice(0, 120) : "";
      const morceaux = v
        .split(/,| et /)
        .map(plier)
        .filter((m) => m.trim());
      return [nom, morceaux.every((m) => lue.includes(m)) ? v : ""];
    }),
  );
}

/** Prochaine source extraite sans proposition, que l'enseignant n'a pas encore enregistrée. */
export const sourceSansInformations = (db: Db) =>
  db
    .prepare(
      `SELECT s.id FROM sources s JOIN ingestion_jobs j ON j.source_id = s.id
     WHERE j.etat = 'awaiting_review' AND s.statut != 'rejetee' AND s.profil = 'arts-appliques'
       AND json_type(s.metadonnees, '$.propositions') IS NULL
       AND json_type(s.metadonnees, '$.artiste') IS NULL
     LIMIT 1`,
    )
    .get()?.id as string | undefined;

/**
 * Propose date, artiste et mouvement d'après le titre, le nom du fichier et le début du texte.
 * La proposition reste dans `propositions`, hors de la vue élève, jusqu'à ce que l'enseignant
 * enregistre le formulaire de la source.
 */
export async function proposerInformations(db: Db, modeles: Modeles, sourceId: string) {
  const s = lireSource(db, sourceId);
  if (s.profil !== "arts-appliques") return;
  const meta = JSON.parse(s.metadonnees) as Meta;
  let texte: string;
  try {
    texte = lireDocument(sourceId, s.revision).texte;
  } catch (e) {
    // Un fichier de la révision manque ou est abîmé, par exemple après la restauration d'une
    // sauvegarde prise pendant une suppression. Le travail passe en échec : la source ne revient
    // plus ici, sa page affiche la cause, et le worker continue.
    const cause = `Texte extrait illisible : ${(e as Error).message}`;
    console.error(`informations ${sourceId}: ${cause}`);
    db.prepare(
      `UPDATE ingestion_jobs SET etat = 'failed', erreur = ?, maj_le = ?
       WHERE source_id = ? AND etat = 'awaiting_review'`,
    ).run(cause, maintenant(), sourceId);
    return;
  }
  const fiche = [
    `Titre : ${s.titre}`,
    `Fichier : ${s.fichier}`,
    `Séquence : ${regroupement(db, s) ?? ""}`,
    `Séance : ${meta.seance ?? ""}`,
    `Texte : ${texte.slice(0, 2000)}`,
  ].join("\n");
  let propositions = {};
  try {
    const { texte } = await modeles.generer([
      { role: "system", content: CONSIGNE_INFORMATIONS },
      { role: "user", content: fiche },
    ]);
    propositions = lireInformations(texte, fiche);
  } catch (e) {
    // ponytail: un échec laisse une proposition vide pour ne pas boucler. Retirer
    // `$.propositions` des métadonnées relance la source.
    console.error(`informations ${sourceId}: ${(e as Error).message}`);
  }
  // L'enseignant a pu enregistrer pendant l'appel: sa saisie l'emporte.
  db.prepare(
    `UPDATE sources SET metadonnees = json_set(metadonnees, '$.propositions', json(?))
     WHERE id = ? AND json_type(metadonnees, '$.artiste') IS NULL`,
  ).run(JSON.stringify(propositions), sourceId);
}

/**
 * Ce qui empêche de certifier la source, ou `undefined` : seule une extraction qui attend sa
 * relecture se certifie. Une source a toujours un travail, créé avec elle par `deposer()`.
 */
export function refusCertification(db: Db, sourceId: string) {
  const etat = db
    .prepare("SELECT etat FROM ingestion_jobs WHERE source_id = ?")
    .get(sourceId)?.etat;
  if (etat === "awaiting_review") return undefined;
  if (etat === "failed") return "son traitement a échoué";
  return etat ? "son extraction n'est pas terminée" : "elle est introuvable";
}

/**
 * Certifie ou rejette une source. Certifier avec `revision`, sa révision en attente, fait servir
 * celle-ci et ses images dans la transaction de l'index : un échec laisse servir l'ancienne. Un
 * exercice qui citait une autre révision, ou une source rejetée, devient à revoir.
 */
export function statuer(
  db: Db,
  sourceId: string,
  statut: "certifiee" | "rejetee",
  par: string,
  revision?: number,
) {
  let retirees: string[] = [];
  transaction(db, () => {
    const refus = statut === "certifiee" && refusCertification(db, sourceId);
    if (refus) throw new Error(`La source n'est pas prête à être certifiée : ${refus}.`);
    if (revision !== undefined) {
      if (revisionEnAttente(db, sourceId)?.n !== revision) {
        throw new Error("Cette version n'attend plus de relecture.");
      }
      // Les questions suggérées ont été vérifiées sur l'ancien texte.
      db.prepare("UPDATE sources SET revision = ?, suggestions_le = NULL WHERE id = ?").run(
        revision,
        sourceId,
      );
      const images = lireInventaire(sourceId, revision);
      if (images) retirees = servirImages(db, sourceId, revision, images);
    }
    db.prepare("UPDATE sources SET statut = ?, statut_par = ?, statut_le = ? WHERE id = ?").run(
      statut,
      par,
      maintenant(),
      sourceId,
    );
    reindexer(db, sourceId);
    revoirActivites(db, sourceId);
  });
  retirer(retirees);
}

// Chaque changement d'une source écrit, réindexe et signale les activités à revoir dans une seule
// transaction, comme `statuer()`. Les routes et la CLI l'appellent sans rien ajouter.

/**
 * Change les lecteurs d'une source. Un exercice dont les élèves perdent l'accès devient à revoir.
 * L'index ne porte pas les lecteurs, et les questions suggérées ne dépendent pas d'eux.
 */
export function changerLecteurs(db: Db, sourceId: string, lecteurs: Audience) {
  transaction(db, () => {
    db.prepare("UPDATE sources SET audience = ? WHERE id = ?").run(lecteurs, sourceId);
    revoirActivites(db, sourceId);
  });
}

/**
 * Rattache une source à `liens`, à la place de ses cours et thèmes précédents. L'en-tête de ses
 * passages porte le nom de ses thèmes : elle se réindexe. Un exercice d'un cours retiré devient
 * à revoir.
 */
export function rattacher(db: Db, sourceId: string, liens: Affiliation[]) {
  transaction(db, () => {
    affiliations(db, sourceId, liens);
    reindexer(db, sourceId);
    revoirActivites(db, sourceId);
  });
}

/**
 * Enregistre les informations et les lecteurs d'une source, et ses cours quand `liens` est
 * donné. Les questions suggérées reprennent le titre et les informations : elles se régénèrent.
 */
export function modifierSource(
  db: Db,
  sourceId: string,
  m: {
    titre: string;
    meta: Record<string, unknown>;
    langue: string;
    audience: Audience;
    reponses: number;
    liens?: Affiliation[];
  },
) {
  transaction(db, () => {
    if (m.liens) affiliations(db, sourceId, m.liens);
    db.prepare(
      `UPDATE sources SET titre = ?, metadonnees = ?, langue = ?, audience = ?, reponses = ?,
       suggestions_le = NULL WHERE id = ?`,
    ).run(m.titre, JSON.stringify(m.meta), m.langue, m.audience, m.reponses, sourceId);
    reindexer(db, sourceId);
    revoirActivites(db, sourceId);
  });
}

/**
 * Relance l'extraction d'une présentation avec ou sans ses diapositives masquées. Rend `false`
 * pendant une extraction : le worker réécrirait la révision en cours.
 */
export function inclureDiapositivesMasquees(db: Db, sourceId: string, inclure: boolean) {
  return transaction(db, () => {
    const { changes } = db
      .prepare(
        `UPDATE ingestion_jobs SET etat = 'received', tentatives = 0, erreur = NULL,
         verrou_expire_le = NULL, maj_le = ?
         WHERE source_id = ? AND etat IN ('awaiting_review', 'failed')`,
      )
      .run(maintenant(), sourceId);
    if (changes) {
      db.prepare(
        `UPDATE sources SET metadonnees = json_set(metadonnees, '$.diapositives_masquees', json(?))
         WHERE id = ?`,
      ).run(JSON.stringify(inclure), sourceId);
    }
    return changes > 0;
  });
}

/**
 * Supprime une source pour de bon. La transaction retire sa ligne et tout ce qui en dérive en
 * base : index, révisions, images, rattachements, suggestions, travail, légendes en cache, et ses
 * citations dans les réponses et les exercices conservés. Ses fichiers partent ensuite. Refusée
 * pendant que le worker l'extrait : il réécrirait des fichiers et le cache après la suppression.
 * `secure_delete` (connexion) et l'option de la migration 0017 effacent aussi son texte du
 * fichier de la base.
 */
export async function supprimerSource(db: Db, sourceId: string) {
  const s = lireSource(db, sourceId);
  if (!s) throw new Error("Source introuvable.");
  const images = db
    .prepare("SELECT revision, fichier, mime FROM images WHERE source_id = ?")
    .all(sourceId) as { revision: number; fichier: string; mime: string }[];
  // ponytail: la clé suit le modèle de légende actuel. Une légende mise en cache sous un autre
  // modèle, pour une image qu'une extraction a retirée ou pour celle d'une révision en attente,
  // reste dans le cache.
  const cles: string[] = [];
  for (const i of images) {
    const octets = await readFile(cheminImage(sourceId, i)).catch(() => undefined);
    if (octets) cles.push(await cleLegende(config.modeles.legende, octets, i.mime, s.profil));
  }
  transaction(db, () => {
    const job = db
      .prepare("SELECT etat, verrou_expire_le FROM ingestion_jobs WHERE source_id = ?")
      .get(sourceId) as { etat: string; verrou_expire_le: string | null } | undefined;
    if (
      job &&
      ["extracting", "enriching"].includes(job.etat) &&
      (job.verrou_expire_le ?? "") > maintenant()
    ) {
      throw new Error("Extraction en cours : supprimer la source une fois le traitement terminé.");
    }
    retirerSource(db, sourceId);
    oublierSource(db, sourceId);
    for (const table of ["images", "suggestions", "ingestion_jobs"]) {
      db.prepare(`DELETE FROM ${table} WHERE source_id = ?`).run(sourceId);
    }
    // Les révisions et les rattachements suivent par ON DELETE CASCADE.
    db.prepare("DELETE FROM sources WHERE id = ?").run(sourceId);
    db.prepare("DELETE FROM cache_modeles WHERE cle IN (SELECT value FROM json_each(?))").run(
      JSON.stringify(cles),
    );
    const messages = db
      .prepare(
        "SELECT id, etat, resultat, journal FROM messages WHERE instr(resultat, ?) OR instr(journal, ?)",
      )
      .all(sourceId, sourceId) as {
      id: string;
      etat: string;
      resultat: string | null;
      journal: string | null;
    }[];
    const ecrire = db.prepare(
      "UPDATE messages SET etat = ?, resultat = ?, journal = ? WHERE id = ?",
    );
    for (const m of messages) {
      const avant = m.resultat ? (JSON.parse(m.resultat) as Resultat) : undefined;
      const apres = avant && resultatSans(avant, sourceId);
      ecrire.run(
        apres === avant ? m.etat : apres!.etat,
        apres ? JSON.stringify(apres) : null,
        m.journal && JSON.stringify(journalSans(JSON.parse(m.journal), (id) => id === sourceId)),
        m.id,
      );
    }
  });
  // Le WAL garde les anciennes pages jusqu'au point de contrôle. TRUNCATE le vide, sauf si une
  // lecture en cours l'en empêche.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  await rm(contenu(sourceId), { recursive: true, force: true });
}

export function relireLegende(
  db: Db,
  imageId: string,
  action: "certified" | "rejected",
  texte: string,
  par: string,
  credit = "",
) {
  transaction(db, () => {
    const img = db.prepare("SELECT source_id, legende FROM images WHERE id = ?").get(imageId) as
      | { source_id: string; legende: string }
      | undefined;
    if (!img) return;
    const corrigee = action === "certified" && texte.trim() && texte.trim() !== img.legende;
    db.prepare(
      `UPDATE images SET legende_statut = ?, relu_par = ?, relu_le = ?,
       legende = CASE WHEN ? THEN ? ELSE legende END,
       legende_origine = CASE WHEN ? THEN 'teacher' ELSE legende_origine END,
       credit = ?
     WHERE id = ?`,
    ).run(
      action,
      par,
      maintenant(),
      corrigee ? 1 : 0,
      texte.trim(),
      corrigee ? 1 : 0,
      credit.trim() || null,
      imageId,
    );
    reindexer(db, img.source_id);
  });
}

/** Les images que la source sert. Une légende ne se montre qu'une fois relue. */
export const imagesLues = (db: Db, sourceId: string) =>
  db
    .prepare(
      `SELECT id, CASE WHEN legende_statut = 'certified' THEN legende END AS legende, credit
       FROM images WHERE source_id = ? ORDER BY position`,
    )
    .all(sourceId) as { id: string; legende: string | null; credit: string | null }[];

export type ImageALegender = {
  id: string;
  legende: string | null;
  legende_statut: string;
  legende_origine: string | null;
  modele: string | null;
  source_id: string;
  titre: string;
  credit: string | null;
  restantes: number;
};

// La file ne propose que les images des sources que le compte peut relire.
const FILE = `i.legende_statut = 'unreviewed' AND s.statut != 'rejetee' AND s.school_id = $etablissement
  AND ${filtreModification()}`;
const parametresFile = (db: Db, compte: Compte) => ({
  ...parametresModification(compte),
  etablissement: lireInstance(db).school_id,
});

export const aLegender = (db: Db, compte: Compte, imageId = "") => {
  const restantes = db
    .prepare(`SELECT count(*) n FROM images i JOIN sources s ON s.id = i.source_id WHERE ${FILE}`)
    .get(parametresFile(db, compte))!.n as number;
  const i = db
    .prepare(
      `SELECT i.*, s.titre FROM images i JOIN sources s ON s.id = i.source_id WHERE ${FILE}
       ORDER BY (i.id = ?) DESC, ${nomTheme("s")}, s.titre, i.position LIMIT 1`,
    )
    .get(parametresFile(db, compte), imageId) as Omit<ImageALegender, "restantes"> | undefined;
  return i && { ...i, restantes };
};

/** Le nombre de légendes que le compte a à relire, affiché dans le menu. */
export const nombreLegendes = (db: Db, compte: Compte) =>
  db
    .prepare(
      `SELECT count(*) AS n FROM images i JOIN sources s ON s.id = i.source_id WHERE ${FILE}`,
    )
    .get(parametresFile(db, compte))!.n as number;

// Les douze prochaines images de la file, dans l'ordre où elles seront proposées.
export const fileLegendes = (db: Db, compte: Compte) =>
  db
    .prepare(
      `SELECT i.id, s.titre FROM images i JOIN sources s ON s.id = i.source_id WHERE ${FILE}
       ORDER BY ${nomTheme("s")}, s.titre, i.position LIMIT 12`,
    )
    .all(parametresFile(db, compte)) as { id: string; titre: string }[];
