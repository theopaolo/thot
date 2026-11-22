import { CHAMPS, type Champ, champsVerrouilles, type Profil, PROFILS } from "../../core/profils.ts";
import type { Db } from "../db.ts";

export const texte = (s: string, max = 200) => {
  if (!s.trim() || s.trim().length > max) throw new Error(`Texte attendu : 1 à ${max} caractères.`);
  return s.trim();
};

/** Les champs prédéfinis, puis les champs personnalisés dans l'ordre de leur création. */
export const catalogueChamps = (db: Db): Champ[] => [
  ...Object.entries(CHAMPS).map(([cle, c]) => ({ cle, ...c })),
  ...(db
    .prepare("SELECT id AS cle, nom AS label, type FROM champs_personnalises ORDER BY rowid")
    .all() as Champ[]),
];
/** Les champs du dépôt d'une matière. Une source sans matière prend ceux de son profil. */
export function champsMatiere(db: Db, matiereId: string | null, profil: Profil): Champ[] {
  const liste = matiereId
    ? (db.prepare("SELECT champs FROM matieres WHERE id = ?").get(matiereId)?.champs as
        | string
        | null)
    : null;
  const cles = new Set([
    ...champsVerrouilles(profil),
    ...(liste ? (JSON.parse(liste) as string[]) : PROFILS[profil].informations),
  ]);
  return catalogueChamps(db).filter((c) => cles.has(c.cle));
}
/**
 * Enregistre les champs du dépôt d'une matière, sauf si sa liste a changé depuis `version`.
 * Rend `false` dans ce cas. Retirer un champ le masque et garde ses valeurs.
 */
export function enregistrerChamps(db: Db, matiereId: string, cles: string[], version: number) {
  const m = db.prepare("SELECT profil FROM matieres WHERE id = ?").get(matiereId);
  if (!m) throw new Error("Matière inconnue.");
  const choisis = new Set([...champsVerrouilles(m.profil as Profil), ...cles]);
  const connus = catalogueChamps(db).map((c) => c.cle);
  if ([...choisis].some((c) => !connus.includes(c))) throw new Error("Champ inconnu.");
  return (
    db
      .prepare("UPDATE matieres SET champs = ?, version = version + 1 WHERE id = ? AND version = ?")
      .run(JSON.stringify(connus.filter((c) => choisis.has(c))), matiereId, version).changes === 1
  );
}

export const TYPES_CHAMP = { text: "Texte", date: "Date", tags: "Mots-clés" };
/** Un libellé de champ est unique parmi les champs prédéfinis et personnalisés. */
export function nomChamp(db: Db, nom: string, id = "") {
  const n = texte(nom, 60);
  if (
    Object.values(CHAMPS).some((c) => c.label === n) ||
    db.prepare("SELECT 1 FROM champs_personnalises WHERE nom = ? AND id != ?").get(n, id)
  ) {
    throw new Error(`« ${n} » existe déjà.`);
  }
  return n;
}
/** Le préfixe sépare la clé du champ des autres clés de `sources.metadonnees`. */
export function champPersonnalise(db: Db, nom: string, type: string) {
  if (!Object.hasOwn(TYPES_CHAMP, type)) throw new Error("Type de champ inconnu.");
  if ((db.prepare("SELECT count(*) n FROM champs_personnalises").get()!.n as number) >= 30) {
    throw new Error("30 champs personnalisés au maximum.");
  }
  const id = `perso_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  db.prepare("INSERT INTO champs_personnalises VALUES (?, ?, ?)").run(id, nomChamp(db, nom), type);
  return id;
}
/** Le nombre de ressources qui portent une valeur pour ce champ. */
export const ressourcesAvec = (db: Db, cle: string) =>
  db
    .prepare(
      "SELECT count(*) n FROM sources WHERE coalesce(json_extract(metadonnees, ?), '') != ''",
    )
    .get(`$.${cle}`)!.n as number;
