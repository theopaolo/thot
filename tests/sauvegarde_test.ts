import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { deposerImage } from "../src/app/activites.ts";
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
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const image = await deposerImage("activite-1", png);
  // Une écriture en cours du serveur ne se copie pas.
  await writeFile(join(dir, "content", ".original.pdf.partiel"), "moitié");
  const question = "Pourquoi Gaudí refuse-t-il la ligne droite sur la façade ?";
  const perimetre = { schoolId: lireInstance(db).school_id, lecteur: null };
  const avant = chercherFts(db, question, perimetre);
  assert(avant.length > 0);

  const racine = await mkdtemp(join(tmpdir(), "thot-sauvegarde-"));
  const sauvegarde = join(racine, "sauvegarde");
  assertEquals(sauvegarder(db, sauvegarde), []);
  // La base d'origine continue de changer, la sauvegarde garde l'état copié.
  db.exec("DELETE FROM chunks");
  db.close();

  assertEquals((await readdir(sauvegarde)).sort(), [
    "activites",
    "content",
    "secret",
    "state.sqlite3",
  ]);
  assertEquals(
    new Uint8Array(await readFile(join(sauvegarde, "activites", "activite-1", image))),
    png,
  );
  assert(!(await readdir(join(sauvegarde, "content"))).includes(".original.pdf.partiel"));
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
