import {
  ancrer,
  champs,
  champsQuestion,
  type Contenu,
  CRITERES,
  type Explication,
  genererQuestion,
  genererSerie,
  MAX_QUESTIONS,
  TYPES_QUESTION,
  typesDeSerie,
} from "../../core/activite.ts";
import type { Modeles } from "../../core/modeles.ts";
import {
  type ChunkIndexe,
  chercherFts,
  type Perimetre,
  revisionCitable,
} from "../../core/recherche.ts";
import { demander } from "../../core/reponse.ts";
import { texte } from "../../core/texte.ts";
import type { Compte } from "../comptes.ts";
import { config } from "../config.ts";
import type { Db } from "../db.ts";
import { type Activite, type Cible, cibleDe, lireContenu, perimetre } from "./acces.ts";
import { objectifChoisi } from "./objectifs.ts";
import { enregistrer, inserer } from "./versions.ts";

export type SourceCitable = {
  id: string;
  titre: string;
  /** le thème de la source dans le cours, `null` directement dans le cours */
  theme: string | null;
  /** l'ordre de lecture que l'enseignant donne, `null` sans ordre */
  ordre: number | null;
};

/**
 * L'ordre du sommaire élève : les sources sans thème en tête, puis par thème, chacune dans l'ordre
 * de lecture puis par titre. La collation française range « Écrire » avec les E.
 */
export const ordreLecture = (a: SourceCitable, b: SourceCitable) =>
  Number(a.theme !== null) - Number(b.theme !== null) ||
  (a.theme ?? "").localeCompare(b.theme ?? "", "fr") ||
  (a.ordre ?? Infinity) - (b.ordre ?? Infinity) ||
  a.titre.localeCompare(b.titre, "fr");

/** Les sources du cours qu'un exercice peut citer, dans l'ordre de lecture. */
export const sourcesCitables = (db: Db, a: Cible) => {
  const p = perimetre(db, a);
  return (
    db
      .prepare(
        `SELECT s.id, s.titre, t.nom AS theme, json_extract(s.metadonnees, '$.ordre') AS ordre
         FROM sources s JOIN source_cours sc ON sc.source_id = s.id
         LEFT JOIN themes t ON t.id = sc.theme_id
         WHERE sc.cours_id = ? AND s.statut = 'certifiee'`,
      )
      .all(a.cours_id) as SourceCitable[]
  )
    .filter((s) => revisionCitable(db, s.id, p) !== undefined)
    .toSorted(ordreLecture);
};

/** Les images des sources citables du cours, qu'une question peut montrer. */
export const imagesCitables = (db: Db, a: Cible) => {
  const ids = sourcesCitables(db, a).map((s) => s.id);
  return db
    .prepare(
      `SELECT i.id, i.source_id, i.legende, s.titre FROM images i JOIN sources s ON s.id = i.source_id
       WHERE i.source_id IN (SELECT value FROM json_each(?)) ORDER BY s.titre, i.position`,
    )
    .all(JSON.stringify(ids)) as {
    id: string;
    source_id: string;
    legende: string | null;
    titre: string;
  }[];
};

const PASSAGES = 8;
export const MAX_SOURCES = 4;
// ponytail: quelques passages par source, choisis par FTS5 sur l'objectif, sinon les premiers. Un
// long document peut cacher le passage utile : passer par `chercher()` et son reclasseur si les
// brouillons en souffrent.
export function passages(db: Db, a: Cible, objectif: string, ids: string[]) {
  const p = perimetre(db, a);
  const k = Math.max(2, Math.floor(PASSAGES / ids.length));
  return ids.flatMap((id) => {
    const trouves = chercherFts(db, objectif, { ...p, sourceId: id }, k);
    return trouves.length
      ? trouves
      : (db
          .prepare("SELECT * FROM chunks WHERE source_id = ? ORDER BY debut LIMIT ?")
          .all(id, k) as ChunkIndexe[]);
  });
}

export type Preparation = {
  type: Activite["type"];
  coursId: string;
  /** vide : un nouvel objectif, `intitule` et `reference` */
  objectifId: string;
  intitule: string;
  reference: string;
  sources: string[];
  /** Pour un exercice : le nombre de questions, de 1 à `MAX_SERIE`. Une seule par défaut. */
  nombre?: number;
  /** Les types tirés dans l'ordre, en boucle. `redigee` par défaut. */
  types?: string[];
  correction?: Contenu["correction"];
};

export const MAX_SERIE = 10;

/** Les types de chaque question d'une série, `redigee` sans choix valable. Un nombre invalide lève une erreur. */
function typesSaisis(nombre: number | undefined, types: string[] | undefined) {
  const n = nombre ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > MAX_SERIE) {
    throw new Error(`Une série compte de 1 à ${MAX_SERIE} questions.`);
  }
  const choisis = TYPES_QUESTION.filter((t) => types?.includes(t));
  return typesDeSerie(n, choisis.length ? choisis : ["redigee"]);
}

/**
 * Rédige le brouillon d'un exercice ou d'une explication sur l'objectif, d'après les sources
 * choisies. Un exercice est une série : un appel de modèle par question. Un nouvel objectif n'est
 * enregistré qu'avec l'activité. Une saisie invalide lève une erreur. Rend l'identifiant de
 * l'activité, ou ce qui a manqué à la génération.
 */
export async function preparer(
  db: Db,
  modeles: Modeles,
  compte: Compte,
  s: Preparation,
): Promise<{ id: string } | { erreur: string; rejets: string[] }> {
  const cible = cibleDe(db, compte, s.coursId);
  const intitule = objectifChoisi(db, s.coursId, s.objectifId, s.intitule);
  texte(s.reference, "Référence", 300, false);
  const types = s.type === "exercice" ? typesSaisis(s.nombre, s.types) : [];
  const citables = new Set(sourcesCitables(db, cible).map((x) => x.id));
  const ids = [...new Set(s.sources)];
  // Le nombre de sources borne les passages, donc la taille de l'appel.
  if (!ids.length || ids.length > MAX_SOURCES || ids.some((id) => !citables.has(id))) {
    throw new Error(`Choisissez de 1 à ${MAX_SOURCES} sources certifiées de ce cours.`);
  }
  let contenu: Contenu | Explication;
  let rejets: string[] = [];
  let modele: string;
  if (s.type === "explication") {
    const g = await expliquer(db, modeles, intitule, { ...perimetre(db, cible), sources: ids });
    if ("erreur" in g) return { erreur: g.erreur, rejets: [] };
    ({ contenu, rejets, modele } = g);
  } else {
    const g = await genererSerie(modeles, intitule, passages(db, cible, intitule, ids), types);
    if (!g.questions.length) {
      return {
        erreur: g.refus
          ? "Thot ne trouve pas dans ces sources de quoi rédiger un exercice sur cet objectif."
          : types.every((t) => t === "redigee")
            ? `Thot n'a pas pu ancrer l'exercice. Il faut une consigne, une réponse attendue, ${CRITERES.min} critères et un retour, chacun cité mot pour mot.`
            : "Thot n'a pas pu ancrer de question. Chaque question veut une consigne et un retour cités mot pour mot, et une bonne option citée pour un choix.",
        rejets: g.rejets,
      };
    }
    contenu = {
      correction: s.correction === "question" ? "question" : "serie",
      questions: g.questions,
    };
    ({ rejets, modele } = g);
  }
  return { id: inserer(db, compte, { ...s, intitule, contenu, rejets, modele }) };
}

/**
 * Une explication est la réponse vérifiée de `demander()` à l'objectif, posé comme une question
 * dans les sources choisies : mêmes citations, même juge, mêmes blocs.
 */
async function expliquer(
  db: Db,
  modeles: Modeles,
  objectif: string,
  p: Perimetre,
): Promise<{ erreur: string } | { contenu: Explication; rejets: string[]; modele: string }> {
  const { resultat, journal } = await demander(db, modeles, objectif, p, config.seuil);
  if (resultat.etat === "out_of_corpus") {
    return { erreur: "Thot ne trouve pas dans ces sources de quoi expliquer cet objectif." };
  }
  if (resultat.etat === "failed") {
    return { erreur: `Thot n'a pas pu rédiger l'explication : ${resultat.message}` };
  }
  const { affirmations, blocs, partielle, juge_indisponible } = resultat;
  const contenu: Explication = { affirmations, blocs, partielle, juge_indisponible };
  return { contenu, rejets: [], modele: String(journal.modele ?? "") };
}

/**
 * Retrouve un passage mot pour mot dans la révision servie d'une source citable du cours
 * d'origine. Lève une erreur nommée d'après `nom` si la source n'est plus citable ou si le passage
 * n'y est pas.
 */
export function ancrerPassage(db: Db, a: Cible, sourceId: string, passage: string, nom: string) {
  const titre = String(
    db.prepare("SELECT titre FROM sources WHERE id = ?").get(sourceId)?.titre ?? "",
  );
  if (revisionCitable(db, sourceId, perimetre(db, a)) === undefined) {
    throw new Error(
      `${nom} : « ${titre || "cette source"} » n'est pas une source citable de ce cours.`,
    );
  }
  const chunks = db
    .prepare("SELECT * FROM chunks WHERE source_id = ? ORDER BY debut")
    .all(sourceId) as ChunkIndexe[];
  const trouvee = ancrer(passage, chunks);
  if (!trouvee) throw new Error(`${nom} : passage introuvable mot pour mot dans « ${titre} ».`);
  return trouvee;
}

/**
 * Rédige de nouveau une question de la série, du même type, ou en ajoute une du type demandé,
 * d'après l'objectif de l'activité et les sources que la série cite, ou à défaut les premières
 * sources citables du cours. Une question rédigée de nouveau prend un nouvel identifiant : les
 * réponses données à l'ancienne ne se comptent pas contre elle. L'ensemble devient une nouvelle
 * version par `enregistrer`. Une demande invalide ou une génération sans question lève une erreur
 * lisible.
 */
export async function regenerer(
  db: Db,
  modeles: Modeles,
  compte: Compte,
  a: Activite,
  revision: number,
  cible: { question: string } | { type: string },
) {
  const contenu = lireContenu(a.contenu);
  if (a.type === "explication" || !("questions" in contenu)) {
    throw new Error("Une explication ne se modifie pas. Préparez-en une autre.");
  }
  const rang =
    "question" in cible ? contenu.questions.findIndex((q) => q.id === cible.question) : -1;
  if ("question" in cible && rang < 0) throw new Error("Question inconnue dans cette activité.");
  const type =
    "question" in cible
      ? contenu.questions[rang].type
      : TYPES_QUESTION.find((t) => t === cible.type);
  if (!type) throw new Error("Type de question inconnu.");
  if (!("question" in cible) && contenu.questions.length >= MAX_QUESTIONS) {
    throw new Error(`Une série a de 1 à ${MAX_QUESTIONS} questions.`);
  }
  const citables = sourcesCitables(db, a).map((s) => s.id);
  const citees = new Set(
    ("question" in cible ? champsQuestion(contenu.questions[rang]) : champs(contenu)).flatMap(
      (ch) => ch.citations.map((c) => c.source_id),
    ),
  );
  const utiles = citables.filter((id) => citees.has(id));
  const ids = (utiles.length ? utiles : citables).slice(0, MAX_SOURCES);
  if (!ids.length) throw new Error("Aucune source certifiée de ce cours ne sert à Thot.");
  const n = rang < 0 ? contenu.questions.length + 1 : rang + 1;
  const g = await genererQuestion(modeles, type, a.intitule, passages(db, a, a.intitule, ids), {
    n,
    total: Math.max(n, contenu.questions.length),
    eviter: contenu.questions.map((q) => q.consigne.texte),
  });
  if (!g.question) {
    throw new Error(
      g.refus
        ? "Thot ne trouve pas dans ces sources de quoi rédiger cette question."
        : `Thot n'a pas pu ancrer la question. ${g.rejets.join(" ")}`,
    );
  }
  const questions = [...contenu.questions];
  if (rang < 0) questions.push(g.question);
  else questions[rang] = g.question;
  return enregistrer(db, modeles, compte, a, revision, { ...contenu, questions });
}
