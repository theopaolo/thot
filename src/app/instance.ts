import { config, fournisseurs } from "./config.ts";
import type { Db } from "./db.ts";
import { type Audience, AUDIENCES } from "./depot.ts";
import { profilInstance } from "./domaines.ts";
import { PROFILS } from "../core/profils.ts";

/** Un terme vide reprend celui du profil. `version` compte les enregistrements des réglages. */
export type Instance = {
  id: string;
  school_id: string;
  nom: string;
  mode: "shared" | "personal";
  matiere: string;
  matieres: string;
  cours: string;
  cours_pluriel: string;
  niveau: string;
  regroupement: string;
  regroupements: string;
  lecteurs: Audience;
  version: number;
};

export const lireInstance = (db: Db) =>
  db
    .prepare(
      `SELECT id, school_id, nom, mode, matiere, matieres, cours, cours_pluriel, niveau,
       regroupement, regroupements, lecteurs, version FROM instance WHERE singleton = 1`,
    )
    .get() as Instance;

/** Un terme dans une phrase : « Matières et cours ». */
export const minuscule = (terme: string) =>
  terme.charAt(0).toLocaleLowerCase("fr") + terme.slice(1);
/** Les termes que l'instance règle, chacun au singulier et au pluriel sauf le niveau. */
export const TERMES = [
  ["matiere", "matieres"],
  ["cours", "cours_pluriel"],
  ["niveau"],
  ["regroupement", "regroupements"],
] as const;
type Terme = (typeof TERMES)[number][number];
export type Libelles = Pick<Instance, Terme> & {
  sousRegroupement: string;
  seance: string;
};
/**
 * Les termes affichés : ceux de l'instance, sinon ceux du profil, général tant qu'elle est vide.
 * Le sous-regroupement et la séance restent ceux du profil.
 */
export function libelles(db: Db): Libelles {
  const i = lireInstance(db);
  const p = PROFILS[profilInstance(db) ?? "general"];
  return {
    ...(Object.fromEntries(TERMES.flat().map((t) => [t, i[t] || p[t]])) as Pick<Instance, Terme>),
    sousRegroupement: p.sousRegroupement,
    seance: p.seance,
  };
}

export type Reglages = Pick<Instance, "nom" | Terme | "lecteurs">;
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
  if (!AUDIENCES.some((a) => a.value === r.lecteurs)) erreurs.lecteurs = "Lecteurs inconnus.";
  if (Object.keys(erreurs).length) return erreurs;
  return (
    db
      .prepare(
        `UPDATE instance SET nom = ?, ${TERMES.flat()
          .map((t) => `${t} = ?`)
          .join(", ")}, lecteurs = ?, version = version + 1 WHERE singleton = 1 AND version = ?`,
      )
      .run(r.nom, ...TERMES.flat().map((t) => r[t]), r.lecteurs, version).changes === 1
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
