import type { Lecteur } from "../../core/recherche.ts";
import type { Db } from "../db.ts";

export type Membre = { id: string; administrateur: number };
/** Les cours dont le compte est membre. */
export const coursDuCompte = (db: Db, compteId: string) =>
  new Set(
    db
      .prepare("SELECT cours_id FROM membres_cours WHERE compte_id = ?")
      .all(compteId)
      .map((l) => l.cours_id as string),
  );
export const membres = (db: Db, coursId: string) =>
  db
    .prepare(
      `SELECT a.id, a.identifiant, a.nom, a.role FROM membres_cours m JOIN comptes a ON a.id = m.compte_id
     WHERE m.cours_id = ? ORDER BY a.role, a.nom`,
    )
    .all(coursId) as { id: string; identifiant: string; nom: string; role: string }[];
export function inscrire(db: Db, coursId: string, compteId: string) {
  if (!db.prepare("SELECT 1 FROM cours WHERE id = ?").get(coursId)) {
    throw new Error("Cours inconnu.");
  }
  if (!db.prepare("SELECT 1 FROM comptes WHERE id = ?").get(compteId)) {
    throw new Error("Compte inconnu.");
  }
  db.prepare("INSERT OR IGNORE INTO membres_cours VALUES (?, ?)").run(coursId, compteId);
}
export const desinscrire = (db: Db, coursId: string, compteId: string) =>
  db
    .prepare("DELETE FROM membres_cours WHERE cours_id = ? AND compte_id = ?")
    .run(coursId, compteId);

/** Un rattachement ne nomme un cours qu'à ses membres et aux administrateurs. */
export const MES_COURS =
  "($administrateur OR sc.cours_id IN (SELECT cours_id FROM membres_cours WHERE compte_id = $lecteur))";
export const mesCours = (l: Lecteur) => ({
  administrateur: l.administrateur ? 1 : 0,
  lecteur: l.id,
});
