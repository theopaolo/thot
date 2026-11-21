import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { RACINE } from "../src/app/config.ts";
import type { Db } from "../src/app/db.ts";
import { deposer, valider } from "../src/app/depot.ts";
import { revendiquer, statuer, traiter } from "../src/app/ingestion.ts";
import { lireInstance } from "../src/app/instance.ts";
import { environnement, fauxModeles, ORIGINE, session } from "./outils.ts";

/** Une source extraite et laissée à relire. */
async function deposee(db: Db, titre: string, audience: "prive" | "collegues" = "collegues") {
  const v = valider({ titre, type_document: "cours" });
  assert("meta" in v);
  const proprietaireId = db
    .prepare("SELECT id FROM comptes WHERE role = 'enseignant' LIMIT 1")
    .get()?.id as string | undefined;
  const { source_id } = await deposer(db, {
    meta: v.meta,
    nomFichier: "cours.html",
    format: "html",
    schoolId: lireInstance(db).school_id,
    enseignant: "Prof",
    proprietaireId,
    audience,
    reponses: true,
    octets: new TextEncoder().encode(`<html><h1>${titre}</h1><p>Texte de ${titre}.</p></html>`),
  });
  await traiter(db, revendiquer(db)!, fauxModeles().modeles);
  return source_id;
}

const poster = (s: Awaited<ReturnType<typeof session>>, chemin: string) =>
  s.app.request(chemin, {
    method: "POST",
    headers: { cookie: s.cookie, origin: ORIGINE },
  });
const statutDe = (db: Db, id: string) =>
  db.prepare("SELECT statut FROM sources WHERE id = ?").get(id)?.statut;

test("relecture : la liste montre les ressources à relire, pas les certifiées", async () => {
  const { db } = await environnement();
  const prof = await session(db, fauxModeles().modeles, "enseignant");
  const a = await deposee(db, "Alpha", "collegues");
  const b = await deposee(db, "Bêta", "collegues");
  statuer(db, b, "certifiee", "Test");
  const r = await prof.requete("/prof/relecture");
  assertEquals(r.status, 200);
  const corps = await r.text();
  assertStringIncludes(corps, "Alpha");
  assertStringIncludes(corps, "Sans cours");
  assert(!corps.includes("Bêta"));
  assertStringIncludes(corps, `/prof/relecture/${a}/certifiee`);
  assertStringIncludes(await (await prof.requete("/prof")).text(), "Relire une par une");
});

test("relecture : certifier ouvre la suivante, la dernière mène à l'état vide", async () => {
  const { db } = await environnement();
  const prof = await session(db, fauxModeles().modeles, "enseignant");
  const a = await deposee(db, "Alpha", "collegues");
  const b = await deposee(db, "Bêta", "collegues");
  let r = await poster(prof, `/prof/relecture/${a}/certifiee`);
  assertEquals(r.status, 303);
  assertEquals(r.headers.get("location"), `/prof/relecture?id=${b}`);
  assertEquals(statutDe(db, a), "certifiee");
  r = await poster(prof, `/prof/relecture/${b}/rejetee`);
  assertEquals(r.status, 303);
  assertEquals(r.headers.get("location"), "/prof/relecture");
  assertEquals(statutDe(db, b), "rejetee");
  assertStringIncludes(
    await (await prof.requete("/prof/relecture")).text(),
    "aucune n'attend votre relecture.",
  );
  assert(!(await (await prof.requete("/prof")).text()).includes("Relire une par une"));
});

test("relecture : une nouvelle version renvoie à la fiche, sans bouton", async () => {
  const { db } = await environnement();
  const prof = await session(db, fauxModeles().modeles, "enseignant");
  const a = await deposee(db, "Alpha", "collegues");
  statuer(db, a, "certifiee", "Test");
  db.prepare("INSERT INTO revisions (source_id, n, cree_le) VALUES (?, 2, ?)").run(
    a,
    new Date().toISOString(),
  );
  const corps = await (await prof.requete(`/prof/relecture?id=${a}`)).text();
  assertStringIncludes(corps, "Relire la nouvelle version");
  assert(!corps.includes(`/prof/relecture/${a}/certifiee`));
});

test("relecture : un élève n'ouvre ni la page ni les actions", async () => {
  const { db } = await environnement();
  const eleve = await session(db, fauxModeles().modeles, "eleve");
  await session(db, fauxModeles().modeles, "enseignant");
  const a = await deposee(db, "Alpha", "collegues");
  assertEquals((await eleve.requete("/prof/relecture")).status, 403);
  assertEquals((await poster(eleve, `/prof/relecture/${a}/certifiee`)).status, 403);
  assertEquals(statutDe(db, a), "a_relire");
});

test("relecture : un enseignant ne certifie pas la source privée d'un autre", async () => {
  const { db } = await environnement();
  const modeles = fauxModeles().modeles;
  await session(db, modeles, "enseignant", false);
  const autre = await session(db, modeles, "enseignant", false);
  const a = await deposee(db, "Note privée", "prive");
  assertEquals((await poster(autre, `/prof/relecture/${a}/certifiee`)).status, 403);
  assertEquals(statutDe(db, a), "a_relire");
  assert(!(await (await autre.requete("/prof/relecture")).text()).includes("Note privée"));
});

const travail = (db: Db, id: string, etat: string) =>
  db.prepare("UPDATE ingestion_jobs SET etat = ? WHERE source_id = ?").run(etat, id);

test("certifier une sélection : les sources prêtes sont certifiées, les autres nommées avec leur raison", async () => {
  const { db } = await environnement();
  const prof = await session(db, fauxModeles().modeles, "enseignant");
  const encours = await deposee(db, "Bêta");
  const prete = await deposee(db, "Alpha");
  const echouee = await deposee(db, "Gamma");
  const derniere = await deposee(db, "Delta");
  travail(db, encours, "extracting");
  travail(db, echouee, "failed");
  const r = await prof.requete("/prof/sources/statut?statut=a_relire", {
    method: "POST",
    body: new URLSearchParams([
      ["statut", "certifiee"],
      ...[encours, prete, echouee, derniere].map((id) => ["ids", id]),
    ]),
  });
  assertEquals(r.status, 303);
  assertEquals(
    [encours, prete, echouee, derniere].map((id) => statutDe(db, id)),
    ["a_relire", "certifiee", "a_relire", "certifiee"],
  );
  const retour = r.headers.get("location")!;
  assertStringIncludes(retour, "statut=a_relire", "les filtres de la bibliothèque restent");
  const page = await (await prof.requete(retour)).text();
  assertStringIncludes(page, "2 sources");
  assertStringIncludes(page, "Bêta</a> : son extraction");
  assertStringIncludes(page, "Gamma</a> : son traitement a échoué");
  assert(!page.includes("Alpha</a> :"), "une source certifiée n'est pas dans la liste des refus");
  // Un identifiant ajouté à l'adresse ne nomme pas une source que le compte ne lit pas.
  const privee = await deposee(db, "Secrète", "prive");
  db.prepare("UPDATE sources SET proprietaire_id = NULL WHERE id = ?").run(privee);
  assert(!(await (await prof.requete(`/prof?refus=${privee}`)).text()).includes("Secrète"));
});

test("certifier depuis la page d'une source qui n'est pas prête répond 409 avec la raison", async () => {
  const { db } = await environnement();
  const prof = await session(db, fauxModeles().modeles, "enseignant");
  const id = await deposee(db, "Bêta");
  travail(db, id, "enriching");
  const r = await poster(prof, `/prof/sources/${id}/certifiee`);
  assertEquals(r.status, 409);
  assertStringIncludes(await r.text(), "son extraction n'est pas terminée");
  assertEquals(statutDe(db, id), "a_relire");
});

test("CLI : certifier --tout et reextraire continuent après un échec, nomment la source et sortent en 1", async () => {
  const { db, dir } = await environnement();
  try {
    const encours = await deposee(db, "Bêta");
    const prete = await deposee(db, "Alpha");
    travail(db, encours, "extracting");
    const lancer = (...args: string[]) =>
      spawnSync(process.execPath, ["src/cli.ts", ...args], {
        cwd: RACINE,
        encoding: "utf8",
        env: {
          ...process.env,
          THOT_DATA_DIR: dir,
          THOT_ORIGIN: "",
          THOT_OPENROUTER_ENABLED: "0",
          THOT_MISTRAL_ENABLED: "0",
        },
      });
    const certifier = lancer("certifier", "--tout");
    assertEquals(certifier.status, 1, certifier.stderr);
    assertStringIncludes(certifier.stdout, "1 source(s) certifiée(s).");
    assertStringIncludes(certifier.stderr, `Bêta (${encours})`);
    assertStringIncludes(certifier.stderr, "son extraction n'est pas terminée");
    assertEquals([statutDe(db, prete), statutDe(db, encours)], ["certifiee", "a_relire"]);

    // L'original d'une des deux sources a disparu : l'autre se réextrait quand même.
    travail(db, encours, "awaiting_review");
    rmSync(join(dir, "content", encours, "original/cours.html"));
    const reextraire = lancer("reextraire");
    assertEquals(reextraire.status, 1, reextraire.stderr);
    assertStringIncludes(reextraire.stdout, "identique: 1");
    assertStringIncludes(reextraire.stderr, `Bêta (${encours})`);
    assertStringIncludes(reextraire.stderr, "ENOENT");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});
