import { existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { assert, assertEquals } from "@std/assert";
import { contenu } from "../src/app/config.ts";
import type { Db } from "../src/app/db.ts";
import { deposer, valider } from "../src/app/depot.ts";
import {
  reextraire,
  relireLegende,
  revendiquer,
  revisionEnAttente,
  statuer,
  traiter,
} from "../src/app/ingestion.ts";
import { lireInstance } from "../src/app/instance.ts";
import { environnement, fauxModeles, session } from "./outils.ts";

/** Un PNG réduit à son en-tête, distingué par sa hauteur. */
const png = (n: number) => {
  const o = new Uint8Array(24);
  o.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(o.buffer).setUint32(16, 2);
  new DataView(o.buffer).setUint32(20, n);
  return o;
};
const page = (images: number[], suite = "") =>
  `<html><h1>Les croquis</h1><p>Trois croquis de la façade, du plus ancien au plus récent.</p>${images
    .map((n) => `<img src="data:image/png;base64,${Buffer.from(png(n)).toString("base64")}">`)
    .join("")}${suite}</html>`;

// La légende nomme la hauteur de l'image : elle dit quels octets elle décrit.
const modeles = {
  ...fauxModeles().modeles,
  legender: (o: Uint8Array) => Promise.resolve({ texte: `Croquis ${o[23]}`, modele: "faux-vl" }),
};

/** Une page HTML certifiée, avec les croquis 1 et 2. */
async function source(db: Db) {
  const v = valider({ titre: "Les croquis", type_document: "cours" });
  assert("meta" in v);
  const { source_id: id } = await deposer(db, {
    meta: v.meta,
    nomFichier: "croquis.html",
    format: "html",
    schoolId: lireInstance(db).school_id,
    enseignant: "Prof",
    audience: "eleves",
    reponses: true,
    octets: new TextEncoder().encode(page([1, 2])),
  });
  await traiter(db, revendiquer(db)!, modeles);
  statuer(db, id, "certifiee", "Test");
  return id;
}

/** Remplace l'original et rejoue le travail du worker, comme après un changement d'extracteur. */
async function redeposer(db: Db, id: string, html: string) {
  writeFileSync(contenu(id, "original", "croquis.html"), html);
  db.prepare("UPDATE ingestion_jobs SET etat = 'received' WHERE source_id = ?").run(id);
  await traiter(db, revendiquer(db)!, modeles);
}

const images = (db: Db) =>
  db
    .prepare("SELECT id, revision, legende, legende_statut FROM images ORDER BY position")
    .all()
    .map((i) => [i.id, i.revision, i.legende, i.legende_statut]);
const fichiers = (id: string, ...dossier: string[]) =>
  readdirSync(contenu(id, ...dossier, "assets")).length;

test("une légende relue suit les octets de son image, pas sa place", async () => {
  const { db } = await environnement();
  const id = await source(db);
  relireLegende(db, `${id}-1`, "certified", "Croquis relu", "Test");

  // Même texte, autre ordre, une image de plus : la révision servie reçoit ses images en place.
  await redeposer(db, id, page([2, 1, 3]));
  assertEquals(revisionEnAttente(db, id), undefined);
  assertEquals(images(db), [
    [`${id}-1`, 1, "Croquis relu", "certified"],
    [`${id}-0`, 1, "Croquis 1", "unreviewed"],
    [`${id}-2`, 1, "Croquis 3", "unreviewed"],
  ]);
  assertEquals(fichiers(id), 3);

  // Une image que l'extraction ne rend plus sort, avec son fichier.
  await redeposer(db, id, page([2]));
  assertEquals(images(db), [[`${id}-1`, 1, "Croquis relu", "certified"]]);
  assertEquals(fichiers(id), 1);
  const { requete } = await session(db, modeles, "eleve");
  assertEquals((await requete(`/media/${id}-1`)).status, 200);
  assertEquals((await requete(`/media/${id}-0`)).status, 404);
});

test("une image enregistrée avant la migration garde sa ligne, sa légende relue et son fichier", async () => {
  const { db } = await environnement();
  const id = await source(db);
  // Avant la migration, le fichier portait le nom de sa place.
  for (const [n, { fichier }] of db
    .prepare("SELECT fichier FROM images ORDER BY position")
    .all()
    .entries()) {
    renameSync(contenu(id, "assets", String(fichier)), contenu(id, "assets", `image-${n}.png`));
    db.prepare("UPDATE images SET fichier = ? WHERE id = ?").run(`image-${n}.png`, `${id}-${n}`);
  }
  relireLegende(db, `${id}-0`, "certified", "Croquis relu", "Test");
  const avant = db.prepare("SELECT * FROM images ORDER BY position").all();
  assertEquals(
    avant.map((i) => [i.revision, i.fichier]),
    [
      [1, "image-0.png"],
      [1, "image-1.png"],
    ],
  );

  await redeposer(db, id, page([1, 2]));
  assertEquals(db.prepare("SELECT * FROM images ORDER BY position").all(), avant);
  assertEquals(readdirSync(contenu(id, "assets")).sort(), ["image-0.png", "image-1.png"]);
  const { requete } = await session(db, modeles, "eleve");
  const servie = await requete(`/media/${id}-1`);
  assertEquals(new Uint8Array(await servie.arrayBuffer()), png(2));
});

test("les images d'une version à relire ne sont servies qu'une fois la version certifiée", async () => {
  const { db } = await environnement();
  const id = await source(db);
  const avant = images(db);
  const { requete } = await session(db, modeles, "eleve");

  await redeposer(db, id, page([1, 3], "<p>Un paragraphe de plus change le texte.</p>"));
  assertEquals(revisionEnAttente(db, id)?.n, 2);
  assertEquals(images(db), avant);
  assertEquals(fichiers(id), 2);
  assertEquals(fichiers(id, "revisions", "2"), 1, "seule l'image nouvelle est écrite");
  assert(!(await (await requete(`/eleve/sources/${id}`)).text()).includes(`/media/${id}-2`));
  const rappel = () => db.prepare("SELECT group_concat(rappel) r FROM chunks").get()!.r as string;
  assert(!rappel().includes("Croquis 3"));

  statuer(db, id, "certifiee", "Test", 2);
  assertEquals(images(db), [
    [`${id}-0`, 1, "Croquis 1", "unreviewed"],
    [`${id}-2`, 2, "Croquis 3", "unreviewed"],
  ]);
  assert(rappel().includes("Croquis 3") && !rappel().includes("Croquis 2"));
  assertEquals((await requete(`/media/${id}-2`)).status, 200);
  assertEquals((await requete(`/media/${id}-1`)).status, 404);
  assertEquals(fichiers(id), 1, "le fichier de l'image retirée part avec sa ligne");

  // `reextraire` ne lit pas les images : sa version n'en apporte ni n'en retire.
  writeFileSync(contenu(id, "original", "croquis.html"), page([], "<p>Un autre texte.</p>"));
  assertEquals(await reextraire(db, id), "revision");
  assert(!existsSync(contenu(id, "revisions", "3", "images.jsonl")));
  statuer(db, id, "certifiee", "Test", 3);
  assertEquals(images(db).length, 2);
});
