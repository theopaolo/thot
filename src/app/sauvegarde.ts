import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "./config.ts";
import type { Db } from "./db.ts";

/**
 * Copie de l'instance dans un répertoire vide ou absent: la base par `VACUUM INTO`, puis
 * `content/` et le secret de session. La base est figée avant la copie des fichiers, un original
 * déposé pendant la copie peut donc manquer à la base sans la rendre incohérente.
 */
export function sauvegarder(db: Db, destination: string) {
  const dest = resolve(destination);
  if (existsSync(dest) && readdirSync(dest).length)
    throw new Error(`${dest} n'est pas vide: choisir un répertoire neuf.`);
  if (dest === config.donnees || dest.startsWith(config.donnees + "/"))
    throw new Error("La destination ne peut pas être dans le répertoire de données.");
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  db.prepare("VACUUM INTO ?").run(join(dest, "state.sqlite3"));
  const contenu = join(config.donnees, "content");
  if (existsSync(contenu)) cpSync(contenu, join(dest, "content"), { recursive: true });
  const secret = join(config.donnees, "secret");
  if (existsSync(secret)) copyFileSync(secret, join(dest, "secret"));
}
