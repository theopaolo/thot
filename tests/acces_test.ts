import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { connexion, type Db, migrer } from "../src/app/db.ts";
import { config, RACINE } from "../src/app/config.ts";
import { type Audience, deposer, valider } from "../src/app/depot.ts";
import { configurerInstance, lireInstance } from "../src/app/instance.ts";
import { revendiquer, statuer, traiter } from "../src/app/ingestion.ts";
import { chercherFts, type Lecteur } from "../src/core/recherche.ts";
import { actualiserResultat, demander } from "../src/core/reponse.ts";
import type { Modeles } from "../src/core/modeles.ts";
import { suggestionsDuPerimetre, suggestionsParChapitre } from "../src/app/suggestions.ts";
import { environnement, fauxModeles, session } from "./outils.ts";

const TEXTE = "La façade de la Casa Batlló est couverte de céramique irisée. " +
  "Gaudí refuse la ligne droite dans toute la façade.";
const BONNE = JSON.stringify({
  affirmations: [{
    texte: "Gaudí refuse la ligne droite.",
    extrait: 1,
    citation: "Gaudí refuse la ligne droite dans toute la façade",
  }],
});

async function source(db: Db, titre: string, audience: Audience, proprietaireId: string) {
  const v = valider({ titre, type_document: "cours" });
  assert("meta" in v);
  const { source_id } = await deposer(db, {
    meta: v.meta,
    nomFichier: "cours.html",
    format: "html",
    schoolId: lireInstance(db).school_id,
    enseignant: "Prof",
    proprietaireId,
    audience,
    reponses: true,
    octets: new TextEncoder().encode(
      `<html><h1>${titre}</h1><img src="data:image/jpeg;base64,/9j/4AAQ"><p>${TEXTE}</p></html>`,
    ),
  });
  await traiter(db, revendiquer(db)!, fauxModeles().modeles);
  statuer(db, source_id, "certifiee", "Test");
  return source_id;
}

/** Une session et l'identifiant de son compte. */
async function compte(db: Db, role: "enseignant" | "eleve", modeles = fauxModeles().modeles) {
  const s = await session(db, modeles, role);
  const id = db.prepare("SELECT id FROM comptes ORDER BY rowid DESC LIMIT 1").get()!.id as string;
  return { ...s, id };
}

const image = (db: Db, sourceId: string) =>
  db.prepare("SELECT id FROM images WHERE source_id = ?").get(sourceId)!.id as string;
const statut = async (r: Response | Promise<Response>) => (await r).status;

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

Deno.test("lecture : propriétaire, collègue, élève et administrateur", async () => {
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
    for (const [id, code] of [[prive, 404], [collegues, 404], [eleves, 200]] as const) {
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

    // La revue des questions ne nomme pas la séquence d'une source que l'enseignant ne lit pas.
    db.prepare(
      "UPDATE sources SET metadonnees = json_set(metadonnees, '$.sequence', 'Séquence secrète') WHERE id = ?",
    ).run(prive);
    db.prepare(
      `INSERT INTO messages (id, compte_id, question, etat, resultat, cree_le, maj_le)
       VALUES ('m', ?, 'Une question', 'answered', ?, '2026-10-10T08:00:00Z', '2026-10-10T08:00:00Z')`,
    ).run(eleve.id, JSON.stringify({ affirmations: [{ source_id: prive }] }));
    assertStringIncludes(await (await a.requete("/prof/questions")).text(), "Séquence secrète");
    const questions = await (await b.requete("/prof/questions")).text();
    assert(questions.includes("Une question") && !questions.includes("Séquence secrète"));

    // Les questions suggérées sont communes à tous : seules celles des sources publiées restent.
    for (const id of [prive, collegues, eleves]) {
      db.prepare("INSERT INTO suggestions VALUES (?, ?, ?, 'faux', 'test')").run(id, id, `Q ${id}`);
    }
    assertEquals(suggestionsDuPerimetre(db, new Set([prive, collegues, eleves])), [`Q ${eleves}`]);
    assertEquals([...suggestionsParChapitre(db).values()].flat(), [`Q ${eleves}`]);

    const trouve = (l?: Lecteur) =>
      new Set(
        chercherFts(db, "façade céramique", { schoolId: lireInstance(db).school_id, lecteur: l })
          .map((c) => c.source_id),
      );
    const lecteur = (id: string, administrateur = false) => ({
      id,
      enseignant: true,
      administrateur,
    });
    assertEquals(trouve(), new Set([eleves]));
    assertEquals(trouve(lecteur(b.id)), new Set([collegues, eleves]));
    assertEquals(trouve(lecteur(a.id)), new Set([prive, collegues, eleves]));
    assertEquals(trouve(lecteur(admin.id, true)), new Set([prive, collegues, eleves]));
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("écriture : le propriétaire et les administrateurs seulement", async () => {
  const { db, dir, a, b, admin, collegues } = await instance();
  try {
    const poster = (qui: typeof a, chemin: string, corps: Record<string, string>) =>
      statut(qui.requete(chemin, { method: "POST", body: new URLSearchParams(corps) }));
    const modifier = { titre: "Corrigé", sequence: "", audience: "prive" };
    assertEquals(await poster(b, `/prof/sources/${collegues}/modifier`, modifier), 403);
    assertEquals(await poster(b, `/prof/sources/${collegues}/rejetee`, {}), 403);
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
        ...db.prepare(
          "SELECT proprietaire_id, audience, reponses FROM sources WHERE titre = 'Dépôt'",
        ).get(),
      },
      { proprietaire_id: b.id, audience: "collegues", reponses: 0 },
    );
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("réponses : preuves lisibles par le lecteur, retrait pendant la génération", async () => {
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
    assertEquals(actualiserResultat(db, pourProf.resultat, { schoolId }).etat, "failed");
    assertEquals(
      (await demander(db, fauxModeles().modeles, q, { schoolId }, 0.023)).resultat.etat,
      "out_of_corpus",
    );

    // Une réponse publiée perd sa preuve à la relecture quand la source devient privée.
    db.prepare("UPDATE sources SET reponses = 1 WHERE id = ?").run(eleves);
    const poser = async () => {
      const fragment = await (await eleve.requete("/eleve/questions", {
        method: "POST",
        headers: { "HX-Request": "true" },
        body: new URLSearchParams({ texte: q }),
      })).text();
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
      !(await (await eleve.requete(`/eleve/messages/${publie}/citations/0`)).text())
        .includes("dans toute la façade"),
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
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("partager une source ne partage pas les échanges de son propriétaire", async () => {
  const f = fauxModeles({ sorties: [BONNE] });
  const { db, dir, a, b } = await instance(f.modeles);
  try {
    const fragment = await (await a.requete("/eleve/questions", {
      method: "POST",
      headers: { "HX-Request": "true" },
      body: new URLSearchParams({ texte: "Question privée sur la façade" }),
    })).text();
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
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("instance personnelle : le propriétaire étudie ses ressources privées", async () => {
  const { db, dir } = await environnement();
  try {
    configurerInstance(db, "Mon étude", "personal");
    const moi = await compte(db, "enseignant");
    db.prepare("UPDATE comptes SET administrateur = 1 WHERE id = ?").run(moi.id);
    const id = await source(db, "Mes notes", "prive", moi.id);
    assertStringIncludes(await (await moi.requete("/eleve")).text(), "Mes notes");
    assertEquals(await statut(moi.requete(`/eleve/sources/${id}`)), 200);
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migration des lecteurs : aucun accès élargi ni retiré", async () => {
  const dir = await Deno.makeTempDir();
  config.donnees = dir;
  const db = connexion(join(dir, "state.sqlite3"));
  try {
    db.exec("CREATE TABLE migrations (nom TEXT PRIMARY KEY, applique_le TEXT NOT NULL)");
    for (const nom of [...Deno.readDirSync(join(RACINE, "migrations"))].map((f) => f.name).sort()) {
      if (nom >= "0008") continue;
      db.exec(Deno.readTextFileSync(join(RACINE, "migrations", nom)));
      db.prepare("INSERT INTO migrations VALUES (?, 'fixture')").run(nom);
    }
    for (const [id, nom] of [["d", "M. Detienne"], ["h1", "Homonyme"], ["h2", "Homonyme"]]) {
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
    assertEquals(migrer(db), ["0008_acces.sql"]);
    assertEquals(
      db.prepare("SELECT audience, reponses, proprietaire_id, metadonnees FROM sources ORDER BY id")
        .all().map((s) => ({ ...s })),
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
    await Deno.remove(dir, { recursive: true });
  }
});
