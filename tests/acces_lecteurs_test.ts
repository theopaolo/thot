import { readFileSync, readdirSync } from "node:fs";
import { rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { connexion, migrer } from "../src/app/db.ts";
import { config, RACINE } from "../src/app/config.ts";
import { configurerInstance, lireInstance } from "../src/app/instance.ts";
import { reextraire, statuer } from "../src/app/ingestion.ts";
import { chercherFts, LISIBLE, type Lecteur, parametresLisible } from "../src/core/recherche.ts";
import { demander } from "../src/core/reponse.ts";
import { resultatActuel } from "../src/app/conversations.ts";
import { type Modeles } from "../src/core/modeles.ts";
import { suggestionsDuPerimetre } from "../src/app/suggestions.ts";
import { lecteur, lireCompte } from "../src/app/comptes.ts";
import { affiliations, cours, matiere, theme } from "../src/app/domaines.ts";
import { environnement, fauxModeles } from "./outils.ts";
import { BONNE, compte, envoyer, image, source, statut, TEXTE } from "./acces_outils.ts";

async function instance(modeles?: Modeles) {
  const { db, dir } = await environnement();
  const a = await compte(db, "enseignant", modeles);
  const b = await compte(db, "enseignant", modeles);
  const eleve = await compte(db, "eleve", modeles);
  const admin = await compte(db, "enseignant", modeles);
  db.prepare("UPDATE comptes SET administrateur = 1 WHERE id = ?").run(admin.id);
  const prive = await source(db, "Note privée", "prive", a.id);
  const collegues = await source(db, "Corrigé des collègues", "collegues", a.id);
  const eleves = await source(db, "Cours publié", "eleves", a.id);
  return { db, dir, a, b, eleve, admin, prive, collegues, eleves };
}

test("lecture : propriétaire, collègue, élève et administrateur", async () => {
  const { db, dir, a, b, eleve, admin, prive, collegues, eleves } = await instance();
  try {
    const attendu: [typeof a, string, number][] = [
      [a, prive, 200],
      [a, collegues, 200],
      [b, prive, 404],
      [b, collegues, 200],
      [b, eleves, 200],
      [admin, prive, 200],
    ];
    for (const [qui, id, code] of attendu) {
      assertEquals(await statut(qui.requete(`/prof/sources/${id}`)), code, `${id} ${code}`);
      assertEquals(await statut(qui.requete(`/media/${image(db, id)}`)), code, `image ${id}`);
    }
    for (const [id, code] of [
      [prive, 404],
      [collegues, 404],
      [eleves, 200],
    ] as const) {
      assertEquals(await statut(eleve.requete(`/eleve/sources/${id}`)), code, `élève ${id}`);
      assertEquals(await statut(eleve.requete(`/media/${image(db, id)}`)), code);
      assertEquals(await statut(eleve.requete(`/eleve/documents/${id}/apercu`)), code);
    }
    const bibliotheque = await (await b.requete("/prof")).text();
    assert(!bibliotheque.includes(prive) && bibliotheque.includes(collegues));
    // Un enseignant étudie aussi ce que ses collègues partagent. Un élève ne le voit pas.
    assertStringIncludes(await (await b.requete("/eleve")).text(), "Corrigé des collègues");
    const accueil = await (await eleve.requete("/eleve")).text();
    assert(accueil.includes("Cours publié") && !accueil.includes("Corrigé des collègues"));

    // Une image déjà vue se revalide : devenue privée, elle n'est plus servie depuis le cache.
    const vue = await eleve.requete(`/media/${image(db, eleves)}`);
    const etag = vue.headers.get("etag")!;
    assertEquals(vue.headers.get("cache-control"), "private, no-cache");
    assertEquals(vue.headers.get("x-content-type-options"), "nosniff");
    await vue.body?.cancel();
    assertEquals(
      await statut(
        eleve.requete(`/media/${image(db, eleves)}`, { headers: { "if-none-match": etag } }),
      ),
      304,
    );
    db.prepare("UPDATE sources SET audience = 'prive' WHERE id = ?").run(eleves);
    assertEquals(
      await statut(
        eleve.requete(`/media/${image(db, eleves)}`, { headers: { "if-none-match": etag } }),
      ),
      404,
    );
    db.prepare("UPDATE sources SET audience = 'eleves' WHERE id = ?").run(eleves);

    // La revue des questions ne nomme pas le thème d'une source que l'enseignant ne lit pas.
    const secret = cours(db, matiere(db, "Secrets"), "Cours secret");
    affiliations(db, prive, [{ cours_id: secret, theme_id: theme(db, secret, "Thème secret") }]);
    db.prepare(
      `INSERT INTO messages (id, compte_id, question, etat, resultat, cree_le, maj_le)
       VALUES ('m', ?, 'Une question', 'answered', ?, '2026-10-10T08:00:00Z', '2026-10-10T08:00:00Z')`,
    ).run(eleve.id, JSON.stringify({ affirmations: [{ source_id: prive }] }));
    assertStringIncludes(await (await a.requete("/prof/questions")).text(), "Thème secret");
    const questions = await (await b.requete("/prof/questions")).text();
    assert(questions.includes("Une question") && !questions.includes("Thème secret"));

    // Les questions suggérées sont communes à tous : seules celles des sources publiées restent.
    const commeEleve = { id: eleve.id, enseignant: false, administrateur: false };
    for (const id of [prive, collegues, eleves]) {
      db.prepare("INSERT INTO suggestions VALUES (?, ?, ?, 'faux', 'test')").run(id, id, `Q ${id}`);
    }
    assertEquals(suggestionsDuPerimetre(db, commeEleve, new Set([prive, collegues, eleves])), [
      `Q ${eleves}`,
    ]);

    const trouve = (l: Lecteur | null) =>
      new Set(
        chercherFts(db, "façade céramique", {
          schoolId: lireInstance(db).school_id,
          lecteur: l,
        }).map((c) => c.source_id),
      );
    const lecteur = (id: string, administrateur = false) => ({
      id,
      enseignant: true,
      administrateur,
    });
    assertEquals(trouve(null), new Set([eleves]));
    assertEquals(trouve(lecteur(b.id)), new Set([collegues, eleves]));
    assertEquals(trouve(lecteur(a.id)), new Set([prive, collegues, eleves]));
    assertEquals(trouve(lecteur(admin.id, true)), new Set([prive, collegues, eleves]));
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("écriture : le propriétaire et les administrateurs seulement", async () => {
  const { db, dir, a, b, admin, collegues } = await instance();
  try {
    const poster = (qui: typeof a, chemin: string, corps: Record<string, string>) =>
      statut(qui.requete(chemin, { method: "POST", body: new URLSearchParams(corps) }));
    const modifier = { titre: "Corrigé", sequence: "", audience: "prive" };
    assertEquals(await poster(b, `/prof/sources/${collegues}/modifier`, modifier), 403);
    assertEquals(await poster(b, `/prof/sources/${collegues}/rejetee`, {}), 403);
    assertEquals(await poster(b, `/prof/sources/${collegues}/revisions/2/certifiee`, {}), 403);
    assertEquals(
      await poster(b, "/prof/legendes/rejected", { image: image(db, collegues), texte: "" }),
      403,
    );
    await poster(b, "/prof/sources/statut", { ids: collegues, statut: "rejetee" });
    const lire = () => ({
      ...db.prepare("SELECT statut, audience FROM sources WHERE id = ?").get(collegues),
    });
    assertEquals(lire(), { statut: "certifiee", audience: "collegues" });

    assertEquals(await poster(a, `/prof/sources/${collegues}/modifier`, modifier), 303);
    assertEquals(lire(), { statut: "certifiee", audience: "prive" });
    const lecteurs = { ids: collegues, statut: "lecteurs", audience: "eleves" };
    await poster(b, "/prof/sources/statut", lecteurs);
    assertEquals(lire(), { statut: "certifiee", audience: "prive" });
    await poster(a, "/prof/sources/statut", lecteurs);
    assertEquals(lire(), { statut: "certifiee", audience: "eleves" });
    assertEquals(await poster(admin, `/prof/sources/${collegues}/rejetee`, {}), 200);
    assertEquals(
      await poster(a, "/prof/legendes/rejected", { image: image(db, collegues), texte: "" }),
      200,
    );
    assertEquals(
      await poster(a, "/prof/sources/statut", {
        ids: collegues,
        statut: "lecteurs",
        audience: "x",
      }),
      400,
    );

    // Un dépôt web appartient à son auteur, avec les lecteurs choisis.
    const f = new FormData();
    for (const [k, v] of Object.entries({ titre: "Dépôt", type_document: "cours" })) f.append(k, v);
    f.append("audience", "collegues");
    f.append("fichier", new File([`<html><p>${TEXTE}</p></html>`], "depot.html"));
    assertEquals(await statut(b.requete("/prof/depot", { method: "POST", body: f })), 200);
    assertEquals(
      {
        ...db
          .prepare("SELECT proprietaire_id, audience, reponses FROM sources WHERE titre = 'Dépôt'")
          .get(),
      },
      { proprietaire_id: b.id, audience: "collegues", reponses: 0 },
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("réponses : preuves lisibles par le lecteur, retrait pendant la génération", async () => {
  const f = fauxModeles({ sorties: [BONNE, BONNE] });
  const { db, dir, b, eleve, collegues, eleves } = await instance(f.modeles);
  try {
    db.prepare("UPDATE sources SET reponses = 0 WHERE id = ?").run(eleves);
    const schoolId = lireInstance(db).school_id;
    const q = "Pourquoi la façade n'a pas de ligne droite ?";
    const prof = { id: b.id, enseignant: true, administrateur: false };
    const pourProf = await demander(
      db,
      fauxModeles({ sorties: [BONNE] }).modeles,
      q,
      { schoolId, lecteur: prof },
      0.023,
    );
    assertEquals(pourProf.resultat.etat, "answered");
    if (pourProf.resultat.etat === "answered") {
      assertEquals(pourProf.resultat.affirmations[0].source_id, collegues);
    }
    // Relue par un élève, la même réponse perd sa preuve.
    assertEquals(resultatActuel(db, pourProf.resultat, { schoolId, lecteur: null }).etat, "failed");
    assertEquals(
      (await demander(db, fauxModeles().modeles, q, { schoolId, lecteur: null }, 0.023)).resultat
        .etat,
      "out_of_corpus",
    );

    // Une réponse publiée perd sa preuve à la relecture quand la source devient privée.
    db.prepare("UPDATE sources SET reponses = 1 WHERE id = ?").run(eleves);
    const poser = async () => {
      const fragment = await (
        await eleve.requete("/eleve/questions", {
          method: "POST",
          headers: { "HX-Request": "true" },
          body: new URLSearchParams({ texte: q }),
        })
      ).text();
      return fragment.match(/messages\/([\w-]+)\/flux/)![1];
    };
    const publie = await poser();
    assertStringIncludes(
      await (await eleve.requete(`/eleve/messages/${publie}/flux`)).text(),
      "Gaudí refuse la ligne droite.",
    );
    assertStringIncludes(
      await (await eleve.requete(`/eleve/messages/${publie}/citations/0`)).text(),
      "dans toute la façade",
    );
    db.prepare("UPDATE sources SET audience = 'prive' WHERE id = ?").run(eleves);
    assert(
      !(await (await eleve.requete("/eleve/chat")).text()).includes(
        "Gaudí refuse la ligne droite.",
      ),
    );
    assert(
      !(await (await eleve.requete(`/eleve/messages/${publie}/citations/0`)).text()).includes(
        "dans toute la façade",
      ),
    );
    db.prepare("UPDATE sources SET audience = 'eleves' WHERE id = ?").run(eleves);

    // La source devient privée pendant que le modèle rédige la réponse de l'élève.
    const generer = f.modeles.generer;
    f.modeles.generer = (messages) => {
      db.prepare("UPDATE sources SET audience = 'prive' WHERE id = ?").run(eleves);
      return generer(messages);
    };
    const mid = await poser();
    const flux = await (await eleve.requete(`/eleve/messages/${mid}/flux`)).text();
    assert(!flux.includes("dans toute la façade"), "texte publié après le retrait");
    assertEquals(db.prepare("SELECT etat FROM messages WHERE id = ?").get(mid)!.etat, "failed");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("révisions : une version citée ne se lit qu'avec l'accès actuel", async () => {
  const { db, dir, eleve, eleves } = await instance(fauxModeles({ sorties: [BONNE] }).modeles);
  try {
    const fragment = await (
      await eleve.requete("/eleve/questions", {
        method: "POST",
        headers: { "HX-Request": "true" },
        body: new URLSearchParams({ texte: "Pourquoi la façade n'a pas de ligne droite ?" }),
      })
    ).text();
    const mid = fragment.match(/messages\/([\w-]+)\/flux/)![1];
    await (await eleve.requete(`/eleve/messages/${mid}/flux`)).text();

    // La version citée cesse de servir, une troisième attend sa certification.
    const original = join(config.donnees, "content", eleves, "original", "cours.html");
    const page = readFileSync(original, "utf8");
    await writeFile(original, page.replace("<p>", "<p>Une phrase ajoutée.</p><p>"));
    assertEquals(await reextraire(db, eleves), "revision");
    statuer(db, eleves, "certifiee", "Test", 2);
    await writeFile(original, page.replace("<p>", "<p>Une autre phrase.</p><p>"));
    assertEquals(await reextraire(db, eleves), "revision");

    const ancienne = `/eleve/sources/${eleves}?revision=1`;
    const panneau = async () => (await eleve.requete(`/eleve/messages/${mid}/citations/0`)).text();
    assertEquals(await statut(eleve.requete(ancienne)), 200);
    assertEquals(await statut(eleve.requete(`/eleve/sources/${eleves}?revision=3`)), 404);
    assertStringIncludes(await panneau(), "<mark>");

    db.prepare("UPDATE sources SET audience = 'prive' WHERE id = ?").run(eleves);
    assertEquals(await statut(eleve.requete(ancienne)), 404);
    assert(!(await panneau()).includes("<mark>"));
    assertStringIncludes(
      await (await eleve.requete("/eleve/chat")).text(),
      "Une source de cette réponse a été retirée ou modifiée.",
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("partager une source ne partage pas les échanges de son propriétaire", async () => {
  const f = fauxModeles({ sorties: [BONNE] });
  const { db, dir, a, b } = await instance(f.modeles);
  try {
    const fragment = await (
      await a.requete("/eleve/questions", {
        method: "POST",
        headers: { "HX-Request": "true" },
        body: new URLSearchParams({ texte: "Question privée sur la façade" }),
      })
    ).text();
    const mid = fragment.match(/messages\/([\w-]+)\/flux/)![1];
    assertStringIncludes(await (await a.requete(`/eleve/messages/${mid}/flux`)).text(), "Gaudí");
    assertStringIncludes(
      await (await a.requete(`/eleve/messages/${mid}/citations/0`)).text(),
      "façade",
    );
    assert(!(await (await b.requete("/eleve/chat")).text()).includes("Question privée"));
    assert(
      !(await (await b.requete(`/eleve/messages/${mid}/citations/0`)).text()).includes("façade"),
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("instance personnelle : le propriétaire étudie ses ressources privées", async () => {
  const { db, dir } = await environnement();
  try {
    configurerInstance(db, "Mon étude", "personal");
    const moi = await compte(db, "enseignant");
    db.prepare("UPDATE comptes SET administrateur = 1 WHERE id = ?").run(moi.id);
    const id = await source(db, "Mes notes", "prive", moi.id);
    assertStringIncludes(await (await moi.requete("/eleve")).text(), "Mes notes");
    assertEquals(await statut(moi.requete(`/eleve/sources/${id}`)), 200);
    // Sans élèves à inscrire, l'instance ne crée pas de lien d'inscription.
    const lecture = cours(db, matiere(db, "Notes"), "Lecture");
    const corps = { cours: lecture, jours: "14", places: "40" };
    assertEquals(await statut(envoyer(moi, "/prof/eleves/liens", corps)), 404);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("lecture : un élève ne lit pas une source publiée qui n'est pas certifiée", async () => {
  const { db, dir, a, eleve, eleves } = await instance();
  try {
    db.prepare("UPDATE sources SET statut = 'a_relire' WHERE id = ?").run(eleves);
    const lisible = (compte: { id: string }) =>
      db
        .prepare(`SELECT 1 FROM sources s WHERE s.id = ? AND ${LISIBLE}`)
        .get(
          parametresLisible(lireInstance(db).school_id, lecteur(lireCompte(db, compte.id)!)),
          eleves,
        ) !== undefined;
    assertEquals(lisible(eleve), false);
    assertEquals(lisible(a), true);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("migration des lecteurs : aucun accès élargi ni retiré", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thot-"));
  config.donnees = dir;
  const db = connexion(join(dir, "state.sqlite3"));
  try {
    db.exec("CREATE TABLE migrations (nom TEXT PRIMARY KEY, applique_le TEXT NOT NULL)");
    for (const nom of readdirSync(join(RACINE, "migrations"), { withFileTypes: true })
      .map((f) => f.name)
      .sort()) {
      if (nom >= "0008") continue;
      db.exec(readFileSync(join(RACINE, "migrations", nom), "utf8"));
      db.prepare("INSERT INTO migrations VALUES (?, 'fixture')").run(nom);
    }
    for (const [id, nom] of [
      ["d", "M. Detienne"],
      ["h1", "Homonyme"],
      ["h2", "Homonyme"],
    ]) {
      db.prepare(
        "INSERT INTO comptes (id, identifiant, nom, role, sel, empreinte, cree_le) VALUES (?, ?, ?, 'enseignant', '', '', 'fixture')",
      ).run(id, id, nom);
    }
    const sources = [
      ["M. Detienne", ["enseignants", "eleves", "thot", "consultants"]],
      ["Homonyme", ["enseignants"]],
      ["Inconnu", ["eleves"]],
      ["M. Detienne", []],
      ["M. Detienne", ["enseignants", "thot"]],
    ] as const;
    for (const [i, [enseignant, publics]] of sources.entries()) {
      db.prepare(
        `INSERT INTO sources (id,school_id,titre,metadonnees,fichier,format,checksum,octets,enseignant,cree_le) VALUES (?, 'pilote', 'Cours', ?, 'cours.html', 'html', 'x', 1, ?, 'fixture')`,
      ).run(String(i), JSON.stringify({ sequence: "Lumière", publics }), enseignant);
    }
    assertEquals(migrer(db), [
      "0008_acces.sql",
      "0009_membres.sql",
      "0010_liens.sql",
      "0011_revisions.sql",
      "0012_reglages.sql",
      "0013_conversations.sql",
      "0014_reponses.sql",
      "0015_lots.sql",
      "0016_comparaison.sql",
      "0017_suppression.sql",
      "0018_themes.sql",
      "0019_activites.sql",
      "0020_credits.sql",
      "0021_images_section.sql",
      "0024_explications.sql",
      "0025_termes.sql",
      "0026_series.sql",
      "0027_lectures.sql",
      "0028_connexions.sql",
      "0029_images_revision.sql",
      "0030_images_numero.sql",
      "0031_genres.sql",
      "0032_index.sql",
    ]);
    assertEquals(
      db
        .prepare("SELECT audience, reponses, proprietaire_id, metadonnees FROM sources ORDER BY id")
        .all()
        .map((s) => ({ ...s })),
      [
        ["eleves", 1, "d"],
        ["collegues", 0, null],
        ["eleves", 0, null],
        ["collegues", 0, "d"],
        ["collegues", 1, "d"],
      ].map(([audience, reponses, proprietaire_id]) => ({
        audience,
        reponses,
        proprietaire_id,
        metadonnees: '{"sequence":"Lumière"}',
      })),
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("une adresse inconnue rend une page dans la mise en page, une requête htmx un texte court", async () => {
  const { db, dir } = await environnement();
  try {
    const eleve = await compte(db, "eleve");
    const prof = await compte(db, "enseignant");
    const page = await eleve.requete("/eleve/sources/inconnue");
    assertEquals(page.status, 404);
    const texte = await page.text();
    assertStringIncludes(texte, "<h1>Page introuvable</h1>");
    assertStringIncludes(texte, "que ton compte peut ouvrir");
    assertStringIncludes(texte, 'href="/"');
    assertStringIncludes(await (await prof.requete("/nulle-part")).text(), "que votre compte");
    const fragment = await eleve.requete("/eleve/sources/inconnue", {
      headers: { "HX-Request": "true" },
    });
    assertEquals([fragment.status, await fragment.text()], [404, "Introuvable."]);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});
