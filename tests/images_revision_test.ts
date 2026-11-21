import { existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { assert, assertEquals } from "@std/assert";
import { bloquantes } from "../src/app/activites.ts";
import { contenu } from "../src/app/config.ts";
import type { Db } from "../src/app/db.ts";
import { deposer, valider } from "../src/app/depot.ts";
import { cours, matiere } from "../src/app/domaines.ts";
import {
  lireDocument,
  reextraire,
  relireLegende,
  revendiquer,
  revisionEnAttente,
  statuer,
  traiter,
} from "../src/app/ingestion.ts";
import { lireInstance } from "../src/app/instance.ts";
import { environnement, fauxModeles, session } from "./outils.ts";
import { modifier } from "./activites_outils.ts";
import { compte, exercice, libre, page as lire, publie } from "./pratique_outils.ts";

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
async function source(db: Db, coursId?: string) {
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
    liens: coursId ? [{ cours_id: coursId, theme_id: null }] : undefined,
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

  // Même texte, autre ordre, une image de plus : une version à relire, que l'enseignant certifie.
  await redeposer(db, id, page([2, 1, 3]));
  statuer(db, id, "certifiee", "Test", 2);
  assertEquals(images(db), [
    [`${id}-1`, 1, "Croquis relu", "certified"],
    [`${id}-0`, 1, "Croquis 1", "unreviewed"],
    [`${id}-2`, 2, "Croquis 3", "unreviewed"],
  ]);
  assertEquals([fichiers(id), fichiers(id, "revisions", "2")], [2, 1]);

  // Une image que la version certifiée ne rend plus sort, avec son fichier.
  await redeposer(db, id, page([2]));
  statuer(db, id, "certifiee", "Test", 3);
  assertEquals(images(db), [[`${id}-1`, 1, "Croquis relu", "certified"]]);
  assertEquals([fichiers(id), fichiers(id, "revisions", "2")], [1, 0]);
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

test("des images différentes sous un texte identique font une version à relire", async () => {
  const { db } = await environnement();
  const id = await source(db);
  const avant = images(db);
  const { requete } = await session(db, modeles, "eleve");

  await redeposer(db, id, page([1, 3]));
  assertEquals(revisionEnAttente(db, id)?.n, 2);
  assertEquals(images(db), avant, "les images servies attendent la relecture");
  assertEquals(lireDocument(id, 2).texte, lireDocument(id, 1).texte);
  assertEquals((await requete(`/media/${id}-2`)).status, 404);
  assert(!(await (await requete(`/eleve/sources/${id}`)).text()).includes("Croquis 3"));
  // `reextraire` ne lit pas les images : elle ne sait pas si celles de la version sont revenues.
  assertEquals(await reextraire(db, id), "identique");
  assertEquals(revisionEnAttente(db, id)?.n, 2);

  // Les images servies reviennent, dans un autre ordre : plus rien à relire.
  await redeposer(db, id, page([2, 1]));
  assertEquals(revisionEnAttente(db, id), undefined);
  assert(!existsSync(contenu(id, "revisions", "2")));
  assertEquals(images(db), [avant[1], avant[0]]);

  await redeposer(db, id, page([1, 3]));
  statuer(db, id, "certifiee", "Test", 2);
  assertEquals(images(db), [
    [`${id}-0`, 1, "Croquis 1", "unreviewed"],
    [`${id}-2`, 2, "Croquis 3", "unreviewed"],
  ]);
  assertEquals((await requete(`/media/${id}-2`)).status, 200);

  // Aucun élève ne lit une source rejetée : ses images se rangent en place, comme à la première
  // extraction.
  statuer(db, id, "rejetee", "Test");
  await redeposer(db, id, page([3]));
  assertEquals(revisionEnAttente(db, id), undefined);
  assertEquals(images(db), [[`${id}-2`, 2, "Croquis 3", "unreviewed"]]);
});

test("la relecture d'une version montre les images qu'elle ajoute et nomme celles qui partent", async () => {
  const { db } = await environnement();
  const coursId = cours(db, matiere(db, "Arts appliqués"), "Design");
  const id = await source(db, coursId);
  const prof = await compte(db, "enseignant");
  const collegue = await compte(db, "enseignant", false);
  const eleve = await compte(db, "eleve");
  await redeposer(db, id, page([1, 3]));

  const [ajoutee] = readdirSync(contenu(id, "revisions", "2", "assets"));
  const adresse = `/prof/sources/${id}/revisions/2/images/${ajoutee}`;
  const fiche = await lire(prof, `/prof/sources/${id}`);
  assert(fiche.includes(`src="${adresse}"`), "l'image ajoutée");
  assert(fiche.includes("Croquis 3"), "sa légende proposée");
  assert(/retire 1 image.*Croquis 2/s.test(fiche), "l'image qui part est nommée");

  const servie = await prof.requete(adresse);
  assertEquals(servie.status, 200);
  assertEquals(servie.headers.get("cache-control"), "no-store");
  assertEquals(new Uint8Array(await servie.arrayBuffer()), png(3));
  // Seuls ceux qui modifient la source voient les images d'une version que personne n'a certifiée.
  assertEquals((await collegue.requete(adresse)).status, 404);
  assert(!(await lire(collegue, `/prof/sources/${id}`)).includes(adresse));
  assertEquals((await eleve.requete(adresse)).status, 403);
  assert(!(await lire(eleve, `/eleve/sources/${id}`)).includes(ajoutee));
  for (const autre of [
    `/prof/sources/${id}/revisions/3/images/${ajoutee}`,
    `/prof/sources/${id}/revisions/2/images/images.jsonl`,
    `/prof/sources/${id}/revisions/2/images/..%2Fdocument.txt`,
  ]) {
    assertEquals((await prof.requete(autre)).status, 404, autre);
  }

  statuer(db, id, "certifiee", "Test", 2);
  assertEquals((await prof.requete(adresse)).status, 404, "la version n'attend plus");
  assertEquals((await eleve.requete(`/media/${id}-2`)).status, 200);
});

test("une activité qui montre une image retirée devient à revoir, et son numéro ne revient pas", async () => {
  const { db } = await environnement();
  const coursId = cours(db, matiere(db, "Arts appliqués"), "Design");
  const id = await source(db, coursId);
  const prof = await compte(db, "enseignant");
  const eleve = await compte(db, "eleve");
  const activite = publie(
    db,
    prof.compte,
    exercice(db, prof.compte, coursId, {
      correction: "serie",
      questions: [
        {
          id: "q1",
          type: "terme",
          consigne: libre("Que montre ce croquis ?"),
          retour: libre(""),
          accepte: ["la façade"],
          image: { media: `${id}-1`, source: id, alt: "Un croquis" },
        },
      ],
    }),
  );
  const etat = () => db.prepare("SELECT etat FROM activites").get()!.etat;

  // La version en attente ne change rien pour l'élève.
  await redeposer(db, id, page([1]));
  assertEquals(etat(), "publiee");
  assert((await lire(eleve, `/eleve/activites/${activite.id}`)).includes(`/media/${id}-1`));

  statuer(db, id, "certifiee", "Test", 2);
  assertEquals(etat(), "a_revoir");
  assertEquals(bloquantes(db, activite, coursId), ["Les croquis (image retirée)"]);
  // La page de l'élève revérifie à chaque affichage, sans attendre le signalement.
  db.prepare("UPDATE activites SET etat = 'publiee'").run();
  assertEquals((await eleve.requete(`/eleve/activites/${activite.id}`)).status, 404);

  // Le numéro 1 était le plus grand : une image nouvelle ne le reprend pas.
  await redeposer(db, id, page([1, 3]));
  statuer(db, id, "certifiee", "Test", 3);
  assertEquals(images(db), [
    [`${id}-0`, 1, "Croquis 1", "unreviewed"],
    [`${id}-2`, 3, "Croquis 3", "unreviewed"],
  ]);
  assertEquals(bloquantes(db, activite, coursId), ["Les croquis (image retirée)"]);

  // L'enseignant retire l'image de la question : l'activité redevient un brouillon à relire.
  db.prepare("UPDATE activites SET etat = 'a_revoir'").run();
  assertEquals((await modifier(prof, db, activite.id, { image_retirer: "1" })).status, 303);
  assertEquals(etat(), "brouillon");
});
