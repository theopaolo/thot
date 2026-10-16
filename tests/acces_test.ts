import { existsSync, readFileSync, readdirSync } from "node:fs";
import { rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { connexion, type Db, maintenant, migrer } from "../src/app/db.ts";
import { config, RACINE } from "../src/app/config.ts";
import { type Audience, deposer, valider } from "../src/app/depot.ts";
import { configurerInstance, lireInstance } from "../src/app/instance.ts";
import { reextraire, revendiquer, statuer, traiter } from "../src/app/ingestion.ts";
import { chercherFts, type Lecteur } from "../src/core/recherche.ts";
import { actualiserResultat, demander } from "../src/core/reponse.ts";
import { cleLegende, type Modeles } from "../src/core/modeles.ts";
import type { Profil } from "../src/core/profils.ts";
import { faitAuHasard, suggestionsDuPerimetre } from "../src/app/suggestions.ts";
import { creerCompte } from "../src/app/comptes.ts";
import {
  affiliations,
  cours,
  coursDuCompte,
  desinscrire,
  inscrire,
  matiere,
  theme,
} from "../src/app/domaines.ts";
import { environnement, fauxModeles, ORIGINE, session } from "./outils.ts";

const TEXTE =
  "La façade de la Casa Batlló est couverte de céramique irisée. " +
  "Gaudí refuse la ligne droite dans toute la façade.";
const BAUHAUS = "L'école du Bauhaus réunit les arts et l'artisanat à Weimar.";
const BONNE = JSON.stringify({
  affirmations: [
    {
      texte: "Gaudí refuse la ligne droite.",
      extrait: 1,
      citation: "Gaudí refuse la ligne droite dans toute la façade",
    },
  ],
});

async function source(
  db: Db,
  titre: string,
  audience: Audience,
  proprietaireId: string,
  coursId?: string,
  texte = TEXTE,
) {
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
    liens: coursId ? [{ cours_id: coursId, theme_id: null }] : undefined,
    octets: new TextEncoder().encode(
      `<html><h1>${titre}</h1><img src="data:image/jpeg;base64,/9j/4AAQ"><p>${texte}</p></html>`,
    ),
  });
  await traiter(db, revendiquer(db)!, fauxModeles().modeles);
  statuer(db, source_id, "certifiee", "Test");
  return source_id;
}

/** Une session et l'identifiant de son compte, inscrit dans les cours demandés. */
async function compte(
  db: Db,
  role: "enseignant" | "eleve",
  modeles = fauxModeles().modeles,
  coursIds: string[] = [],
) {
  const s = await session(db, modeles, role, false);
  const id = db.prepare("SELECT id FROM comptes ORDER BY rowid DESC LIMIT 1").get()!.id as string;
  for (const c of coursIds) inscrire(db, c, id);
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
    assertEquals(
      actualiserResultat(db, pourProf.resultat, { schoolId, lecteur: null }).etat,
      "failed",
    );
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

/** Deux cours d'une même matière, chacun avec son enseignant et son élève. */
async function deuxCours(modeles?: Modeles) {
  const { db, dir } = await environnement();
  const m = matiere(db, "Arts appliqués");
  const c1 = cours(db, m, "Design"),
    c2 = cours(db, m, "Histoire de l'art");
  const profA = await compte(db, "enseignant", modeles, [c1]);
  const profB = await compte(db, "enseignant", modeles, [c2]);
  const profC = await compte(db, "enseignant", modeles, [c1]);
  const eleveA = await compte(db, "eleve", modeles, [c1]);
  const eleveB = await compte(db, "eleve", modeles, [c2]);
  const publie = await source(db, "Cours du design", "eleves", profA.id, c1);
  const partage = await source(db, "Corrigé du design", "collegues", profA.id, c1);
  const prive = await source(db, "Brouillon du design", "prive", profA.id, c1);
  const libre = await source(db, "Ressource sans cours", "eleves", profA.id);
  return { db, dir, m, c1, c2, profA, profB, profC, eleveA, eleveB, publie, partage, prive, libre };
}

test("cours : seuls ses membres lisent et modifient ce qu'il partage", async () => {
  const { db, dir, c1, profA, profB, profC, eleveA, eleveB, publie, partage, prive, libre } =
    await deuxCours();
  try {
    const attendu: [typeof profA, string, number][] = [
      [profB, publie, 404],
      [profB, partage, 404],
      [profB, libre, 200],
      [profC, partage, 200],
      [profC, prive, 404],
    ];
    for (const [qui, id, code] of attendu) {
      assertEquals(await statut(qui.requete(`/prof/sources/${id}`)), code, `${id} ${code}`);
    }
    assertStringIncludes(
      await (await eleveA.requete("/eleve/sans-sequence")).text(),
      "Les enseignants de tes cours lisent tes questions.",
    );
    for (const [qui, id, code] of [
      [eleveA, publie, 200],
      [eleveB, publie, 404],
      [eleveB, libre, 200],
    ] as const) {
      assertEquals(await statut(qui.requete(`/eleve/sources/${id}`)), code, `élève ${id}`);
      assertEquals(await statut(qui.requete(`/media/${image(db, id)}`)), code);
    }
    const commeEleve = (id: string) => ({ id, enseignant: false, administrateur: false });
    const trouve = (id: string) =>
      new Set(
        chercherFts(db, "façade céramique", {
          schoolId: lireInstance(db).school_id,
          lecteur: commeEleve(id),
        }).map((c) => c.source_id),
      );
    assertEquals(trouve(eleveA.id), new Set([publie, libre]));
    assertEquals(trouve(eleveB.id), new Set([libre]));
    db.prepare("INSERT INTO suggestions VALUES ('s', ?, 'Q design', 'faux', 'test')").run(publie);
    assertEquals(suggestionsDuPerimetre(db, commeEleve(eleveA.id), new Set([publie])), [
      "Q design",
    ]);
    assertEquals(suggestionsDuPerimetre(db, commeEleve(eleveB.id), new Set([publie])), []);

    // Un enseignant du cours modifie une source partagée, pas celle d'un autre cours.
    const poster = (qui: typeof profA, chemin: string, corps: Record<string, string>) =>
      statut(qui.requete(chemin, { method: "POST", body: new URLSearchParams(corps) }));
    assertEquals(await poster(profC, `/prof/sources/${partage}/rejetee`, {}), 200);
    assertEquals(await poster(profB, `/prof/sources/${libre}/rejetee`, {}), 403);
    // La revue groupée applique la même règle : rien d'un autre cours, rien de privé.
    await poster(profB, "/prof/sources/statut", { ids: publie, statut: "rejetee" });
    await poster(profC, "/prof/sources/statut", { ids: prive, statut: "rejetee" });
    assertEquals(
      db
        .prepare("SELECT statut FROM sources WHERE id IN (?, ?)")
        .all(publie, prive)
        .map((l) => l.statut),
      ["certifiee", "certifiee"],
    );
    // Il ne rattache une source qu'à ses cours. Le rattachement d'un autre cours reste.
    const f = new FormData();
    for (const [k, v] of Object.entries({ titre: "Dépôt", type_document: "cours" })) f.append(k, v);
    f.append("cours", c1);
    f.append("fichier", new File([`<html><p>${TEXTE}</p></html>`], "depot.html"));
    assertEquals(await statut(profB.requete("/prof/depot", { method: "POST", body: f })), 400);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("cours : retirer un élève pendant la génération garde le texte hors de sa réponse", async () => {
  const f = fauxModeles({ sorties: [BONNE] });
  const { db, dir, c1, eleveA, libre } = await deuxCours(f.modeles);
  try {
    db.prepare("UPDATE sources SET reponses = 0 WHERE id = ?").run(libre);
    const generer = f.modeles.generer;
    f.modeles.generer = (messages) => {
      desinscrire(db, c1, eleveA.id);
      return generer(messages);
    };
    const fragment = await (
      await eleveA.requete("/eleve/questions", {
        method: "POST",
        headers: { "HX-Request": "true" },
        body: new URLSearchParams({ texte: "Pourquoi la façade n'a pas de ligne droite ?" }),
      })
    ).text();
    const mid = fragment.match(/messages\/([\w-]+)\/flux/)![1];
    const flux = await (await eleveA.requete(`/eleve/messages/${mid}/flux`)).text();
    assert(!flux.includes("Gaudí refuse la ligne droite."), "texte publié après le retrait");
    assertEquals(db.prepare("SELECT etat FROM messages WHERE id = ?").get(mid)!.etat, "failed");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("questions des élèves : chaque enseignant lit celles de ses cours", async () => {
  const { db, dir, c1, profA, profB, eleveA, eleveB } = await deuxCours();
  try {
    const sansCours = await compte(db, "eleve");
    const poser = (id: string, eleve: string, question: string, coursId = "") =>
      db
        .prepare(
          `INSERT INTO messages (id, compte_id, question, etat, cours_id, cree_le, maj_le)
         VALUES (?, ?, ?, 'out_of_corpus', ?, '2026-10-10T08:00:00Z', '2026-10-10T08:00:00Z')`,
        )
        .run(id, eleve, question, coursId);
    const [q1, q2, q3] = [
      "Question posée dans Design",
      "Question libre de B",
      "Question sans cours",
    ];
    poser("q1", eleveA.id, q1, c1);
    poser("q2", eleveB.id, q2);
    poser("q3", sansCours.id, q3);
    const lues = async (qui: typeof profA) => {
      const page = await (await qui.requete("/prof/questions")).text();
      return [q1, q2, q3].filter((q) => page.includes(q));
    };
    assertEquals(await lues(profA), [q1, q3]);
    assertEquals(await lues(profB), [q2, q3]);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("migration des membres : chaque compte rejoint chaque cours existant", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thot-"));
  config.donnees = dir;
  const db = connexion(join(dir, "state.sqlite3"));
  try {
    db.exec("CREATE TABLE migrations (nom TEXT PRIMARY KEY, applique_le TEXT NOT NULL)");
    for (const nom of readdirSync(join(RACINE, "migrations"), { withFileTypes: true })
      .map((f) => f.name)
      .sort()) {
      if (nom >= "0009") continue;
      db.exec(readFileSync(join(RACINE, "migrations", nom), "utf8"));
      db.prepare("INSERT INTO migrations VALUES (?, 'fixture')").run(nom);
    }
    db.exec(`INSERT INTO matieres VALUES ('m', 'Arts appliqués', 'arts-appliques');
      INSERT INTO cours (id, matiere_id, nom) VALUES ('c1', 'm', 'Design'), ('c2', 'm', 'Histoire');
      INSERT INTO comptes (id, identifiant, nom, role, sel, empreinte, cree_le)
        VALUES ('p', 'p', 'Prof', 'enseignant', '', '', 'x'), ('e', 'e', 'Élève', 'eleve', '', '', 'x');`);
    assertEquals(migrer(db), [
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
    ]);
    assertEquals(
      db
        .prepare("SELECT cours_id || compte_id AS m FROM membres_cours ORDER BY m")
        .all()
        .map((l) => l.m),
      ["c1e", "c1p", "c2e", "c2p"],
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

type Qui = Awaited<ReturnType<typeof compte>>;
const envoyer = (qui: Qui, chemin: string, corps: Record<string, string> = {}) =>
  qui.requete(chemin, { method: "POST", body: new URLSearchParams(corps) });
const texteDe = async (qui: Qui, chemin: string) => (await qui.requete(chemin)).text();
/** Les rattachements d'une source, cours par cours : `{ cours_id: theme_id | null }`. */
const liens = (db: Db, sourceId: string) =>
  Object.fromEntries(
    db
      .prepare("SELECT cours_id, theme_id FROM source_cours WHERE source_id = ?")
      .all(sourceId)
      .map((l) => [l.cours_id as string, l.theme_id as string | null]),
  );
/** Le gabarit échappe l'apostrophe : `nom` se retrouve tel quel ou échappé. */
const nomme = (page: string, nom: string) =>
  page.includes(nom) || page.includes(nom.replaceAll("'", "&#39;"));
const commeEleve = (id: string) => ({ id, enseignant: false, administrateur: false });

async function administrateur(db: Db) {
  const admin = await compte(db, "enseignant");
  db.prepare("UPDATE comptes SET administrateur = 1 WHERE id = ?").run(admin.id);
  return admin;
}

/** Une seconde matière avec son cours et son enseignant, étrangers à ceux de `deuxCours`. */
async function autreMatiere(db: Db) {
  const m = matiere(db, "Histoire");
  const c = cours(db, m, "Antiquité");
  return { m, c, prof: await compte(db, "enseignant", undefined, [c]) };
}

/** Une question d'élève, avec le périmètre que l'élève avait choisi. */
function poserQuestion(
  db: Db,
  id: string,
  eleveId: string,
  texte: string,
  o: { matiere_id?: string; cours_id?: string; theme_id?: string } = {},
) {
  db.prepare(
    `INSERT INTO messages (id, compte_id, question, etat, matiere_id, cours_id, theme_id,
       cree_le, maj_le)
     VALUES (?, ?, ?, 'answered', ?, ?, ?, '2026-10-10T08:00:00Z', '2026-10-10T08:00:00Z')`,
  ).run(id, eleveId, texte, o.matiere_id ?? "", o.cours_id ?? "", o.theme_id ?? "");
}

test("élèves : seuls les administrateurs gèrent ceux sans cours", async () => {
  const { db, dir, c1, profA, profB, eleveA, eleveB } = await deuxCours();
  try {
    const sansCours = await compte(db, "eleve");
    const admin = await administrateur(db);
    const profSansCours = await compte(db, "enseignant");
    const eleves = [eleveA, eleveB, sansCours];
    const identifiant = (e: Qui) =>
      db.prepare("SELECT identifiant FROM comptes WHERE id = ?").get(e.id)!.identifiant as string;
    const empreinte = (e: Qui) =>
      db.prepare("SELECT empreinte FROM comptes WHERE id = ?").get(e.id)!.empreinte as string;
    const listes = async (qui: Qui) => {
      const page = await texteDe(qui, "/prof/eleves");
      return eleves.filter((e) => page.includes(identifiant(e))).map((e) => e.id);
    };
    const reinitialiser = (qui: Qui, e: Qui) =>
      statut(envoyer(qui, `/prof/eleves/${e.id}/reinitialiser`));
    const avantB = empreinte(eleveB);
    assertEquals(await reinitialiser(profA, eleveB), 404);
    assertEquals(empreinte(eleveB), avantB, "le mot de passe d'un autre cours a changé");
    const avantA = empreinte(eleveA);
    assertEquals(await reinitialiser(profA, eleveA), 200);
    assert(empreinte(eleveA) !== avantA, "le mot de passe n'a pas changé");
    const avantSansCours = empreinte(sansCours);
    assertEquals(await reinitialiser(profA, sansCours), 404);
    assertEquals(await reinitialiser(profSansCours, sansCours), 404);
    assertEquals(empreinte(sansCours), avantSansCours, "le mot de passe sans cours a changé");
    assertEquals(await listes(profA), [eleveA.id]);
    assertEquals(await listes(profB), [eleveB.id]);
    assertEquals(await listes(profSansCours), []);
    assertEquals(
      await listes(admin),
      eleves.map((e) => e.id),
    );

    assertEquals(await reinitialiser(profB, eleveA), 404);
    assertEquals(await reinitialiser(profB, eleveB), 200);
    assertEquals(await reinitialiser(admin, eleveA), 200);
    assertEquals(await reinitialiser(admin, eleveB), 200);
    assertEquals(await reinitialiser(admin, sansCours), 200);

    desinscrire(db, c1, eleveA.id);
    assertEquals(await listes(profA), []);
    assertEquals(
      await listes(admin),
      eleves.map((e) => e.id),
    );
    const apresRetrait = empreinte(eleveA);
    assertEquals(await reinitialiser(profA, eleveA), 404);
    assertEquals(await reinitialiser(profSansCours, eleveA), 404);
    assertEquals(empreinte(eleveA), apresRetrait, "le retrait a ouvert la réinitialisation");
    assertEquals(await reinitialiser(admin, eleveA), 200);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("modifier : la séquence d'une ancienne source reste lisible et ne la range plus", async () => {
  const { db, dir, c1, profA, publie } = await deuxCours();
  try {
    db.prepare(
      "UPDATE sources SET metadonnees = json_set(metadonnees, '$.sequence', 'Lumière') WHERE id = ?",
    ).run(publie);
    const fiche = await texteDe(profA, `/prof/sources/${publie}`);
    assert(!fiche.includes('name="sequence"'), "le formulaire montre encore le champ libre");
    assertStringIncludes(fiche, "Lumière");
    // Un formulaire ouvert avant les thèmes envoie encore une séquence : elle ne change rien.
    const corps = { titre: "Cours du design", sequence: "Couleur" };
    assertEquals(await statut(envoyer(profA, `/prof/sources/${publie}/modifier`, corps)), 303);
    assertEquals(liens(db, publie), { [c1]: null });
    const meta = db.prepare("SELECT metadonnees FROM sources WHERE id = ?").get(publie)!;
    assertEquals(JSON.parse(meta.metadonnees as string).sequence, "Lumière");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("dépôt : sans cours choisi, la source va au premier cours de l'enseignant dans la matière", async () => {
  const { db, dir, m, c2, profB } = await deuxCours();
  try {
    const autre = await autreMatiere(db);
    const deposer = (qui: Qui, titre: string) => {
      const f = new FormData();
      for (const [k, v] of Object.entries({
        titre,
        type_document: "cours",
        matiere_id: m,
        sequence: "Lumière",
      }))
        f.append(k, v);
      f.append("fichier", new File([`<html><p>${TEXTE}</p></html>`], "depot.html"));
      return statut(qui.requete("/prof/depot", { method: "POST", body: f }));
    };
    const idDe = (titre: string) =>
      db.prepare("SELECT id FROM sources WHERE titre = ?").get(titre)!.id as string;
    const decompte = () => ({
      ...db
        .prepare(
          "SELECT (SELECT count(*) FROM cours) AS cours, (SELECT count(*) FROM themes) AS themes",
        )
        .get(),
    });

    // c1 est le premier cours de la matière, mais profB n'en est pas membre.
    assertEquals(await deposer(profB, "Dépôt de B"), 200);
    const theme2 = db
      .prepare("SELECT id FROM themes WHERE cours_id = ? AND nom = 'Lumière'")
      .get(c2)!.id as string;
    assertEquals(liens(db, idDe("Dépôt de B")), { [c2]: theme2 });

    // Un enseignant sans cours dans la matière dépose une source non rattachée.
    const avant = decompte();
    assertEquals(await deposer(autre.prof, "Dépôt de D"), 200);
    assertEquals(liens(db, idDe("Dépôt de D")), {});
    assertEquals(decompte(), avant);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("modifier : décocher tous les cours est refusé pour tout compte", async () => {
  const { db, dir, c1, profA, publie } = await deuxCours();
  try {
    const admin = await administrateur(db);
    const ressource = () => db.prepare("SELECT * FROM sources WHERE id = ?").get(publie);
    const avant = ressource();
    const decocher = (qui: Qui) =>
      envoyer(qui, `/prof/sources/${publie}/modifier`, {
        titre: "Cours retitré",
        sequence: "",
        affiliations_presentes: "1",
      });
    const refus = await decocher(profA);
    assertEquals(refus.status, 400);
    assertEquals(await refus.text(), "Une ressource rattachée garde au moins un cours.");
    assertEquals(liens(db, publie), { [c1]: null });
    assertEquals(ressource(), avant);

    const refusAdmin = await decocher(admin);
    assertEquals(refusAdmin.status, 400);
    assertEquals(await refusAdmin.text(), "Une ressource rattachée garde au moins un cours.");
    assertEquals(liens(db, publie), { [c1]: null });
    assertEquals(ressource(), avant);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("questions des élèves : le thème d'une source citée n'est montré qu'à qui la lit", async () => {
  const { db, dir, c1, c2, profA, profB, profC, prive, partage, libre } = await deuxCours();
  try {
    const [secrete, collegues, ouverte] = ["Thème secret", "Thème des collègues", "Thème ouvert"];
    for (const [id, c, nom] of [
      [prive, c1, secrete],
      [partage, c1, collegues],
      [libre, c2, ouverte],
    ]) {
      affiliations(db, id, [{ cours_id: c, theme_id: theme(db, c, nom) }]);
    }
    // Sans cours, cet élève pose des questions que tous les enseignants lisent.
    const eleve = await compte(db, "eleve");
    const questions = ["Question un", "Question deux", "Question trois"];
    [prive, partage, libre].forEach((source, i) => {
      poserQuestion(db, `q${i}`, eleve.id, questions[i]);
      db.prepare("UPDATE messages SET resultat = ? WHERE id = ?").run(
        JSON.stringify({ affirmations: [{ source_id: source }] }),
        `q${i}`,
      );
    });
    const vues = async (qui: Qui) => {
      const page = await texteDe(qui, "/prof/questions");
      for (const q of questions) assertStringIncludes(page, q);
      return [secrete, collegues, ouverte].filter((s) => page.includes(s));
    };
    assertEquals(await vues(profA), [secrete, collegues, ouverte]);
    assertEquals(await vues(profC), [collegues]);
    assertEquals(await vues(profB), [ouverte]);
    assertStringIncludes(await texteDe(profB, "/prof/questions"), "Autres questions");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("cours : un élève ne voit ni ne choisit le nom d'un cours dont il n'est pas membre", async () => {
  const { db, dir, c1, c2, eleveA, eleveB, publie } = await deuxCours();
  try {
    const impressionnisme = theme(db, c2, "Impressionnisme");
    affiliations(db, publie, [
      { cours_id: c1, theme_id: null },
      {
        cours_id: c2,
        theme_id: impressionnisme,
      },
    ]);

    const accueilA = await texteDe(eleveA, "/eleve");
    assertStringIncludes(accueilA, "Cours du design");
    assert(nomme(accueilA, "Design"));
    assert(!nomme(accueilA, "Histoire de l'art"), "nom du cours c2 montré à un élève de c1");
    assert(!nomme(accueilA, "Impressionnisme"), "nom du thème c2 montré à un élève de c1");
    const accueilB = await texteDe(eleveB, "/eleve");
    assert(nomme(accueilB, "Histoire de l'art") && nomme(accueilB, "Impressionnisme"));
    assert(!nomme(accueilB, "Design"));

    // eleveA lit la source rattachée à c2 par c1, mais ne pose pas de question dans c2.
    assertEquals(await statut(eleveA.requete(`/eleve/sources/${publie}`)), 200);
    const poser = (corps: Record<string, string>) =>
      statut(envoyer(eleveA, "/eleve/questions", { texte: "Une question", ...corps }));
    const nMessages = () => db.prepare("SELECT count(*) AS n FROM messages").get()!.n;
    assertEquals(await poser({ cours_id: c2 }), 400);
    assertEquals(await poser({ theme_id: impressionnisme }), 400);
    assertEquals(nMessages(), 0);
    assertEquals(await poser({ cours_id: c1 }), 303);
    assertEquals(
      db
        .prepare("SELECT cours_id FROM messages")
        .all()
        .map((l) => l.cours_id),
      [c1],
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("questions des élèves : un thème va aux enseignants de son cours, une matière à ceux de ses cours", async () => {
  const { db, dir, m, c1, profA, profB, profC, eleveA } = await deuxCours();
  try {
    const autre = await autreMatiere(db);
    const admin = await administrateur(db);
    const [duTheme, deLaMatiere] = ["Question sur les couleurs", "Question sur la matière"];
    poserQuestion(db, "q1", eleveA.id, duTheme, { theme_id: theme(db, c1, "Couleurs") });
    poserQuestion(db, "q2", eleveA.id, deLaMatiere, { matiere_id: m });
    const lues = async (qui: Qui) => {
      const page = await texteDe(qui, "/prof/questions");
      return [duTheme, deLaMatiere].filter((q) => page.includes(q));
    };
    assertEquals(await lues(profA), [duTheme, deLaMatiere]);
    assertEquals(await lues(profC), [duTheme, deLaMatiere]);
    assertEquals(await lues(profB), [deLaMatiere]);
    assertEquals(await lues(autre.prof), []);
    assertEquals(await lues(admin), [duTheme, deLaMatiere]);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("suggestions : un élève ne reçoit ni question ni fait d'une source hors de ses cours", async () => {
  const { db, dir, c1, profA, eleveA, eleveB, publie, libre } = await deuxCours();
  try {
    const phrase =
      "Gaudí construit la façade de la Casa Batlló à Barcelone entre 1904 et 1906 " +
      "avec des fragments de céramique irisée et des balcons en forme de masques.";
    // Les autres phrases ont moins de douze mots ou aucun fait : une seule se lit seule.
    const passage =
      `${phrase} La toiture ondule comme un dos de dragon. Les colonnes évoquent ` +
      "des os. Les couleurs changent avec la lumière du jour et le ciel de la ville. Chaque balcon " +
      "ressemble à un masque de carnaval et chaque fenêtre s'ouvre sans angle droit.";
    assert(passage.length >= 300);
    const faits = await source(db, "Faits du design", "eleves", profA.id, c1, passage);
    for (const [id, sourceId] of [
      ["s1", publie],
      ["s2", libre],
      ["s3", faits],
    ]) {
      db.prepare("INSERT INTO suggestions VALUES (?, ?, ?, 'faux', 'test')").run(
        id,
        sourceId,
        `Q ${id}`,
      );
    }
    const questions = (id: string) =>
      suggestionsDuPerimetre(db, commeEleve(id), new Set([publie, libre, faits])).sort();
    assertEquals(questions(eleveA.id), ["Q s1", "Q s2", "Q s3"]);
    assertEquals(questions(eleveB.id), ["Q s2"]);

    const fait = faitAuHasard(db, commeEleve(eleveA.id));
    assertEquals(fait?.source_id, faits);
    assertEquals(fait?.phrase, phrase);
    assertEquals(faitAuHasard(db, commeEleve(eleveB.id)), undefined);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("bibliothèque : la case d'une ressource que l'enseignant ne peut pas modifier est désactivée", async () => {
  const { db, dir, profA, profB, profC, publie, partage, libre } = await deuxCours();
  try {
    const desactivee = async (qui: Qui, id: string) => {
      const balise = (await texteDe(qui, "/prof")).match(
        new RegExp(`<input id="selection-${id}"[^>]*>`),
      );
      assert(balise, `la ressource ${id} manque à la bibliothèque`);
      return /\bdisabled\b/.test(balise[0]);
    };
    assertEquals(await desactivee(profB, libre), true);
    assertEquals(await desactivee(profA, libre), false);
    // Un collègue du cours modifie ce que le cours partage, pas la ressource libre d'un autre.
    assertEquals(await desactivee(profC, partage), false);
    assertEquals(await desactivee(profC, publie), false);
    assertEquals(await desactivee(profC, libre), true);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("modifier : cocher son cours garde les rattachements des autres cours", async () => {
  const { db, dir, c1, c2, profC, eleveA, eleveB, publie } = await deuxCours();
  try {
    affiliations(db, publie, [
      { cours_id: c1, theme_id: null },
      { cours_id: c2, theme_id: null },
    ]);
    const lit = (qui: Qui) => statut(qui.requete(`/eleve/sources/${publie}`));
    assertEquals(await lit(eleveB), 200);
    const modifier = (corps: Record<string, string>) =>
      statut(
        envoyer(profC, `/prof/sources/${publie}/modifier`, {
          titre: "Cours du design",
          sequence: "",
          affiliations_presentes: "1",
          ...corps,
        }),
      );

    assertEquals(await modifier({ cours: c1 }), 303);
    assertEquals(liens(db, publie), { [c1]: null, [c2]: null });
    assertEquals(await lit(eleveB), 200);
    assertEquals(await lit(eleveA), 200);

    // Décocher son seul cours retire c1 et laisse c2 : la ressource garde un cours.
    assertEquals(await modifier({}), 303);
    assertEquals(liens(db, publie), { [c2]: null });
    assertEquals(await lit(eleveB), 200);
    assertEquals(await lit(eleveA), 404);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("élèves : un enseignant ajoute un élève à ses cours et l'en retire, le compte reste", async () => {
  const { db, dir, c1, c2, profA, profB, profC, eleveA, eleveB, publie, libre } = await deuxCours();
  try {
    const admin = await administrateur(db);
    const comptes = () => db.prepare("SELECT count(*) n FROM comptes").get()!.n as number;
    const ajouter = (qui: Qui, identifiant: string, cours: string[]) => {
      const corps = new URLSearchParams({ identifiant, nom: "Léa Martin" });
      for (const id of cours) corps.append("cours", id);
      return qui.requete("/prof/eleves/ajouter", { method: "POST", body: corps });
    };
    const retirer = (qui: Qui, eleveId: string, coursId: string) =>
      statut(envoyer(qui, `/prof/eleves/${eleveId}/retirer`, { cours_id: coursId }));

    const avant = comptes();
    const refus = await ajouter(profB, "lea.martin", [c1]);
    assertEquals(refus.status, 400);
    assertStringIncludes(await refus.text(), "vos cours");
    assertEquals((await ajouter(profA, "lea.martin", [])).status, 400);
    const pris = db.prepare("SELECT identifiant FROM comptes WHERE id = ?").get(eleveA.id)!;
    const doublon = await ajouter(profA, pris.identifiant as string, [c1]);
    assertEquals(doublon.status, 400);
    assertStringIncludes(await doublon.text(), "rejoint vos cours par un lien d");
    assertEquals((await ajouter(profA, "LÉA", [c1])).status, 400);
    assertEquals(comptes(), avant);

    // Le mot de passe s'affiche une fois. L'élève s'en sert pour lire les ressources du cours.
    const feuille = await ajouter(profA, "lea.martin", [c1]);
    assertEquals(feuille.status, 200);
    assertEquals(feuille.headers.get("cache-control"), "no-store");
    const motDePasse = (await feuille.text()).match(/Mot de passe : <strong>([0-9a-f]+)</)![1];
    const lea = db.prepare("SELECT id FROM comptes WHERE identifiant = 'lea.martin'").get()!
      .id as string;
    const connexion = await profA.app.request("/connexion", {
      method: "POST",
      headers: { origin: "http://localhost" },
      body: new URLSearchParams({ identifiant: "lea.martin", mot_de_passe: motDePasse }),
    });
    const cookie = connexion.headers.get("set-cookie")!.split(";")[0];
    const lit = (id: string) =>
      statut(profA.app.request(`/eleve/sources/${id}`, { headers: { cookie } }));
    assertEquals(await lit(publie), 200);
    assertStringIncludes(await texteDe(profA, "/prof/eleves"), "lea.martin");
    assert(!(await texteDe(profB, "/prof/eleves")).includes("lea.martin"));

    // Un enseignant ne retire que les élèves de ses cours.
    assertEquals(await retirer(profB, lea, c1), 404);
    assertEquals(await retirer(profA, eleveB.id, c2), 404);
    assertEquals(await retirer(profA, profC.id, c1), 404);
    assertEquals(await lit(publie), 200);

    assertEquals(await retirer(profA, lea, c1), 303);
    assertEquals(await lit(publie), 404);
    assertEquals(await lit(libre), 200, "le compte retiré n'existe plus");
    assert(!(await texteDe(profA, "/prof/eleves")).includes("lea.martin"));
    assertEquals(await statut(envoyer(profA, `/prof/eleves/${lea}/reinitialiser`)), 404);
    const page = await texteDe(admin, "/prof/eleves");
    assert(page.indexOf("lea.martin") > page.indexOf("<h2>Sans cours</h2>"));
    assertEquals(await statut(envoyer(admin, `/prof/eleves/${lea}/reinitialiser`)), 200);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

/** Un lien d'inscription demandé par `qui` pour ces cours. */
const lienDe = (qui: Qui, cours: string[], places = "40") => {
  const corps = new URLSearchParams({ jours: "14", places });
  for (const id of cours) corps.append("cours", id);
  return qui.requete("/prof/eleves/liens", { method: "POST", body: corps });
};
const dernierJeton = (db: Db) =>
  db.prepare("SELECT jeton FROM liens ORDER BY rowid DESC LIMIT 1").get()!.jeton as string;
/** Une requête sans session, en GET, ou en POST avec un corps. */
const visiteur = (qui: Qui, chemin: string, corps?: Record<string, string>) =>
  qui.app.request(
    chemin,
    corps ? { method: "POST", headers: { origin: ORIGINE }, body: new URLSearchParams(corps) } : {},
  );
const LEA = { nom: "Léa Martin", identifiant: "lea.martin", mot_de_passe: "un mot de passe sûr" };

test("lien d'inscription : un visiteur crée son compte, un élève d'un autre cours rejoint d'un clic", async () => {
  const { db, dir, c1, c2, profA, profB, eleveB, publie } = await deuxCours();
  try {
    db.prepare("UPDATE comptes SET nom = 'M. Detienne' WHERE id = ?").run(profA.id);
    // Un enseignant ne crée de lien que pour ses cours.
    assertEquals(await statut(lienDe(profA, [c2])), 400);
    assertEquals(await statut(lienDe(profA, [])), 400);
    assertEquals(await statut(lienDe(profA, [c1], "0")), 400);
    assertEquals(db.prepare("SELECT count(*) n FROM liens").get()!.n, 0);
    assertEquals(await statut(lienDe(profA, [c1])), 303);
    const jeton = dernierJeton(db);
    assertEquals(Buffer.from(jeton, "base64url").length, 16);
    assertStringIncludes(await texteDe(profA, "/prof/eleves"), `/inscription/${jeton}`);
    assert(!(await texteDe(profB, "/prof/eleves")).includes(jeton));

    const page = await (await visiteur(profA, `/inscription/${jeton}`)).text();
    assertStringIncludes(page, "M. Detienne");
    assertStringIncludes(page, "Design");
    const places = () => db.prepare("SELECT places FROM liens WHERE jeton = ?").get(jeton)!.places;
    const comptes = () => db.prepare("SELECT count(*) n FROM comptes").get()!.n;
    const avant = comptes();
    const pris = db.prepare("SELECT identifiant FROM comptes WHERE id = ?").get(eleveB.id)!;
    for (const refus of [
      { ...LEA, mot_de_passe: "court" },
      { ...LEA, identifiant: pris.identifiant as string },
      { ...LEA, identifiant: "LÉA" },
    ]) {
      assertEquals(await statut(visiteur(profA, `/inscription/${jeton}`, refus)), 400);
    }
    assertEquals([comptes(), places()], [avant, 40]);

    // Le compte créé ouvre sa session sur /eleve et lit les ressources publiées du cours.
    const r = await visiteur(profA, `/inscription/${jeton}`, LEA);
    assertEquals(r.status, 303);
    assertEquals(r.headers.get("location"), "/eleve");
    const cookie = r.headers.get("set-cookie")!.split(";")[0];
    const commeLea = (chemin: string) => profA.app.request(chemin, { headers: { cookie } });
    assertEquals(await statut(commeLea("/eleve")), 200);
    assertEquals(await statut(commeLea(`/eleve/sources/${publie}`)), 200);
    assertEquals(places(), 39);
    assertStringIncludes(await texteDe(profA, "/prof/eleves"), "lea.martin");
    // Le mot de passe choisi reste le sien : la connexion n'en demande pas un autre.
    const connexion = await visiteur(profA, "/connexion", {
      identifiant: LEA.identifiant,
      mot_de_passe: LEA.mot_de_passe,
    });
    assertEquals(connexion.headers.get("location"), "/");

    // Un élève d'un autre cours rejoint d'un clic et garde ses cours. Un second clic est sans effet.
    assertStringIncludes(await texteDe(eleveB, `/inscription/${jeton}`), "Rejoindre</button>");
    assertEquals(await statut(envoyer(eleveB, `/inscription/${jeton}`)), 303);
    assertEquals(coursDuCompte(db, eleveB.id), new Set([c2, c1]));
    assertEquals(await statut(eleveB.requete(`/eleve/sources/${publie}`)), 200);
    assertEquals(await statut(envoyer(eleveB, `/inscription/${jeton}`)), 303);
    assertEquals(places(), 38);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("lien d'inscription : expiré, révoqué ou complet, il n'inscrit personne", async () => {
  const { db, dir, c1, profA, profB, eleveB } = await deuxCours();
  try {
    const comptes = () => db.prepare("SELECT count(*) n FROM comptes").get()!.n;
    const inutile = async (jeton: string) => {
      const avant = comptes();
      assertEquals(await statut(visiteur(profA, `/inscription/${jeton}`)), 404);
      const noe = { ...LEA, identifiant: "noe.petit" };
      assertEquals(await statut(visiteur(profA, `/inscription/${jeton}`, noe)), 404);
      assertEquals(await statut(envoyer(eleveB, `/inscription/${jeton}`)), 404);
      assertEquals(comptes(), avant);
      assert(!coursDuCompte(db, eleveB.id).has(c1));
    };

    await lienDe(profA, [c1], "1");
    const complet = dernierJeton(db);
    assertEquals(await statut(visiteur(profA, `/inscription/${complet}`, LEA)), 303);
    await inutile(complet);

    await lienDe(profA, [c1]);
    const expire = dernierJeton(db);
    db.prepare("UPDATE liens SET expire_le = '2000-01-01T00:00:00Z' WHERE jeton = ?").run(expire);
    await inutile(expire);

    // Seul un enseignant de ses cours révoque un lien. Les élèves qu'il a inscrits restent.
    await lienDe(profA, [c1]);
    const revoque = dernierJeton(db);
    const max = { ...LEA, identifiant: "max.roux" };
    assertEquals(await statut(visiteur(profA, `/inscription/${revoque}`, max)), 303);
    assertEquals(await statut(envoyer(profB, `/prof/eleves/liens/${revoque}/revoquer`)), 404);
    assertEquals(await statut(envoyer(profA, `/prof/eleves/liens/${revoque}/revoquer`)), 303);
    assert(!(await texteDe(profA, "/prof/eleves")).includes(revoque));
    await inutile(revoque);
    const maxId = db.prepare("SELECT id FROM comptes WHERE identifiant = 'max.roux'").get()!;
    assert(coursDuCompte(db, maxId.id as string).has(c1), "la révocation a retiré l'élève");

    // Un enseignant retiré du cours : son lien n'y inscrit plus.
    await lienDe(profA, [c1]);
    const orphelin = dernierJeton(db);
    desinscrire(db, c1, profA.id);
    await inutile(orphelin);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("lien d'inscription : une session enseignant n'est pas inscrite, la connexion revient au lien", async () => {
  const { db, dir, c1, profA, profB } = await deuxCours();
  try {
    const admin = await administrateur(db);
    await lienDe(profA, [c1]);
    const jeton = dernierJeton(db);
    for (const qui of [profB, admin]) {
      const avant = coursDuCompte(db, qui.id);
      assertStringIncludes(
        await texteDe(qui, `/inscription/${jeton}`),
        "Ce lien inscrit des élèves",
      );
      assertEquals(await statut(envoyer(qui, `/inscription/${jeton}`)), 403);
      assertEquals(coursDuCompte(db, qui.id), avant);
    }
    assertEquals(db.prepare("SELECT places FROM liens").get()!.places, 40);

    // Un élève qui a un compte se connecte, puis revient au lien. Aucune autre adresse de retour.
    const page = await (await visiteur(profA, `/inscription/${jeton}`)).text();
    assertStringIncludes(page, `/connexion?retour=/inscription/${jeton}`);
    const formulaire = await visiteur(profA, `/connexion?retour=/inscription/${jeton}`);
    assertStringIncludes(await formulaire.text(), `value="/inscription/${jeton}"`);
    const ailleurs = await (await visiteur(profA, "/connexion?retour=/prof")).text();
    assert(!ailleurs.includes('name="retour"'));
    const motDePasse = await creerCompte(db, "noe.petit", "Noé Petit", "eleve");
    const retour = async (adresse: string) =>
      (
        await visiteur(profA, "/connexion", {
          identifiant: "noe.petit",
          mot_de_passe: motDePasse,
          retour: adresse,
        })
      ).headers.get("location");
    assertEquals(await retour(`/inscription/${jeton}`), `/inscription/${jeton}`);
    for (const adresse of [
      "https://exemple.org/inscription/x",
      "//exemple.org/inscription/x",
      "/\\exemple.org/inscription/x",
      "/prof",
      "/inscription/",
      "/inscription/../prof",
      "/inscription/x?y=1",
    ]) {
      assertEquals(await retour(adresse), "/", adresse);
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("supprimer : le propriétaire efface la source, ses fichiers et ses citations, rien n'en reste en base", async () => {
  const { db, dir } = await environnement();
  try {
    const c1 = cours(db, matiere(db, "Arts appliqués"), "Design");
    const proprio = await compte(db, "enseignant", undefined, [c1]);
    const collegue = await compte(db, "enseignant", undefined, [c1]);
    const eleve = await compte(db, "eleve", undefined, [c1]);
    const cible = await source(db, "Bauhaus", "eleves", proprio.id, c1, BAUHAUS);
    const autre = await source(db, "Casa Batlló", "eleves", proprio.id, c1);
    const schoolId = lireInstance(db).school_id;
    const repondre = async (
      sourceId: string,
      question: string,
      texte: string,
      citation: string,
    ) => {
      const sortie = JSON.stringify({ affirmations: [{ texte, extrait: 1, citation }] });
      const p = { schoolId, lecteur: commeEleve(eleve.id), sourceId };
      const r = await demander(db, fauxModeles({ sorties: [sortie] }).modeles, question, p, 0);
      assert(r.resultat.etat === "answered");
      return { resultat: r.resultat, journal: r.journal };
    };
    const seule = await repondre(
      cible,
      "Que réunit l'école ?",
      "Arts et artisanat.",
      "réunit les arts et l'artisanat",
    );
    const batllo = await repondre(
      autre,
      "Pourquoi pas de ligne droite ?",
      "Pas de ligne droite.",
      "Gaudí refuse la ligne droite dans toute la façade",
    );
    // Les titres de blocs viennent du modèle : ils peuvent nommer la source supprimée.
    const mixte = {
      ...batllo.resultat,
      affirmations: [...seule.resultat.affirmations, ...batllo.resultat.affirmations],
      blocs: [
        {
          type: "tableau",
          colonnes: ["Bauhaus", "Gaudí"],
          lignes: [{ titre: "Idée", affirmations: [0, 1] }],
        },
      ],
    };
    const candidats = [seule, batllo].flatMap((r) => r.journal.candidats as unknown[]);
    const t = maintenant();
    db.prepare(
      "INSERT INTO conversations (id, compte_id, titre, active_le, cree_le) VALUES ('conv', ?, 'Révisions', ?, ?)",
    ).run(eleve.id, t, t);
    const message = (id: string, etat: string, resultat: unknown, journal: unknown, rang: number) =>
      db
        .prepare(
          `INSERT INTO messages (id, compte_id, question, etat, resultat, journal, cree_le, maj_le,
             conversation_id, rang) VALUES (?, ?, 'Question', ?, ?, ?, ?, ?, 'conv', ?)`,
        )
        .run(id, eleve.id, etat, JSON.stringify(resultat), JSON.stringify(journal), t, t, rang);
    message("seule", "answered", seule.resultat, seule.journal, 1);
    message("mixte", "answered", mixte, { ...seule.journal, candidats }, 2);
    message(
      "refus",
      "out_of_corpus",
      { etat: "out_of_corpus", raison: "refus_modele" },
      seule.journal,
      3,
    );
    const img = db
      .prepare(
        "SELECT i.fichier, i.mime, s.profil FROM images i JOIN sources s ON s.id = i.source_id WHERE s.id = ?",
      )
      .get(cible) as { fichier: string; mime: string; profil: Profil };
    const octets = readFileSync(join(dir, "content", cible, "assets", img.fichier));
    const cle = await cleLegende(config.modeles.legende, octets, img.mime, img.profil);
    db.prepare(
      "INSERT INTO cache_modeles VALUES (?, 'Une affiche du Bauhaus.', ?), ('autre', 'Une façade.', ?)",
    ).run(cle, t, t);
    db.prepare(
      "INSERT INTO suggestions VALUES ('sg', ?, 'Que réunit le Bauhaus ?', 'faux', ?)",
    ).run(cible, t);

    const supprimer = (qui: Qui) => statut(envoyer(qui, `/prof/sources/${cible}/supprimer`));
    assert(
      !(await texteDe(collegue, `/prof/sources/${cible}`)).includes("Supprimer définitivement"),
    );
    assertEquals(
      await supprimer(collegue),
      403,
      "un enseignant du cours modifie, il ne supprime pas",
    );
    assertStringIncludes(
      await texteDe(proprio, `/prof/sources/${cible}`),
      "Supprimer définitivement",
    );
    const job = db.prepare(
      "UPDATE ingestion_jobs SET etat = ?, verrou_expire_le = ? WHERE source_id = ?",
    );
    job.run("enriching", maintenant(Date.now() + 60_000), cible);
    assertEquals(
      await supprimer(proprio),
      409,
      "le worker réécrirait des fichiers après la suppression",
    );
    job.run("awaiting_review", null, cible);
    const r = await envoyer(proprio, `/prof/sources/${cible}/supprimer`);
    assertEquals([r.status, r.headers.get("location")], [303, "/prof?supprimee"]);
    assertStringIncludes(
      await texteDe(proprio, "/prof?supprimee"),
      "Source supprimée définitivement.",
    );

    for (const table of [
      "revisions",
      "chunks",
      "images",
      "source_cours",
      "suggestions",
      "ingestion_jobs",
    ]) {
      const n = db.prepare(`SELECT count(*) n FROM ${table} WHERE source_id = ?`).get(cible)!.n;
      assertEquals(n, 0, table);
    }
    const compter = (table: string) => db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n;
    assertEquals(compter("chunks_fts"), compter("chunks"));
    assertEquals(
      db
        .prepare("SELECT cle FROM cache_modeles")
        .all()
        .map((l) => l.cle),
      ["autre"],
    );
    // Ni une ligne, ni un segment de l'index plein texte, ni une page libérée ne garde la source.
    const garde = /bauhaus|weimar|artisanat/i;
    const texte = (v: unknown) =>
      v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : String(v);
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()) {
      const lignes = db.prepare(`SELECT * FROM "${name}"`).all().flatMap(Object.values);
      assert(!garde.test(lignes.map(texte).join(" ")), `${name} garde la source`);
    }
    for (const f of readdirSync(dir).filter((f) => f.startsWith("state.sqlite3"))) {
      assert(!garde.test(readFileSync(join(dir, f)).toString("latin1")), `${f} garde la source`);
    }
    assert(!existsSync(join(dir, "content", cible)));
    const trouvees = chercherFts(db, "façade ligne droite", {
      schoolId,
      lecteur: commeEleve(eleve.id),
    }).map((c) => c.source_id);
    assertEquals(new Set(trouvees), new Set([autre]));
    for (const chemin of [`/prof/sources/${cible}`, `/media/${cible}-0`]) {
      assertEquals(await statut(proprio.requete(chemin)), 404, chemin);
    }
    assertEquals(await statut(eleve.requete(`/eleve/sources/${cible}`)), 404);

    // La réponse qui ne citait que la source devient indisponible, l'autre garde la Casa Batlló.
    const ligne = (id: string) =>
      db.prepare("SELECT etat, resultat, journal FROM messages WHERE id = ?").get(id)!;
    assertEquals(ligne("seule").etat, "failed");
    const reste = JSON.parse(ligne("mixte").resultat as string);
    assertEquals(
      reste.affirmations.map((a: { source_id: string }) => a.source_id),
      [autre],
    );
    assertEquals([reste.blocs, reste.source_supprimee], [undefined, true]);
    const journal = JSON.parse(ligne("refus").journal as string);
    assertEquals(
      [ligne("refus").etat, journal.candidats, journal.tentatives],
      ["out_of_corpus", [], undefined],
    );
    const page = await texteDe(eleve, "/eleve/chat/conv");
    assertStringIncludes(page, "Une source citée a été supprimée.");
    assertStringIncludes(page, "la partie de la réponse qui la citait est retirée");
    assertStringIncludes(page, "Pas de ligne droite.");
    assertStringIncludes(
      await texteDe(eleve, "/eleve/messages/mixte/citations/0"),
      "refuse la ligne droite",
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});
