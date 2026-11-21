import type { Contenu } from "../../core/activite.ts";
import { finie, juste, refusee, valeur } from "../../core/questions.ts";
import { transaction } from "../../core/recherche.ts";
import { texte } from "../../core/texte.ts";
import type { Compte } from "../comptes.ts";
import { type Db, maintenant } from "../db.ts";
import { type Activite, LUE } from "./acces.ts";

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

// Pratique de l'élève : où il en est de chaque exercice.

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
