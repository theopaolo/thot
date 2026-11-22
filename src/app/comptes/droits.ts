import type { Db } from "../db.ts";
import type { Compte } from "./compte.ts";

/**
 * Modifient, certifient et relisent une source : son propriétaire, les administrateurs, et les
 * enseignants de ses cours quand elle n'est pas privée.
 */
export const filtreModification = (s = "s") =>
  `($administrateur OR ${s}.proprietaire_id = $lecteur OR ($enseignant AND ${s}.audience != 'prive'
    AND EXISTS (SELECT 1 FROM source_cours sc JOIN membres_cours mc ON mc.cours_id = sc.cours_id
      WHERE sc.source_id = ${s}.id AND mc.compte_id = $lecteur)))`;
export const parametresModification = (c: Compte) => ({
  administrateur: c.administrateur === 1 ? 1 : 0,
  lecteur: c.id,
  enseignant: c.role === "enseignant" ? 1 : 0,
});
export const peutModifier = (db: Db, c: Compte, sourceId: string) =>
  db
    .prepare(`SELECT 1 FROM sources s WHERE s.id = ? AND ${filtreModification()}`)
    .get(parametresModification(c), sourceId) !== undefined;
