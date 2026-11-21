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
} from "../core/activite.ts";
import type { Modeles } from "../core/modeles.ts";
import { finie, juste, refusee, valeur } from "../core/questions.ts";
import {
  type ChunkIndexe,
  chercherFts,
  type Perimetre,
  revisionCitable,
  transaction,
} from "../core/recherche.ts";
import { demander } from "../core/reponse.ts";
import { texte } from "../core/texte.ts";
import type { Compte } from "./comptes.ts";
import { config } from "./config.ts";
import { type Db, maintenant } from "./db.ts";
import { type Activite, type Cible, cibleDe, LUE, perimetre } from "./activites/acces.ts";
import { objectifChoisi } from "./activites/objectifs.ts";
import { enregistrer, inserer } from "./activites/versions.ts";

export * from "./activites/acces.ts";
export * from "./activites/objectifs.ts";
export * from "./activites/versions.ts";
export * from "./activites/images.ts";

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

// Tentatives : une par passage de l'élève sur une version de l'exercice.

/** Les essais de l'élève à une question, et les critères qu'il coche sur une réponse rédigée. */
export type ReponseQuestion = { essais: string[]; finie?: true; criteres?: number[] };
/** La note et le commentaire de l'enseignant sur une question. */
export type RetourQuestion = { note?: number; commentaire?: string };

export type Tentative = {
  id: string;
  compte_id: string;
  revision: number;
  cree_le: string;
  /** par identifiant de question */
  reponses: Record<string, ReponseQuestion>;
  retours: Record<string, RetourQuestion>;
  /** la série remise, ou toutes ses questions finies : rien ne s'y change plus */
  rendue_le: string | null;
  /** l'enseignant laisse l'élève recommencer */
  a_reprendre: boolean;
};

type LigneTentative = Omit<Tentative, "reponses" | "retours" | "a_reprendre"> & {
  reponses: string;
  retours: string;
  a_reprendre: number;
};
const COLONNES =
  "t.id, t.compte_id, t.revision, t.cree_le, t.reponses, t.retours, t.rendue_le, t.a_reprendre";
const lireTentative = (l: LigneTentative): Tentative => ({
  ...l,
  reponses: JSON.parse(l.reponses),
  retours: JSON.parse(l.retours),
  a_reprendre: l.a_reprendre === 1,
});

/**
 * Une tentative `t` que son auteur retrouve sur l'activité `a` : celle de la version actuelle, ou
 * une tentative remise sur une version précédente. Un brouillon d'une version précédente ne revient
 * pas, parce qu'il répondait à des questions qui ont pu changer.
 */
const RETROUVEE = "(t.revision = a.revision OR t.rendue_le IS NOT NULL)";

/** La dernière tentative que le compte retrouve : elle seule ouvre le corrigé. */
export const tentative = (db: Db, c: Compte, a: Activite) => {
  const l = db
    .prepare(
      `SELECT ${COLONNES} FROM tentatives t JOIN activites a ON a.id = t.activite_id
       WHERE t.activite_id = ? AND t.compte_id = ? AND ${RETROUVEE} ORDER BY t.rowid DESC LIMIT 1`,
    )
    .get(a.id, c.id) as LigneTentative | undefined;
  return l && lireTentative(l);
};

/**
 * Vrai si le corrigé de la question peut sortir du serveur : la tentative a fini cette question,
 * et la série est remise quand le corrigé suit la série. Une question ajoutée ou rédigée de nouveau
 * après la remise n'est finie dans aucune tentative : son corrigé reste sur le serveur.
 */
export const corrigee = (c: Contenu, t: Tentative | undefined, questionId: string) =>
  !!t?.reponses[questionId]?.finie && (c.correction === "question" || !!t.rendue_le);

const ecrire = (db: Db, t: Pick<Tentative, "id" | "reponses" | "rendue_le">) =>
  db
    .prepare("UPDATE tentatives SET reponses = ?, rendue_le = ? WHERE id = ?")
    .run(JSON.stringify(t.reponses), t.rendue_le, t.id);

/** La tentative que le compte retrouve, créée vide sur la version actuelle s'il n'en a pas. */
function enCours(db: Db, c: Compte, a: Activite) {
  const t = tentative(db, c, a);
  if (t) return t;
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO tentatives (id, activite_id, compte_id, revision, cree_le) VALUES (?, ?, ?, ?, ?)",
  ).run(id, a.id, c.id, a.revision, maintenant());
  return tentative(db, c, a)!;
}

/**
 * Enregistre les réponses d'une série corrigée après sa remise : la valeur saisie à chaque
 * question remplace la précédente, et une saisie vide n'en garde aucune. `remettre` finit toutes
 * les questions, répondues ou non, et ouvre le corrigé. Une saisie que `valeur()` refuse laisse la
 * réponse déjà enregistrée et empêche la remise : `refusee`. `refus` une fois la série remise.
 */
export function enregistrerReponses(
  db: Db,
  c: Compte,
  a: Activite,
  brutes: Record<string, unknown>,
  remettre: boolean,
): "enregistree" | "rendue" | "refus" | "refusee" {
  const contenu = JSON.parse(a.contenu) as Contenu;
  if (contenu.correction !== "serie") return "refus";
  const refus = contenu.questions.some((q) => refusee(q, brutes[q.id]));
  const rendre = remettre && !refus;
  return transaction(db, () => {
    const t = enCours(db, c, a);
    if (t.rendue_le) return "refus";
    for (const q of contenu.questions) {
      const v = valeur(q, brutes[q.id]);
      const essais = refusee(q, brutes[q.id])
        ? (t.reponses[q.id]?.essais ?? [])
        : v === null
          ? []
          : [v];
      t.reponses[q.id] = { essais, ...(rendre ? { finie: true } : {}) };
    }
    t.rendue_le = rendre ? maintenant() : null;
    ecrire(db, t);
    return refus ? "refusee" : rendre ? "rendue" : "enregistree";
  });
}

/**
 * Un essai à une question d'une série corrigée question par question. Rend `invalide` pour une
 * saisie qui ne convient pas à la question, `refus` pour une question déjà finie. Toutes les
 * questions finies, la tentative est rendue.
 */
export function essayer(db: Db, c: Compte, a: Activite, questionId: string, brute: unknown) {
  const contenu = JSON.parse(a.contenu) as Contenu;
  const q = contenu.questions.find((x) => x.id === questionId);
  if (contenu.correction !== "question" || !q) return "refus" as const;
  const v = valeur(q, brute);
  if (v === null) return "invalide" as const;
  return transaction(db, () => {
    const t = enCours(db, c, a);
    const r = t.reponses[q.id] ?? { essais: [] };
    if (r.finie || t.rendue_le) return "refus" as const;
    r.essais.push(v);
    if (finie(q, r.essais, "question")) r.finie = true;
    t.reponses[q.id] = r;
    if (contenu.questions.every((x) => t.reponses[x.id]?.finie)) t.rendue_le = maintenant();
    ecrire(db, t);
    return { juste: juste(q, v), finie: !!r.finie };
  });
}

/** Les critères que l'élève coche sur une réponse rédigée corrigée de la tentative qu'il retrouve. */
export function cocher(
  db: Db,
  c: Compte,
  a: Activite,
  tentativeId: string,
  questionId: string,
  coches: number[],
) {
  const contenu = JSON.parse(a.contenu) as Contenu;
  const q = contenu.questions.find((x) => x.id === questionId);
  const t = tentative(db, c, a);
  if (q?.type !== "redigee" || t?.id !== tentativeId || !corrigee(contenu, t, q.id)) return false;
  const n = q.criteres.length;
  const r = t.reponses[q.id] ?? { essais: [], finie: true };
  r.criteres = [...new Set(coches)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < n)
    .sort((x, y) => x - y);
  t.reponses[q.id] = r;
  ecrire(db, t);
  return true;
}

/** Une tentative rendue et marquée à reprendre laisse l'élève en commencer une autre, sur la version actuelle. */
export function recommencer(db: Db, c: Compte, a: Activite) {
  return transaction(db, () => {
    const t = tentative(db, c, a);
    if (!t?.rendue_le || !t.a_reprendre) return false;
    db.prepare(
      "INSERT INTO tentatives (id, activite_id, compte_id, revision, cree_le) VALUES (?, ?, ?, ?, ?)",
    ).run(crypto.randomUUID(), a.id, c.id, a.revision, maintenant());
    return true;
  });
}

/**
 * Qui lit les tentatives d'une activité : un enseignant membre d'un de ses cours, ou l'auteur d'une
 * activité privée. Les routes `/prof` ne servent que les enseignants. Être administrateur ne suffit
 * pas.
 */
const lit = (db: Db, c: Compte, a: Activite) =>
  a.audience === "prive"
    ? a.auteur_id === c.id
    : !!db
        .prepare(
          `SELECT 1 FROM activite_cours ac JOIN membres_cours m ON m.cours_id = ac.cours_id
           WHERE ac.activite_id = ? AND m.compte_id = ?`,
        )
        .get(a.id, c.id);

export type TentativeLue = Tentative & { nom: string };

/**
 * Les tentatives de toutes les versions que l'enseignant lit, des plus récentes aux plus
 * anciennes : celles des élèves de ses cours parmi ceux de l'activité. `undefined` si le compte ne
 * lit pas les tentatives de l'activité.
 */
export const tentativesLues = (db: Db, c: Compte, a: Activite) =>
  lit(db, c, a)
    ? (
        db
          .prepare(
            `SELECT ${COLONNES}, co.nom FROM tentatives t JOIN activites a ON a.id = t.activite_id
             JOIN comptes co ON co.id = t.compte_id WHERE t.activite_id = ? AND ${LUE}
             ORDER BY t.rowid DESC`,
          )
          .all(a.id, c.id, c.id) as (LigneTentative & { nom: string })[]
      ).map((l) => ({ ...lireTentative(l), nom: l.nom }))
    : undefined;

/**
 * Les élèves que l'enseignant suit sur l'activité : ceux de ses cours parmi ceux de l'activité,
 * ou l'auteur d'une activité privée.
 */
export const elevesSuivis = (db: Db, c: Compte, a: Activite) =>
  a.audience === "prive"
    ? a.auteur_id === c.id
      ? [{ id: a.auteur_id, nom: a.auteur }]
      : []
    : (db
        .prepare(
          `SELECT DISTINCT co.id, co.nom FROM activite_cours ac
           JOIN membres_cours mp ON mp.cours_id = ac.cours_id AND mp.compte_id = ?
           JOIN membres_cours me ON me.cours_id = ac.cours_id
           JOIN comptes co ON co.id = me.compte_id AND co.role = 'eleve'
           WHERE ac.activite_id = ? ORDER BY co.nom`,
        )
        .all(c.id, a.id) as { id: string; nom: string }[]);

const tentativeLue = (db: Db, c: Compte, a: Activite, tentativeId: string) =>
  tentativesLues(db, c, a)?.find((t) => t.id === tentativeId);

export const NOTES = [0, 0.5, 1];

/**
 * La note (0, 0,5 ou 1, `null` pour l'enlever) et le commentaire de l'enseignant sur une question
 * d'une tentative qu'il lit. Rend faux si la tentative ou la question n'existe pas pour lui.
 */
export function noter(
  db: Db,
  c: Compte,
  a: Activite,
  tentativeId: string,
  questionId: string,
  note: number | null,
  commentaire: string,
) {
  const t = tentativeLue(db, c, a, tentativeId);
  if (!t?.reponses[questionId] || (note !== null && !NOTES.includes(note))) return false;
  const texteCommentaire = texte(commentaire, "Commentaire", 2000, false);
  const r: RetourQuestion = {
    ...(note === null ? {} : { note }),
    ...(texteCommentaire ? { commentaire: texteCommentaire } : {}),
  };
  if (Object.keys(r).length) t.retours[questionId] = r;
  else delete t.retours[questionId];
  db.prepare("UPDATE tentatives SET retours = ? WHERE id = ?").run(JSON.stringify(t.retours), t.id);
  return true;
}

/** Marque une tentative rendue à reprendre, ou retire la marque. */
export function aReprendre(db: Db, c: Compte, a: Activite, tentativeId: string, oui: boolean) {
  const t = tentativeLue(db, c, a, tentativeId);
  if (!t?.rendue_le) return false;
  db.prepare("UPDATE tentatives SET a_reprendre = ? WHERE id = ?").run(oui ? 1 : 0, t.id);
  return true;
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
  if (a.type === "explication") {
    throw new Error("Une explication ne se modifie pas. Préparez-en une autre.");
  }
  const contenu = JSON.parse(a.contenu) as Contenu;
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

// Pratique de l'élève : où il en est de chaque exercice, et les activités d'une ressource.

/** D'après la dernière tentative que le compte retrouve sur l'exercice. */
export type Avancement = "a_faire" | "en_cours" | "remise" | "retour";

/**
 * Les activités de la liste, chaque exercice avec l'avancement du compte. Une explication n'en a
 * pas. « Retour » : la tentative est rendue et l'enseignant l'a notée ou commentée.
 */
export function avecAvancement<T extends Pick<Activite, "id" | "type">>(
  db: Db,
  c: Compte,
  liste: T[],
): (T & { avancement?: Avancement })[] {
  // Rangées par rowid : la dernière tentative de chaque activité remplace les précédentes.
  const derniere = new Map(
    (
      db
        .prepare(
          `SELECT t.activite_id, t.rendue_le IS NOT NULL AS rendue, t.retours != '{}' AS retour
           FROM tentatives t JOIN activites a ON a.id = t.activite_id AND ${RETROUVEE}
           WHERE t.compte_id = ? AND t.activite_id IN (SELECT value FROM json_each(?))
           ORDER BY t.rowid`,
        )
        .all(c.id, JSON.stringify(liste.map((a) => a.id))) as {
        activite_id: string;
        rendue: number;
        retour: number;
      }[]
    ).map((l) => [l.activite_id, l]),
  );
  return liste.map((a) => {
    if (a.type === "explication") return a;
    const t = derniere.get(a.id);
    const avancement: Avancement = !t
      ? "a_faire"
      : !t.rendue
        ? "en_cours"
        : t.retour
          ? "retour"
          : "remise";
    return { ...a, avancement };
  });
}
