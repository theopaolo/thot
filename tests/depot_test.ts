import { readFile, writeFile } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { detecterFormat, MAX_LOT, MAX_OCTETS, nomSur } from "../src/app/depot.ts";
import { tranche } from "../src/core/texte.ts";
import { lireDocument, reextraire, revendiquer, traiter } from "../src/app/ingestion.ts";
import { config } from "../src/app/config.ts";
import { environnement, fauxModeles, session } from "./outils.ts";
import { type Acces, CHAMPS, enc, formulaire } from "./source_outils.ts";

test("le format vient des octets, un nom reçu ne devient pas un chemin", () => {
  assertEquals(detecterFormat(enc("%PDF-1.7")), "pdf");
  assertEquals(detecterFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "jpg");
  assertEquals(
    detecterFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "png",
  );
  assertEquals(detecterFormat(enc("  <!doctype html><p>a")), "html");
  assertEquals(detecterFormat(enc("MZ binaire")), null);
  assertEquals(nomSur("../../etc/passwd"), "passwd");
  assertEquals(nomSur("Fiche Art Nouveau.pdf"), "Fiche-Art-Nouveau.pdf");
  assertEquals(nomSur("..."), "sans-nom");
});

test("dépôt complet: original écrit, source et travail créés", async () => {
  const { db, dir } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  const r = await requete("/prof/depot", {
    method: "POST",
    body: formulaire(CHAMPS, enc("%PDF-1.7 contenu")),
  });
  assertEquals(r.status, 200);
  assertStringIncludes(await r.text(), "est déposé");
  const s = db.prepare("SELECT id, metadonnees, format FROM sources").get()!;
  assertEquals(s.format, "pdf");
  assertEquals(JSON.parse(s.metadonnees as string).publics, undefined);
  const acces = db.prepare("SELECT audience, reponses, proprietaire_id FROM sources").get()!;
  assertEquals(acces.audience, "eleves");
  assertEquals(acces.reponses, 1);
  assertEquals(acces.proprietaire_id, db.prepare("SELECT id FROM comptes").get()!.id);
  const original = await readFile(
    join(dir, "content", s.id as string, "original", "fiche.pdf"),
    "utf8",
  );
  assertEquals(original, "%PDF-1.7 contenu");
  assertEquals(db.prepare("SELECT etat FROM ingestion_jobs").get()!.etat, "received");
});

test("champs manquants et format refusé: erreurs par champ, saisie conservée", async () => {
  const { db } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  const r = await requete("/prof/depot", {
    method: "POST",
    body: formulaire(
      {
        titre: "   ",
        type_document: "",
        matiere: "",
        classe: "2nde",
        seance: "S1",
      },
      enc("MZ\x90 exe"),
    ),
  });
  assertEquals(r.status, 400);
  const page = await r.text();
  assertStringIncludes(page, 'id="type_document-erreur">Champ obligatoire.');
  assert(!page.includes('id="titre-erreur"'));
  assert(!page.includes('id="matiere-erreur"'));
  assertStringIncludes(page, "Format non reconnu");
  assertStringIncludes(page, 'value="S1"');
  assertEquals(db.prepare("SELECT count(*) n FROM sources").get()!.n, 0);
});

test("les dépôts trop grands sont refusés avant lecture du fichier", async () => {
  const { db } = await environnement();
  const arrayBuffer = File.prototype.arrayBuffer;
  try {
    const prof = await session(db, fauxModeles().modeles, "enseignant");
    let lectures = 0;
    File.prototype.arrayBuffer = function () {
      lectures++;
      return arrayBuffer.call(this);
    };
    const proche = await prof.requete("/prof/depot", {
      method: "POST",
      body: formulaire(CHAMPS, new Uint8Array(MAX_OCTETS + 1)),
    });
    assertEquals(proche.status, 400);
    assertEquals(lectures, 0);
    let lus = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        lus++;
        c.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const trop = await prof.requete("/prof/depot", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      body,
      duplex: "half",
    });
    assertEquals(trop.status, 413);
    assert(lus <= 53, "le flux est arrêté sans lire tout le corps");
    assertEquals(lectures, 0);
    assertEquals(db.prepare("SELECT count(*) n FROM sources").get()!.n, 0);
  } finally {
    File.prototype.arrayBuffer = arrayBuffer;
    db.close();
  }
});

const COURS_MD = enc(
  "---\ntitle: Docker\n---\n\n# Docker\n\nUne **image** décrit le conteneur.\n\n## Construire\n\n```dockerfile\n# Image de base\nFROM node:26\n```\n\n- `docker build` crée l'image\n",
);

test("le Markdown se reconnaît à l'extension et à l'UTF-8, pas au type annoncé", () => {
  assertEquals(detecterFormat(enc("# Titre\n"), "cours.MD"), "md");
  assertEquals(detecterFormat(enc("<details>a</details>"), "cours.markdown"), "md");
  assertEquals(detecterFormat(enc("# Titre\n"), "cours.txt"), null);
  assertEquals(detecterFormat(new Uint8Array([0x23, 0x20, 0xe9, 0x0a]), "cours.md"), null);
  assertEquals(detecterFormat(enc("# a\0b"), "cours.md"), null);
});

test("Markdown non UTF-8 refusé au dépôt", async () => {
  const { db } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  const r = await requete("/prof/depot", {
    method: "POST",
    body: formulaire(CHAMPS, new Uint8Array([0x23, 0x20, 0xe9, 0x0a]), "latin1.md"),
  });
  assertEquals(r.status, 400);
  assertStringIncludes(await r.text(), "Format non reconnu");
  assertEquals(db.prepare("SELECT count(*) n FROM sources").get()!.n, 0);
});

test("Markdown: dépôt, extraction aux offsets exacts, original servi, réextraction identique", async () => {
  const { db } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  const r = await requete("/prof/depot", {
    method: "POST",
    body: formulaire(CHAMPS, COURS_MD, "docker.md"),
  });
  assertEquals(r.status, 200);
  const s = db.prepare("SELECT id, format FROM sources").get()!;
  assertEquals(s.format, "md");
  await traiter(db, revendiquer(db)!, fauxModeles().modeles);

  const { texte, blocs } = lireDocument(s.id as string, 1);
  assertEquals(
    blocs.map((b) => b.section),
    ["Docker", "Docker", "Construire", "Construire", "Construire"],
  );
  for (const b of blocs) assertEquals(tranche(texte, b.debut, b.fin), b.texte);
  assertStringIncludes(texte, "# Image de base\nFROM node:26");
  assert(!texte.includes("**") && !texte.includes("title:"));

  const original = await requete(`/prof/sources/${s.id}/original`);
  assertEquals(original.headers.get("content-type"), "text/markdown; charset=utf-8");
  assertEquals(await reextraire(db, s.id as string), "identique");
});

test("Markdown: réextraire pose l'indicateur de code sur une source déjà importée, sans révision", async () => {
  const { db } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  await requete("/prof/depot", { method: "POST", body: formulaire(CHAMPS, COURS_MD, "docker.md") });
  const id = db.prepare("SELECT id FROM sources").get()!.id as string;
  await traiter(db, revendiquer(db)!, fauxModeles().modeles);
  const fichier = join(config.donnees, "content", id, "blocs.jsonl");
  const actuel = await readFile(fichier, "utf8");
  assertEquals(lireDocument(id, 1).blocs.filter((b) => b.code).length, 1);
  // Les blocs d'avant l'indicateur: même texte, mêmes offsets, pas de `code`.
  const ancien = actuel
    .split("\n")
    .map((l) => JSON.stringify({ ...JSON.parse(l), code: undefined }))
    .join("\n");
  await writeFile(fichier, ancien);
  assert(!lireDocument(id, 1).blocs.some((b) => b.code));
  assertEquals(await reextraire(db, id), "mise_a_jour");
  assertEquals(await readFile(fichier, "utf8"), actuel);
  assertEquals(db.prepare("SELECT count(*) n FROM revisions").get()!.n, 1);
});

/** Un envoi de fichiers sous les champs de `CHAMPS`, sans le titre commun. */
const envoi = (
  fichiers: [string, string | Uint8Array<ArrayBuffer>][],
  acces: Acces = { audience: "eleves", reponses: true },
) => {
  const f = formulaire({ ...CHAMPS, titre: "" }, new Uint8Array(), "vide", acces);
  f.delete("fichier");
  for (const [nom, contenu] of fichiers) f.append("fichier", new File([contenu], nom));
  return f;
};

test("plusieurs fichiers sans JavaScript: chacun se dépose seul dans un même lot", async () => {
  const { db } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  const formulaireDepot = await (await requete("/prof/depot")).text();
  assertStringIncludes(formulaireDepot, "multiple");
  assertStringIncludes(formulaireDepot, 'name="lot"');

  const r = await requete("/prof/depot", {
    method: "POST",
    body: envoi([
      ["un.md", "---\ntitle: Premier chapitre\n---\n# Un\nTexte."],
      ["deux.md", "# Deux\nTexte."],
      ["casse.md", new Uint8Array([0x23, 0x20, 0xe9, 0x0a])],
    ]),
  });
  assertEquals(r.status, 200);
  const page = await r.text();
  assertStringIncludes(page, "2 déposés, 1 erreur");
  assertStringIncludes(page, "« Premier chapitre » est déposé");
  assertStringIncludes(page, "« deux » est déposé");
  assertStringIncludes(page, "casse.md : Format non reconnu");
  const sources = db.prepare("SELECT titre, lot_id FROM sources").all();
  assertEquals(new Set(sources.map((s) => s.titre)), new Set(["Premier chapitre", "deux"]));
  const lot = sources[0].lot_id as string;
  assertEquals(sources[1].lot_id, lot);
  assertEquals(db.prepare("SELECT count(*) n FROM ingestion_jobs").get()!.n, 2);

  await requete("/prof/depot", { method: "POST", body: envoi([["trois.md", "# Trois\n"]]) });
  assertEquals(db.prepare("SELECT count(DISTINCT lot_id) n FROM sources").get()!.n, 2);
  const biblio = await (await requete(`/prof?lot=${lot}`)).text();
  assertStringIncludes(biblio, "Lot déposé : 2 fichiers");
  assertStringIncludes(biblio, "Premier chapitre");
  assert(!biblio.includes("trois"));
});

test("une clé rejouée rend la source créée, un fichier déjà lisible est un doublon", async () => {
  const { db } = await environnement();
  const prof = await session(db, fauxModeles().modeles, "enseignant");
  const autre = await session(db, fauxModeles().modeles, "enseignant");
  const envoyer = async (qui: typeof prof, contenu: string, cle: string, acces?: Acces) => {
    const f = envoi([["a.md", contenu]], acces);
    f.set("titre", "A");
    f.set("cle", cle);
    const r = await qui.requete("/prof/depot", {
      method: "POST",
      headers: { accept: "application/json" },
      body: f,
    });
    return (await r.json()) as Record<string, string>;
  };
  const sources = () => db.prepare("SELECT count(*) n FROM sources").get()!.n;

  const premier = await envoyer(prof, "# A\n", "cle-aaaaaaaa");
  assertEquals(premier.etat, "recu");
  const rejoue = await envoyer(prof, "# A\n", "cle-aaaaaaaa");
  assertEquals(rejoue, { ...premier, nom: "a.md", titre: "A", format: "md" });
  assertEquals([sources(), db.prepare("SELECT count(*) n FROM ingestion_jobs").get()!.n], [1, 1]);

  const doublon = await envoyer(prof, "# A\n", "cle-bbbbbbbb");
  assertEquals([doublon.etat, doublon.id, sources()], ["doublon", premier.id, 1]);

  // Une source privée d'un autre compte n'existe pas pour lui: aucun doublon ne la révèle.
  const prive = { audience: "prive", reponses: false } as const;
  assertEquals((await envoyer(prof, "# Secret\n", "cle-cccccccc", prive)).etat, "recu");
  const recu = await envoyer(autre, "# Secret\n", "cle-dddddddd");
  assertEquals(recu.etat, "recu");
  assertEquals(sources(), 3);
  assertEquals((await envoyer(prof, "# Secret\n", "cle-eeeeeeee")).etat, "doublon");
});

test("un lot compte au plus MAX_LOT fichiers", async () => {
  const { db } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  const fichiers = Array.from({ length: MAX_LOT + 1 }, (_, i): [string, string] => [
    `c${i}.md`,
    `# Chapitre ${i}\n`,
  ]);
  const r = await requete("/prof/depot", { method: "POST", body: envoi(fichiers) });
  assertEquals(r.status, 200);
  assertStringIncludes(await r.text(), `Un lot compte ${MAX_LOT} fichiers au maximum.`);
  assertEquals(db.prepare("SELECT count(*) n FROM sources").get()!.n, MAX_LOT);
});
