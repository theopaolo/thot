import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { config } from "../src/app/config.ts";
import { connexion } from "../src/app/db.ts";
import { lireInstance } from "../src/app/instance.ts";
import { sauvegarder } from "../src/app/sauvegarde.ts";
import { chercherFts } from "../src/core/recherche.ts";
import { environnement, publier } from "./outils.ts";

test("une sauvegarde restaurée dans un répertoire neuf répond à la même question", async () => {
  const { db, dir } = await environnement();
  await publier(db, "Casa Batlló");
  await writeFile(join(dir, "secret"), "secret-de-test");
  const question = "Pourquoi Gaudí refuse-t-il la ligne droite sur la façade ?";
  const perimetre = { schoolId: lireInstance(db).school_id, lecteur: null };
  const avant = chercherFts(db, question, perimetre);
  assert(avant.length > 0);

  const racine = await mkdtemp(join(tmpdir(), "thot-sauvegarde-"));
  const sauvegarde = join(racine, "sauvegarde");
  sauvegarder(db, sauvegarde);
  // La base d'origine continue de changer, la sauvegarde garde l'état copié.
  db.exec("DELETE FROM chunks");
  db.close();

  assertEquals((await readdir(sauvegarde)).sort(), ["content", "secret", "state.sqlite3"]);
  const restauree = connexion(join(sauvegarde, "state.sqlite3"));
  const apres = chercherFts(restauree, question, perimetre);
  restauree.close();
  assertEquals(
    apres.map((c) => [c.id, c.source_id, c.texte]),
    avant.map((c) => [c.id, c.source_id, c.texte]),
  );

  // Une destination non vide est refusée, sans rien écrire dedans.
  const occupee = join(racine, "occupee");
  await mkdir(occupee);
  await writeFile(join(occupee, "autre"), "x");
  const ouverte = connexion(join(sauvegarde, "state.sqlite3"));
  assertThrows(() => sauvegarder(ouverte, occupee), Error, "n'est pas vide");
  assertEquals(await readdir(occupee), ["autre"]);
  assertThrows(
    () => sauvegarder(ouverte, join(config.donnees, "copie")),
    Error,
    "répertoire de données",
  );
  ouverte.close();
});
