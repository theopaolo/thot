import { readFileSync, mkdirSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { Cache } from "../core/modeles.ts";
import { config, RACINE } from "./config.ts";
import { initialiserInstance } from "./instance.ts";

export type Db = DatabaseSync;

export const maintenant = () => new Date().toISOString().slice(0, 19) + "Z";

export function purgerMessages(db: Db, jours: number, date = Date.now()) {
  if (!Number.isInteger(jours) || jours < 1) {
    throw new Error("THOT_RETENTION_JOURS doit être un entier positif.");
  }
  const limite = new Date(date - jours * 86_400_000).toISOString().slice(0, 19) + "Z";
  const n = db.prepare("DELETE FROM messages WHERE cree_le < ?").run(limite).changes;
  // Le titre reprend une question : une conversation vidée part avec ses échanges.
  db.prepare(
    "DELETE FROM conversations WHERE NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = conversations.id)",
  ).run();
  return n;
}

/** Une connexion par processus. WAL laisse lire pendant une écriture du worker. */
export function connexion(chemin = join(config.donnees, "state.sqlite3")): Db {
  mkdirSync(config.donnees, { recursive: true, mode: 0o700 });
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
    db
      .prepare("SELECT nom FROM migrations")
      .all()
      .map((l) => l.nom as string),
  );
  const dossier = join(RACINE, "migrations");
  const fichiers = readdirSync(dossier, { withFileTypes: true })
    .map((f) => f.name)
    .filter((n) => n.endsWith(".sql"))
    .sort();
  const appliquees: string[] = [];
  for (const nom of fichiers) {
    if (faites.has(nom)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(join(dossier, nom), "utf8"));
      db.prepare("INSERT INTO migrations VALUES (?, ?)").run(nom, maintenant());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${nom}: ${(e as Error).message}`);
    }
    appliquees.push(nom);
  }
  initialiserInstance(db);
  return appliquees;
}

export const cacheModeles = (db: Db): Cache => ({
  lire: (cle) =>
    db.prepare("SELECT valeur FROM cache_modeles WHERE cle = ?").get(cle)?.valeur as
      | string
      | undefined,
  ecrire: (cle, valeur) =>
    db
      .prepare("INSERT OR REPLACE INTO cache_modeles VALUES (?, ?, ?)")
      .run(cle, valeur, maintenant()),
});
