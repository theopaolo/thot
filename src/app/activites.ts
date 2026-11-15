import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ancrer,
  type Champ,
  champs,
  champsQuestion,
  citationsDe,
  type Contenu,
  CRITERES,
  type Explication,
  genererQuestion,
  genererSerie,
  jugerChamps,
  MAX_QUESTIONS,
  type Question,
  sourcesMontrees,
  transformer,
  TYPES_QUESTION,
  typesDeSerie,
} from "../core/activite.ts";
import type { Modeles } from "../core/modeles.ts";
import { erreursQuestion, finie, juste, valeur } from "../core/questions.ts";
import {
  type ChunkIndexe,
  chercherFts,
  type Perimetre,
  revisionCitable,
  transaction,
} from "../core/recherche.ts";
import { demander } from "../core/reponse.ts";
import { sansAccents } from "../core/texte.ts";
import { type Compte, lecteur, lireCompte } from "./comptes.ts";
import { config } from "./config.ts";
import { type Db, maintenant } from "./db.ts";
import { catalogueDe } from "./domaines.ts";
import { lireInstance } from "./instance.ts";

export type Activite = {
  id: string;
  /** Le cours où l'activité est née, celui de son objectif. `coursDe` liste tous ses cours. */
  cours_id: string;
  objectif_id: string;
  auteur_id: string;
  /** `cours` : les élèves de ses cours. `prive` : son auteur seul, en mode personnel. */
  audience: "cours" | "prive";
  etat: "brouillon" | "relue" | "publiee" | "a_revoir";
  /** Une explication se lit, sans tentative ni corrigé. */
  type: "exercice" | "explication";
  revision: number;
  /** JSON de `Contenu` pour un exercice, d'`Explication` pour une explication */
  contenu: string;
  /** JSON des motifs des champs rejetés à la génération */
  rejets: string;
  /** Le titre de l'activité, l'intitulé de son objectif s'il est vide. */
  titre: string;
  /** Archivée, elle n'est plus servie aux élèves. Ses tentatives restent lisibles. */
  archivee_le: string | null;
  /** Une date affichée à l'élève, qui ne bloque rien. */
  a_rendre_le: string | null;
  maj_le: string;
  intitule: string;
  reference: string;
  cours: string;
  auteur: string;
};

/**
 * Un exercice privé ne s'ouvre qu'à son auteur. Celui d'un cours s'ouvre aux membres de ses cours
 * et aux administrateurs : ses enseignants le préparent, ses élèves le pratiquent une fois publié.
 */
const ACCES = `CASE a.audience WHEN 'prive' THEN a.auteur_id = ? ELSE (? OR EXISTS (
  SELECT 1 FROM activite_cours ac JOIN membres_cours m ON m.cours_id = ac.cours_id
  WHERE ac.activite_id = a.id AND m.compte_id = ?)) END`;
const acces = (c: Compte) => [c.id, c.administrateur, c.id];
const SELECT = `SELECT a.id, a.cours_id, a.objectif_id, a.auteur_id, a.audience, a.etat, a.type,
  a.revision, a.contenu, a.rejets, a.modele, a.archivee_le, a.a_rendre_le, a.cree_le, a.maj_le,
  coalesce(nullif(a.titre, ''), o.intitule) AS titre, o.intitule, o.reference, co.nom AS cours,
  au.nom AS auteur
  FROM activites a JOIN objectifs o ON o.id = a.objectif_id JOIN cours co ON co.id = a.cours_id
  JOIN comptes au ON au.id = a.auteur_id`;

/**
 * Une tentative `t` qu'un enseignant lit : celles de l'auteur d'une activité privée, ou celles des
 * élèves qui partagent avec lui un cours de l'activité. Paramètres : l'enseignant, deux fois.
 */
const LUE = `(CASE a.audience WHEN 'prive' THEN a.auteur_id = ? ELSE EXISTS (
  SELECT 1 FROM activite_cours ac
  JOIN membres_cours mp ON mp.cours_id = ac.cours_id AND mp.compte_id = ?
  JOIN membres_cours me ON me.cours_id = ac.cours_id AND me.compte_id = t.compte_id
  WHERE ac.activite_id = a.id) END)`;

type Cible = Pick<Activite, "cours_id" | "audience" | "auteur_id"> & { id?: string };

/** Les cours d'une activité, par nom. */
export const coursDe = (db: Db, id: string) =>
  db
    .prepare(
      `SELECT co.id, co.nom FROM activite_cours ac JOIN cours co ON co.id = ac.cours_id
       WHERE ac.activite_id = ? ORDER BY co.nom`,
    )
    .all(id) as { id: string; nom: string }[];

const coursIds = (db: Db, a: Cible) => {
  const ids = a.id ? coursDe(db, a.id).map((c) => c.id) : [];
  return ids.length ? ids : [a.cours_id];
};

/**
 * Le lecteur des preuves dans un cours : ses élèves (le système, restreint au cours), ou l'auteur
 * d'un exercice privé. Une source citée doit être certifiée, rattachée au cours, lisible par ce
 * lecteur et servir à Thot pour répondre.
 */
export const perimetre = (db: Db, a: Cible, coursId = a.cours_id): Perimetre => ({
  schoolId: lireInstance(db).school_id,
  coursId,
  lecteur: a.audience === "prive" ? lecteur(lireCompte(db, a.auteur_id)!) : null,
});

const lireContenu = (contenu: string) => JSON.parse(contenu) as Contenu | Explication;
const citations = (contenu: string) => citationsDe(lireContenu(contenu));
const montrees = (contenu: string) => {
  const c = lireContenu(contenu);
  return "affirmations" in c ? [] : sourcesMontrees(c);
};

/** La révision que sert aujourd'hui chaque source citée dans le cours, `undefined` si elle n'est plus citable. */
export function servies(db: Db, a: Cible & Pick<Activite, "contenu">, coursId = a.cours_id) {
  const p = perimetre(db, a, coursId);
  const ids = new Set([...citations(a.contenu).map((c) => c.source_id), ...montrees(a.contenu)]);
  return new Map([...ids].map((id) => [id, revisionCitable(db, id, p)]));
}

/**
 * Les titres des sources qui ne tiennent plus dans le cours : une citation qui vise une autre
 * révision que celle servie, ou une source montrée qui n'est plus citable.
 */
export function bloquantes(db: Db, a: Cible & Pick<Activite, "contenu">, coursId: string) {
  const s = servies(db, a, coursId);
  const titre = db.prepare("SELECT titre FROM sources WHERE id = ?");
  const ids = new Set([
    ...citations(a.contenu)
      .filter((c) => s.get(c.source_id) !== c.revision)
      .map((c) => c.source_id),
    ...montrees(a.contenu).filter((id) => s.get(id) === undefined),
  ]);
  return [...ids].map((id) => String(titre.get(id)?.titre ?? "source supprimée"));
}

/** Vrai si les preuves tiennent dans le cours, ou dans chacun des cours de l'activité. */
export const preuvesValides = (db: Db, a: Cible & Pick<Activite, "contenu">, coursId?: string) =>
  (coursId ? [coursId] : coursIds(db, a)).every((id) => !bloquantes(db, a, id).length);

const historique = (
  db: Db,
  id: string,
  revision: number,
  action: string,
  compteId: string | null,
) =>
  db
    .prepare("INSERT INTO relectures VALUES (?, ?, ?, ?, ?)")
    .run(id, revision, action, compteId, maintenant());

export const relectures = (db: Db, id: string) =>
  db
    .prepare(
      `SELECT r.revision, r.action, r.le, r.compte_id, c.nom FROM relectures r
       LEFT JOIN comptes c ON c.id = r.compte_id WHERE r.activite_id = ? ORDER BY r.rowid`,
    )
    .all(id) as {
    revision: number;
    action: string;
    le: string;
    compte_id: string | null;
    nom: string | null;
  }[];

/** Qui a relu la version actuelle. */
export const relecteur = (db: Db, a: Activite) =>
  relectures(db, a.id).findLast((r) => r.action === "relue" && r.revision === a.revision)?.nom ??
  undefined;

export type ActiviteListee = Activite & {
  /** les noms de ses cours, séparés par une virgule */
  les_cours: string;
  /** nombre de questions d'un exercice, `null` pour une explication */
  questions: number | null;
  /** tentatives remises que l'enseignant lit */
  remises: number;
};

export type FiltreActivites = {
  coursId?: string;
  /** vide : les activités non archivées. `archivee`, ou un état. */
  etat?: string;
};

/** Les activités que l'enseignant prépare : celles de ses cours et les siennes, les plus récentes d'abord. */
export const activitesProf = (db: Db, c: Compte, f: FiltreActivites = {}) =>
  db
    .prepare(
      `SELECT x.*, json_array_length(x.contenu, '$.questions') AS questions,
       (SELECT group_concat(y.nom, ', ') FROM activite_cours z JOIN cours y ON y.id = z.cours_id
        WHERE z.activite_id = x.id) AS les_cours,
       (SELECT count(*) FROM tentatives t JOIN activites a ON a.id = t.activite_id
        WHERE t.activite_id = x.id AND t.rendue_le IS NOT NULL AND ${LUE}) AS remises
       FROM (${SELECT} WHERE ${ACCES}
         AND (? = '' OR EXISTS (SELECT 1 FROM activite_cours w WHERE w.activite_id = a.id AND w.cours_id = ?))
         AND CASE ? WHEN '' THEN a.archivee_le IS NULL WHEN 'archivee' THEN a.archivee_le IS NOT NULL
           ELSE a.archivee_le IS NULL AND a.etat = ? END) x
       ORDER BY x.maj_le DESC`,
    )
    .all(
      c.id,
      c.id,
      ...acces(c),
      f.coursId ?? "",
      f.coursId ?? "",
      f.etat ?? "",
      f.etat ?? "",
    ) as ActiviteListee[];

export const activiteProf = (db: Db, c: Compte, id: string) =>
  db.prepare(`${SELECT} WHERE a.id = ? AND ${ACCES}`).get(id, ...acces(c)) as Activite | undefined;

/**
 * Le cours où l'élève reçoit l'activité : un cours de l'activité dont il est membre, où ses preuves
 * tiennent. L'auteur d'une activité privée la reçoit dans son cours d'origine. Un administrateur
 * hors des cours la reçoit dans le premier où elle tient.
 */
function coursServi(db: Db, c: Compte, a: Activite, coursId = "", matiereId = "") {
  const candidats = (
    a.audience === "prive"
      ? db.prepare("SELECT id, nom, matiere_id FROM cours WHERE id = ?").all(a.cours_id)
      : db
          .prepare(
            `SELECT co.id, co.nom, co.matiere_id FROM activite_cours ac JOIN cours co ON co.id = ac.cours_id
             WHERE ac.activite_id = ? AND (? OR EXISTS (SELECT 1 FROM membres_cours m
               WHERE m.cours_id = co.id AND m.compte_id = ?)) ORDER BY co.nom`,
          )
          .all(a.id, c.administrateur, c.id)
  ) as { id: string; nom: string; matiere_id: string }[];
  return candidats.find(
    (x) =>
      (!coursId || x.id === coursId) &&
      (!matiereId || x.matiere_id === matiereId) &&
      preuvesValides(db, a, x.id),
  );
}

const SERVIE = `${SELECT} WHERE a.etat = 'publiee' AND a.archivee_le IS NULL AND ${ACCES}`;

/**
 * Les activités publiées que le compte pratique, tant que leurs preuves tiennent dans un de ses
 * cours. `cours_id` et `cours` nomment ce cours, pas le cours d'origine.
 */
export const activitesEleve = (db: Db, c: Compte, coursId = "", matiereId = "") =>
  (db.prepare(`${SERVIE} ORDER BY titre`).all(...acces(c)) as Activite[]).flatMap((a) => {
    const s = coursServi(db, c, a, coursId, matiereId);
    return s ? [{ ...a, cours_id: s.id, cours: s.nom }] : [];
  });

export const activiteEleve = (db: Db, c: Compte, id: string) => {
  const a = db.prepare(`${SERVIE} AND a.id = ?`).get(...acces(c), id) as Activite | undefined;
  const s = a && coursServi(db, c, a);
  return a && s ? { ...a, cours_id: s.id, cours: s.nom } : undefined;
};

export const objectifs = (db: Db, coursId: string) =>
  db
    .prepare("SELECT id, intitule, reference FROM objectifs WHERE cours_id = ? ORDER BY intitule")
    .all(coursId) as { id: string; intitule: string; reference: string }[];

const cle = (s: string) => sansAccents(s.toLowerCase()).replace(/\s+/g, " ").trim();

/** L'objectif du cours de même intitulé, sans compter la casse, les accents ni les espaces. */
export const objectifNomme = (db: Db, coursId: string, intitule: string) =>
  objectifs(db, coursId).find((o) => cle(o.intitule) === cle(intitule));

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

export const texte = (v: unknown, nom: string, max: number, requis = true) => {
  const t = String(v ?? "").trim();
  if ((requis && !t) || t.length > max) {
    throw new Error(`${nom} : ${requis ? "1" : "0"} à ${max} caractères.`);
  }
  return t;
};

export type Insertion = {
  type: Activite["type"];
  coursId: string;
  /** vide : un objectif retrouvé par son intitulé, ou créé avec l'activité */
  objectifId: string;
  intitule: string;
  reference: string;
  titre?: string;
  contenu: Contenu | Explication;
  rejets?: string[];
  modele?: string;
};

/** Le cours d'une nouvelle activité, s'il fait partie de ceux du compte. */
const cibleDe = (db: Db, compte: Compte, coursId: string): Cible => {
  if (!catalogueDe(db, compte).cours.some((c) => c.id === coursId)) {
    throw new Error("Choisissez un de vos cours.");
  }
  return {
    cours_id: coursId,
    audience: lireInstance(db).mode === "personal" ? "prive" : "cours",
    auteur_id: compte.id,
  };
};

/** L'intitulé de l'objectif choisi, ou celui d'un nouvel objectif. Une saisie invalide lève une erreur. */
function objectifChoisi(db: Db, coursId: string, objectifId: string, intitule: string) {
  if (!objectifId) return texte(intitule, "Objectif", 300);
  const o = db
    .prepare("SELECT intitule FROM objectifs WHERE id = ? AND cours_id = ?")
    .get(objectifId, coursId) as { intitule: string } | undefined;
  if (!o) throw new Error("Objectif inconnu dans ce cours.");
  return o.intitule;
}

/**
 * Enregistre une nouvelle activité en brouillon, dans le cours choisi. Un nouvel objectif reprend
 * celui du cours de même intitulé, ou naît avec l'activité. Rend son identifiant.
 */
export function inserer(db: Db, compte: Compte, s: Insertion) {
  const cible = cibleDe(db, compte, s.coursId);
  const intitule = objectifChoisi(db, s.coursId, s.objectifId, s.intitule);
  const id = crypto.randomUUID();
  const t = maintenant();
  const contenu = JSON.stringify(s.contenu);
  transaction(db, () => {
    let objectifId = s.objectifId || objectifNomme(db, s.coursId, intitule)?.id;
    if (!objectifId) {
      objectifId = crypto.randomUUID();
      db.prepare("INSERT INTO objectifs VALUES (?, ?, ?, ?, ?)").run(
        objectifId,
        s.coursId,
        intitule,
        texte(s.reference, "Référence", 300, false),
        t,
      );
    }
    // Une source a pu changer pendant la génération : le brouillon naît alors à revoir.
    db.prepare(
      `INSERT INTO activites (id, cours_id, objectif_id, auteur_id, audience, etat, type, contenu,
       rejets, modele, titre, cree_le, maj_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      s.coursId,
      objectifId,
      compte.id,
      cible.audience,
      preuvesValides(db, { ...cible, contenu }, s.coursId) ? "brouillon" : "a_revoir",
      s.type,
      contenu,
      JSON.stringify(s.rejets ?? []),
      s.modele ?? "",
      texte(s.titre ?? intitule, "Titre", 300),
      t,
      t,
    );
    db.prepare("INSERT INTO activite_cours VALUES (?, ?)").run(id, s.coursId);
  });
  return id;
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

/** Ce que lit le juge : un champ qui garde son texte et ses passages garde son avis. */
const lu = (ch: Champ) =>
  JSON.stringify([ch.texte, ch.citations.map((c) => [c.citation, c.titre, c.revision])]);

/** Ce qui rend une série inutilisable, question par question. */
export function erreursContenu(c: Contenu) {
  const erreurs: string[] = [];
  if (!c.questions.length || c.questions.length > MAX_QUESTIONS) {
    erreurs.push(`Une série a de 1 à ${MAX_QUESTIONS} questions.`);
  }
  if (new Set(c.questions.map((q) => q.id)).size !== c.questions.length) {
    erreurs.push("Deux questions ont le même identifiant.");
  }
  c.questions.forEach((q, i) =>
    erreurs.push(...erreursQuestion(q).map((e) => `Question ${i + 1} : ${e}`)),
  );
  return erreurs;
}

/**
 * Enregistre une nouvelle version d'un exercice, partie de la version `revision`. Le contenu vient
 * de l'enseignant ou du générateur : ses avis de juge ne comptent pas. Un champ dont le texte et
 * les passages n'ont pas changé reprend l'avis de la version précédente, et le juge lit les autres
 * champs cités. La nouvelle version est un brouillon à relire, ou à revoir si une preuve ne tient
 * plus dans un des cours.
 */
export async function enregistrer(
  db: Db,
  modeles: Modeles,
  compte: Compte,
  a: Activite,
  revision: number,
  neuf: Contenu,
): Promise<"conflit" | "inchange" | "modifie"> {
  if (a.type === "explication") {
    throw new Error("Une explication ne se modifie pas. Préparez-en une autre.");
  }
  if (revision !== a.revision) return "conflit";
  const erreurs = erreursContenu(neuf);
  if (erreurs.length) throw new Error(erreurs.join(" "));
  const avis = new Map(
    champs(JSON.parse(a.contenu) as Contenu)
      .filter((ch) => "soutien" in ch)
      .map((ch) => [lu(ch), ch.soutien]),
  );
  for (const ch of champs(neuf)) {
    if (avis.has(lu(ch))) ch.soutien = avis.get(lu(ch));
    else delete ch.soutien;
  }
  if (JSON.stringify(neuf) === a.contenu)
    return revalider(db, a, compte.id) ? "modifie" : "inchange";
  await jugerChamps(modeles, champs(neuf));
  const contenu = JSON.stringify(neuf);
  return transaction(db, () => {
    const etat = preuvesValides(db, { ...a, contenu }) ? "brouillon" : "a_revoir";
    const r = db
      .prepare(
        `UPDATE activites SET contenu = ?, revision = revision + 1, etat = ?, maj_le = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(contenu, etat, maintenant(), a.id, a.revision);
    if (!r.changes) return "conflit";
    historique(db, a.id, a.revision + 1, "modifiee", compte.id);
    return "modifie";
  });
}

/** Le titre et la date à rendre ne changent pas la version : ils ne demandent pas de relecture. */
export function regler(db: Db, a: Activite, titre: string, aRendreLe: string) {
  const t = texte(titre, "Titre", 300);
  const date = String(aRendreLe ?? "").trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Date à rendre : AAAA-MM-JJ.");
  db.prepare("UPDATE activites SET titre = ?, a_rendre_le = ?, maj_le = ? WHERE id = ?").run(
    t,
    date || null,
    maintenant(),
    a.id,
  );
}

/** Rattache l'activité à un autre objectif de son cours d'origine. */
export function changerObjectif(db: Db, a: Activite, objectifId: string) {
  const r = db
    .prepare(
      `UPDATE activites SET objectif_id = ?, maj_le = ? WHERE id = ?
       AND EXISTS (SELECT 1 FROM objectifs WHERE id = ? AND cours_id = ?)`,
    )
    .run(objectifId, maintenant(), a.id, objectifId, a.cours_id);
  if (!r.changes) throw new Error("Objectif inconnu dans ce cours.");
}

/** Un objectif d'un cours du compte, ou une erreur. */
const objectifDu = (db: Db, compte: Compte, id: string) => {
  const o = db.prepare("SELECT id, cours_id, intitule FROM objectifs WHERE id = ?").get(id) as
    | { id: string; cours_id: string; intitule: string }
    | undefined;
  if (!o || !catalogueDe(db, compte).cours.some((c) => c.id === o.cours_id)) {
    throw new Error("Objectif inconnu dans vos cours.");
  }
  return o;
};

export function renommerObjectif(db: Db, compte: Compte, id: string, intitule: string) {
  const o = objectifDu(db, compte, id);
  const t = texte(intitule, "Objectif", 300);
  const autre = objectifNomme(db, o.cours_id, t);
  if (autre && autre.id !== id) {
    throw new Error(
      `« ${autre.intitule} » existe déjà dans ce cours : fusionnez les deux objectifs.`,
    );
  }
  db.prepare("UPDATE objectifs SET intitule = ? WHERE id = ?").run(t, id);
}

/** Les activités de l'objectif `de` passent à l'objectif `vers` du même cours, puis `de` disparaît. */
export function fusionnerObjectifs(db: Db, compte: Compte, de: string, vers: string) {
  const a = objectifDu(db, compte, de);
  const b = objectifDu(db, compte, vers);
  if (a.id === b.id || a.cours_id !== b.cours_id) {
    throw new Error("Choisissez un autre objectif du même cours.");
  }
  transaction(db, () => {
    db.prepare("UPDATE activites SET objectif_id = ? WHERE objectif_id = ?").run(b.id, a.id);
    db.prepare("DELETE FROM objectifs WHERE id = ?").run(a.id);
  });
}

/**
 * Ajoute un cours à l'activité. Rend les titres des sources qui n'y tiennent pas, sans rien
 * ajouter, ou une liste vide.
 */
export function ajouterCours(db: Db, compte: Compte, a: Activite, coursId: string) {
  if (!catalogueDe(db, compte).cours.some((c) => c.id === coursId)) {
    throw new Error("Choisissez un de vos cours.");
  }
  const manque = bloquantes(db, a, coursId);
  if (!manque.length) {
    db.prepare("INSERT OR IGNORE INTO activite_cours VALUES (?, ?)").run(a.id, coursId);
  }
  return manque;
}

/** Retire un cours de l'activité. Le cours d'origine porte l'objectif et reste. */
export function retirerCours(db: Db, compte: Compte, a: Activite, coursId: string) {
  if (coursId === a.cours_id) {
    throw new Error("Le cours d'origine porte l'objectif de l'activité : il reste.");
  }
  db.prepare("DELETE FROM activite_cours WHERE activite_id = ? AND cours_id = ?").run(
    a.id,
    coursId,
  );
  revalider(db, a, compte.id);
}

/**
 * Une activité à revoir dont les preuves tiennent de nouveau, parce qu'un cours fautif est retiré
 * ou que ses passages se retrouvent sans changement, redevient un brouillon à relire.
 */
function revalider(db: Db, a: Activite, compteId: string) {
  if (a.etat !== "a_revoir" || !preuvesValides(db, a)) return false;
  db.prepare("UPDATE activites SET etat = 'brouillon', maj_le = ? WHERE id = ?").run(
    maintenant(),
    a.id,
  );
  historique(db, a.id, a.revision, "modifiee", compteId);
  return true;
}

/** Supprime un brouillon jamais publié, sans tentative. Rend faux s'il ne s'en est pas supprimé. */
export async function supprimerBrouillon(db: Db, a: Activite) {
  const supprime = transaction(db, () => {
    const publiee = db
      .prepare(
        `SELECT 1 FROM relectures WHERE activite_id = ? AND action = 'publiee'
         UNION SELECT 1 FROM tentatives WHERE activite_id = ?`,
      )
      .get(a.id, a.id);
    if (publiee) return false;
    db.prepare("DELETE FROM relectures WHERE activite_id = ?").run(a.id);
    db.prepare("DELETE FROM activites WHERE id = ?").run(a.id);
    return true;
  });
  if (supprime) await rm(dossierActivite(a.id), { recursive: true, force: true });
  return supprime;
}

/** Archivée, une activité n'est plus servie. Désarchivée, elle reprend son état. */
export const archiver = (db: Db, a: Activite, oui: boolean) =>
  db
    .prepare("UPDATE activites SET archivee_le = ?, maj_le = ? WHERE id = ?")
    .run(oui ? maintenant() : null, maintenant(), a.id);

/** Relit la version affichée d'un brouillon. Une autre version ne se relit pas à sa place. */
export const relire = (db: Db, compte: Compte, a: Activite, revision: number) =>
  transaction(db, () => {
    const r = db
      .prepare(
        "UPDATE activites SET etat = 'relue', maj_le = ? WHERE id = ? AND revision = ? AND etat = 'brouillon'",
      )
      .run(maintenant(), a.id, revision);
    if (r.changes) historique(db, a.id, revision, "relue", compte.id);
    return r.changes > 0;
  });

const signaler = (db: Db, a: Pick<Activite, "id" | "revision">) => {
  db.prepare("UPDATE activites SET etat = 'a_revoir', maj_le = ? WHERE id = ?").run(
    maintenant(),
    a.id,
  );
  historique(db, a.id, a.revision, "a_revoir", null);
};

/**
 * Publie la version relue. Une preuve qui ne tient plus dans un des cours fait signaler l'exercice
 * à revoir.
 */
export const publier = (db: Db, compte: Compte, id: string, revision: number) =>
  transaction(db, () => {
    // Relue dans la transaction : une modification arrivée entre-temps n'est pas publiée.
    const a = db.prepare("SELECT * FROM activites WHERE id = ?").get(id) as Activite;
    if (a.etat !== "relue" || a.revision !== revision) return "refus";
    if (!preuvesValides(db, a)) {
      signaler(db, a);
      return "preuves";
    }
    db.prepare("UPDATE activites SET etat = 'publiee', maj_le = ? WHERE id = ?").run(
      maintenant(),
      a.id,
    );
    historique(db, a.id, revision, "publiee", compte.id);
    return "publiee";
  });

/**
 * Signale à revoir les activités qui citent ou montrent la source et dont une preuve ne tient plus
 * dans un de leurs cours : nouvelle révision servie, rejet, lecteurs ou cours retirés. Les
 * changements d'une source dans `ingestion.ts` l'appellent. La page de l'élève revérifie aussi à
 * chaque affichage.
 */
export function revoirActivites(db: Db, sourceId: string) {
  const liste = db
    .prepare("SELECT * FROM activites WHERE etat != 'a_revoir' AND instr(contenu, ?)")
    .all(sourceId) as Activite[];
  for (const a of liste) if (!preuvesValides(db, a)) signaler(db, a);
}

/**
 * Retire des activités ce qui vient d'une source supprimée : ses passages, et le texte des champs
 * qui les citaient, rédigé d'après elle. Une question perd aussi une image prise dans la source et
 * le lien pour y chercher. Une explication perd les phrases qui la citaient et ses blocs, dont les
 * titres ont pu la nommer. L'activité est à revoir. Les tentatives des élèves gardent leur réponse
 * et la version à laquelle elles répondaient.
 */
export function oublierSource(db: Db, sourceId: string) {
  const liste = db
    .prepare("SELECT id, revision, etat, contenu FROM activites WHERE instr(contenu, ?)")
    .all(sourceId) as Pick<Activite, "id" | "revision" | "etat" | "contenu">[];
  const sans = (ch: Champ): Champ =>
    ch.citations.some((c) => c.source_id === sourceId)
      ? { texte: "", citations: ch.citations.filter((c) => c.source_id !== sourceId) }
      : ch;
  const sansMontree = (q: Question): Question => {
    const r = transformer(q, sans);
    if (r.image?.source === sourceId) delete r.image;
    if (r.ou === sourceId) delete r.ou;
    return r;
  };
  for (const a of liste) {
    const c = lireContenu(a.contenu);
    const contenu: Contenu | Explication =
      "affirmations" in c
        ? { affirmations: c.affirmations.filter((x) => x.source_id !== sourceId) }
        : { ...c, questions: c.questions.map(sansMontree) };
    db.prepare("UPDATE activites SET contenu = ? WHERE id = ?").run(JSON.stringify(contenu), a.id);
    if (a.etat !== "a_revoir") signaler(db, a);
  }
}

// Images déposées avec une activité. Elles vivent hors de `content/`, qui range les sources.

export const dossierActivite = (id: string) => join(config.donnees, "activites", id);
const FICHIER = /^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/;
const MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
export const MAX_IMAGE = 5 * 1024 * 1024;

/** L'extension que disent les premiers octets d'une image PNG, JPEG, WebP ou GIF. */
function format(o: Uint8Array) {
  const debut = (s: string, depuis = 0) => {
    for (let i = 0; i < s.length; i++) if (o[depuis + i] !== s.charCodeAt(i)) return false;
    return true;
  };
  if (o[0] === 0x89 && debut("PNG", 1)) return "png";
  if (o[0] === 0xff && o[1] === 0xd8 && o[2] === 0xff) return "jpg";
  if (debut("GIF8")) return "gif";
  if (debut("RIFF") && debut("WEBP", 8)) return "webp";
}

/**
 * Range une image déposée par l'enseignant avec l'activité. Le format vient de ses octets, pas du
 * nom ni du type annoncés par le navigateur. Rend le nom du fichier.
 */
export async function deposerImage(id: string, octets: Uint8Array) {
  const ext = format(octets);
  if (!ext) throw new Error("Image : PNG, JPEG, WebP ou GIF.");
  if (octets.length > MAX_IMAGE) throw new Error("Image : 5 Mo au plus.");
  const nom = `${crypto.randomUUID()}.${ext}`;
  await mkdir(dossierActivite(id), { recursive: true, mode: 0o700 });
  await writeFile(join(dossierActivite(id), nom), octets);
  return nom;
}

/** Une image déposée, si son nom est l'un des nôtres et qu'elle existe. */
export async function lireImage(id: string, fichier: string) {
  if (!FICHIER.test(fichier)) return undefined;
  try {
    const octets = await readFile(join(dossierActivite(id), fichier));
    return { octets, mime: MIMES[fichier.split(".").pop()!] };
  } catch {
    return undefined;
  }
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

/** La dernière tentative du compte sur la version actuelle : elle seule ouvre le corrigé. */
export const tentative = (db: Db, c: Compte, a: Activite) => {
  const l = db
    .prepare(
      `SELECT ${COLONNES} FROM tentatives t
       WHERE t.activite_id = ? AND t.compte_id = ? AND t.revision = ? ORDER BY t.rowid DESC LIMIT 1`,
    )
    .get(a.id, c.id, a.revision) as LigneTentative | undefined;
  return l && lireTentative(l);
};

/**
 * Vrai si le corrigé de la question peut sortir du serveur : la série remise, ou, quand la
 * correction suit chaque question, cette question finie.
 */
export const corrigee = (c: Contenu, t: Tentative | undefined, questionId: string) =>
  !!t && (c.correction === "serie" ? !!t.rendue_le : !!t.reponses[questionId]?.finie);

const ecrire = (db: Db, t: Pick<Tentative, "id" | "reponses" | "rendue_le">) =>
  db
    .prepare("UPDATE tentatives SET reponses = ?, rendue_le = ? WHERE id = ?")
    .run(JSON.stringify(t.reponses), t.rendue_le, t.id);

/** La tentative en cours du compte, créée vide s'il n'en a pas sur cette version. */
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
 * question remplace la précédente, une saisie vide ou invalide n'en garde aucune. `remettre` finit
 * toutes les questions, répondues ou non, et ouvre le corrigé. Refusé une fois la série remise.
 */
export function enregistrerReponses(
  db: Db,
  c: Compte,
  a: Activite,
  brutes: Record<string, unknown>,
  remettre: boolean,
): "enregistree" | "rendue" | "refus" {
  const contenu = JSON.parse(a.contenu) as Contenu;
  if (contenu.correction !== "serie") return "refus";
  return transaction(db, () => {
    const t = enCours(db, c, a);
    if (t.rendue_le) return "refus";
    for (const q of contenu.questions) {
      const v = valeur(q, brutes[q.id]);
      t.reponses[q.id] = { essais: v === null ? [] : [v], ...(remettre ? { finie: true } : {}) };
    }
    t.rendue_le = remettre ? maintenant() : null;
    ecrire(db, t);
    return remettre ? "rendue" : "enregistree";
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

/** Les critères que l'élève coche sur une réponse rédigée corrigée de sa tentative actuelle. */
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

/** Une tentative rendue et marquée à reprendre laisse l'élève en commencer une autre. */
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
 * Par objectif des cours du compte : ses activités, celles publiées et les tentatives remises
 * qu'il lit.
 */
export const suiviObjectifs = (db: Db, c: Compte) =>
  db
    .prepare(
      `SELECT o.id, o.intitule, o.reference, o.cours_id, co.nom AS cours,
       count(DISTINCT a.id) AS activites,
       count(DISTINCT CASE WHEN a.etat = 'publiee' AND a.archivee_le IS NULL THEN a.id END) AS publiees,
       count(DISTINCT t.id) AS tentatives
       FROM objectifs o JOIN cours co ON co.id = o.cours_id
       LEFT JOIN activites a ON a.objectif_id = o.id
       LEFT JOIN tentatives t ON t.activite_id = a.id AND t.rendue_le IS NOT NULL AND ${LUE}
       WHERE o.cours_id IN (SELECT value FROM json_each(?))
       GROUP BY o.id ORDER BY co.nom, o.intitule`,
    )
    .all(c.id, c.id, JSON.stringify(catalogueDe(db, c).cours.map((x) => x.id))) as {
    id: string;
    intitule: string;
    reference: string;
    cours_id: string;
    cours: string;
    activites: number;
    publiees: number;
    tentatives: number;
  }[];

/**
 * Rédige de nouveau une question de la série (même type, même identifiant) ou en ajoute une du
 * type demandé, d'après l'objectif de l'activité et les sources que la série cite, ou à défaut les
 * premières sources citables du cours. L'ensemble devient une nouvelle version par `enregistrer`.
 * Une demande invalide ou une génération sans question lève une erreur lisible.
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
  else questions[rang] = { ...g.question, id: contenu.questions[rang].id } as Question;
  return enregistrer(db, modeles, compte, a, revision, { ...contenu, questions });
}

// Pratique de l'élève : où il en est de chaque exercice, et les activités d'une ressource.

/** D'après la dernière tentative du compte sur la version actuelle de l'exercice. */
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
           FROM tentatives t JOIN activites a ON a.id = t.activite_id AND a.revision = t.revision
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

/** Vrai si l'activité cite la source, montre une de ses images ou y renvoie pour chercher. */
export const couvre = (a: Pick<Activite, "contenu">, sourceId: string) =>
  citations(a.contenu).some((c) => c.source_id === sourceId) ||
  montrees(a.contenu).includes(sourceId);
