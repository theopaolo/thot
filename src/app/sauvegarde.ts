import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "./config.ts";
import type { Db } from "./db.ts";

/**
 * Copie un dossier que le serveur et le worker écrivent encore. Un fichier `.partiel` est une
 * écriture en cours et reste hors de la copie. Un fichier renommé ou supprimé entre la lecture du
 * dossier et sa copie est passé : son chemin rejoint `disparus`.
 */
function copierDossier(source: string, dest: string, disparus: string[]) {
  let entrees;
  try {
    entrees = readdirSync(source, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    disparus.push(source);
    return;
  }
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const e of entrees) {
    const de = join(source, e.name);
    if (e.isDirectory()) copierDossier(de, join(dest, e.name), disparus);
    else if (!e.name.endsWith(".partiel")) {
      try {
        copyFileSync(de, join(dest, e.name));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        disparus.push(de);
      }
    }
  }
}

/**
 * Copie de l'instance dans un répertoire vide ou absent : la base par `VACUUM INTO`, le secret de
 * session, puis `content/` et `activites/`. La base est figée avant la copie des fichiers, un
 * original déposé pendant la copie peut donc manquer à la base sans la rendre incohérente. Rend
 * les fichiers disparus pendant la copie.
 */
export function sauvegarder(db: Db, destination: string): string[] {
  const dest = resolve(destination);
  if (existsSync(dest) && readdirSync(dest).length)
    throw new Error(`${dest} n'est pas vide: choisir un répertoire neuf.`);
  if (dest === config.donnees || dest.startsWith(config.donnees + "/"))
    throw new Error("La destination ne peut pas être dans le répertoire de données.");
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  db.prepare("VACUUM INTO ?").run(join(dest, "state.sqlite3"));
  const secret = join(config.donnees, "secret");
  if (existsSync(secret)) copyFileSync(secret, join(dest, "secret"));
  const disparus: string[] = [];
  for (const dossier of ["content", "activites"]) {
    const source = join(config.donnees, dossier);
    if (existsSync(source)) copierDossier(source, join(dest, dossier), disparus);
  }
  return disparus;
}
