import { transaction } from "../../core/recherche.ts";
import { sansAccents, texte } from "../../core/texte.ts";
import type { Compte } from "../comptes.ts";
import { type Db, maintenant } from "../db.ts";
import { catalogueDe } from "../domaines.ts";
import { type Activite, LUE } from "./acces.ts";

export const objectifs = (db: Db, coursId: string) =>
  db
    .prepare("SELECT id, intitule, reference FROM objectifs WHERE cours_id = ? ORDER BY intitule")
    .all(coursId) as { id: string; intitule: string; reference: string }[];

const cle = (s: string) => sansAccents(s.toLowerCase()).replace(/\s+/g, " ").trim();

/** L'objectif du cours de même intitulé, sans compter la casse, les accents ni les espaces. */
export const objectifNomme = (db: Db, coursId: string, intitule: string) =>
  objectifs(db, coursId).find((o) => cle(o.intitule) === cle(intitule));

/** L'intitulé de l'objectif choisi, ou celui d'un nouvel objectif. Une saisie invalide lève une erreur. */
export function objectifChoisi(db: Db, coursId: string, objectifId: string, intitule: string) {
  if (!objectifId) return texte(intitule, "Objectif", 300);
  const o = db
    .prepare("SELECT intitule FROM objectifs WHERE id = ? AND cours_id = ?")
    .get(objectifId, coursId) as { intitule: string } | undefined;
  if (!o) throw new Error("Objectif inconnu dans ce cours.");
  return o.intitule;
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
