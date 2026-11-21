import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { coherent } from "../src/core/document.ts";
import { chercherFts } from "../src/core/recherche.ts";
import { tranche } from "../src/core/texte.ts";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { contenu } from "../src/app/config.ts";
import type { Db } from "../src/app/db.ts";
import {
  lireDocument,
  MAX_LEGENDES,
  reextraire,
  relireLegende,
  revendiquer,
  revisionEnAttente,
  statuer,
  traiter,
} from "../src/app/ingestion.ts";
import { lireInstance } from "../src/app/instance.ts";
import { environnement, fauxModeles, session } from "./outils.ts";
import {
  COURS_DOCX,
  DECK,
  type Diapo,
  docx,
  forme,
  MEDIAS,
  p,
  photo,
  png,
  pptx,
  type Rel,
  t,
} from "./office_outils.ts";

const deposer = (
  requete: (chemin: string, init?: RequestInit) => Response | Promise<Response>,
  octets: Uint8Array,
  nom: string,
) => {
  const f = new FormData();
  f.append("type_document", "cours");
  f.append("audience", "eleves");
  f.append("reponses", "1");
  f.append("fichier", new File([octets as Uint8Array<ArrayBuffer>], nom));
  return requete("/prof/depot", { method: "POST", body: f });
};
const sourceDeposee = (db: Db) =>
  db.prepare("SELECT id, format, titre FROM sources").get() as {
    id: string;
    format: string;
    titre: string;
  };

test("DOCX : dépôt, offsets exacts, image dans sa section, original téléchargé, réextraction identique", async () => {
  const { db } = await environnement();
  const { modeles } = fauxModeles();
  const { requete } = await session(db, modeles, "enseignant");
  assertEquals((await deposer(requete, await COURS_DOCX(), "Casa Batlló.docx")).status, 200);
  const s = sourceDeposee(db);
  assertEquals([s.format, s.titre], ["docx", "Casa Batlló"]);
  await traiter(db, revendiquer(db)!, modeles);
  const doc = lireDocument(s.id, 1);
  assert(coherent(doc));
  for (const b of doc.blocs) assertEquals(tranche(doc.texte, b.debut, b.fin), b.texte);
  assertEquals(db.prepare("SELECT section FROM images").get()!.section, "Les détails");
  const original = await requete(`/prof/sources/${s.id}/original`);
  assertEquals(
    original.headers.get("content-type"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assertStringIncludes(original.headers.get("content-disposition")!, "attachment");
  assertEquals(await reextraire(db, s.id), "identique");
});

test("dépôt : un fichier Office chiffré, à macros ou cassé est refusé avec sa raison", async () => {
  const { db } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  const docm = await docx(p(t("x")), {
    type: "application/vnd.ms-word.document.macroEnabled.main+xml",
  });
  for (const [octets, nom, raison] of [
    [cfb, "protege.docx", "chiffré ou ancien format"],
    [docm, "macro.docx", "macros"],
    [(await COURS_DOCX()).slice(0, -30), "casse.docx", "Archive corrompue"],
  ] as const) {
    const r = await deposer(requete, octets, nom);
    assertEquals(r.status, 400, nom);
    assertStringIncludes(await r.text(), raison);
  }
  assertEquals(db.prepare("SELECT count(*) n FROM sources").get()!.n, 0);
});

test("PPTX : une note de l'orateur qui porte le corrigé n'atteint ni l'index ni l'élève", async () => {
  const { db } = await environnement();
  const { modeles } = fauxModeles({ legende: "Façade ondulée" });
  const auteur = await session(db, modeles, "enseignant");
  const deck = await pptx(DECK, { medias: MEDIAS });
  assertEquals((await deposer(auteur.requete, deck, "Art nouveau.pptx")).status, 200);
  const s = sourceDeposee(db);
  assertEquals(s.format, "pptx");
  await traiter(db, revendiquer(db)!, modeles);
  statuer(db, s.id, "certifiee", "Test");

  const doc = lireDocument(s.id, 1);
  assert(coherent(doc));
  assert(!doc.texte.includes("Corrigé") && !doc.texte.includes("1907"));
  const fuites = db
    .prepare(
      "SELECT count(*) n FROM chunks WHERE texte LIKE '%1907%' OR rappel LIKE '%1907%' OR preuve LIKE '%1907%'",
    )
    .get()!.n;
  assertEquals(fuites, 0);
  const schoolId = lireInstance(db).school_id;
  assertEquals(chercherFts(db, "corrigé évaluation 1907", { lecteur: null, schoolId }), []);
  assert(chercherFts(db, "céramique fer forgé", { lecteur: null, schoolId }).length > 0);
  // La légende accompagne le passage de sa diapositive, pas le premier du document.
  const chunks = db.prepare("SELECT titre, rappel FROM chunks ORDER BY n").all() as {
    titre: string;
    rappel: string;
  }[];
  assertEquals(
    chunks.filter((c) => c.rappel.includes("Façade ondulée")).map((c) => c.titre),
    ["Art nouveau : Diapositive 2 : Matériaux", "Art nouveau : Diapositive 4"],
  );

  assertEquals(await reextraire(db, s.id), "identique");

  // L'élève lit les diapositives, sans les notes ni l'original. Une citation ouvre sa diapositive.
  const eleve = await session(db, modeles, "eleve");
  const verre = doc.blocs.find((b) => b.texte === "Verre")!;
  const lecture = await (
    await eleve.requete(`/eleve/sources/${s.id}?revision=1&debut=${verre.debut}&fin=${verre.fin}`)
  ).text();
  const titre = lecture.indexOf("Diapositive 2 : Matériaux");
  assert(titre >= 0 && titre < lecture.indexOf('<mark id="passage">Verre</mark>'));
  assert(!lecture.includes("Corrigé"));
  assertEquals((await eleve.requete(`/prof/sources/${s.id}/original`)).status, 403);

  // L'auteur relit les notes. Un collègue qui lit la source sans la relire ne les voit pas.
  const relecture = await (await auteur.requete(`/prof/sources/${s.id}`)).text();
  assertStringIncludes(relecture, "Notes de l'orateur");
  assertStringIncludes(relecture, "la réponse est 1907.");
  assertEquals((await auteur.requete(`/prof/sources/${s.id}/original`)).status, 200);
  const collegue = await session(db, modeles, "enseignant", false);
  const vue = await collegue.requete(`/prof/sources/${s.id}`);
  assertEquals(vue.status, 200);
  assert(!(await vue.text()).includes("1907"));
  assertEquals((await collegue.requete(`/prof/sources/${s.id}/original`)).status, 403);

  // Les notes viennent du dossier de la révision, écrit par le worker : la page ne rouvre pas
  // l'original. `document.txt` ne les contient pas.
  assertStringIncludes(readFileSync(contenu(s.id, "notes.json"), "utf8"), "1907");
  rmSync(contenu(s.id, "original"), { recursive: true });
  assertStringIncludes(
    await (await auteur.requete(`/prof/sources/${s.id}`)).text(),
    "la réponse est 1907.",
  );
  // Une présentation extraite avant ce fichier : la page le dit, sans lire l'original.
  rmSync(contenu(s.id, "notes.json"));
  assertStringIncludes(
    await (await auteur.requete(`/prof/sources/${s.id}`)).text(),
    "n'ont pas été lues",
  );
});

test("légendes : au plus MAX_LEGENDES images légendées par extraction, les autres comptées", async () => {
  const { db } = await environnement();
  let appels = 0;
  const modeles = {
    ...fauxModeles().modeles,
    legender: () => Promise.resolve({ texte: `Image ${++appels}.`, modele: "faux-vl" }),
  };
  const { requete } = await session(db, modeles, "enseignant");
  const n = MAX_LEGENDES + 3;
  const medias: Record<string, Uint8Array> = {};
  for (let i = 0; i < n; i++) medias[`i${i}.png`] = png(2, 2 + i);
  const deck = await pptx(
    [
      {
        formes: Object.keys(medias)
          .map((_, i) => photo(`rId${i}`))
          .join(""),
        rels: Object.keys(medias).map((nom, i): Rel => [`rId${i}`, "image", `../media/${nom}`]),
      },
    ],
    { medias },
  );
  await deposer(requete, deck, "images.pptx");
  await traiter(db, revendiquer(db)!, modeles);
  assertEquals(appels, MAX_LEGENDES);
  assertEquals(db.prepare("SELECT count(*) n FROM images").get()!.n, n);
  assertEquals(
    db.prepare("SELECT count(*) n FROM images WHERE legende IS NULL").get()!.n,
    3,
    "les premières images du document sont légendées",
  );
  assertEquals(
    db.prepare("SELECT max(position) p FROM images WHERE legende IS NOT NULL").get()!.p,
    MAX_LEGENDES - 1,
  );
  const { avertissements } = db.prepare("SELECT avertissements FROM ingestion_jobs").get()!;
  assertStringIncludes(String(avertissements), "3 images sans légende proposée");
});

test("PPTX : inclure les diapositives masquées relance l'extraction en une version à relire", async () => {
  const { db } = await environnement();
  const { modeles } = fauxModeles();
  const { requete } = await session(db, modeles, "enseignant");
  await deposer(requete, await pptx(DECK, { medias: MEDIAS }), "deck.pptx");
  const s = sourceDeposee(db);
  await traiter(db, revendiquer(db)!, modeles);
  statuer(db, s.id, "certifiee", "Test");
  assertStringIncludes(await (await requete(`/prof/sources/${s.id}`)).text(), "Les inclure");

  const inclure = (valeur: string) =>
    requete(`/prof/sources/${s.id}/diapositives-masquees`, {
      method: "POST",
      body: new URLSearchParams({ inclure: valeur }),
    });
  assertEquals((await inclure("1")).status, 303);
  // Une seconde demande pendant l'extraction est refusée.
  assertEquals((await inclure("0")).status, 409);
  await traiter(db, revendiquer(db)!, modeles);

  assertEquals(revisionEnAttente(db, s.id)?.n, 2);
  assertStringIncludes(lireDocument(s.id, 2).texte, "Diapositive 3 (masquée) : Brouillon");
  assert(!lireDocument(s.id, 1).texte.includes("Brouillon"), "la version servie ne change pas");
  assertStringIncludes(await (await requete(`/prof/sources/${s.id}`)).text(), "Les exclure");
});

// Une image par diapositive, la deuxième masquée : l'inclure décale la troisième image.
const TROIS: Diapo[] = [1, 2, 3].map((n) => ({
  formes: forme("title", `Partie ${n}`) + photo("rIdI"),
  masquee: n === 2,
  rels: [["rIdI", "image", `../media/i${n}.png`]],
}));
const IMAGES = { "i1.png": png(2, 2, 1), "i2.png": png(2, 2, 2), "i3.png": png(2, 2, 3) };

/** Une présentation certifiée dont la légende de la dernière image est relue. */
async function presentationRelue() {
  const { db } = await environnement();
  const modeles = {
    ...fauxModeles().modeles,
    legender: (o: Uint8Array) => Promise.resolve({ texte: `Croquis ${o[39]}`, modele: "faux-vl" }),
  };
  const prof = await session(db, modeles, "enseignant");
  await deposer(prof.requete, await pptx(TROIS, { medias: IMAGES }), "croquis.pptx");
  const s = sourceDeposee(db);
  await traiter(db, revendiquer(db)!, modeles);
  statuer(db, s.id, "certifiee", "Test");
  relireLegende(db, `${s.id}-1`, "certified", "Croquis relu", "Test", "Atelier");
  const eleve = await session(db, modeles, "eleve");
  const basculer = async (inclure: string) => {
    await prof.requete(`/prof/sources/${s.id}/diapositives-masquees`, {
      method: "POST",
      body: new URLSearchParams({ inclure }),
    });
    await traiter(db, revendiquer(db)!, modeles);
  };
  const statuerRevision = (n: number, statut: string) =>
    prof.requete(`/prof/sources/${s.id}/revisions/${n}/${statut}`, { method: "POST" });
  const images = () =>
    db
      .prepare(
        "SELECT id, position, revision, legende, legende_statut, credit FROM images ORDER BY position",
      )
      .all()
      .map((i) => [i.id, i.revision, i.legende, i.legende_statut, i.credit]);
  const rappels = () =>
    db
      .prepare("SELECT rappel FROM chunks")
      .all()
      .map((c) => c.rappel)
      .join("\n");
  return { db, s, prof, eleve, basculer, statuerRevision, images, rappels };
}

test("PPTX : l'image d'une diapositive masquée attend la certification de sa version", async () => {
  const { db, s, eleve, basculer, statuerRevision, images, rappels } = await presentationRelue();
  const avant = images();
  assertEquals(avant, [
    [`${s.id}-0`, 1, "Croquis 1", "unreviewed", null],
    [`${s.id}-1`, 1, "Croquis relu", "certified", "Atelier"],
  ]);

  await basculer("1");
  assertEquals(revisionEnAttente(db, s.id)?.n, 2);
  // La version attend sa relecture : rien de la diapositive masquée n'est servi.
  assertEquals(images(), avant);
  assert(!rappels().includes("Croquis 2"));
  const page = await (await eleve.requete(`/eleve/sources/${s.id}`)).text();
  assertEquals(page.match(/\/media\/[\w-]+/g), [`/media/${s.id}-0`, `/media/${s.id}-1`]);
  assertEquals((await eleve.requete(`/media/${s.id}-2`)).status, 404);

  // Certifiée, la version sert ses images. La légende relue a suivi son image d'une place.
  assertEquals((await statuerRevision(2, "certifiee")).status, 303);
  assertEquals(images(), [
    [`${s.id}-0`, 1, "Croquis 1", "unreviewed", null],
    [`${s.id}-2`, 2, "Croquis 2", "unreviewed", null],
    [`${s.id}-1`, 1, "Croquis relu", "certified", "Atelier"],
  ]);
  assertStringIncludes(rappels(), "Croquis 2");
  const masquee = await eleve.requete(`/media/${s.id}-2`);
  assertEquals(masquee.status, 200);
  assertEquals(new Uint8Array(await masquee.arrayBuffer()), IMAGES["i2.png"]);

  // Exclure de nouveau puis certifier retire l'image, sa ligne et son fichier.
  await basculer("0");
  assertEquals(images().length, 3, "la version servie garde ses images jusqu'à la relecture");
  assertEquals((await statuerRevision(3, "certifiee")).status, 303);
  assertEquals(images(), avant);
  assert(!rappels().includes("Croquis 2"));
  assertEquals((await eleve.requete(`/media/${s.id}-2`)).status, 404);
  assertEquals(readdirSync(contenu(s.id, "revisions", "2", "assets")), []);
});

test("PPTX : rejeter la version efface les images qu'elle apportait", async () => {
  const { db, s, basculer, statuerRevision, images } = await presentationRelue();
  const avant = images();
  await basculer("1");
  assertEquals(readdirSync(contenu(s.id, "revisions", "2", "assets")).length, 1);
  assertEquals((await statuerRevision(2, "rejetee")).status, 303);
  assert(!existsSync(contenu(s.id, "revisions", "2")));
  assertEquals(images(), avant);
  assertEquals(revisionEnAttente(db, s.id), undefined);
});

test("PPTX : « Les inclure » puis « Les exclure » ne laisse aucune version à relire", async () => {
  const { db, s, prof, basculer, images } = await presentationRelue();
  const avant = images();
  await basculer("1");
  assertStringIncludes(
    await (await prof.requete(`/prof/sources/${s.id}`)).text(),
    "Nouvelle version à relire",
  );
  await basculer("0");
  assertEquals(revisionEnAttente(db, s.id), undefined);
  assert(!existsSync(contenu(s.id, "revisions", "2")));
  assert(
    !(await (await prof.requete(`/prof/sources/${s.id}`)).text()).includes(
      "Nouvelle version à relire",
    ),
  );
  assertEquals(images(), avant);
  assert(!lireDocument(s.id, 1).texte.includes("masquée"));
});
