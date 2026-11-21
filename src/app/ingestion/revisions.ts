import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { type Bloc, coherent, type Document } from "../../core/document.ts";
import type { Note } from "../../core/pptx.ts";
import type { Profil } from "../../core/profils.ts";
import { transaction } from "../../core/recherche.ts";
import { contenu } from "../config.ts";
import { type Db, maintenant } from "../db.ts";

export type Source = {
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

export function ecrireAtomique(chemin: string, donnees: string | Uint8Array) {
  const tmp = `${chemin}.partiel`;
  writeFileSync(tmp, donnees);
  renameSync(tmp, chemin);
}

export const lireSource = (db: Db, id: string) =>
  db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as unknown as Source;

/** La révision 1 garde les fichiers du pilote, à la racine de la source. */
export const dossierRevision = (sourceId: string, n: number) =>
  n === 1 ? contenu(sourceId) : contenu(sourceId, "revisions", String(n));

export const jsonl = (lignes: unknown[]) => lignes.map((l) => JSON.stringify(l)).join("\n");

function lireSiPresent(chemin: string) {
  try {
    return readFileSync(chemin, "utf8");
  } catch {
    return undefined;
  }
}

const lireFichiers = (dossier: string) => ({
  texte: lireSiPresent(`${dossier}/document.txt`),
  blocs: lireSiPresent(`${dossier}/blocs.jsonl`),
});

function ecrireDocument(dossier: string, doc: Document) {
  mkdirSync(dossier, { recursive: true });
  ecrireAtomique(`${dossier}/document.txt`, doc.texte);
  ecrireAtomique(`${dossier}/blocs.jsonl`, jsonl(doc.blocs));
}

/** Les notes de l'orateur d'une présentation, à côté du texte de la révision et hors de lui. */
function ecrireNotes(dossier: string, notes?: Note[]) {
  if (!notes) return;
  mkdirSync(dossier, { recursive: true });
  ecrireAtomique(`${dossier}/notes.json`, JSON.stringify(notes));
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
 *
 * Tout se fait dans une transaction, fichiers compris, et la révision servie s'y relit : un
 * enseignant a pu certifier la révision en attente pendant l'extraction, et le numéro calculé
 * d'après une lecture plus ancienne désignerait alors le dossier de la révision servie.
 */
export function enregistrer(
  db: Db,
  s: Source,
  doc: Document,
  avertissements: string[],
  notes?: Note[],
) {
  const blocs = jsonl(doc.blocs);
  // La révision en attente que cette extraction écarte. Son dossier part une fois sa ligne
  // retirée pour de bon.
  let ecartee: number | undefined;
  const ecarter = (n: number) => {
    db.prepare("DELETE FROM revisions WHERE source_id = ? AND n = ?").run(s.id, n);
    ecartee = n;
  };
  const resultat = transaction(db, () => {
    const revision = lireSource(db, s.id).revision;
    const attente = revisionEnAttente(db, s.id);
    const servie = lireFichiers(dossierRevision(s.id, revision));
    if (servie.texte === undefined || servie.texte === doc.texte) {
      // Le texte servi est revenu : la révision en attente n'a plus rien à faire relire.
      if (attente) ecarter(attente.n);
      db.prepare(
        `INSERT INTO revisions (source_id, n, avertissements, cree_le) VALUES (?, ?, ?, ?)
         ON CONFLICT (source_id, n) DO UPDATE SET avertissements = excluded.avertissements`,
      ).run(s.id, revision, JSON.stringify(avertissements), maintenant());
      // Les notes s'écrivent même sans changement de texte : une présentation extraite avant que
      // le worker ne les garde les reçoit à sa prochaine extraction.
      ecrireNotes(dossierRevision(s.id, revision), notes);
      if (servie.texte === doc.texte && servie.blocs === blocs) return "identique";
      ecrireDocument(dossierRevision(s.id, revision), doc);
      return "mise_a_jour";
    }
    if (attente) {
      const fichiers = lireFichiers(dossierRevision(s.id, attente.n));
      if (fichiers.texte === doc.texte && fichiers.blocs === blocs) return "identique";
    }
    const n = (attente?.n ?? revision) + 1;
    const dossier = contenu(s.id, "revisions", String(n));
    // Un dossier sans ligne en base reste d'un essai interrompu.
    rmSync(dossier, { recursive: true, force: true });
    ecrireDocument(dossier, doc);
    ecrireNotes(dossier, notes);
    if (!coherent(lireDocument(s.id, n))) {
      throw new Error(`Révision ${n} incohérente : un bloc ne retombe pas sur son texte.`);
    }
    db.prepare(
      "INSERT INTO revisions (source_id, n, avertissements, cree_le) VALUES (?, ?, ?, ?)",
    ).run(s.id, n, JSON.stringify(avertissements), maintenant());
    // L'ancienne révision en attente n'a jamais servi : la nouvelle la remplace.
    if (attente) ecarter(attente.n);
    return "revision";
  });
  if (ecartee)
    rmSync(contenu(s.id, "revisions", String(ecartee)), { recursive: true, force: true });
  return resultat;
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

export function lireDocument(sourceId: string, revision: number): Document {
  const dossier = dossierRevision(sourceId, revision);
  const texte = readFileSync(`${dossier}/document.txt`, "utf8");
  const blocs = readFileSync(`${dossier}/blocs.jsonl`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Bloc);
  return { texte, blocs };
}
