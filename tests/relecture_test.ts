import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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
