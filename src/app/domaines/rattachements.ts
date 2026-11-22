import { FILTRE_ACCES, type Lecteur, parametresAcces } from "../../core/recherche.ts";
import type { Db } from "../db.ts";
import { cours, theme } from "./catalogue.ts";
import { coursDuCompte, type Membre, MES_COURS, mesCours } from "./membres.ts";

export type Affiliation = { cours_id: string; theme_id: string | null };
/** Le nombre de ressources rattachées à chaque cours, pour l'administration. */
export const nombreRessources = (db: Db) =>
  new Map(
    db
      .prepare("SELECT cours_id, count(*) n FROM source_cours GROUP BY cours_id")
      .all()
      .map((l) => [l.cours_id as string, l.n as number]),
  );
/**
 * Un enseignant ne rattache une source qu'à ses propres cours. Les rattachements de la source à
 * d'autres cours restent en place, puisque son formulaire ne les montre pas.
 */
export function liensAutorises(
  db: Db,
  c: Membre,
  liens: Affiliation[],
  sourceId?: string,
): Affiliation[] {
  const siens = c.administrateur === 1 ? null : coursDuCompte(db, c.id);
  if (siens && liens.some((l) => !siens.has(l.cours_id))) {
    throw new Error("Rattachement refusé : ce cours n'est pas le vôtre.");
  }
  const actuels = sourceId
    ? (db
        .prepare("SELECT cours_id, theme_id FROM source_cours WHERE source_id = ?")
        .all(sourceId) as Affiliation[])
    : [];
  const autres = siens ? actuels.filter((l) => !siens.has(l.cours_id)) : [];
  // Sans cours, une source partagée se lirait dans toute l'instance.
  if (actuels.length && !liens.length && !autres.length) {
    throw new Error("Une ressource rattachée garde au moins un cours.");
  }
  return [...liens, ...autres];
}
export function affiliations(db: Db, sourceId: string, liens: Affiliation[]) {
  for (const l of liens) {
    if (
      !db.prepare("SELECT id FROM cours WHERE id = ?").get(l.cours_id) ||
      (l.theme_id &&
        !db
          .prepare("SELECT id FROM themes WHERE id = ? AND cours_id = ?")
          .get(l.theme_id, l.cours_id))
    )
      throw new Error("Cours ou thème inconnu.");
  }
  db.prepare("DELETE FROM source_cours WHERE source_id = ?").run(sourceId);
  for (const l of liens) {
    db.prepare("INSERT INTO source_cours VALUES (?, ?, ?)").run(sourceId, l.cours_id, l.theme_id);
  }
}
export function liensFormulaire(b: Record<string, unknown>): Affiliation[] {
  return [...new Set([b.cours ?? []].flat().map(String))].map((id) => ({
    cours_id: id,
    theme_id: String(b[`theme_${id}`] ?? "") || null,
  }));
}
/** Le thème de ce nom dans le cours, créé s'il manque. Sans nom, aucun thème. */
export const themeNomme = (db: Db, coursId: string, nom = "") =>
  nom
    ? ((db.prepare("SELECT id FROM themes WHERE cours_id = ? AND nom = ?").get(coursId, nom)?.id as
        | string
        | undefined) ?? theme(db, coursId, nom))
    : null;
/** Le nom du thème d'une source, le premier par ordre alphabétique si elle en a plusieurs. */
export const nomTheme = (s: string) =>
  `(SELECT min(t.nom) FROM source_cours sc JOIN themes t ON t.id = sc.theme_id WHERE sc.source_id = ${s}.id)`;
/**
 * Le thème qui remplace un ancien chapitre, c'est-à-dire une séquence : celui où sont rangées le
 * plus de sources de cette séquence, dans un cours du compte d'abord. Seules comptent les sources
 * que le lecteur lit, dans les cours qu'on lui nomme : une séquence qu'il ne lit pas ne mène nulle
 * part, comme une séquence inconnue. Vide si aucun thème ne convient. La migration 0018 fait le
 * même choix pour les conversations.
 */
export const themeDuChapitre = (db: Db, nom: string, l: Lecteur) =>
  (db
    .prepare(
      `SELECT sc.theme_id FROM source_cours sc JOIN sources s ON s.id = sc.source_id
       JOIN themes t ON t.id = sc.theme_id
     WHERE json_extract(s.metadonnees, '$.sequence') = ? AND ${FILTRE_ACCES} AND ${MES_COURS}
     GROUP BY sc.theme_id
     ORDER BY EXISTS (SELECT 1 FROM membres_cours m WHERE m.cours_id = t.cours_id
       AND m.compte_id = $lecteur) DESC, count(*) DESC
     LIMIT 1`,
    )
    .get({ ...parametresAcces(l), ...mesCours(l) }, nom)?.theme_id as string | undefined) ?? "";
/**
 * Range une source sans cours choisi dans le premier cours de sa matière, sous le thème du nom de
 * sa séquence. Seul l'import CLI remplit encore la séquence, avec le nom du dossier. L'import et un
 * administrateur créent ce cours s'il manque. Un enseignant ne range que dans ses propres cours :
 * sans cours à lui dans la matière, la source reste non classée.
 */
export function rangerLegacy(
  db: Db,
  sourceId: string,
  matiereId: string | null,
  sequence: string,
  par?: Membre,
) {
  if (!matiereId) return;
  const restreint = par && par.administrateur !== 1;
  let c = db
    .prepare(
      `SELECT id FROM cours WHERE matiere_id = ? AND (? OR id IN
      (SELECT cours_id FROM membres_cours WHERE compte_id = ?))
     ORDER BY rowid LIMIT 1`,
    )
    .get(matiereId, restreint ? 0 : 1, par?.id ?? "")?.id as string | undefined;
  if (!c && restreint) {
    // Le formulaire ne montre pas les cours des autres enseignants : leurs liens restent.
    affiliations(db, sourceId, liensAutorises(db, par, [], sourceId));
    return;
  }
  c ??= cours(
    db,
    matiereId,
    db.prepare("SELECT nom FROM matieres WHERE id = ?").get(matiereId)!.nom as string,
  );
  const lien = [{ cours_id: c, theme_id: themeNomme(db, c, sequence) }];
  affiliations(db, sourceId, par ? liensAutorises(db, par, lien, sourceId) : lien);
}
