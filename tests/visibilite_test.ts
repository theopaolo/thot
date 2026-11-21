import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { PanneModele } from "../src/core/modeles.ts";
import { chercherFts } from "../src/core/recherche.ts";
import { demander } from "../src/core/reponse.ts";
import { relireLegende, revendiquer, statuer, traiter } from "../src/app/ingestion.ts";
import { faitAuHasard, sourceSansSuggestions } from "../src/app/suggestions.ts";
import { cours, matiere } from "../src/app/domaines.ts";
import { environnement, fauxModeles, session } from "./outils.ts";
import {
  CHAMPS,
  ELEVE,
  formulaire,
  PAGE,
  sourceTraitee,
  suivre,
  variante,
} from "./source_outils.ts";

test("une session élève reçoit 403 sur chaque route enseignant", async () => {
  const { db } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "eleve");
  for (const chemin of ["/prof", "/prof/depot", "/prof/legendes", "/prof/sources/x"]) {
    assertEquals((await requete(chemin)).status, 403, chemin);
  }
  assertEquals(
    (await requete("/prof/sources/statut", { method: "POST", body: new FormData() })).status,
    403,
  );
  assertEquals((await requete("/eleve")).status, 200);
});

test("une source non certifiée n'apparaît sur aucune route élève ni dans l'index", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  const { requete } = await session(db, fauxModeles().modeles, "eleve");
  assert(!(await (await requete("/eleve")).text()).includes("Art nouveau, panorama"));
  assertEquals((await requete(`/eleve/sources/${id}`)).status, 404);
  assertEquals((await requete(`/media/${id}-0`)).status, 404);
  assertEquals(
    chercherFts(db, "Casa Batlló façade", { lecteur: null, schoolId: "pilote" }).length,
    0,
  );

  statuer(db, id, "certifiee", "test");
  assertStringIncludes(await (await requete("/eleve")).text(), "Art nouveau, panorama");
  assertEquals((await requete(`/eleve/sources/${id}`)).status, 200);
  assertEquals(
    chercherFts(db, "Casa Batlló façade", { lecteur: null, schoolId: "pilote" }).length,
    1,
  );

  statuer(db, id, "rejetee", "test");
  assertEquals((await requete(`/eleve/sources/${id}`)).status, 404);
  assertEquals(
    chercherFts(db, "Casa Batlló façade", { lecteur: null, schoolId: "pilote" }).length,
    0,
  );
});

test("les documents sans thème ont leur propre route, distincte d'un thème homonyme", async () => {
  const { db, dir } = await environnement();
  try {
    cours(db, matiere(db, "Arts appliqués", "arts-appliques"), "Arts appliqués");
    const { requete } = await session(db, fauxModeles().modeles, "enseignant");
    const ids: string[] = [];
    for (const sequence of ["", "Sans séquence"]) {
      await requete("/prof/depot", {
        method: "POST",
        body: formulaire(
          { ...CHAMPS, titre: sequence ? "Cours nommé" : "Cours non classé", sequence },
          variante(PAGE, sequence),
          "casa.html",
        ),
      });
      const job = revendiquer(db)!;
      await traiter(db, job, fauxModeles().modeles);
      statuer(db, job.source_id, "certifiee", "Prof");
      ids.push(job.source_id);
    }
    const eleve = await session(db, fauxModeles().modeles, "eleve");
    const accueil = await (await eleve.requete("/eleve")).text();
    const theme = db
      .prepare("SELECT theme_id FROM source_cours WHERE source_id = ?")
      .get(ids[1])!.theme_id;
    // L'ancienne adresse de la séquence mène au thème du même nom.
    const ancienne = await eleve.requete(`/eleve/sequences/Sans%20s%C3%A9quence?doc=${ids[1]}`);
    assertEquals(ancienne.headers.get("location"), `/eleve/themes/${theme}?doc=${ids[1]}`);
    const chemins = ["/eleve/sans-sequence", `/eleve/themes/${theme}`];
    for (const [i, chemin] of chemins.entries()) {
      assertStringIncludes(accueil, `href="${chemin}"`);
      const r = await eleve.requete(`${chemin}?doc=${ids[i]}`);
      assertEquals(r.status, 200);
      const page = await r.text();
      assertStringIncludes(page, `href="/eleve/sources/${ids[i]}"`);
      assert(!page.includes(ids[1 - i]));
      assertStringIncludes(page, `hx-push-url="${chemin}?doc=${ids[i]}"`);
      const document = await (await eleve.requete(`/eleve/sources/${ids[i]}`)).text();
      assertStringIncludes(document, `href="${chemin}?doc=${ids[i]}"`);
    }
    statuer(db, ids[0], "rejetee", "Prof");
    assertEquals((await eleve.requete("/eleve/sans-sequence")).status, 404);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("sans public Élèves, une source certifiée reste invisible aux élèves et à Thot", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db, undefined, { audience: "collegues", reponses: true });
  statuer(db, id, "certifiee", "test");
  const prof = await session(db, fauxModeles().modeles, "enseignant");
  const eleve = await session(db, fauxModeles().modeles, "eleve");

  assertEquals((await prof.requete(`/prof/sources/${id}`)).status, 200);
  assertEquals((await prof.requete(`/media/${id}-0`)).status, 200);
  assert(!(await (await eleve.requete("/eleve")).text()).includes(CHAMPS.titre));
  for (const chemin of [
    `/eleve/sequences/${encodeURIComponent(CHAMPS.sequence)}`,
    `/eleve/documents/${id}/apercu`,
    `/eleve/sources/${id}`,
    `/media/${id}-0`,
  ])
    assertEquals((await suivre(eleve, chemin)).status, 404, chemin);
  assertEquals(
    (
      await eleve.requete("/eleve/questions", {
        method: "POST",
        body: new URLSearchParams({ texte: "Pourquoi ?", chapitre: CHAMPS.sequence }),
      })
    ).status,
    400,
  );
  assertEquals(
    chercherFts(db, "Casa Batlló façade", { lecteur: null, schoolId: "pilote" }).length,
    0,
  );
  assertEquals(faitAuHasard(db, ELEVE), undefined);
  assertEquals(sourceSansSuggestions(db), undefined);
});

test("sans public Thot, une source reste lisible mais ne sert pas aux réponses", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db, undefined, { audience: "eleves", reponses: false });
  statuer(db, id, "certifiee", "test");
  const { requete } = await session(db, fauxModeles().modeles, "eleve");

  assertStringIncludes(await (await requete("/eleve")).text(), CHAMPS.titre);
  assertEquals((await requete(`/eleve/sources/${id}`)).status, 200);
  assertEquals((await requete(`/media/${id}-0`)).status, 200);
  assertEquals(
    chercherFts(db, "Casa Batlló façade", { lecteur: null, schoolId: "pilote" }).length,
    0,
  );
  assertEquals(sourceSansSuggestions(db), undefined);
  assertEquals(
    (
      await demander(
        db,
        fauxModeles().modeles,
        "Pourquoi Gaudí refuse la ligne droite ?",
        { lecteur: null, schoolId: "pilote" },
        0.023,
      )
    ).resultat.etat,
    "out_of_corpus",
  );
});

test("une légende non relue aide la recherche mais n'atteint jamais le générateur", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db, "Carapace de dragon en écailles turquoise.");
  statuer(db, id, "certifiee", "test");
  // Le mot n'est que dans la légende: la recherche le trouve grâce à elle.
  assertEquals(
    chercherFts(db, "dragon turquoise", { lecteur: null, schoolId: "pilote" }).length,
    1,
  );

  const f = fauxModeles({ sorties: ['{"refus": true}'] });
  await demander(db, f.modeles, "dragon turquoise", { lecteur: null, schoolId: "pilote" }, 0.023);
  assert(!JSON.stringify(f.vus).includes("Carapace"), "légende non relue envoyée au générateur");

  relireLegende(db, `${id}-0`, "certified", "", "test");
  const g = fauxModeles({ sorties: ['{"refus": true}'] });
  await demander(db, g.modeles, "dragon turquoise", { lecteur: null, schoolId: "pilote" }, 0.023);
  assertStringIncludes(JSON.stringify(g.vus), "Image : Carapace de dragon");
});

test("la recherche trouve une image par sa légende non relue sans la montrer", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db, "Carapace de dragon en écailles turquoise.", {
    audience: "eleves",
    reponses: false,
  });
  statuer(db, id, "certifiee", "test");
  const { requete } = await session(db, fauxModeles().modeles, "eleve");

  const page = await (await requete("/eleve/recherche?q=dragon%20turquoise")).text();
  assertStringIncludes(page, `/media/${id}-0`);
  assertStringIncludes(page, CHAMPS.titre);
  assert(!page.includes("Carapace"), "légende non relue montrée à l'élève");
  // Sous le seuil, la page ne montre rien.
  const { requete: bas } = await session(db, fauxModeles({ score: 0.01 }).modeles, "eleve");
  assert(!(await (await bas("/eleve/recherche?q=dragon")).text()).includes(`/media/${id}-0`));
  // Reclasseur en panne: les résultats suivent l'ordre de FTS5.
  const sans = fauxModeles();
  sans.modeles.reclasser = () => Promise.reject(new PanneModele("reclasseur 503"));
  const { requete: repli } = await session(db, sans.modeles, "eleve");
  assertStringIncludes(
    await (await repli("/eleve/recherche?q=dragon%20turquoise")).text(),
    `/media/${id}-0`,
  );
});
