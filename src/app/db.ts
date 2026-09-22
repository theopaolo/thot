import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import type { Cache } from "../core/modeles.ts";
import { config, RACINE } from "./config.ts";

export type Db = DatabaseSync;

export const maintenant = () => new Date().toISOString().slice(0, 19) + "Z";

/** Une connexion par processus. WAL laisse lire pendant une écriture du worker. */
export function connexion(chemin = join(config.donnees, "state.sqlite3")): Db {
  Deno.mkdirSync(config.donnees, { recursive: true });
  const db = new DatabaseSync(chemin);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return db;
}

/** Applique les fichiers `migrations/*.sql` non encore appliqués, dans l'ordre. */
export function migrer(db: Db): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS migrations (nom TEXT PRIMARY KEY, applique_le TEXT NOT NULL)",
  );
  const faites = new Set(
    db.prepare("SELECT nom FROM migrations").all().map((l) => l.nom as string),
  );
  const dossier = join(RACINE, "migrations");
  const fichiers = [...Deno.readDirSync(dossier)].map((f) => f.name).filter((n) =>
    n.endsWith(".sql")
  )
    .sort();
  const appliquees: string[] = [];
  for (const nom of fichiers) {
    if (faites.has(nom)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(Deno.readTextFileSync(join(dossier, nom)));
      db.prepare("INSERT INTO migrations VALUES (?, ?)").run(nom, maintenant());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${nom}: ${(e as Error).message}`);
    }
    appliquees.push(nom);
  }
  return appliquees;
}

export const cacheModeles = (db: Db): Cache => ({
  lire: (cle) =>
    db.prepare("SELECT valeur FROM cache_modeles WHERE cle = ?").get(cle)?.valeur as
      | string
      | undefined,
  ecrire: (cle, valeur) =>
    db.prepare("INSERT OR REPLACE INTO cache_modeles VALUES (?, ?, ?)").run(
      cle,
      valeur,
      maintenant(),
    ),
});
