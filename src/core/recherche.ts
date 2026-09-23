import type { DatabaseSync } from "node:sqlite";
import snowball from "snowball";
import type { Modeles } from "./modeles.ts";
import { mots } from "./texte.ts";

const stemmer = snowball.newStemmer("french");

/** Racines françaises. L'élision est retirée à la main: le Snowball npm date d'avant ce retrait. */
export const racines = (texte: string) =>
  mots(texte).map((m) => stemmer.stem(m.replace(/^(qu|[cdjlmnst])'/, "")) as string);

export type ChunkIndexe = {
  id: string;
  source_id: string;
  school_id: string;
  titre: string;
  debut: number;
  fin: number;
  /** tranche exacte de `document.txt`, seule base des offsets de citation */
  texte: string;
  /** texte de recherche: contexte, titre, texte, toutes les légendes */
  rappel: string;
  /** texte de preuve: texte et légendes certifiées seulement */
  preuve: string;
};

export type Candidat = ChunkIndexe & { rang_fts: number; score?: number };

export type Perimetre = { schoolId: string; chapitre?: string };

export type Recherche = {
  candidats: Candidat[];
  retenus: Candidat[];
  score: number;
  horsCorpus: boolean;
};

export function transaction<T>(db: DatabaseSync, f: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = f();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function retirerSource(db: DatabaseSync, sourceId: string) {
  db.prepare("DELETE FROM chunks_fts WHERE rowid IN (SELECT n FROM chunks WHERE source_id = ?)")
    .run(sourceId);
  db.prepare("DELETE FROM chunks WHERE source_id = ?").run(sourceId);
}

/** Remplace les chunks d'une source dans l'index. Appelé dans une transaction. */
export function indexerSource(db: DatabaseSync, sourceId: string, chunks: ChunkIndexe[]) {
  retirerSource(db, sourceId);
  const ins = db.prepare(
    "INSERT INTO chunks (id, source_id, school_id, titre, debut, fin, texte, rappel, preuve)" +
      " VALUES (:id, :source_id, :school_id, :titre, :debut, :fin, :texte, :rappel, :preuve)",
  );
  const fts = db.prepare("INSERT INTO chunks_fts (rowid, titre, texte) VALUES (?, ?, ?)");
  for (const c of chunks) {
    const { lastInsertRowid } = ins.run(c);
    fts.run(lastInsertRowid, racines(c.titre).join(" "), racines(c.rappel).join(" "));
  }
}

export function chercherFts(db: DatabaseSync, question: string, p: Perimetre, k = 20): Candidat[] {
  const termes = [...new Set(racines(question))];
  if (!termes.length) return [];
  // Le filtre d'établissement s'applique dans la même requête que le classement.
  const lignes = db.prepare(
    `SELECT c.* FROM chunks_fts f JOIN chunks c ON c.n = f.rowid
     JOIN sources s ON s.id = c.source_id
     WHERE chunks_fts MATCH ? AND c.school_id = ?
       AND (? = '' OR coalesce(json_extract(s.metadonnees, '$.sequence'), '') = ?)
     ORDER BY bm25(chunks_fts, 3.0, 1.0) LIMIT ?`,
  ).all(
    termes.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR "),
    p.schoolId,
    p.chapitre ?? "",
    p.chapitre ?? "",
    k,
  );
  return lignes.map((l, i) => ({ ...(l as unknown as ChunkIndexe), rang_fts: i + 1 }));
}

/** FTS5 top 20, reclassement, top 5. Sous le seuil, la question est hors corpus. */
export async function chercher(
  db: DatabaseSync,
  modeles: Modeles,
  question: string,
  p: Perimetre,
  seuil: number,
): Promise<Recherche> {
  const candidats = chercherFts(db, question, p);
  if (!candidats.length) return { candidats, retenus: [], score: 0, horsCorpus: true };
  const ordre = await modeles.reclasser(question, candidats.map((c) => c.rappel));
  for (const { index, score } of ordre) candidats[index].score = score;
  const classes = ordre.map(({ index }) => candidats[index]);
  const score = classes[0]?.score ?? 0;
  return { candidats, retenus: classes.slice(0, 5), score, horsCorpus: score < seuil };
}
