import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import {
  assembler,
  type Bloc,
  coherent,
  decouper,
  type Document,
  type Extraction,
} from "../core/document.ts";
import { extraireHtml } from "../core/html.ts";
import { extraireMarkdown } from "../core/markdown.ts";
import { cleLegende, type Modeles } from "../core/modeles.ts";
import { extrairePdf } from "../core/pdf.ts";
import { type ChunkIndexe, indexerSource, retirerSource, transaction } from "../core/recherche.ts";
import { journalSans, type Resultat, resultatSans } from "../core/reponse.ts";
import { oublierSource, revoirActivites } from "./activites.ts";
import { config, contenu } from "./config.ts";
import { type Db, maintenant } from "./db.ts";
import { sha256 } from "./depot.ts";
import type { Profil } from "../core/profils.ts";

const VERROU_MS = 5 * 60_000;
const MAX_TENTATIVES = 3;

const horodatage = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";

export type Job = { id: string; source_id: string; tentatives: number };

type Source = {
  id: string;
  school_id: string;
  titre: string;
  metadonnees: string;
  fichier: string;
  format: string;
  statut: string;
  profil: Profil;
  langue: string;
  /** la révision servie aux lecteurs et à l'index */
  revision: number;
};

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

async function ecrireAtomique(chemin: string, donnees: string | Uint8Array) {
  const tmp = `${chemin}.partiel`;
  if (typeof donnees === "string") await writeFile(tmp, donnees);
  else await writeFile(tmp, donnees);
  await rename(tmp, chemin);
}

const lireSource = (db: Db, id: string) =>
  db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as unknown as Source;

async function extraire(s: Source): Promise<Extraction> {
  const chemin = contenu(s.id, "original", s.fichier);
  if (s.format === "pdf") return await extrairePdf(chemin, s.profil);
  if (s.format === "html") return extraireHtml(await readFile(chemin, "utf8"), s.titre);
  if (s.format === "md") return extraireMarkdown(await readFile(chemin, "utf8"), s.titre);
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

function etat(db: Db, job: Job, etat: string, avertissements: string[], fin = false) {
  db.prepare(
    `UPDATE ingestion_jobs SET etat = ?, etape = ?, avertissements = ?, maj_le = ?,
       progression = ?, verrou_expire_le = CASE WHEN ? THEN NULL ELSE verrou_expire_le END
     WHERE id = ?`,
  ).run(
    etat,
    etat,
    JSON.stringify(avertissements),
    maintenant(),
    fin ? 1 : 0.5,
    fin ? 1 : 0,
    job.id,
  );
}

/** Extraction puis légendes. Un échec de légende devient un avertissement, pas un échec du travail. */
export async function traiter(db: Db, job: Job, modeles: Modeles) {
  const s = lireSource(db, job.source_id);
  try {
    const ext = await extraire(s);
    const doc = assembler(ext.parties);
    const avertissements = [...ext.avertissements];
    if (s.langue !== "fr") {
      avertissements.push("Langue non prise en charge pour la recherche : " + s.langue);
    }
    if (!doc.texte && !ext.images.length) avertissements.push("Aucun texte ni image extrait.");

    const dossier = contenu(s.id);
    await mkdir(`${dossier}/assets`, { recursive: true });
    await enregistrer(db, s, doc, ext.avertissements);
    // Une légende relue décrit des octets précis : d'autres octets à la même place repartent sans
    // légende. La ligne change avant le fichier, une légende ne décrit donc jamais d'autres octets.
    const ins = db.prepare(
      `INSERT INTO images (id, source_id, position, fichier, mime, checksum)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_id, position) DO UPDATE SET fichier = excluded.fichier,
         mime = excluded.mime, checksum = excluded.checksum, legende = NULL,
         legende_origine = NULL, legende_statut = 'unreviewed', modele = NULL, relu_par = NULL,
         relu_le = NULL, credit = NULL
       WHERE checksum != excluded.checksum`,
    );
    for (const [i, img] of ext.images.entries()) {
      const fichier = `image-${i}.${img.extension}`;
      ins.run(`${s.id}-${i}`, s.id, i, fichier, img.mime, await sha256(img.octets));
      await ecrireAtomique(`${dossier}/assets/${fichier}`, img.octets);
    }
    etat(db, job, "enriching", avertissements);

    const aLegender = db
      .prepare(
        `SELECT id, fichier, mime FROM images
       WHERE source_id = ? AND legende IS NULL AND legende_statut = 'unreviewed'`,
      )
      .all(s.id) as { id: string; fichier: string; mime: string }[];
    for (const img of aLegender) {
      try {
        const { texte, modele } = await modeles.legender(
          await readFile(`${dossier}/assets/${img.fichier}`),
          img.mime,
          s.profil,
        );
        db.prepare(
          `UPDATE images SET legende = ?, legende_origine = 'generated', modele = ?
           WHERE id = ? AND legende IS NULL AND legende_statut = 'unreviewed'`,
        ).run(texte, modele, img.id);
      } catch (e) {
        avertissements.push(`Légende non produite: ${(e as Error).message}`);
      }
    }
    etat(db, job, "awaiting_review", avertissements, true);
    // Une source déjà certifiée qu'on réingère se réindexe avec ses sections et légendes.
    if (s.statut === "certifiee") indexer(db, s.id);
  } catch (e) {
    db.prepare(
      `UPDATE ingestion_jobs SET etat = 'failed', erreur = ?, verrou_expire_le = NULL, maj_le = ?
       WHERE id = ?`,
    ).run((e as Error).message, maintenant(), job.id);
  }
}

/** La révision 1 garde les fichiers du pilote, à la racine de la source. */
const dossierRevision = (sourceId: string, n: number) =>
  n === 1 ? contenu(sourceId) : contenu(sourceId, "revisions", String(n));

const jsonl = (blocs: Bloc[]) => blocs.map((b) => JSON.stringify(b)).join("\n");

const lireFichiers = async (dossier: string) => ({
  texte: await readFile(`${dossier}/document.txt`, "utf8").catch(() => undefined),
  blocs: await readFile(`${dossier}/blocs.jsonl`, "utf8").catch(() => undefined),
});

async function ecrireDocument(dossier: string, doc: Document) {
  await mkdir(dossier, { recursive: true });
  await ecrireAtomique(`${dossier}/document.txt`, doc.texte);
  await ecrireAtomique(`${dossier}/blocs.jsonl`, jsonl(doc.blocs));
}

/** La révision plus récente que la révision servie, qui attend la relecture d'un enseignant. */
export const revisionEnAttente = (db: Db, sourceId: string) =>
  db
    .prepare(
      `SELECT r.n, r.avertissements, r.cree_le FROM revisions r JOIN sources s ON s.id = r.source_id
     WHERE r.source_id = ? AND r.n > s.revision ORDER BY r.n DESC`,
    )
    .get(sourceId) as { n: number; avertissements: string; cree_le: string } | undefined;

/**
 * Range une extraction. Une première extraction, ou un texte identique à celui de la révision
 * servie, s'écrit en place : les offsets des citations ne bougent pas. Un autre texte devient une
 * révision en attente, vérifiée avant d'être enregistrée. La révision servie reste citée jusqu'à
 * ce qu'un enseignant certifie la nouvelle.
 */
async function enregistrer(db: Db, s: Source, doc: Document, avertissements: string[]) {
  const blocs = jsonl(doc.blocs);
  const servie = await lireFichiers(dossierRevision(s.id, s.revision));
  if (servie.texte === undefined || servie.texte === doc.texte) {
    db.prepare(
      `INSERT INTO revisions (source_id, n, avertissements, cree_le) VALUES (?, ?, ?, ?)
       ON CONFLICT (source_id, n) DO UPDATE SET avertissements = excluded.avertissements`,
    ).run(s.id, s.revision, JSON.stringify(avertissements), maintenant());
    if (servie.texte === doc.texte && servie.blocs === blocs) return "identique";
    await ecrireDocument(dossierRevision(s.id, s.revision), doc);
    return "mise_a_jour";
  }
  const attente = revisionEnAttente(db, s.id);
  if (attente) {
    const fichiers = await lireFichiers(dossierRevision(s.id, attente.n));
    if (fichiers.texte === doc.texte && fichiers.blocs === blocs) return "identique";
  }
  const n = (attente?.n ?? s.revision) + 1;
  const dossier = contenu(s.id, "revisions", String(n));
  // Un dossier sans ligne en base reste d'un essai interrompu.
  await rm(dossier, { recursive: true, force: true });
  await ecrireDocument(dossier, doc);
  if (!coherent(lireDocument(s.id, n))) {
    throw new Error(`Révision ${n} incohérente : un bloc ne retombe pas sur son texte.`);
  }
  db.prepare(
    "INSERT INTO revisions (source_id, n, avertissements, cree_le) VALUES (?, ?, ?, ?)",
  ).run(s.id, n, JSON.stringify(avertissements), maintenant());
  // L'ancienne révision en attente n'a jamais servi : la nouvelle la remplace.
  if (attente) await ecarterRevision(db, s.id, attente.n);
  return "revision";
}

/** Écarte la révision en attente. Elle n'a jamais servi, personne ne la cite. */
export async function ecarterRevision(db: Db, sourceId: string, n: number) {
  const { changes } = db
    .prepare(
      `DELETE FROM revisions WHERE source_id = ? AND n = ?
       AND n > (SELECT revision FROM sources WHERE id = ?)`,
    )
    .run(sourceId, n, sourceId);
  if (!changes) throw new Error("Cette version n'attend plus de relecture.");
  await rm(contenu(sourceId, "revisions", String(n)), { recursive: true, force: true });
}

/**
 * Rejoue l'extraction d'une source extraite, après une amélioration de l'extracteur. Un texte
 * changé devient une révision en attente : les citations déjà données gardent la leur.
 */
export async function reextraire(db: Db, sourceId: string) {
  const s = lireSource(db, sourceId);
  const job = db.prepare("SELECT etat FROM ingestion_jobs WHERE source_id = ?").get(sourceId);
  if (!["html", "pdf", "md"].includes(s.format) || job?.etat !== "awaiting_review") {
    return "ignoree";
  }
  const ext = await extraire(s);
  const r = await enregistrer(db, s, assembler(ext.parties), ext.avertissements);
  if (r === "mise_a_jour") indexer(db, s.id);
  return r;
}

export type Meta = { sequence?: string; seance?: string };

/**
 * Ce qui range la source : les noms de ses thèmes, tous, par ordre alphabétique. Une source dans
 * plusieurs cours a un thème par cours, et chaque nom donne un mot de plus à la recherche. Une
 * source sans thème garde l'ancienne séquence.
 */
function regroupement(db: Db, s: Source) {
  const noms = db
    .prepare(
      `SELECT DISTINCT t.nom FROM source_cours sc JOIN themes t ON t.id = sc.theme_id
       WHERE sc.source_id = ? ORDER BY t.nom`,
    )
    .all(s.id)
    .map((t) => t.nom as string);
  return noms.length ? noms.join(" / ") : (JSON.parse(s.metadonnees) as Meta).sequence;
}

/** Réindexe les sources d'un thème : l'en-tête de leurs passages porte son nom. */
export function indexerTheme(db: Db, themeId: string) {
  const ids = db.prepare("SELECT source_id FROM source_cours WHERE theme_id = ?").all(themeId);
  for (const { source_id } of ids) indexer(db, source_id as string);
}

export function lireDocument(sourceId: string, revision: number): Document {
  const dossier = dossierRevision(sourceId, revision);
  const texte = readFileSync(`${dossier}/document.txt`, "utf8");
  const blocs = readFileSync(`${dossier}/blocs.jsonl`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Bloc);
  return { texte, blocs };
}

/**
 * Chunks d'une révision, la servie par défaut: texte de recherche avec toutes les légendes,
 * preuve avec les certifiées. Titres et légendes sont ceux d'aujourd'hui, même pour une ancienne.
 */
export function chunksSource(db: Db, sourceId: string, revision?: number): ChunkIndexe[] {
  const s = lireSource(db, sourceId);
  const n = revision ?? s.revision;
  const meta = JSON.parse(s.metadonnees) as Meta;
  const contexte = [
    s.profil === "arts-appliques" ? regroupement(db, s)?.replace(/^ATC /, "") : regroupement(db, s),
    meta.seance,
  ]
    .filter(Boolean)
    .join(" / ");
  const images = db
    .prepare(
      `SELECT legende, legende_statut FROM images
     WHERE source_id = ? AND legende IS NOT NULL AND legende_statut != 'rejected' ORDER BY position`,
    )
    .all(sourceId) as { legende: string; legende_statut: string }[];
  const chunks = decouper(lireDocument(sourceId, n));
  return chunks.map((c, i) => {
    // Les images d'une page accompagnent son premier passage.
    const legendes = i === 0 ? images : [];
    const titre =
      c.section && c.section !== s.titre && c.section !== "Introduction"
        ? `${s.titre} : ${c.section}`
        : s.titre;
    return {
      id: c.id,
      source_id: s.id,
      school_id: s.school_id,
      titre,
      debut: c.debut,
      fin: c.fin,
      texte: c.texte,
      rappel: [contexte, titre, c.texte, ...legendes.map((l) => l.legende)]
        .filter(Boolean)
        .join("\n"),
      preuve: [
        c.texte,
        ...legendes
          .filter((l) => l.legende_statut === "certified")
          .map((l) => `Image : ${l.legende}`),
      ].join("\n\n"),
      revision: n,
    };
  });
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
  const fiche = [
    `Titre : ${s.titre}`,
    `Fichier : ${s.fichier}`,
    `Séquence : ${regroupement(db, s) ?? ""}`,
    `Séance : ${meta.seance ?? ""}`,
    `Texte : ${lireDocument(sourceId, s.revision).texte.slice(0, 2000)}`,
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

/** Seule une source certifiée entre dans l'index. Toute autre en sort. */
export function indexer(db: Db, sourceId: string) {
  transaction(db, () => {
    const s = lireSource(db, sourceId);
    indexerSource(db, sourceId, s.statut === "certifiee" ? chunksSource(db, sourceId) : []);
  });
}

/**
 * Certifie ou rejette une source. Certifier avec `revision`, sa révision en attente, fait servir
 * celle-ci dans la transaction de l'index : un échec laisse servir l'ancienne. Un exercice qui
 * citait une autre révision, ou une source rejetée, devient à revoir.
 */
export function statuer(
  db: Db,
  sourceId: string,
  statut: "certifiee" | "rejetee",
  par: string,
  revision?: number,
) {
  transaction(db, () => {
    if (
      statut === "certifiee" &&
      db.prepare("SELECT etat FROM ingestion_jobs WHERE source_id = ?").get(sourceId)?.etat !==
        "awaiting_review"
    ) {
      throw new Error("La source n'est pas prête à être certifiée.");
    }
    if (revision !== undefined) {
      if (revisionEnAttente(db, sourceId)?.n !== revision) {
        throw new Error("Cette version n'attend plus de relecture.");
      }
      // Les questions suggérées ont été vérifiées sur l'ancien texte.
      db.prepare("UPDATE sources SET revision = ?, suggestions_le = NULL WHERE id = ?").run(
        revision,
        sourceId,
      );
    }
    db.prepare("UPDATE sources SET statut = ?, statut_par = ?, statut_le = ? WHERE id = ?").run(
      statut,
      par,
      maintenant(),
      sourceId,
    );
    indexerSource(db, sourceId, statut === "certifiee" ? chunksSource(db, sourceId) : []);
    revoirActivites(db, sourceId);
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
    .prepare("SELECT fichier, mime FROM images WHERE source_id = ?")
    .all(sourceId) as { fichier: string; mime: string }[];
  // ponytail: la clé suit le modèle de légende actuel. Une légende mise en cache sous un autre
  // modèle, ou pour une image remplacée par une réextraction, reste dans le cache.
  const cles: string[] = [];
  for (const i of images) {
    const octets = await readFile(contenu(sourceId, "assets", i.fichier)).catch(() => undefined);
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
    const s = lireSource(db, img.source_id);
    indexerSource(db, s.id, s.statut === "certifiee" ? chunksSource(db, s.id) : []);
  });
}
