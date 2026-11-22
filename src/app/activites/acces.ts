import {
  citationsDe,
  type Contenu,
  type Explication,
  sourcesMontrees,
} from "../../core/activite.ts";
import { type Perimetre, revisionCitable } from "../../core/recherche.ts";
import { type Compte, lecteur, lireCompte } from "../comptes.ts";
import type { Db } from "../db.ts";
import { libelles } from "../termes.ts";
import { catalogueDe } from "../domaines.ts";
import { lireInstance } from "../instance.ts";

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
 * élèves qui partagent avec lui un cours de l'activité. L'essai d'un collègue du cours n'en fait
 * pas partie. Paramètres : l'enseignant, deux fois.
 */
export const LUE = `(CASE a.audience WHEN 'prive' THEN a.auteur_id = ? ELSE EXISTS (
  SELECT 1 FROM activite_cours ac
  JOIN membres_cours mp ON mp.cours_id = ac.cours_id AND mp.compte_id = ?
  JOIN membres_cours me ON me.cours_id = ac.cours_id AND me.compte_id = t.compte_id
  JOIN comptes ce ON ce.id = me.compte_id AND ce.role = 'eleve'
  WHERE ac.activite_id = a.id) END)`;

export type Cible = Pick<Activite, "cours_id" | "audience" | "auteur_id"> & { id?: string };

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

export const lireContenu = (contenu: string) => JSON.parse(contenu) as Contenu | Explication;
const citations = (contenu: string) => citationsDe(lireContenu(contenu));
const montrees = (contenu: string) => {
  const c = lireContenu(contenu);
  return "affirmations" in c ? [] : sourcesMontrees(c);
};

/** Les images de sources que montrent les questions : leur identifiant et leur source. */
const imagesMontrees = (contenu: string) => {
  const c = lireContenu(contenu);
  return "affirmations" in c
    ? []
    : c.questions.flatMap((q) =>
        q.image?.media ? [{ id: q.image.media, source: q.image.source ?? "" }] : [],
      );
};

/** La révision que sert aujourd'hui chaque source citée dans le cours, `undefined` si elle n'est plus citable. */
export function servies(db: Db, a: Cible & Pick<Activite, "contenu">, coursId = a.cours_id) {
  const p = perimetre(db, a, coursId);
  const ids = new Set([...citations(a.contenu).map((c) => c.source_id), ...montrees(a.contenu)]);
  return new Map([...ids].map((id) => [id, revisionCitable(db, id, p)]));
}

/**
 * Les titres des sources qui ne tiennent plus dans le cours : une citation qui vise une autre
 * révision que celle servie, ou une source montrée qui n'est plus citable. Une source qui tient
 * mais ne sert plus l'image montrée est nommée avec « (image retirée) ».
 */
export function bloquantes(db: Db, a: Cible & Pick<Activite, "contenu">, coursId: string) {
  const s = servies(db, a, coursId);
  const titre = db.prepare("SELECT titre FROM sources WHERE id = ?");
  const nom = (id: string) => String(titre.get(id)?.titre ?? "source supprimée");
  const ids = new Set([
    ...citations(a.contenu)
      .filter((c) => s.get(c.source_id) !== c.revision)
      .map((c) => c.source_id),
    ...montrees(a.contenu).filter((id) => s.get(id) === undefined),
  ]);
  // Le numéro d'une image retirée ne revient pas : une ligne trouvée est l'image choisie.
  const servie = db.prepare("SELECT 1 FROM images WHERE id = ? AND source_id = ?");
  const retirees = imagesMontrees(a.contenu)
    .filter((i) => !ids.has(i.source) && !servie.get(i.id, i.source))
    .map((i) => `${nom(i.source)} (image retirée)`);
  return [...new Set([...[...ids].map(nom), ...retirees])];
}

/** Vrai si les preuves tiennent dans le cours, ou dans chacun des cours de l'activité. */
export const preuvesValides = (db: Db, a: Cible & Pick<Activite, "contenu">, coursId?: string) =>
  (coursId ? [coursId] : coursIds(db, a)).every((id) => !bloquantes(db, a, id).length);

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
  /** les activités d'un cours de cette matière */
  matiereId?: string;
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
         AND (? = '' OR EXISTS (SELECT 1 FROM activite_cours w JOIN cours co ON co.id = w.cours_id
           WHERE w.activite_id = a.id AND co.matiere_id = ?))
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
      f.matiereId ?? "",
      f.matiereId ?? "",
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

/** Le cours d'une nouvelle activité, s'il fait partie de ceux du compte. */
export const cibleDe = (db: Db, compte: Compte, coursId: string): Cible => {
  if (!catalogueDe(db, compte).cours.some((c) => c.id === coursId)) {
    throw new Error(
      `Choisissez ${libelles(db).formes.cours.selon("un", "une")} de vos ${libelles(db).formes.cours.noms}.`,
    );
  }
  return {
    cours_id: coursId,
    audience: lireInstance(db).mode === "personal" ? "prive" : "cours",
    auteur_id: compte.id,
  };
};

/** Vrai si l'activité cite la source, montre une de ses images ou y renvoie pour chercher. */
export const couvre = (a: Pick<Activite, "contenu">, sourceId: string) =>
  citations(a.contenu).some((c) => c.source_id === sourceId) ||
  montrees(a.contenu).includes(sourceId);
