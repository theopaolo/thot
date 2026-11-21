import { readFileSync, rmSync } from "node:fs";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import {
  assembler,
  type Bloc,
  coherent,
  decouper,
  type Document,
  type Extraction,
} from "../core/document.ts";
import { extraireDocx } from "../core/docx.ts";
import { extraireHtml, extrairePearltrees } from "../core/html.ts";
import { extraireMarkdown } from "../core/markdown.ts";
import { cleLegende, type Modeles } from "../core/modeles.ts";
import { extrairePdf } from "../core/pdf.ts";
import { extrairePptx, type Note } from "../core/pptx.ts";
import {
  type ChunkIndexe,
  estAnglais,
  indexerSource,
  retirerSource,
  transaction,
} from "../core/recherche.ts";
import { journalSans, type Resultat, resultatSans } from "../core/reponse.ts";
import { oublierSource, revoirActivites } from "./activites.ts";
import { config, contenu } from "./config.ts";
import { type Db, maintenant } from "./db.ts";
import { type Audience, sha256 } from "./depot.ts";
import { filtreModification, parametresModification, type Compte } from "./comptes.ts";
import { type Affiliation, affiliations, nomTheme, renommer } from "./domaines.ts";
import { lireInstance } from "./instance.ts";
import type { Profil } from "../core/profils.ts";

const VERROU_MS = 5 * 60_000;
const MAX_TENTATIVES = 3;
/**
 * Images légendées par extraction. Chaque légende est un appel payant d'au plus deux fois 90 s, et
 * le worker ne traite qu'un document à la fois. Les images suivantes sont importées sans légende.
 */
export const MAX_LEGENDES = 50;

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
    if (s.langue !== "fr" && !estAnglais(s.langue)) {
      avertissements.push("Langue non prise en charge pour la recherche : " + s.langue);
    }
    if (!doc.texte && !ext.images.length) avertissements.push("Aucun texte ni image extrait.");

    await enregistrer(db, s, doc, ext.avertissements, ext.notes);
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
      if (!servies.has(checksum)) await ecrireAtomique(`${dossier}/assets/${fichier}`, img.octets);
      parOctets.set(checksum, { checksum, fichier, mime: img.mime, section: img.section ?? null });
    }
    const images = [...parOctets.values()];
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
      try {
        const { texte, modele } = await modeles.legender(
          await readFile(img.chemin),
          img.mime,
          s.profil,
        );
        img.garder(texte, modele);
      } catch (e) {
        avertissements.push(`Légende non produite: ${(e as Error).message}`);
      }
    }
    // Les images d'une révision en attente restent dans son dossier, avec leur légende proposée :
    // `statuer` les sert quand un enseignant la certifie, `ecarterRevision` les efface avec elle.
    if (attente) await ecrireAtomique(`${dossier}/images.jsonl`, jsonl(images));
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

const jsonl = (lignes: unknown[]) => lignes.map((l) => JSON.stringify(l)).join("\n");

/**
 * Une image d'une extraction, à sa place dans le document. `legende` et `modele` : la légende
 * proposée pour une image que la source ne sert pas encore.
 */
type ImageRevision = {
  checksum: string;
  fichier: string;
  mime: string;
  section: string | null;
  legende?: string;
  modele?: string;
};

/** Le fichier d'une image servie, dans le dossier de la révision qui l'a apportée. */
export const cheminImage = (sourceId: string, i: { revision: number; fichier: string }) =>
  `${dossierRevision(sourceId, i.revision)}/assets/${i.fichier}`;

/** Les images d'une révision en attente. `undefined` si elle vient de `reextraire`, sans images. */
function lireInventaire(sourceId: string, n: number): ImageRevision[] | undefined {
  try {
    return readFileSync(`${dossierRevision(sourceId, n)}/images.jsonl`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ImageRevision);
  } catch {
    return undefined;
  }
}

/**
 * Fait des images de la révision `n` celles que la source sert. Une image suit ses octets : celle
 * que la source servait déjà garde son identifiant, sa légende et sa relecture, et prend sa
 * nouvelle place. Les autres entrent avec la légende proposée. Celles que la révision n'a plus
 * sortent, et leurs fichiers sont rendus pour être effacés une fois la transaction validée.
 * Sans transaction.
 */
function servirImages(db: Db, sourceId: string, n: number, images: ImageRevision[]) {
  // ponytail: le numéro repart du plus grand encore servi. Celui d'une image retirée peut donc
  // revenir à une autre, et une activité qui montrait la première montrerait la seconde. Un
  // compteur par source l'éviterait.
  let numero = db
    .prepare(
      "SELECT coalesce(max(CAST(substr(id, ?) AS INTEGER)), -1) + 1 AS n FROM images WHERE source_id = ?",
    )
    .get(sourceId.length + 2, sourceId)!.n as number;
  // Les places passent sous zéro le temps du rangement : `(source_id, position)` est unique, et
  // ce qui reste sous zéro à la fin n'est plus dans la révision.
  db.prepare("UPDATE images SET position = -1 - position WHERE source_id = ?").run(sourceId);
  const garder = db.prepare(
    `UPDATE images SET position = ?, section = ? WHERE id = (
       SELECT id FROM images WHERE source_id = ? AND checksum = ? AND position < 0
       ORDER BY position DESC LIMIT 1)`,
  );
  const ajouter = db.prepare(
    `INSERT INTO images (id, source_id, revision, position, fichier, mime, checksum, section,
       legende, legende_origine, modele)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [position, i] of images.entries()) {
    if (garder.run(position, i.section, sourceId, i.checksum).changes) continue;
    ajouter.run(
      `${sourceId}-${numero++}`,
      sourceId,
      n,
      position,
      i.fichier,
      i.mime,
      i.checksum,
      i.section,
      i.legende ?? null,
      i.legende ? "generated" : null,
      i.modele ?? null,
    );
  }
  return (
    db
      .prepare(
        "DELETE FROM images WHERE source_id = ? AND position < 0 RETURNING revision, fichier",
      )
      .all(sourceId) as { revision: number; fichier: string }[]
  ).map((i) => cheminImage(sourceId, i));
}

const retirer = (chemins: string[]) => chemins.forEach((c) => rmSync(c, { force: true }));

const lireFichiers = async (dossier: string) => ({
  texte: await readFile(`${dossier}/document.txt`, "utf8").catch(() => undefined),
  blocs: await readFile(`${dossier}/blocs.jsonl`, "utf8").catch(() => undefined),
});

async function ecrireDocument(dossier: string, doc: Document) {
  await mkdir(dossier, { recursive: true });
  await ecrireAtomique(`${dossier}/document.txt`, doc.texte);
  await ecrireAtomique(`${dossier}/blocs.jsonl`, jsonl(doc.blocs));
}

/** Les notes de l'orateur d'une présentation, à côté du texte de la révision et hors de lui. */
async function ecrireNotes(dossier: string, notes?: Note[]) {
  if (!notes) return;
  await mkdir(dossier, { recursive: true });
  await ecrireAtomique(`${dossier}/notes.json`, JSON.stringify(notes));
}

/**
 * Les notes de la révision servie. `undefined` pour une présentation extraite avant que le worker
 * ne les garde.
 */
export function lireNotes(db: Db, sourceId: string): Note[] | undefined {
  const dossier = dossierRevision(sourceId, lireSource(db, sourceId).revision);
  try {
    return JSON.parse(readFileSync(`${dossier}/notes.json`, "utf8"));
  } catch {
    return undefined;
  }
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
 * servie, s'écrit en place : les offsets des citations ne bougent pas, et une révision en attente
 * est écartée. Un autre texte devient une révision en attente, vérifiée avant d'être enregistrée.
 * La révision servie reste citée jusqu'à ce qu'un enseignant certifie la nouvelle.
 */
async function enregistrer(
  db: Db,
  s: Source,
  doc: Document,
  avertissements: string[],
  notes?: Note[],
) {
  const blocs = jsonl(doc.blocs);
  const servie = await lireFichiers(dossierRevision(s.id, s.revision));
  if (servie.texte === undefined || servie.texte === doc.texte) {
    // Le texte servi est revenu : la révision en attente n'a plus rien à faire relire.
    const perimee = revisionEnAttente(db, s.id);
    if (perimee) await ecarterRevision(db, s.id, perimee.n);
    db.prepare(
      `INSERT INTO revisions (source_id, n, avertissements, cree_le) VALUES (?, ?, ?, ?)
       ON CONFLICT (source_id, n) DO UPDATE SET avertissements = excluded.avertissements`,
    ).run(s.id, s.revision, JSON.stringify(avertissements), maintenant());
    // Les notes s'écrivent même sans changement de texte : une présentation extraite avant que
    // le worker ne les garde les reçoit à sa prochaine extraction.
    await ecrireNotes(dossierRevision(s.id, s.revision), notes);
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
  await ecrireNotes(dossier, notes);
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

/** Écarte la révision en attente, avec ses images. Elle n'a jamais servi, personne ne la cite. */
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
  if (
    !["html", "pdf", "md", "docx", "pptx"].includes(s.format) ||
    job?.etat !== "awaiting_review"
  ) {
    return "ignoree";
  }
  const ext = await extraire(s);
  const r = await enregistrer(db, s, assembler(ext.parties), ext.avertissements, ext.notes);
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

/**
 * Renomme une matière, un cours, un thème ou un champ. L'en-tête des passages porte le nom de
 * leurs thèmes : les sources d'un thème renommé se réindexent dans la même transaction.
 */
export function renommerEntree(db: Db, genre: string, id: string, nom: string) {
  transaction(db, () => {
    renommer(db, genre, id, nom);
    if (genre !== "theme") return;
    const ids = db.prepare("SELECT source_id FROM source_cours WHERE theme_id = ?").all(id);
    for (const { source_id } of ids) reindexer(db, source_id as string);
  });
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
      `SELECT legende, legende_statut, section FROM images
     WHERE source_id = ? AND legende IS NOT NULL AND legende_statut != 'rejected' ORDER BY position`,
    )
    .all(sourceId) as { legende: string; legende_statut: string; section: string | null }[];
  const chunks = decouper(lireDocument(sourceId, n));
  // Une image accompagne le premier passage de sa section, une diapositive par exemple. Sans
  // section connue, ou si la révision n'a plus cette section, le premier passage du document.
  const place = (section: string | null) =>
    Math.max(0, section === null ? 0 : chunks.findIndex((c) => c.section === section));
  return chunks.map((c, i) => {
    const legendes = images.filter((l) => place(l.section) === i);
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

/** Seule une source certifiée entre dans l'index. Toute autre en sort. Sans transaction. */
function reindexer(db: Db, sourceId: string) {
  const s = lireSource(db, sourceId);
  indexerSource(db, sourceId, s.statut === "certifiee" ? chunksSource(db, sourceId) : []);
}

export const indexer = (db: Db, sourceId: string) => transaction(db, () => reindexer(db, sourceId));

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
