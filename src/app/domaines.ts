import { FILTRE_DOMAINE, parametresDomaine } from "../core/recherche.ts";
import type { Db } from "./db.ts";
import { type Profil, PROFILS } from "../core/profils.ts";

export type Matiere = { id: string; nom: string; profil: Profil };
export type Cours = {
  id: string;
  matiere_id: string;
  nom: string;
  public: string;
  objectif: string;
};
export type Theme = { id: string; cours_id: string; nom: string };
export type Catalogue = { matieres: Matiere[]; cours: Cours[]; themes: Theme[] };
export const catalogue = (db: Db): Catalogue => ({
  matieres: db.prepare("SELECT * FROM matieres ORDER BY nom").all() as Matiere[],
  cours: db.prepare("SELECT * FROM cours ORDER BY nom").all() as Cours[],
  themes: db.prepare("SELECT * FROM themes ORDER BY nom").all() as Theme[],
});

const texte = (s: string, max = 200) => {
  if (!s.trim() || s.trim().length > max) throw new Error(`Texte attendu : 1 à ${max} caractères.`);
  return s.trim();
};
export function matiere(db: Db, nom: string, profil: string = "general") {
  const id = crypto.randomUUID();
  if (!Object.hasOwn(PROFILS, profil)) throw new Error("Profil inconnu.");
  db.prepare("INSERT INTO matieres VALUES (?, ?, ?)").run(id, texte(nom), profil);
  return id;
}
export function cours(db: Db, matiereId: string, nom: string, publicCible = "", objectif = "") {
  const id = crypto.randomUUID();
  if (publicCible.trim().length > 200 || objectif.trim().length > 4000) {
    throw new Error("Public ou objectif trop long.");
  }
  db.prepare("INSERT INTO cours VALUES (?, ?, ?, ?, ?)").run(
    id,
    matiereId,
    texte(nom),
    publicCible.trim(),
    objectif.trim(),
  );
  return id;
}
export function theme(db: Db, coursId: string, nom: string) {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO themes VALUES (?, ?, ?)").run(id, coursId, texte(nom));
  return id;
}
export function profilMatiere(db: Db, id: string, profil: string) {
  if (!Object.hasOwn(PROFILS, profil)) throw new Error("Profil inconnu.");
  if (!db.prepare("UPDATE matieres SET profil = ? WHERE id = ?").run(profil, id).changes) {
    throw new Error("Matière inconnue.");
  }
}
// ponytail: liste en dur. `thot ingest --matiere=` et la migration 0007 la lisent encore.
export const MATIERES = [
  { value: "arts-appliques", label: "Arts appliqués" },
  { value: "histoire-geographie", label: "Histoire-géographie" },
  { value: "francais", label: "Français" },
  { value: "physique-chimie", label: "Physique-chimie" },
  { value: "mathematiques", label: "Mathématiques" },
  { value: "eps", label: "Éducation physique et sportive" },
];

/** Sans matière choisie, une source rattachée à un cours d'arts appliqués en prend le profil. */
export function domaineSource(db: Db, champs: Record<string, string>, liens: Affiliation[] = []) {
  let m: Matiere | undefined;
  if (champs.matiere_id) {
    m = db.prepare("SELECT * FROM matieres WHERE id = ?").get(champs.matiere_id) as
      | Matiere
      | undefined;
    if (!m) throw new Error("Matière inconnue.");
  } else if (champs.matiere?.trim()) {
    const cle = champs.matiere.trim();
    const nom = MATIERES.find((x) => x.value === cle)?.label ?? cle;
    m = db.prepare("SELECT * FROM matieres WHERE nom = ?").get(nom) as Matiere | undefined;
    if (!m) {
      const id = matiere(db, nom, cle === "arts-appliques" ? "arts-appliques" : "general");
      m = db.prepare("SELECT * FROM matieres WHERE id = ?").get(id) as Matiere;
    }
  }
  const arts = liens.some((l) =>
    db.prepare("SELECT m.profil FROM cours c JOIN matieres m ON m.id = c.matiere_id WHERE c.id = ?")
      .get(l.cours_id)?.profil === "arts-appliques"
  );
  return {
    matiere_id: m?.id ?? null,
    profil: m?.profil ?? (arts ? "arts-appliques" : "general") as Profil,
    langue: langueSource(champs.langue),
  };
}
export type Affiliation = { cours_id: string; theme_id: string | null };
export function affiliations(db: Db, sourceId: string, liens: Affiliation[]) {
  for (const l of liens) {
    if (
      !db.prepare("SELECT id FROM cours WHERE id = ?").get(l.cours_id) ||
      (l.theme_id &&
        !db.prepare("SELECT id FROM themes WHERE id = ? AND cours_id = ?").get(
          l.theme_id,
          l.cours_id,
        ))
    ) throw new Error("Cours ou thème inconnu.");
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
export function rangerLegacy(db: Db, sourceId: string, matiereId: string | null, sequence: string) {
  if (!matiereId) return;
  let c = db.prepare("SELECT id FROM cours WHERE matiere_id = ? ORDER BY rowid LIMIT 1").get(
    matiereId,
  )?.id as string | undefined;
  c ??= cours(
    db,
    matiereId,
    db.prepare("SELECT nom FROM matieres WHERE id = ?").get(matiereId)!.nom as string,
  );
  const t = sequence
    ? db.prepare("SELECT id FROM themes WHERE cours_id = ? AND nom = ?").get(c, sequence)?.id as
      | string
      | undefined ?? theme(db, c, sequence)
    : null;
  affiliations(db, sourceId, [{ cours_id: c, theme_id: t }]);
}

export type Scope = { matiere_id: string; cours_id: string; theme_id: string };
export const lireScope = (champs: Record<string, unknown>): Scope => ({
  matiere_id: String(champs.matiere_id ?? ""),
  cours_id: String(champs.cours_id ?? ""),
  theme_id: String(champs.theme_id ?? ""),
});
export function sourcesPerimetre(db: Db, p: Scope) {
  return new Set(
    db.prepare(`SELECT s.id FROM sources s WHERE ${FILTRE_DOMAINE}`)
      .all(
        ...parametresDomaine({
          schoolId: "",
          matiereId: p.matiere_id,
          coursId: p.cours_id,
          themeId: p.theme_id,
        }),
      ).map((s) => s.id as string),
  );
}

export function catalogueVisible(db: Db): Catalogue {
  const cat = catalogue(db);
  const liens = db.prepare(
    `SELECT sc.cours_id, sc.theme_id FROM source_cours sc JOIN sources s ON s.id = sc.source_id
    WHERE s.statut = 'certifiee' AND EXISTS (SELECT 1 FROM json_each(s.metadonnees, '$.publics') WHERE value = 'eleves')`,
  ).all();
  const ids = new Set(liens.map((s) => s.cours_id));
  const themes = new Set(liens.map((s) => s.theme_id));
  cat.cours = cat.cours.filter((c) => ids.has(c.id));
  cat.matieres = cat.matieres.filter((m) => cat.cours.some((c) => c.matiere_id === m.id));
  cat.themes = cat.themes.filter((t) => themes.has(t.id));
  return cat;
}

export function langueSource(valeur = "fr") {
  const langue = valeur.trim().toLowerCase() || "fr";
  if (langue.length > 30 || !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(langue)) {
    throw new Error("Code de langue invalide.");
  }
  return langue;
}
