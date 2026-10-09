import { config, fournisseurs } from "./config.ts";
import type { Db } from "./db.ts";

export type Instance = { id: string; school_id: string; nom: string; mode: "shared" | "personal" };

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
      db.prepare("INSERT INTO instance VALUES (1, ?, ?, 'Thot', 'shared')").run(
        crypto.randomUUID(),
        ecoles[0]?.school_id ?? config.schoolId,
      );
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const lireInstance = (db: Db) =>
  db.prepare("SELECT id, school_id, nom, mode FROM instance WHERE singleton = 1").get() as Instance;

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
  db.prepare("UPDATE instance SET nom = ?, mode = ? WHERE singleton = 1").run(nom, mode);
  return lireInstance(db);
}

export const traitements = () => [
  { nom: "OpenRouter", ...fournisseurs.openrouter, disponible: !!config.modeles.cle },
  { nom: "Mistral", ...fournisseurs.mistral, disponible: !!config.modeles.cleMistral },
];
