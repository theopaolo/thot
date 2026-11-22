import { config, fournisseurs } from "./config.ts";
import type { Db } from "./db.ts";
import { type Audience, AUDIENCES } from "./depot.ts";
import { type Genre, minuscule } from "../core/accords.ts";
import { GENRES, type Libelles, libelles, TERMES, type Terme } from "./termes.ts";

export { GENRES, type Libelles, libelles, minuscule, TERMES };

/** Un terme vide reprend celui du profil. `version` compte les enregistrements des réglages. */
export type Instance = {
  id: string;
  school_id: string;
  nom: string;
  mode: "shared" | "personal";
  matiere: string;
  matieres: string;
  matiere_genre: Genre;
  cours: string;
  cours_pluriel: string;
  cours_genre: Genre;
  niveau: string;
  regroupement: string;
  regroupements: string;
  lecteurs: Audience;
  version: number;
};

export const lireInstance = (db: Db) =>
  db
    .prepare(
      `SELECT id, school_id, nom, mode, matiere, matieres, matiere_genre, cours, cours_pluriel,
       cours_genre, niveau, regroupement, regroupements, lecteurs, version
       FROM instance WHERE singleton = 1`,
    )
    .get() as Instance;

export type Reglages = Pick<Instance, "nom" | Terme | (typeof GENRES)[number] | "lecteurs">;
/**
 * Enregistre tous les réglages ou aucun. Rend les erreurs par champ, `false` si un autre
 * enregistrement a eu lieu depuis `version`, `true` une fois enregistré.
 */
export function enregistrerReglages(db: Db, r: Reglages, version: number) {
  const erreurs: Record<string, string> = {};
  if (!r.nom || r.nom.length > 100) erreurs.nom = "1 à 100 caractères.";
  for (const [singulier, pluriel] of TERMES) {
    for (const n of [singulier, pluriel ?? singulier]) {
      if (r[n].length > 40) erreurs[n] = "1 à 40 caractères.";
    }
    // Un singulier sans son pluriel mêlerait le terme de l'instance et celui du profil.
    if (pluriel && !r[singulier] !== !r[pluriel]) {
      erreurs[r[singulier] ? pluriel : singulier] = "1 à 40 caractères.";
    }
  }
  for (const g of GENRES) {
    if (r[g] !== "m" && r[g] !== "f") erreurs[g] = "Masculin ou féminin.";
  }
  if (!AUDIENCES.some((a) => a.value === r.lecteurs)) erreurs.lecteurs = "Lecteurs inconnus.";
  if (Object.keys(erreurs).length) return erreurs;
  const colonnes = [...TERMES.flat(), ...GENRES];
  return (
    db
      .prepare(
        `UPDATE instance SET nom = ?, ${colonnes
          .map((t) => `${t} = ?`)
          .join(", ")}, lecteurs = ?, version = version + 1 WHERE singleton = 1 AND version = ?`,
      )
      .run(r.nom, ...colonnes.map((t) => r[t]), r.lecteurs, version).changes === 1
  );
}

export function configurerInstance(db: Db, nom?: string, mode?: string) {
  const actuelle = lireInstance(db);
  nom = nom === undefined ? actuelle.nom : nom.trim();
  mode ??= actuelle.mode;
  if (!nom || nom.length > 100) throw new Error("Le nom doit contenir de 1 à 100 caractères.");
  if (mode !== "shared" && mode !== "personal") {
    throw new Error("Mode attendu : shared ou personal.");
  }
  if (mode !== actuelle.mode && db.prepare("SELECT id FROM comptes LIMIT 1").get()) {
    throw new Error("Choisir le mode avant de créer les comptes. La conversion relève de CFG-101.");
  }
  db.prepare(
    "UPDATE instance SET nom = ?, mode = ?, version = version + 1 WHERE singleton = 1",
  ).run(nom, mode);
  return lireInstance(db);
}

export const traitements = () => [
  { nom: "OpenRouter", ...fournisseurs.openrouter, disponible: !!config.modeles.cle },
  { nom: "Mistral", ...fournisseurs.mistral, disponible: !!config.modeles.cleMistral },
];
