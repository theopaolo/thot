import type { DatabaseSync } from "node:sqlite";
import snowball from "snowball";
import { type Modeles, PanneModele } from "./modeles.ts";
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

export type Perimetre = {
  schoolId: string;
  chapitre?: string;
  matiereId?: string;
  coursId?: string;
  themeId?: string;
  sourceId?: string;
  /** recherche de la bibliothèque: toute source lisible, même hors des preuves de réponse */
  bibliotheque?: boolean;
  /** null : vue système des sources publiées, tous cours confondus */
  lecteur: Lecteur | null;
};

export type Lecteur = { id: string; enseignant: boolean; administrateur: boolean };
/**
 * Sources lisibles par le lecteur. Un administrateur lit tout, chacun ses propres sources. Une
 * source partagée ou publiée se lit par les membres de ses cours, ou par tous si elle n'a pas de
 * cours. Avec un lecteur null, le système voit ce qui est publié aux élèves, tous cours confondus.
 */
export const filtreAcces = (s = "s") =>
  `(? OR ${s}.proprietaire_id = ?
  OR ((${s}.audience = 'eleves' OR (? AND ${s}.audience = 'collegues'))
    AND (? OR NOT EXISTS (SELECT 1 FROM source_cours sc WHERE sc.source_id = ${s}.id)
      OR EXISTS (SELECT 1 FROM source_cours sc JOIN membres_cours mc ON mc.cours_id = sc.cours_id
        WHERE sc.source_id = ${s}.id AND mc.compte_id = ?))))`;
export const FILTRE_ACCES = filtreAcces();
export const parametresAcces = (l: Lecteur | null) => [
  l?.administrateur ? 1 : 0,
  l?.id ?? "",
  l?.enseignant ? 1 : 0,
  l ? 0 : 1,
  l?.id ?? "",
];

export const FILTRE_DOMAINE = `((? = '' AND ? = '' AND ? = '')
  OR (? != '' AND ? = '' AND ? = '' AND s.matiere_id = ?)
  OR EXISTS (SELECT 1 FROM source_cours sc JOIN cours co ON co.id = sc.cours_id
    WHERE sc.source_id = s.id AND (? = '' OR co.matiere_id = ?)
      AND (? = '' OR sc.cours_id = ?) AND (? = '' OR sc.theme_id = ?)))`;
export const parametresDomaine = (p: Perimetre) => {
  const m = p.matiereId ?? "",
    c = p.coursId ?? "",
    t = p.themeId ?? "";
  return [m, c, t, m, c, t, m, m, m, c, c, t, t];
};

export type Recherche = {
  candidats: Candidat[];
  retenus: Candidat[];
  score: number;
  horsCorpus: boolean;
  /** message de la panne du reclasseur: `retenus` suit alors l'ordre de FTS5 et `score` vaut 0 */
  panneReclasseur?: string;
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
  db.prepare(
    "DELETE FROM chunks_fts WHERE rowid IN (SELECT n FROM chunks WHERE source_id = ?)",
  ).run(sourceId);
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
  const lignes = db
    .prepare(
      `SELECT c.* FROM chunks_fts f JOIN chunks c ON c.n = f.rowid
     JOIN sources s ON s.id = c.source_id
     WHERE chunks_fts MATCH ? AND c.school_id = ? AND s.statut = 'certifiee'
       AND ${FILTRE_ACCES} AND (? OR s.reponses = 1)
       AND (? = '' OR coalesce(json_extract(s.metadonnees, '$.sequence'), '') = ?)
       AND (? = '' OR s.id = ?)
       AND ${FILTRE_DOMAINE}
     ORDER BY bm25(chunks_fts, 3.0, 1.0) LIMIT ?`,
    )
    .all(
      termes.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR "),
      p.schoolId,
      ...parametresAcces(p.lecteur),
      p.bibliotheque ? 1 : 0,
      p.chapitre ?? "",
      p.chapitre ?? "",
      p.sourceId ?? "",
      p.sourceId ?? "",
      ...parametresDomaine(p),
      k,
    );
  return lignes.map((l, i) => ({ ...(l as unknown as ChunkIndexe), rang_fts: i + 1 }));
}

export function lireChunk(db: DatabaseSync, sourceId: string, id: string, p: Perimetre) {
  return db
    .prepare(
      `SELECT c.* FROM chunks c JOIN sources s ON s.id = c.source_id
     WHERE c.source_id = ? AND c.id = ? AND s.school_id = ? AND s.statut = 'certifiee'
       AND ${FILTRE_ACCES} AND (? OR s.reponses = 1)
       AND (? = '' OR coalesce(json_extract(s.metadonnees, '$.sequence'), '') = ?)
       AND (? = '' OR s.id = ?) AND ${FILTRE_DOMAINE}`,
    )
    .get(
      sourceId,
      id,
      p.schoolId,
      ...parametresAcces(p.lecteur),
      p.bibliotheque ? 1 : 0,
      p.chapitre ?? "",
      p.chapitre ?? "",
      p.sourceId ?? "",
      p.sourceId ?? "",
      ...parametresDomaine(p),
    ) as ChunkIndexe | undefined;
}

/**
 * FTS5 top 20, reclassement, top 5. Sous le seuil, la question est hors corpus. Si le reclasseur
 * est en panne, l'ordre de FTS5 le remplace.
 */
export async function chercher(
  db: DatabaseSync,
  modeles: Modeles,
  question: string,
  p: Perimetre,
  seuil: number,
): Promise<Recherche> {
  const candidats = chercherFts(db, question, p);
  if (!candidats.length) return { candidats, retenus: [], score: 0, horsCorpus: true };
  let ordre: { index: number; score: number }[];
  let panneReclasseur: string | undefined;
  try {
    ordre = await modeles.reclasser(
      question,
      candidats.map((c) => c.rappel),
    );
  } catch (e) {
    if (!(e instanceof PanneModele)) throw e;
    panneReclasseur = e.message;
    ordre = candidats.map((_, index) => ({ index, score: 0 }));
  }
  for (const { index, score } of ordre) candidats[index].score = score;
  const classes = ordre
    .map(({ index }) => candidats[index])
    .filter((c) => {
      const actuel = lireChunk(db, c.source_id, c.id, p);
      return (
        actuel &&
        actuel.titre === c.titre &&
        actuel.rappel === c.rappel &&
        actuel.preuve === c.preuve &&
        actuel.debut === c.debut &&
        actuel.fin === c.fin
      );
    });
  const score = classes[0]?.score ?? 0;
  return {
    candidats: classes,
    retenus: classes.slice(0, 5),
    score,
    // Le seuil est une probabilité du reclasseur: il ne dit rien des rangs FTS5. Sans lui, le
    // refus du générateur et le juge décident.
    horsCorpus: !classes.length || (!panneReclasseur && score < seuil),
    panneReclasseur,
  };
}
