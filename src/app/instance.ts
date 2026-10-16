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
  niveau: string;
  regroupement: string;
  regroupements: string;
  lecteurs: Audience;
  version: number;
};

export function initialiserInstance(db: Db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("SELECT id FROM instance").get()) {
      const ecoles = db.prepare("SELECT DISTINCT school_id FROM sources").all();
      if (ecoles.length > 1) {
        throw new Error(
          "Plusieurs établissements dans la base : séparer leurs données avant migration.",
        );
      }
      db.prepare(
        "INSERT INTO instance (singleton, id, school_id, nom, mode) VALUES (1, ?, ?, 'Thot', 'shared')",
      ).run(crypto.randomUUID(), ecoles[0]?.school_id ?? config.schoolId);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const lireInstance = (db: Db) =>
  db
    .prepare(
      `SELECT id, school_id, nom, mode, niveau, regroupement, regroupements, lecteurs, version
       FROM instance WHERE singleton = 1`,
    )
    .get() as Instance;

export type Libelles = Pick<Instance, "niveau" | "regroupement" | "regroupements"> & {
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
    niveau: i.niveau || p.niveau,
    regroupement: i.regroupement || p.regroupement,
    regroupements: i.regroupements || p.regroupements,
    sousRegroupement: p.sousRegroupement,
    seance: p.seance,
  };
}

export type Reglages = Pick<
  Instance,
  "nom" | "niveau" | "regroupement" | "regroupements" | "lecteurs"
>;
/**
 * Enregistre tous les réglages ou aucun. Rend les erreurs par champ, `false` si un autre
 * enregistrement a eu lieu depuis `version`, `true` une fois enregistré.
 */
export function enregistrerReglages(db: Db, r: Reglages, version: number) {
  const erreurs: Record<string, string> = {};
  if (!r.nom || r.nom.length > 100) erreurs.nom = "1 à 100 caractères.";
  for (const n of ["niveau", "regroupement", "regroupements"] as const) {
    if (r[n].length > 40) erreurs[n] = "1 à 40 caractères.";
  }
  // Un singulier sans son pluriel mêlerait le terme de l'instance et celui du profil.
  if (!r.regroupement !== !r.regroupements) {
    erreurs[r.regroupement ? "regroupements" : "regroupement"] = "1 à 40 caractères.";
  }
  if (!AUDIENCES.some((a) => a.value === r.lecteurs)) erreurs.lecteurs = "Lecteurs inconnus.";
  if (Object.keys(erreurs).length) return erreurs;
  return (
    db
      .prepare(
        `UPDATE instance SET nom = ?, niveau = ?, regroupement = ?, regroupements = ?, lecteurs = ?,
         version = version + 1 WHERE singleton = 1 AND version = ?`,
      )
      .run(r.nom, r.niveau, r.regroupement, r.regroupements, r.lecteurs, version).changes === 1
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
