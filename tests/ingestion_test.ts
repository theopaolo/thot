import { readFile, writeFile, rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "node:path";
import { chercherFts } from "../src/core/recherche.ts";
import { demander } from "../src/core/reponse.ts";
import { purgerMessages } from "../src/app/db.ts";
import {
  lireInformations,
  proposerInformations,
  reextraire,
  relireLegende,
  revendiquer,
  sourceSansInformations,
  statuer,
  traiter,
} from "../src/app/ingestion.ts";
import { config } from "../src/app/config.ts";
import { environnement, fauxModeles, session } from "./outils.ts";
import {
  CHAMPS,
  enc,
  formulaire,
  PAGE,
  poserQuestion,
  REPONSE_CITEE,
  sourceTraitee,
  suivre,
  variante,
} from "./source_outils.ts";

test("réextraire met à jour les sections en place, jamais le texte des citations", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  assertEquals(await reextraire(db, id), "identique");
  const blocs = join(config.donnees, "content", id, "blocs.jsonl");
  const avant = await readFile(blocs, "utf8");
  await writeFile(blocs, avant.replaceAll('"section":"', '"section":"ancienne '));
  assertEquals(await reextraire(db, id), "mise_a_jour");
  assertEquals(await readFile(blocs, "utf8"), avant);
  const doc = join(config.donnees, "content", id, "document.txt");
  const extrait = await readFile(doc, "utf8");
  await writeFile(doc, extrait + " modifié");
  await writeFile(blocs, "");
  assertEquals(await reextraire(db, id), "revision", "des offsets bougeraient");
  assertEquals(await readFile(blocs, "utf8"), "", "la révision servie reste telle quelle");
  assertEquals(
    await readFile(join(config.donnees, "content", id, "revisions/2/document.txt"), "utf8"),
    extrait,
  );
});

test("un travail interrompu reprend après expiration du verrou, sans image en double", async () => {
  const { db } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  await requete("/prof/depot", { method: "POST", body: formulaire(CHAMPS, PAGE, "casa.html") });
  const premier = revendiquer(db)!;
  assertEquals(revendiquer(db), undefined, "un travail verrouillé n'est pas repris");
  // Le worker meurt sans rien écrire. Six minutes plus tard, le verrou a expiré.
  const repris = revendiquer(db, Date.now() + 6 * 60_000)!;
  assertEquals(repris.id, premier.id);
  assertEquals(repris.tentatives, 2);
  await traiter(db, repris, fauxModeles().modeles);
  // Un worker mort après avoir tout écrit sauf la fin du travail : la reprise refait l'extraction.
  db.prepare(
    "UPDATE ingestion_jobs SET etat = 'enriching', verrou_expire_le = '2000-01-01T00:00:00Z'",
  ).run();
  await traiter(db, revendiquer(db)!, fauxModeles().modeles);
  assertEquals(db.prepare("SELECT count(*) n FROM images").get()!.n, 1);
  assertEquals(db.prepare("SELECT etat FROM ingestion_jobs").get()!.etat, "awaiting_review");
});

test("une génération en cours conserve les légendes relues par un enseignant", async () => {
  const { db, dir } = await environnement();
  try {
    const { requete } = await session(db, fauxModeles().modeles, "enseignant");
    for (const action of ["certified", "rejected"] as const) {
      await requete("/prof/depot", {
        method: "POST",
        body: formulaire(CHAMPS, variante(PAGE, action), "casa.html"),
      });
      const job = revendiquer(db)!;
      const appele = Promise.withResolvers<void>();
      const termine = Promise.withResolvers<{ texte: string; modele: string }>();
      const { modeles } = fauxModeles();
      modeles.legender = () => {
        appele.resolve();
        return termine.promise;
      };
      const travail = traiter(db, job, modeles);
      await appele.promise;
      const texte = action === "certified" ? "Légende corrigée par le professeur." : "";
      relireLegende(db, `${job.source_id}-0`, action, texte, "Prof");
      const avant = db.prepare("SELECT * FROM images WHERE source_id = ?").get(job.source_id);
      termine.resolve({ texte: "Légende générée jamais relue.", modele: "faux-vl" });
      await travail;
      assertEquals(
        db.prepare("SELECT * FROM images WHERE source_id = ?").get(job.source_id),
        avant,
      );
      assertEquals(
        db.prepare("SELECT etat FROM ingestion_jobs WHERE id = ?").get(job.id)!.etat,
        "awaiting_review",
      );
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("pendant les légendes, la liste des sources compte les images déjà légendées", async () => {
  const { db, dir } = await environnement();
  try {
    const { requete } = await session(db, fauxModeles().modeles, "enseignant");
    // Deux PNG réduits à leur en-tête. Le profil arts ne garde que la première image d'une page,
    // le profil général les importe toutes.
    const image = (hauteur: number) =>
      `<img src="data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, hauteur]).toString("base64")}">`;
    const deux = enc(`<html><h1>Deux images</h1><p>Un texte.</p>${image(1)}${image(2)}</html>`);
    await requete("/prof/depot", { method: "POST", body: formulaire(CHAMPS, deux, "casa.html") });
    db.prepare("UPDATE sources SET profil = 'general'").run();
    const job = revendiquer(db)!;
    const enAttente = Promise.withResolvers<void>();
    const termine = Promise.withResolvers<{ texte: string; modele: string }>();
    const { modeles } = fauxModeles();
    let appels = 0;
    modeles.legender = () => {
      if (++appels === 1) return Promise.resolve({ texte: "Une image.", modele: "faux-vl" });
      enAttente.resolve();
      return termine.promise;
    };
    const travail = traiter(db, job, modeles);
    await enAttente.promise;
    assertStringIncludes(await (await requete("/prof/lignes")).text(), "légendes 1/2…");
    termine.resolve({ texte: "Une autre image.", modele: "faux-vl" });
    await travail;
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("une certification prématurée ne publie rien après le passage du worker", async () => {
  const { db, dir } = await environnement();
  try {
    const { requete } = await session(db, fauxModeles().modeles, "enseignant");
    await requete("/prof/depot", { method: "POST", body: formulaire(CHAMPS, PAGE, "casa.html") });
    const id = db.prepare("SELECT id FROM sources").get()!.id as string;
    for (const etat of ["received", "extracting", "enriching", "failed"]) {
      db.prepare("UPDATE ingestion_jobs SET etat = ? WHERE source_id = ?").run(etat, id);
      assertThrows(() => statuer(db, id, "certifiee", "Prof"), Error, "pas prête");
      const source = db
        .prepare("SELECT statut, statut_par, statut_le FROM sources WHERE id = ?")
        .get(id)!;
      assertEquals([source.statut, source.statut_par, source.statut_le], ["a_relire", null, null]);
    }
    db.prepare("UPDATE ingestion_jobs SET etat = 'received' WHERE source_id = ?").run(id);
    await traiter(db, revendiquer(db)!, fauxModeles().modeles);
    assertEquals(
      chercherFts(db, "Casa Batlló façade", { lecteur: null, schoolId: "pilote" }).length,
      0,
    );
    const eleve = await session(db, fauxModeles().modeles, "eleve");
    assertEquals((await eleve.requete(`/eleve/sources/${id}`)).status, 404);
    statuer(db, id, "certifiee", "Prof");
    assertEquals(
      chercherFts(db, "Casa Batlló façade", { lecteur: null, schoolId: "pilote" }).length,
      1,
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("un échec d'indexation annule aussi la certification", async () => {
  const { db, dir } = await environnement();
  try {
    const id = await sourceTraitee(db);
    db.exec(`CREATE TRIGGER index_indisponible BEFORE INSERT ON chunks
      BEGIN SELECT RAISE(ABORT, 'Index indisponible'); END`);
    assertThrows(() => statuer(db, id, "certifiee", "Prof"), Error, "Index indisponible");
    const source = db
      .prepare("SELECT statut, statut_par, statut_le FROM sources WHERE id = ?")
      .get(id)!;
    assertEquals([source.statut, source.statut_par, source.statut_le], ["a_relire", null, null]);
    assertEquals(db.prepare("SELECT count(*) n FROM chunks").get()!.n, 0);
    assertEquals(db.prepare("SELECT count(*) n FROM chunks_fts").get()!.n, 0);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("Thot propose date, artiste et mouvement, l'enseignant les valide", async () => {
  const { db } = await environnement();
  const prof = await session(db, fauxModeles().modeles, "enseignant");
  const id = await sourceTraitee(db, undefined, undefined, prof);
  statuer(db, id, "certifiee", "test");
  assertEquals(
    lireInformations(
      '{"artiste": "Gaudí, Picasso", "mouvement": "Art nouveau"}',
      "Gaudí Art-Nouveau",
    ),
    { date: "", artiste: "", mouvement: "Art nouveau" },
  );
  assertEquals(sourceSansInformations(db), id);
  const sortie = JSON.stringify({
    date: "1906",
    artiste: "Antoni Gaudí",
    mouvement: "Art nouveau",
  });
  await proposerInformations(db, fauxModeles({ sorties: [sortie] }).modeles, id);
  assertEquals(sourceSansInformations(db), undefined);

  const fiche = await (await prof.requete(`/prof/sources/${id}`)).text();
  assertStringIncludes(fiche, 'value="Antoni Gaudí"');
  assertStringIncludes(fiche, "Proposé par Thot");
  assert(!fiche.includes('value="1906"'), "une date absente de la fiche n'est pas proposée");
  const eleve = await session(db, fauxModeles().modeles, "eleve");
  const chapitre = `/eleve/sequences/${encodeURIComponent(CHAMPS.sequence)}`;
  assert(!(await (await suivre(eleve, chapitre)).text()).includes("data-verifier-quiz"));

  await prof.requete(`/prof/sources/${id}/modifier`, {
    method: "POST",
    body: new URLSearchParams({
      titre: CHAMPS.titre,
      sequence: CHAMPS.sequence,
      date: "",
      artiste: "Antoni Gaudí",
      mouvement: "Art nouveau",
    }),
  });
  assert(!(await (await prof.requete(`/prof/sources/${id}`)).text()).includes("Proposé par Thot"));
  assertStringIncludes(
    await (await suivre(eleve, chapitre)).text(),
    'data-answer="Antoni Gaudí|Art nouveau"',
  );
  assertEquals(sourceSansInformations(db), undefined);
});

test("titre édité réindexé, image certifiée liée à la réponse et messages purgés", async () => {
  const { db } = await environnement();
  const prof = await session(db, fauxModeles().modeles, "enseignant");
  const id = await sourceTraitee(db, undefined, undefined, prof);
  statuer(db, id, "certifiee", "test");
  const r = await prof.requete(`/prof/sources/${id}/modifier`, {
    method: "POST",
    body: new URLSearchParams({ titre: "Casa Batlló corrigée", date: "1906", artiste: "Gaudí" }),
  });
  assertEquals(r.status, 303);
  assertStringIncludes(
    chercherFts(db, "corrigée", { lecteur: null, schoolId: "pilote" })[0].titre,
    "corrigée",
  );
  relireLegende(db, `${id}-0`, "certified", "", "test");
  const bonne = JSON.stringify({
    affirmations: [
      {
        texte: "Les balcons ressemblent à des masques.",
        extrait: 1,
        citation: "façade ondulée aux balcons en forme de masques",
      },
    ],
  });
  const { resultat } = await demander(
    db,
    fauxModeles({ sorties: [bonne] }).modeles,
    "balcons masques",
    { lecteur: null, schoolId: "pilote" },
    0.023,
  );
  assertEquals(resultat.etat, "answered");
  if (resultat.etat === "answered") assertEquals(resultat.affirmations[0].image_id, `${id}-0`);
  const texteCite = JSON.stringify({
    affirmations: [
      {
        texte: "Gaudí refuse la ligne droite.",
        extrait: 1,
        citation: "Gaudí refuse la ligne droite dans toute la façade",
      },
    ],
  });
  const texteResultat = await demander(
    db,
    fauxModeles({ sorties: [texteCite] }).modeles,
    "ligne droite",
    { lecteur: null, schoolId: "pilote" },
    0.023,
  );
  assertEquals(texteResultat.resultat.etat, "answered");
  if (texteResultat.resultat.etat === "answered") {
    assertEquals(texteResultat.resultat.affirmations[0].image_id, `${id}-0`);
  }
  const eleve = await session(db, fauxModeles().modeles, "eleve");
  const accueil = await (await eleve.requete("/eleve")).text();
  assertStringIncludes(accueil, "Casa Batlló corrigée");
  assertStringIncludes(
    await (await suivre(eleve, `/eleve/sequences/${encodeURIComponent(CHAMPS.sequence)}`)).text(),
    "1906",
  );
  const compte = db
    .prepare("SELECT id FROM comptes WHERE role = 'eleve' ORDER BY rowid DESC LIMIT 1")
    .get()!.id;
  db.prepare(
    "INSERT INTO messages (id, compte_id, question, etat, cree_le, maj_le) VALUES ('ancien', ?, 'question', 'en_attente', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
  ).run(compte);
  assertEquals(purgerMessages(db, 90, Date.UTC(2026, 8, 23)), 1);
});

test("une panne d'indexation annule aussi les éditions de légende et de métadonnées", async () => {
  const { db } = await environnement();
  try {
    const prof = await session(db, fauxModeles().modeles, "enseignant");
    const id = await sourceTraitee(db, undefined, undefined, prof);
    statuer(db, id, "certifiee", "Prof");
    relireLegende(db, `${id}-0`, "certified", "", "Prof");
    const image = db.prepare("SELECT * FROM images WHERE source_id = ?").get(id);
    const source = db.prepare("SELECT * FROM sources WHERE id = ?").get(id);
    const chunks = db.prepare("SELECT * FROM chunks WHERE source_id = ?").all(id);
    db.exec(
      "CREATE TRIGGER index_indisponible BEFORE INSERT ON chunks BEGIN SELECT RAISE(ABORT, 'Index indisponible'); END",
    );
    for (const action of ["rejected", "certified"] as const) {
      assertThrows(() => relireLegende(db, `${id}-0`, action, "Une légende corrigée.", "Prof"));
      assertEquals(db.prepare("SELECT * FROM images WHERE source_id = ?").get(id), image);
      assertEquals(db.prepare("SELECT * FROM chunks WHERE source_id = ?").all(id), chunks);
    }
    const r = await prof.requete(`/prof/sources/${id}/modifier`, {
      method: "POST",
      body: new URLSearchParams({ titre: "Titre corrigé", sequence: "Architecture" }),
    });
    assertEquals(r.status, 500);
    assertEquals(db.prepare("SELECT * FROM sources WHERE id = ?").get(id), source);
    assertEquals(db.prepare("SELECT * FROM chunks WHERE source_id = ?").all(id), chunks);
  } finally {
    db.close();
  }
});

/** Réécrit l'original HTML de la source, comme le lirait un extracteur corrigé. */
async function changerOriginal(id: string, avant: string, apres: string) {
  const original = join(config.donnees, "content", id, "original", "casa.html");
  await writeFile(original, (await readFile(original, "utf8")).replace(avant, apres));
}

const revisions = (db: Parameters<typeof traiter>[0], id: string) => ({
  servie: db.prepare("SELECT revision FROM sources WHERE id = ?").get(id)!.revision,
  index: db
    .prepare("SELECT DISTINCT revision FROM chunks WHERE source_id = ?")
    .all(id)
    .map((c) => c.revision),
  enregistrees: db
    .prepare("SELECT n FROM revisions WHERE source_id = ? ORDER BY n")
    .all(id)
    .map((r) => r.n),
});

test("un texte réextrait attend sa certification, une ancienne réponse garde son passage", async () => {
  const { db, dir } = await environnement();
  try {
    const prof = await session(db, fauxModeles().modeles, "enseignant");
    const id = await sourceTraitee(db, undefined, undefined, prof);
    statuer(db, id, "certifiee", "Prof");
    const sorties = [REPONSE_CITEE, REPONSE_CITEE];
    const eleve = await session(db, fauxModeles({ sorties }).modeles, "eleve");
    const ancien = await poserQuestion(eleve.requete);
    await (await eleve.requete(`/eleve/messages/${ancien}/flux`)).text();

    // Une phrase de plus avant le passage cité déplace ses offsets.
    await changerOriginal(id, "<p>Gaudí", "<p>Une phrase ajoutée.</p><p>Gaudí");
    assertEquals(await reextraire(db, id), "revision");
    assertEquals(await reextraire(db, id), "identique", "la version en attente est déjà là");
    assertEquals(revisions(db, id), { servie: 1, index: [1], enregistrees: [1, 2] });
    assertStringIncludes(
      await (await prof.requete(`/prof/sources/${id}`)).text(),
      "Nouvelle version à relire",
    );
    assertEquals((await eleve.requete(`/eleve/sources/${id}?revision=2`)).status, 404);
    const aRelire = await (await prof.requete("/prof?statut=a_relire")).text();
    assertStringIncludes(aRelire, "Nouvelle version à relire");
    assertStringIncludes(aRelire, `/prof/sources/${id}"`);
    assert(
      !(await (await prof.requete("/prof?statut=certifiee")).text()).includes(
        `/prof/sources/${id}"`,
      ),
    );

    const certifier = await prof.requete(`/prof/sources/${id}/revisions/2/certifiee`, {
      method: "POST",
    });
    assertEquals(certifier.status, 303);
    assertEquals(revisions(db, id), { servie: 2, index: [2], enregistrees: [1, 2] });
    assert(!(await (await prof.requete("/prof")).text()).includes("Nouvelle version à relire"));

    assertStringIncludes(
      await (await eleve.requete("/eleve/chat")).text(),
      "Gaudí refuse la ligne droite.",
    );
    const panneau = await (await eleve.requete(`/eleve/messages/${ancien}/citations/0`)).text();
    assertStringIncludes(panneau, "<mark>Gaudí refuse la ligne droite dans toute la façade</mark>");
    const lien = panneau.match(/href="(\/eleve\/sources\/[^"#]+)/)![1].replaceAll("&amp;", "&");
    assertStringIncludes(lien, "revision=1");
    const lecture = await (await eleve.requete(lien)).text();
    assertStringIncludes(lecture, "Version citée par une réponse précédente");
    assert(!lecture.includes("Une phrase ajoutée."));

    const nouveau = await poserQuestion(eleve.requete);
    await (await eleve.requete(`/eleve/messages/${nouveau}/flux`)).text();
    const [a, b] = [ancien, nouveau].map(
      (m) =>
        JSON.parse(
          db.prepare("SELECT resultat FROM messages WHERE id = ?").get(m)!.resultat as string,
        ).affirmations[0],
    );
    assertEquals([a.revision, b.revision], [1, 2]);
    assert(b.debut > a.debut, "la nouvelle réponse cite la nouvelle version");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("un échec d'extraction ou d'indexation laisse servir la révision certifiée", async () => {
  const { db, dir } = await environnement();
  try {
    const prof = await session(db, fauxModeles().modeles, "enseignant");
    const id = await sourceTraitee(db, undefined, undefined, prof);
    statuer(db, id, "certifiee", "Prof");
    const racine = join(config.donnees, "content", id);
    const page = await readFile(join(racine, "original", "casa.html"));
    await rm(join(racine, "original", "casa.html"));
    await assertRejects(() => reextraire(db, id));
    assertEquals(revisions(db, id), { servie: 1, index: [1], enregistrees: [1] });

    await writeFile(join(racine, "original", "casa.html"), page);
    await changerOriginal(id, "ligne droite", "ligne sinueuse");
    assertEquals(await reextraire(db, id), "revision");
    db.exec(`CREATE TRIGGER index_indisponible BEFORE INSERT ON chunks
      BEGIN SELECT RAISE(ABORT, 'Index indisponible'); END`);
    assertThrows(() => statuer(db, id, "certifiee", "Prof", 2), Error, "Index indisponible");
    db.exec("DROP TRIGGER index_indisponible");
    assertEquals(revisions(db, id), { servie: 1, index: [1], enregistrees: [1, 2] });
    const cherche = (q: string) => chercherFts(db, q, { lecteur: null, schoolId: "pilote" }).length;
    assertEquals([cherche("droite"), cherche("sinueuse")], [1, 0]);

    // Rejeter la version en attente la supprime. Une page restée ouverte ne la certifie plus.
    const rejeter = await prof.requete(`/prof/sources/${id}/revisions/2/rejetee`, {
      method: "POST",
    });
    assertEquals(rejeter.status, 303);
    assertEquals(revisions(db, id), { servie: 1, index: [1], enregistrees: [1] });
    await assertRejects(() => readFile(join(racine, "revisions", "2", "document.txt")));
    assertStringIncludes(await readFile(join(racine, "document.txt"), "utf8"), "ligne droite");
    const tard = await prof.requete(`/prof/sources/${id}/revisions/2/certifiee`, {
      method: "POST",
    });
    assertEquals(tard.status, 409);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("le crédit se saisit à la relecture, s'affiche échappé et ne sort ni de la recherche ni du générateur", async () => {
  const { db, dir } = await environnement();
  try {
    const prof = await session(db, fauxModeles().modeles, "enseignant");
    const acces = { audience: "eleves", reponses: false } as const;
    const texte = "Carapace de dragon en écailles turquoise.";
    const id = await sourceTraitee(db, texte, acces, prof);
    statuer(db, id, "certifiee", "Prof");
    const credit = "<script>alert(1)</script> Musée";
    const corps = new URLSearchParams({ image: `${id}-0`, texte, credit });
    assertEquals(
      (await prof.requete("/prof/legendes/certified", { method: "POST", body: corps })).status,
      200,
    );
    assertEquals(
      db.prepare("SELECT credit FROM images WHERE id = ?").get(`${id}-0`)!.credit,
      credit,
    );

    const { requete } = await session(db, fauxModeles().modeles, "eleve");
    const page = await (await requete(`/eleve/sources/${id}`)).text();
    assertStringIncludes(page, '<span class="credit">&lt;script&gt;alert(1)&lt;/script&gt; Musée');
    assert(!page.includes("<script>alert(1)"), "crédit non échappé");

    assertEquals(chercherFts(db, "Musée", { lecteur: null, schoolId: "pilote" }).length, 0);
    const f = fauxModeles({ sorties: ['{"refus": true}'] });
    await demander(db, f.modeles, "dragon turquoise", { lecteur: null, schoolId: "pilote" }, 0.023);
    assert(!JSON.stringify(f.vus).includes("Musée"), "crédit envoyé au générateur");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("une légende relue ne reste pas sur une autre image à la même place", async () => {
  const { db, dir } = await environnement();
  try {
    const id = await sourceTraitee(db, "Façade aux balcons en masques.");
    relireLegende(db, `${id}-0`, "certified", "", "Prof");
    await changerOriginal(id, "/9kA", "/9kB");
    db.prepare("UPDATE ingestion_jobs SET etat = 'received' WHERE source_id = ?").run(id);
    await traiter(db, revendiquer(db)!, fauxModeles({ legende: "Autre image." }).modeles);
    assertEquals(
      db
        .prepare("SELECT legende, legende_statut FROM images WHERE source_id = ?")
        .all(id)
        .map((i) => ({ ...i })),
      [{ legende: "Autre image.", legende_statut: "unreviewed" }],
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});
