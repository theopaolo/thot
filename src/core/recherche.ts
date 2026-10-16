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
  /** révision de la source dont le chunk est tiré */
  revision: number;
};

/** `matieres` : en comparaison, les noms des matières où le chunk a été trouvé. */
export type Candidat = ChunkIndexe & { rang_fts: number; score?: number; matieres?: string[] };

export type Perimetre = {
  schoolId: string;
  matiereId?: string;
  /** comparaison : deux matières ou plus, qui remplacent `matiereId` */
  matieres?: string[];
  coursId?: string;
  themeId?: string;
  sourceId?: string;
  /** explication d'une activité : les sources choisies, qui remplacent `sourceId` */
  sources?: string[];
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

/** Les matières passent en liste JSON : une seule, ou celles d'une comparaison. */
export const FILTRE_DOMAINE = `((? = '' AND ? = '' AND ? = '')
  OR (? != '' AND ? = '' AND ? = '' AND s.matiere_id IN (SELECT value FROM json_each(?)))
  OR EXISTS (SELECT 1 FROM source_cours sc JOIN cours co ON co.id = sc.cours_id
    WHERE sc.source_id = s.id AND (? = '' OR co.matiere_id IN (SELECT value FROM json_each(?)))
      AND (? = '' OR sc.cours_id = ?) AND (? = '' OR sc.theme_id = ?)))`;
export const parametresDomaine = (p: Perimetre) => {
  const ids = p.matieres?.length ? p.matieres : p.matiereId ? [p.matiereId] : [];
  const m = ids.length ? JSON.stringify(ids) : "",
    c = p.coursId ?? "",
    t = p.themeId ?? "";
  return [m, c, t, m, c, t, m, m, m, c, c, t, t];
};

/** `sourceId` ou `sources`, en liste JSON. Vide : toutes les sources. */
const FILTRE_SOURCES = "(? = '' OR s.id IN (SELECT value FROM json_each(?)))";
const parametresSources = (p: Perimetre) => {
  const ids = p.sources ?? (p.sourceId ? [p.sourceId] : []);
  const j = ids.length ? JSON.stringify(ids) : "";
  return [j, j];
};

export type Recherche = {
  candidats: Candidat[];
  retenus: Candidat[];
  score: number;
  horsCorpus: boolean;
  /** message de la panne du reclasseur: `retenus` suit alors l'ordre de FTS5 et `score` vaut 0 */
  panneReclasseur?: string;
  /** comparaison : les matières sans extrait au-dessus du seuil */
  sansPassage?: string[];
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
    "INSERT INTO chunks (id, source_id, school_id, titre, debut, fin, texte, rappel, preuve, revision)" +
      " VALUES (:id, :source_id, :school_id, :titre, :debut, :fin, :texte, :rappel, :preuve, :revision)",
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
       AND ${FILTRE_SOURCES}
       AND ${FILTRE_DOMAINE}
     ORDER BY bm25(chunks_fts, 3.0, 1.0) LIMIT ?`,
    )
    .all(
      termes.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR "),
      p.schoolId,
      ...parametresAcces(p.lecteur),
      p.bibliotheque ? 1 : 0,
      ...parametresSources(p),
      ...parametresDomaine(p),
      k,
    );
  return lignes.map((l, i) => ({ ...(l as unknown as ChunkIndexe), rang_fts: i + 1 }));
}

/** Une source que le périmètre peut citer: certifiée, lisible par son lecteur, dans son domaine. */
const CITABLE = `s.school_id = ? AND s.statut = 'certifiee' AND ${FILTRE_ACCES} AND (? OR s.reponses = 1)
  AND ${FILTRE_SOURCES} AND ${FILTRE_DOMAINE}`;
const parametresCitable = (p: Perimetre) => [
  p.schoolId,
  ...parametresAcces(p.lecteur),
  p.bibliotheque ? 1 : 0,
  ...parametresSources(p),
  ...parametresDomaine(p),
];

export const lireChunk = (db: DatabaseSync, sourceId: string, id: string, p: Perimetre) =>
  db
    .prepare(
      `SELECT c.* FROM chunks c JOIN sources s ON s.id = c.source_id
     WHERE c.source_id = ? AND c.id = ? AND ${CITABLE}`,
    )
    .get(sourceId, id, ...parametresCitable(p)) as ChunkIndexe | undefined;

/** La révision servie d'une source que le périmètre peut citer, sinon `undefined`. */
export const revisionCitable = (db: DatabaseSync, sourceId: string, p: Perimetre) =>
  db
    .prepare(`SELECT s.revision FROM sources s WHERE s.id = ? AND ${CITABLE}`)
    .get(sourceId, ...parametresCitable(p))?.revision as number | undefined;

/** Matières comparées au plus : une colonne de tableau et un des cinq extraits chacune. */
export const MAX_MATIERES = 4;

/**
 * Comparaison : les 20 candidats FTS5 se partagent entre les matières, puis s'entrelacent par rang.
 * Un chunk trouvé dans deux matières garde les deux noms.
 */
function chercherMatieres(db: DatabaseSync, question: string, p: Perimetre) {
  const matieres = db
    .prepare(
      "SELECT id, nom FROM matieres WHERE id IN (SELECT value FROM json_each(?)) ORDER BY nom",
    )
    .all(JSON.stringify(p.matieres)) as { id: string; nom: string }[];
  const parChunk = new Map<string, Candidat>();
  for (const m of matieres) {
    for (const c of chercherFts(
      db,
      question,
      { ...p, matieres: [m.id] },
      Math.floor(20 / matieres.length),
    )) {
      const cle = `${c.source_id}/${c.id}`;
      const deja = parChunk.get(cle);
      if (deja) deja.matieres!.push(m.nom);
      else parChunk.set(cle, { ...c, matieres: [m.nom] });
    }
  }
  return {
    noms: matieres.map((m) => m.nom),
    candidats: [...parChunk.values()].sort((a, b) => a.rang_fts - b.rang_fts),
  };
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
  signal?: AbortSignal,
): Promise<Recherche> {
  const comparaison = (p.matieres?.length ?? 0) > 1 ? chercherMatieres(db, question, p) : undefined;
  const candidats = comparaison?.candidats ?? chercherFts(db, question, p);
  if (!candidats.length) return { candidats, retenus: [], score: 0, horsCorpus: true };
  let ordre: { index: number; score: number }[];
  let panneReclasseur: string | undefined;
  try {
    ordre = await modeles.reclasser(
      question,
      candidats.map((c) => c.rappel),
      signal,
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
  const recherche = {
    candidats: classes,
    retenus: classes.slice(0, 5),
    score,
    // Le seuil est une probabilité du reclasseur: il ne dit rien des rangs FTS5. Sans lui, le
    // refus du générateur et le juge décident.
    horsCorpus: !classes.length || (!panneReclasseur && score < seuil),
    panneReclasseur,
  };
  if (!comparaison) return recherche;
  // Seuls les extraits au-dessus du seuil servent. Le meilleur de chaque matière a sa place, les
  // meilleurs restants complètent les cinq. Une matière sans extrait est signalée, pas complétée.
  const admis = classes.filter((c) => panneReclasseur || c.score! >= seuil);
  const garantis = new Set(
    comparaison.noms.flatMap((m) => admis.find((c) => c.matieres!.includes(m)) ?? []),
  );
  const libres = admis.filter((c) => !garantis.has(c)).slice(0, Math.max(0, 5 - garantis.size));
  return {
    ...recherche,
    retenus: admis.filter((c) => garantis.has(c) || libres.includes(c)),
    sansPassage: comparaison.noms.filter((m) => !admis.some((c) => c.matieres!.includes(m))),
  };
}

/** Part du meilleur score que garde un document de la recherche élève. Voir `eval recherche --ratios`. */
export const RATIO_AFFICHAGE = 0.25;

/**
 * Documents de la recherche élève: un passage par source, du meilleur score au pire, ceux qui
 * atteignent `ratio` fois le meilleur score et au moins `seuil`. Sans reclasseur, l'ordre de FTS5.
 */
export function documentsProches(r: Recherche, seuil: number, ratio = RATIO_AFFICHAGE) {
  const gardes = r.panneReclasseur
    ? r.candidats
    : r.candidats
        .filter((c) => c.score! >= Math.max(seuil, r.score * ratio))
        .sort((a, b) => b.score! - a.score!);
  const vues = new Set<string>();
  return gardes.filter((c) => !vues.has(c.source_id) && vues.add(c.source_id)).slice(0, 12);
}
