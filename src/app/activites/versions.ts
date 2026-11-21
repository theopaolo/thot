import { rm } from "node:fs/promises";
import {
  type Champ,
  champs,
  type Contenu,
  type Explication,
  jugerChamps,
  MAX_QUESTIONS,
  type Question,
  transformer,
} from "../../core/activite.ts";
import type { Modeles } from "../../core/modeles.ts";
import { erreursQuestion } from "../../core/questions.ts";
import { transaction } from "../../core/recherche.ts";
import { texte } from "../../core/texte.ts";
import type { Compte } from "../comptes.ts";
import { type Db, maintenant } from "../db.ts";
import { catalogueDe } from "../domaines.ts";
import { type Activite, bloquantes, cibleDe, lireContenu, preuvesValides } from "./acces.ts";
import { dossierActivite } from "./images.ts";
import { objectifChoisi, objectifNomme } from "./objectifs.ts";

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

/**
 * Enregistre une nouvelle activité en brouillon, dans le cours choisi. Un nouvel objectif reprend
 * celui du cours de même intitulé, ou naît avec l'activité. Rend son identifiant.
 */
export function inserer(db: Db, compte: Compte, s: Insertion) {
  const cible = cibleDe(db, compte, s.coursId);
  const intitule = objectifChoisi(db, s.coursId, s.objectifId, s.intitule);
  // Un quiz importé arrive ici sans autre contrôle de la série.
  const erreurs = "questions" in s.contenu ? erreursContenu(s.contenu) : [];
  if (erreurs.length) throw new Error(erreurs.join(" "));
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

/** Ce que lit le juge : un champ qui garde son texte et ses passages garde son avis. */
const lu = (ch: Champ) =>
  JSON.stringify([ch.texte, ch.citations.map((c) => [c.citation, c.titre, c.revision])]);

/**
 * Ce qui rend une série inutilisable, question par question. Avec `avant`, la version qu'elle
 * remplace, seul ce qui change est contrôlé : une question reprise telle quelle n'est pas relue, et
 * une série trop longue se raccourcit. Une question vidée par la suppression de sa source ne bloque
 * donc pas la correction des autres.
 */
export function erreursContenu(c: Contenu, avant?: Contenu) {
  const erreurs: string[] = [];
  const n = c.questions.length;
  if (!n || (n > MAX_QUESTIONS && n > (avant?.questions.length ?? 0))) {
    erreurs.push(`Une série a de 1 à ${MAX_QUESTIONS} questions.`);
  }
  if (new Set(c.questions.map((q) => q.id)).size !== n) {
    erreurs.push("Deux questions ont le même identifiant.");
  }
  const reprises = new Set(avant?.questions.map((q) => JSON.stringify(q)));
  c.questions.forEach((q, i) => {
    if (reprises.has(JSON.stringify(q))) return;
    erreurs.push(...erreursQuestion(q).map((e) => `Question ${i + 1} : ${e}`));
  });
  return erreurs;
}

/**
 * Ce qui empêche de relire ou de publier une activité telle qu'elle est enregistrée : une série
 * avec une erreur, ou une explication dont la suppression d'une source a retiré toutes les phrases.
 */
function erreursActivite(a: Pick<Activite, "contenu">) {
  const c = lireContenu(a.contenu);
  if ("questions" in c) return erreursContenu(c);
  return c.affirmations.length
    ? []
    : ["Cette explication n'a plus aucune phrase. Préparez-en une autre."];
}
const exigerContenu = (a: Pick<Activite, "contenu">) => {
  const erreurs = erreursActivite(a);
  if (erreurs.length) throw new Error(erreurs.join(" "));
};

/**
 * Enregistre une nouvelle version d'un exercice, partie de la version `revision`. Le contenu vient
 * de l'enseignant ou du générateur : ses avis de juge ne comptent pas. Un champ dont le texte et
 * les passages n'ont pas changé reprend l'avis de la version précédente, et le juge lit les autres
 * champs cités. La nouvelle version est un brouillon à relire. Elle reste à revoir si une preuve ne
 * tient plus dans un des cours, ou si une question que cette version ne change pas a encore une
 * erreur.
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
  const avant = JSON.parse(a.contenu) as Contenu;
  const erreurs = erreursContenu(neuf, avant);
  if (erreurs.length) throw new Error(erreurs.join(" "));
  const avis = new Map(
    champs(avant)
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
  const valide = !erreursContenu(neuf).length;
  return transaction(db, () => {
    const etat = valide && preuvesValides(db, { ...a, contenu }) ? "brouillon" : "a_revoir";
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
 * ou que ses passages se retrouvent sans changement, redevient un brouillon à relire. Elle reste à
 * revoir tant que son contenu a une erreur, une question vidée par exemple.
 */
function revalider(db: Db, a: Activite, compteId: string) {
  if (a.etat !== "a_revoir" || !preuvesValides(db, a) || erreursActivite(a).length) return false;
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

/**
 * Relit la version affichée d'un brouillon. Une autre version ne se relit pas à sa place. Un
 * brouillon dont le contenu a une erreur lève cette erreur.
 */
export const relire = (db: Db, compte: Compte, a: Activite, revision: number) => {
  if (a.etat === "brouillon" && a.revision === revision) exigerContenu(a);
  return transaction(db, () => {
    const r = db
      .prepare(
        "UPDATE activites SET etat = 'relue', maj_le = ? WHERE id = ? AND revision = ? AND etat = 'brouillon'",
      )
      .run(maintenant(), a.id, revision);
    if (r.changes) historique(db, a.id, revision, "relue", compte.id);
    return r.changes > 0;
  });
};

const signaler = (db: Db, a: Pick<Activite, "id" | "revision">) => {
  db.prepare("UPDATE activites SET etat = 'a_revoir', maj_le = ? WHERE id = ?").run(
    maintenant(),
    a.id,
  );
  historique(db, a.id, a.revision, "a_revoir", null);
};

/**
 * Publie la version relue. Une preuve qui ne tient plus dans un des cours fait signaler l'exercice
 * à revoir. Un contenu avec une erreur lève cette erreur.
 */
export const publier = (db: Db, compte: Compte, id: string, revision: number) =>
  transaction(db, () => {
    // Relue dans la transaction : une modification arrivée entre-temps n'est pas publiée.
    const a = db.prepare("SELECT * FROM activites WHERE id = ?").get(id) as Activite;
    if (a.etat !== "relue" || a.revision !== revision) return "refus";
    exigerContenu(a);
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
 * titres ont pu la nommer. Ce contenu est une nouvelle version, à revoir : une relecture partie de
 * la précédente ne vaut pas pour lui. Les tentatives des élèves gardent leur réponse et la version
 * à laquelle elles répondaient.
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
    db.prepare("UPDATE activites SET contenu = ?, revision = revision + 1 WHERE id = ?").run(
      JSON.stringify(contenu),
      a.id,
    );
    signaler(db, { id: a.id, revision: a.revision + 1 });
  }
}
