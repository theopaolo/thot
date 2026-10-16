import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "vite-plus/test";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "node:path";
import { connexion, migrer } from "../src/app/db.ts";
import { config, RACINE } from "../src/app/config.ts";
import { deposer, valider } from "../src/app/depot.ts";
import {
  affiliations,
  catalogue,
  catalogueVisible,
  champsMatiere,
  changerProfil,
  cours,
  coursDuCompte,
  enregistrerChamps,
  inscrire,
  matiere,
  renommer,
  theme,
} from "../src/app/domaines.ts";
import { configurerInstance, lireInstance } from "../src/app/instance.ts";
import {
  indexer,
  proposerInformations,
  reextraire,
  revendiquer,
  sourceSansInformations,
  statuer,
  traiter,
} from "../src/app/ingestion.ts";
import { chercher, chercherFts, indexerSource, lireChunk, racines } from "../src/core/recherche.ts";
import { demander } from "../src/core/reponse.ts";
import { decouperPdf } from "../src/core/pdf.ts";
import { CHAMPS, PROFILS, validerInformations } from "../src/core/profils.ts";
import { openrouter, PanneModele } from "../src/core/modeles.ts";
import { genererSuggestions } from "../src/app/suggestions.ts";
import { environnement, fauxModeles, session } from "./outils.ts";

async function ressource(
  db: ReturnType<typeof connexion>,
  champs: Record<string, string>,
  liens?: { cours_id: string; theme_id: string | null }[],
  texte = "La lumière traverse le prisme transparent et se décompose en couleurs visibles.",
) {
  const v = valider({ titre: "ATC Lumière", type_document: "cours", ...champs });
  assert("meta" in v);
  const { source_id } = await deposer(db, {
    meta: v.meta,
    liens,
    nomFichier: "cours.html",
    format: "html",
    schoolId: lireInstance(db).school_id,
    enseignant: "Prof original",
    audience: "eleves",
    reponses: true,
    octets: new TextEncoder().encode(
      `<html><h1>Lumière</h1><img src="data:image/jpeg;base64,/9j/4AAQ"><p>${texte}</p></html>`,
    ),
  });
  await traiter(db, revendiquer(db)!, fauxModeles().modeles);
  statuer(db, source_id, "certifiee", "Test");
  return source_id;
}

test("migration des matières : métadonnées intactes, thèmes homonymes séparés, inconnus visibles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thot-"));
  config.donnees = dir;
  const db = connexion(join(dir, "state.sqlite3"));
  try {
    db.exec("CREATE TABLE migrations (nom TEXT PRIMARY KEY, applique_le TEXT NOT NULL)");
    for (const nom of [
      "0001_depot.sql",
      "0002_mvp.sql",
      "0003_suggestions.sql",
      "0004_pilote.sql",
      "0005_coherence.sql",
      "0006_instance.sql",
    ]) {
      db.exec(readFileSync(join(RACINE, "migrations", nom), "utf8"));
      db.prepare("INSERT INTO migrations VALUES (?, 'fixture')").run(nom);
    }
    const metas = [
      { matiere: "arts-appliques", sequence: "Lumière", artiste: "Auteur relu" },
      {
        matiere: "Physique",
        sequence: "Lumière",
        auteur: "Newton",
      },
      { sequence: "Non classée", auteur: "Inconnu" },
    ];
    for (const [i, m] of metas.entries()) {
      db.prepare(
        `INSERT INTO sources (id,school_id,titre,metadonnees,fichier,format,checksum,octets,enseignant,cree_le) VALUES (?, 'pilote', 'Cours', ?, 'cours.html', 'html', 'x', 1, 'Prof historique', 'fixture')`,
      ).run(String(i), JSON.stringify(m));
    }
    assertEquals(migrer(db), [
      "0007_domaines.sql",
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
    assertEquals(migrer(db), []);
    const sources = db.prepare("SELECT * FROM sources ORDER BY id").all();
    assertEquals(
      sources.map((s) => s.metadonnees),
      metas.map((m) => JSON.stringify(m)),
    );
    assertEquals(
      sources.map((s) => s.profil),
      ["arts-appliques", "general", "general"],
    );
    // Sans `publics`, une source reste lisible des enseignants, sans propriétaire et sans réponses.
    assertEquals(
      sources.map((s) => [s.audience, s.reponses, s.proprietaire_id]),
      [
        ["collegues", 0, null],
        ["collegues", 0, null],
        ["collegues", 0, null],
      ],
    );
    assertEquals(sources[2].matiere_id, null);
    const cat = catalogue(db);
    assertEquals(
      cat.matieres.map((m) => m.nom),
      ["Arts appliqués", "Physique"],
    );
    assertEquals(
      cat.themes.map((t) => t.nom),
      ["Lumière", "Lumière"],
    );
    assert(cat.themes[0].id !== cat.themes[1].id);
    assert(cat.themes[0].cours_id !== cat.themes[1].cours_id);
    const prof = await session(db, fauxModeles().modeles, "enseignant");
    // Sources awaiting extraction are still listed after a job is created.
    db.exec(
      "INSERT INTO ingestion_jobs (id,source_id,etat,cree_le,maj_le) VALUES ('j','2','received','fixture','fixture')",
    );
    assertStringIncludes(await (await prof.requete("/prof")).text(), "/prof/sources/2");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("général : champs facultatifs, attribution, profil unique et rattachements sans copie ni publication", async () => {
  const { db, dir } = await environnement();
  try {
    const physique = matiere(db, "Physique");
    const reaper = matiere(db, "REAPER");
    const socio = matiere(db, "Sociologie");
    const c1 = cours(db, physique, "Optique", "", "Comprendre la lumière"),
      c2 = cours(db, reaper, "Manuel");
    cours(db, socio, "Auteurs");
    const t1 = theme(db, c1, "Introduction"),
      t2 = theme(db, c2, "Introduction");
    const id = await ressource(
      db,
      {
        matiere_id: physique,
        auteur: "Isaac Newton",
        version: "2",
        date_evenement: "1704-01-01",
        date_publication: "2025-01-01",
      },
      [
        { cours_id: c1, theme_id: t1 },
        { cours_id: c2, theme_id: t2 },
      ],
    );
    const avant = db.prepare("SELECT * FROM sources WHERE id = ?").get(id)!;
    assertEquals(avant.profil, "general");
    assertEquals(JSON.parse(avant.metadonnees as string).classe, "");
    assertEquals(JSON.parse(avant.metadonnees as string).auteur, "Isaac Newton");
    assertEquals(sourceSansInformations(db), undefined);
    await proposerInformations(db, fauxModeles().modeles, id);
    assertEquals(
      db.prepare("SELECT metadonnees FROM sources WHERE id = ?").get(id)!.metadonnees,
      avant.metadonnees,
    );
    assertEquals(
      chercherFts(db, "lumière", {
        lecteur: null,
        schoolId: "pilote",
        coursId: c1,
        themeId: t1,
      }).map((c) => c.source_id),
      [id],
    );
    assertEquals(
      chercherFts(db, "lumière", { lecteur: null, schoolId: "pilote", coursId: c1, themeId: t2 })
        .length,
      0,
    );
    const chunk = chercherFts(db, "lumière", {
      lecteur: null,
      schoolId: "pilote",
      coursId: c1,
      themeId: t1,
    })[0];
    assert(
      lireChunk(db, id, chunk.id, { lecteur: null, schoolId: "pilote", coursId: c1, themeId: t1 }),
    );
    assertEquals(
      lireChunk(db, id, chunk.id, { lecteur: null, schoolId: "pilote", coursId: c1, themeId: t2 }),
      undefined,
    );
    assertEquals(
      lireChunk(db, id, chunk.id, { lecteur: null, schoolId: "pilote", sourceId: "autre" }),
      undefined,
    );
    assertEquals(
      chercherFts(db, "lumière", {
        lecteur: null,
        schoolId: "pilote",
        matiereId: physique,
        coursId: c2,
      }).length,
      0,
    );
    assertEquals(
      chercherFts(db, "lumière", {
        lecteur: null,
        schoolId: "pilote",
        coursId: c2,
        themeId: t2,
      }).map((c) => c.source_id),
      [id],
    );
    assertThrows(() => affiliations(db, id, [{ cours_id: c1, theme_id: t2 }]));
    assertEquals(db.prepare("SELECT count(*) n FROM source_cours").get()!.n, 2);
    assertEquals(db.prepare("SELECT count(*) n FROM sources").get()!.n, 1);
    const eleve = await session(db, fauxModeles().modeles, "eleve");
    const html = await (await eleve.requete(`/eleve/themes/${t1}`)).text();
    assert(!html.includes("data-verifier-quiz"));
    assertStringIncludes(html, `name="theme_id" value="${t1}"`);
    const prof = await session(db, fauxModeles().modeles, "enseignant");
    // La ressource est déposée sous le nom « Prof original »: le compte connecté en devient propriétaire.
    db.prepare(
      "UPDATE sources SET proprietaire_id = (SELECT id FROM comptes WHERE role = 'enseignant')",
    ).run();
    const bibliotheque = await (await prof.requete(`/prof?cours_id=${c1}`)).text();
    assert(!bibliotheque.includes("Toutes les séquences"));
    assertStringIncludes(bibliotheque, "Ressource</th>");
    const detail = await (await prof.requete(`/prof/sources/${id}`)).text();
    assertStringIncludes(detail, "Isaac Newton");
    assertStringIncludes(
      await (await eleve.requete(`/eleve/sources/${id}`)).text(),
      "Isaac Newton",
    );
    const langue = async (code: string) => {
      assertEquals(
        (
          await prof.requete(`/prof/sources/${id}/modifier`, {
            method: "POST",
            body: new URLSearchParams({ titre: "ATC Lumière", sequence: "", langue: code }),
          })
        ).status,
        303,
      );
      assertEquals(db.prepare("SELECT langue FROM sources WHERE id = ?").get(id)!.langue, code);
      return (await (await eleve.requete(`/eleve/sources/${id}`)).text()).includes(
        "Langue non prise en charge",
      );
    };
    // L'anglais est pris en charge, les autres langues restent signalées.
    assertEquals(await langue("en"), false);
    assertEquals(await langue("de"), true);
    assertEquals(
      JSON.parse(
        db.prepare("SELECT metadonnees FROM sources WHERE id = ?").get(id)!.metadonnees as string,
      ).auteur,
      "Isaac Newton",
    );
    assert(!detail.includes("Le quiz élève"));
    assertThrows(() => changerProfil(db, "arts-appliques"), Error, "ressources");
    assertThrows(() => matiere(db, "Arts", "arts-appliques"), Error, "un seul profil");
    indexer(db, id);
    await reextraire(db, id);
    assertEquals(db.prepare("SELECT profil FROM sources WHERE id = ?").get(id)!.profil, "general");
    db.prepare("UPDATE sources SET audience = 'collegues' WHERE id = ?").run(id);
    assertEquals(
      chercherFts(db, "lumière", { lecteur: null, schoolId: "pilote", coursId: c2 }).length,
      0,
    );
    assertEquals((await eleve.requete(`/eleve/themes/${t2}`)).status, 404);
    assert(
      !catalogueVisible(db, { id: "", enseignant: false, administrateur: false }).themes.some(
        (t) => t.id === t2,
      ),
    );
    assertEquals(
      db.prepare("SELECT enseignant FROM sources WHERE id = ?").get(id)!.enseignant,
      "Prof original",
    );
    assertEquals(
      db.prepare("SELECT fichier FROM sources WHERE id = ?").get(id)!.fichier,
      "cours.html",
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("dépôt web et questions : périmètres par identifiants conservés jusqu’au flux, erreurs sans données partielles", async () => {
  const { db, dir } = await environnement();
  try {
    const m = matiere(db, "Sociologie"),
      c = cours(db, m, "Théories"),
      t = theme(db, c, "Auteurs");
    const citation = "Durkheim décrit les faits sociaux comme des manières collectives de penser.";
    const faux = fauxModeles({
      sorties: [JSON.stringify({ affirmations: [{ texte: citation, extrait: 1, citation }] })],
    });
    const prof = await session(db, faux.modeles, "enseignant");
    const form = new FormData();
    for (const [k, v] of Object.entries({
      titre: "Faits sociaux",
      type_document: "cours",
      matiere_id: m,
      auteur: "Durkheim",
      cours: c,
      [`theme_${c}`]: t,
    }))
      form.set(k, v);
    form.append("audience", "eleves");
    form.append("reponses", "1");
    form.set("fichier", new File([`<p>${citation}</p>`], "social.html"));
    assertEquals((await prof.requete("/prof/depot", { method: "POST", body: form })).status, 200);
    await traiter(db, revendiquer(db)!, faux.modeles);
    const id = db.prepare("SELECT id FROM sources").get()!.id as string;
    statuer(db, id, "certifiee", "Prof");
    const eleve = await session(db, faux.modeles, "eleve");
    const page = await (await eleve.requete(`/eleve?cours_id=${c}&theme_id=${t}`)).text();
    assertStringIncludes(page, "Faits sociaux");
    assertStringIncludes(page, "Théories / Auteurs");
    const recherche = await (
      await eleve.requete(`/eleve/recherche?q=faits&cours_id=${c}&theme_id=${t}`)
    ).text();
    assertStringIncludes(recherche, `name="cours_id" value="${c}"`);
    assertStringIncludes(recherche, `name="theme_id" value="${t}"`);
    assertEquals(
      (
        await eleve.requete("/eleve/questions", {
          method: "POST",
          body: new URLSearchParams({ texte: "faits sociaux", cours_id: c, theme_id: t }),
        })
      ).status,
      303,
    );
    const message = db.prepare("SELECT * FROM messages").get()!;
    assertEquals(message.cours_id, c);
    assertEquals(message.theme_id, t);
    assertEquals(message.chapitre, "");
    const flux = await (await eleve.requete(`/eleve/messages/${message.id}/flux`)).text();
    assertStringIncludes(flux, "Durkheim");
    assertEquals(
      (
        await eleve.requete("/eleve/questions", {
          method: "POST",
          body: new URLSearchParams({ texte: "Question", theme_id: "absent" }),
        })
      ).status,
      400,
    );
    form.set(`theme_${c}`, "absent");
    form.set("fichier", new File(["<p>Un autre texte.</p>"], "autre.html"));
    const refus = await prof.requete("/prof/depot", { method: "POST", body: form });
    assertEquals(refus.status, 400);
    assertStringIncludes(await refus.text(), "Cours ou thème inconnu");
    assertEquals(db.prepare("SELECT count(*) n FROM sources").get()!.n, 1);
    assertEquals(readdirSync(join(dir, "content"), { withFileTypes: true }).length, 1);
    assertEquals((await eleve.requete("/administration/domaines")).status, 403);
    assertEquals((await prof.requete("/administration/domaines")).status, 403);
    const compte = db.prepare("SELECT id FROM comptes WHERE role = 'enseignant'").get()!.id;
    db.prepare("UPDATE comptes SET administrateur = 1 WHERE id = ?").run(compte!);
    assertEquals((await prof.requete("/administration/domaines")).status, 200);
    assertEquals(
      (
        await prof.requete("/administration/domaines/matiere", {
          method: "POST",
          body: new URLSearchParams({ nom: "REAPER", profil: "general" }),
        })
      ).status,
      303,
    );
    assertEquals(
      (
        await prof.requete("/administration/domaines/matiere", {
          method: "POST",
          body: new URLSearchParams({ nom: "Invalide", profil: "arbitraire" }),
        })
      ).status,
      400,
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("prompts neutres, preuves conservées, rubriques ATC et légendes réservées au profil arts", async () => {
  const { db, dir } = await environnement();
  try {
    const citation =
      "La lumière traverse le prisme transparent et se décompose en couleurs visibles.";
    const id = await ressource(db, {}, undefined, Array(5).fill(citation).join(" "));
    const sortie = JSON.stringify({ affirmations: [{ texte: citation, extrait: 1, citation }] });
    const faux = fauxModeles({
      sorties: [
        sortie,
        JSON.stringify({ questions: ["Comment le prisme décompose-t-il la lumière ?"] }),
        sortie,
      ],
    });
    assertEquals(
      (await demander(db, faux.modeles, "lumière", { lecteur: null, schoolId: "pilote" }, 0.01))
        .resultat.etat,
      "answered",
    );
    await genererSuggestions(db, faux.modeles, id);
    const prompts = faux.vus
      .flat()
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    assert(!/Terminale|lycee|artiste|mouvement|oeuvre/.test(prompts));
    assertStringIncludes(prompts, "mot pour mot");
    const appels: string[] = [];
    const avant = globalThis.fetch;
    globalThis.fetch = (_input, init) => {
      appels.push(String(init?.body));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: appels.length === 3 ? "oui" : "Une image." } }],
          }),
          {
            headers: { "content-type": "application/json" },
          },
        ),
      );
    };
    try {
      const modeles = openrouter(
        { ...config.modeles, cle: "factice" },
        {
          lire: () => undefined,
          ecrire: () => {},
        },
      );
      await modeles.legender(new Uint8Array([1]), "image/jpeg", "general");
      await modeles.legender(new Uint8Array([1]), "image/jpeg", "arts-appliques");
      await modeles.soutenir("Phrase", "Citation", "Titre");
      assert(!/Terminale|arts appliques|artiste|mouvement/.test(appels[0]));
      assertStringIncludes(appels[1], "arts appliques");
      assert(!/Terminale|artiste|mouvement|oeuvre/.test(appels[2]));
    } finally {
      globalThis.fetch = avant;
    }
    const brut = "Quoi ?\nLa lumière se décompose.";
    assertEquals(decouperPdf(brut, "arts-appliques").parties[1].section, "Quoi ?");
    assertEquals(decouperPdf(brut, "general").parties[0].section, "Introduction");
    assertEquals(PROFILS.general.activites, ["explication"]);
    assertEquals(CHAMPS.date_evenement.type, "date");
    const general = champsMatiere(db, null, "general");
    assertThrows(() =>
      validerInformations({ valide_du: "2026-01-01", valide_au: "2025-01-01" }, general),
    );
    assertThrows(() => validerInformations({ date_publication: "2025-02-30" }, general));
    await assertRejects(() => ressource(db, { matiere_id: "inconnue" }));
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("profil général : les blocs du modèle rangent les affirmations que le juge garde", async () => {
  const { db, dir } = await environnement();
  try {
    const citation =
      "La lumière traverse le prisme transparent et se décompose en couleurs visibles.";
    await ressource(db, {}, undefined, citation);
    const sortie = JSON.stringify({
      affirmations: ["Un", "Deux", "Trois"].map((texte) => ({ texte, extrait: 1, citation })),
      blocs: [{ type: "etapes", titre: "Dans l'ordre", affirmations: [2, 3, 1] }],
    });
    const faux = fauxModeles({
      sorties: [sortie, sortie],
      soutien: (texte) => (texte === "Trois" ? 0.1 : 0.9),
    });
    const { resultat } = await demander(
      db,
      faux.modeles,
      "lumière",
      { lecteur: null, schoolId: "pilote" },
      0.01,
    );
    assertStringIncludes(faux.vus[0][0].content, "Au plus 8 affirmations et 250 mots");
    assert(resultat.etat === "answered" && resultat.partielle);
    assertEquals(
      resultat.affirmations.map((a) => a.texte),
      ["Deux", "Un"],
    );
    assertEquals(resultat.blocs, [{ type: "etapes", titre: "Dans l'ordre", affirmations: [0, 1] }]);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("arts appliqués : consignes mesurées, matière proposée, profil de l’instance pour les ressources", async () => {
  const { db, dir } = await environnement();
  const empreinte = async (t: string) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  try {
    const citation =
      "La lumière traverse le prisme transparent et se décompose en couleurs visibles.";
    const arts = await ressource(
      db,
      { matiere: "arts-appliques" },
      undefined,
      Array(5).fill(citation).join(" "),
    );
    const [m] = catalogue(db).matieres;
    assertEquals([m.nom, m.profil], ["Arts appliqués", "arts-appliques"]);
    const sortie = JSON.stringify({ affirmations: [{ texte: citation, extrait: 1, citation }] });
    const faux = fauxModeles({
      sorties: [
        sortie,
        JSON.stringify({ questions: ["Comment le prisme décompose-t-il la lumière ?"] }),
        sortie,
      ],
    });
    await demander(db, faux.modeles, "lumière", { lecteur: null, schoolId: "pilote" }, 0.01);
    await genererSuggestions(db, faux.modeles, arts);
    const systeme = faux.vus
      .flat()
      .filter((m) => m.role === "system")
      .map((m) => m.content);
    // Consignes de `reponse.ts` et `suggestions.ts` avant DOM-101, celles des mesures ml4.
    assertEquals(
      new Set(await Promise.all(systeme.map(empreinte))),
      new Set([
        "b2242dea70cea02ca328b17439fc4eac058b3dc9b33e4b0ba984442c75f0f778",
        "3b5289fcae4965f5f2bca037455d4805e334855023495ca8501097f93b92ada8",
      ]),
    );
    const corps: string[] = [];
    const avant = globalThis.fetch;
    globalThis.fetch = (_input, init) => {
      corps.push(String(init?.body));
      const content = corps.length === 1 ? "Une image." : "oui";
      return Promise.resolve(Response.json({ choices: [{ message: { content } }] }));
    };
    try {
      const modeles = openrouter(
        { ...config.modeles, cle: "factice" },
        {
          lire: () => undefined,
          ecrire: () => {},
        },
      );
      await modeles.legender(new Uint8Array([1]), "image/jpeg", "arts-appliques");
      await modeles.soutenir("Phrase", "Citation", "Titre", undefined, "arts-appliques");
    } finally {
      globalThis.fetch = avant;
    }
    // Empreintes enregistrées dans `evaluation/resultats/ml4-vision.json` et `ml4-soutien.json`.
    assertEquals(
      await empreinte(JSON.parse(corps[0]).messages[0].content[0].text),
      "a0f6088160f42e44fb255f8b226f5d3aad812cc51ff68ab97ee89592a4853ad3",
    );
    assertEquals(
      await empreinte(JSON.parse(corps[1]).messages[0].content),
      "af464e182725d30ff3f0be918319cd9e8381f3b221de0ae7272ea420fe45bd22",
    );

    const prof = await session(db, faux.modeles, "enseignant");
    assertStringIncludes(
      await (await prof.requete("/prof/depot")).text(),
      `name="matiere_id" value="${m.id}"`,
    );
    const form = new FormData();
    for (const [k, v] of Object.entries({
      titre: "Prisme",
      type_document: "cours",
      matiere_id: m.id,
      sequence: "Lumière",
      affiliations_presentes: "1",
    }))
      form.set(k, v);
    form.set("fichier", new File([`<p>${citation}</p>`], "prisme.html"));
    assertEquals((await prof.requete("/prof/depot", { method: "POST", body: form })).status, 200);
    assertEquals(
      db
        .prepare(
          `SELECT t.nom FROM sources s JOIN source_cours sc ON sc.source_id = s.id
        JOIN themes t ON t.id = sc.theme_id WHERE s.titre = 'Prisme'`,
        )
        .get()?.nom,
      "Lumière",
    );
    await traiter(db, revendiquer(db)!, faux.modeles);
    const rattachee = await ressource(db, {}, [
      {
        cours_id: catalogue(db).cours[0].id,
        theme_id: null,
      },
    ]);
    assertEquals(
      db.prepare("SELECT profil FROM sources WHERE id = ?").get(rattachee)!.profil,
      "arts-appliques",
    );
    const nonClassee = await ressource(db, {});
    assertEquals(
      db.prepare("SELECT profil FROM sources WHERE id = ?").get(nonClassee)!.profil,
      "arts-appliques",
    );
    assertThrows(() => matiere(db, "Physique", "general"), Error, "un seul profil");
    assertEquals(catalogue(db).matieres.length, 1);
    const eleve = await session(db, faux.modeles, "eleve");
    assertStringIncludes(
      await (await eleve.requete("/eleve")).text(),
      '<h2 id="tes-chapitres">Séquences</h2>',
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

async function administrateur(db: ReturnType<typeof connexion>) {
  const prof = await session(db, fauxModeles().modeles, "enseignant");
  db.prepare("UPDATE comptes SET administrateur = 1 WHERE role = 'enseignant'").run();
  return {
    ...prof,
    poster: (action: string, champs: Record<string, string>) =>
      prof.requete(`/administration/domaines/${action}`, {
        method: "POST",
        body: new URLSearchParams(champs),
      }),
  };
}

test("profil de l’instance : deux matières arts passent au général en une action, refus dès qu’une ressource existe", async () => {
  const { db, dir } = await environnement();
  try {
    const arts = matiere(db, "Arts", "arts-appliques");
    matiere(db, "Design");
    const admin = await administrateur(db);
    const profils = () => catalogue(db).matieres.map((m: { profil: string }) => m.profil);
    assertEquals(profils(), ["arts-appliques", "arts-appliques"]);
    assertEquals((await admin.poster("profil", { profil: "general" })).status, 303);
    assertEquals(profils(), ["general", "general"]);
    // Des matières de profils différents, héritées d’avant la règle, se rejoignent aussi.
    db.prepare("UPDATE matieres SET profil = 'arts-appliques' WHERE id = ?").run(arts);
    changerProfil(db, "general");
    assertEquals(profils(), ["general", "general"]);
    assertThrows(() => changerProfil(db, "inconnu"), Error, "Profil inconnu");
    const page = await (await admin.requete("/administration/domaines")).text();
    assertStringIncludes(page, 'action="/administration/domaines/profil"');

    await ressource(db, { matiere_id: arts });
    const refus = await admin.poster("profil", { profil: "arts-appliques" });
    assertEquals(refus.status, 400);
    assertStringIncludes(await refus.text(), "ressources sont déjà déposées");
    assertEquals(profils(), ["general", "general"]);
    const figee = await (await admin.requete("/administration/domaines")).text();
    assert(!figee.includes('action="/administration/domaines/profil"'));
    assertStringIncludes(figee, "Des ressources sont déposées");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("renommer : le cours pilote et un thème gardent leurs rattachements et les pages élèves", async () => {
  const { db, dir } = await environnement();
  try {
    const id = await ressource(db, { matiere: "arts-appliques", sequence: "Art Nouveau" });
    const [m] = catalogue(db).matieres,
      [c] = catalogue(db).cours,
      [t] = catalogue(db).themes;
    assertEquals([c.nom, t.nom], ["Arts appliqués", "Art Nouveau"]);
    const liens = () => db.prepare("SELECT * FROM source_cours").all();
    const avant = liens();
    const eleve = await session(db, fauxModeles().modeles, "eleve");
    const prof = await session(db, fauxModeles().modeles, "enseignant");

    renommer(db, "cours", c.id, "Histoire de l’art");
    const nouveau = "Art nouveau et Arts and Crafts";
    renommer(db, "theme", t.id, nouveau);
    assertEquals(liens(), avant);
    assertEquals(catalogue(db).cours[0].matiere_id, m.id);
    assertEquals(catalogue(db).themes[0].cours_id, c.id);
    for (const chemin of [`/eleve/themes/${t.id}`, "/eleve", `/eleve?cours_id=${c.id}`]) {
      const reponse = await eleve.requete(chemin);
      assertEquals(reponse.status, 200, chemin);
      assertStringIncludes(await reponse.text(), "ATC Lumière");
    }
    assertStringIncludes(
      await (await eleve.requete(`/eleve/themes/${t.id}`)).text(),
      "<h1>Art nouveau et Arts and Crafts</h1>",
    );
    assertStringIncludes(
      await (await eleve.requete("/eleve")).text(),
      "Art nouveau et Arts and Crafts",
    );
    // Les métadonnées gardent le nom du dossier d’origine : l'ancienne adresse mène au thème
    // renommé.
    assertEquals(
      (await eleve.requete("/eleve/sequences/Art%20Nouveau")).headers.get("location"),
      `/eleve/themes/${t.id}`,
    );
    assertStringIncludes(
      await (await prof.requete(`/prof?theme=${encodeURIComponent(nouveau)}`)).text(),
      `/prof/sources/${id}`,
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("en-tête des passages : noms des thèmes, séquence sans thème, renommage réindexé, preuve intacte", async () => {
  const { db, dir } = await environnement();
  const chunk = (id: string) =>
    db.prepare("SELECT titre, rappel, preuve FROM chunks WHERE source_id = ?").get(id)!;
  const entete = (id: string) => (chunk(id).rappel as string).split("\n")[0];
  try {
    const m = matiere(db, "Physique");
    const [c1, c2] = [cours(db, m, "Optique"), cours(db, m, "Couleurs")];
    const [t1, t2] = [theme(db, c1, "Prisme"), theme(db, c2, "Arc-en-ciel")];
    // Aucune séquence : le dépôt d'aujourd'hui ne la renseigne plus.
    const id = await ressource(db, {}, [
      { cours_id: c1, theme_id: t1 },
      { cours_id: c2, theme_id: t2 },
    ]);
    assertEquals(entete(id), "Arc-en-ciel / Prisme");
    const preuve = chunk(id).preuve as string;
    assert(!preuve.includes("Prisme") && !(chunk(id).titre as string).includes("Prisme"));

    const { poster } = await administrateur(db);
    assertEquals(
      (await poster("renommer", { genre: "theme", id: t1, nom: "Lentilles" })).status,
      303,
    );
    assertEquals(entete(id), "Arc-en-ciel / Lentilles");
    assertEquals(
      chercherFts(db, "lentilles", { schoolId: lireInstance(db).school_id, lecteur: null }).length,
      1,
    );
    assertEquals(chunk(id).preuve, preuve);

    // Une ancienne source sans thème garde sa séquence.
    const ancienne = await ressource(db, { sequence: "Optique ancienne" }, []);
    assertEquals(entete(ancienne), "Optique ancienne");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("import CLI : un cours choisi sans thème range la source dans le thème du nom de son dossier", async () => {
  const { db, dir } = await environnement();
  try {
    const c = cours(db, matiere(db, "Physique"), "Optique");
    const ids = [
      await ressource(db, { sequence: "Lumière" }, [{ cours_id: c, theme_id: null }]),
      await ressource(db, { sequence: "Lumière" }, [{ cours_id: c, theme_id: null }]),
      await ressource(db, {}, [{ cours_id: c, theme_id: null }]),
    ];
    const themes = ids.map(
      (id) =>
        db
          .prepare(
            "SELECT t.nom FROM source_cours sc LEFT JOIN themes t ON t.id = sc.theme_id WHERE sc.source_id = ?",
          )
          .get(id)!.nom,
    );
    assertEquals(themes, ["Lumière", "Lumière", null]);
    assertEquals(catalogue(db).themes.length, 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("renommer : un nom pris est refusé en français, un import par nom cherche l’ancien nom", async () => {
  const { db, dir } = await environnement();
  try {
    const arts = matiere(db, "Arts appliqués", "arts-appliques"),
      chimie = matiere(db, "Chimie");
    const c = cours(db, arts, "Images"),
      c2 = cours(db, arts, "Objets");
    const t = theme(db, c, "Art Nouveau");
    theme(db, c, "Bauhaus");
    theme(db, c2, "Ornement");
    assertThrows(() => renommer(db, "matiere", chimie, " Arts appliqués "), Error, "existe déjà");
    assertThrows(() => renommer(db, "theme", t, "Bauhaus"), Error, "« Bauhaus » existe déjà");
    renommer(db, "theme", t, "Ornement");
    renommer(db, "cours", c2, "Images");
    assertThrows(() => renommer(db, "theme", t, " "), Error, "Texte attendu");
    assertThrows(() => renommer(db, "theme", "absent", "Nom"), Error, "inconnu");
    assertThrows(() => renommer(db, "table", t, "Nom"), Error, "Type inconnu");
    const admin = await administrateur(db);
    const refus = await admin.poster("renommer", {
      genre: "matiere",
      id: chimie,
      nom: "Arts appliqués",
    });
    assertEquals(refus.status, 400);
    const page = await refus.text();
    assertStringIncludes(page, "« Arts appliqués » existe déjà");
    assert(!page.includes("constraint"));

    // `--matiere=` et le dossier d’un import cherchent la matière et le thème par leur nom.
    renommer(db, "theme", t, "Art nouveau 1900");
    renommer(db, "matiere", arts, "Arts appliqués 2de");
    await ressource(db, { matiere_id: arts, sequence: "Art Nouveau" });
    assertEquals(
      catalogue(db)
        .themes.map((x) => x.nom)
        .sort(),
      ["Art Nouveau", "Art nouveau 1900", "Bauhaus", "Ornement"],
    );
    await ressource(db, { matiere: "arts-appliques" });
    assertEquals(
      catalogue(db).matieres.map((x) => x.nom),
      ["Arts appliqués", "Arts appliqués 2de", "Chimie"],
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("supprimer : refusée avec sa raison tant qu’une ressource ou une question utilise l’entrée, sinon retirée des filtres et du dépôt", async () => {
  const { db, dir } = await environnement();
  try {
    const physique = matiere(db, "Physique"),
      socio = matiere(db, "Sociologie");
    const optique = cours(db, physique, "Optique"),
      mecanique = cours(db, physique, "Mécanique");
    const lumiere = theme(db, optique, "Lumière"),
      couleurs = theme(db, optique, "Colorimétrie");
    theme(db, cours(db, socio, "Théories"), "Auteurs");
    await ressource(db, { matiere_id: physique }, [{ cours_id: optique, theme_id: lumiere }]);
    const admin = await administrateur(db);
    const supprimer = (genre: string, id: string) => admin.poster("supprimer", { genre, id });
    db.prepare(
      `INSERT INTO messages (id, compte_id, question, theme_id, etat, cree_le, maj_le)
       VALUES ('q', (SELECT id FROM comptes), 'Question', ?, 'answered', 'x', 'x')`,
    ).run(couleurs);

    for (const [genre, id, raison] of [
      ["theme", lumiere, "« Lumière » est utilisé par 1 ressource(s)."],
      ["theme", couleurs, "« Colorimétrie » est utilisé par 1 question(s)."],
      ["cours", optique, "« Optique » est utilisé par 1 ressource(s) et 1 question(s)."],
      ["matiere", physique, "« Physique » est utilisé par 1 ressource(s) et 1 question(s)."],
    ]) {
      const refus = await supprimer(genre, id);
      assertEquals(refus.status, 400);
      assertStringIncludes(await refus.text(), raison);
    }
    // Un refus ne retire rien, pas même les cours inutilisés de la matière.
    const avant = catalogue(db);
    assertEquals([avant.matieres.length, avant.cours.length, avant.themes.length], [2, 3, 3]);
    assertEquals((await supprimer("table", "x")).status, 400);
    assertEquals((await supprimer("theme", "absent")).status, 400);

    db.prepare("DELETE FROM messages").run();
    assertEquals((await supprimer("theme", couleurs)).status, 303);
    assertEquals((await supprimer("cours", mecanique)).status, 303);
    // Une matière emporte ses cours et ses thèmes quand rien ne les utilise.
    assertEquals((await supprimer("matiere", socio)).status, 303);
    const apres = catalogue(db);
    assertEquals(
      apres.matieres.map((x) => x.nom),
      ["Physique"],
    );
    assertEquals(
      apres.cours.map((x) => x.nom),
      ["Optique"],
    );
    assertEquals(
      apres.themes.map((x) => x.nom),
      ["Lumière"],
    );
    for (const chemin of ["/prof", "/prof/depot"]) {
      const page = await (await admin.requete(chemin)).text();
      assertStringIncludes(page, "Optique");
      for (const retire of ["Sociologie", "Théories", "Auteurs", "Mécanique", "Colorimétrie"]) {
        assert(!page.includes(retire), `${chemin} propose encore ${retire}`);
      }
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("sonde lexicale français / anglais : chaque source racinisée dans sa langue, les autres signalées", async () => {
  const { db, dir } = await environnement();
  try {
    const fr = await ressource(db, { langue: "fr" }),
      en = await ressource(db, { langue: "en" }),
      de = await ressource(db, { langue: "de" });
    const jeux = {
      fr: [
        { texte: "Les chanteurs chantent.", q: "chanter" },
        { texte: "Les chevaux courent.", q: "cheval" },
        { texte: "Les couleurs lumineuses.", q: "couleur" },
        { texte: "Les expériences scientifiques.", q: "expérience" },
      ],
      en: [
        { texte: "The singers were singing.", q: "sing" },
        { texte: "The horses run.", q: "horse" },
        { texte: "The children are learning.", q: "child learn" },
        { texte: "The studies are published.", q: "study publish" },
      ],
    };
    const resultats: Record<string, number> = {};
    for (const [langue, jeu] of Object.entries(jeux)) {
      const id = langue === "fr" ? fr : en;
      indexerSource(
        db,
        id,
        jeu.map((x, i) => ({
          id: String(i),
          source_id: id,
          school_id: "pilote",
          titre: "Ressource",
          debut: 0,
          fin: x.texte.length,
          texte: x.texte,
          rappel: x.texte,
          preuve: x.texte,
          revision: 1,
        })),
      );
      resultats[langue] = jeu.filter((x, i) =>
        chercherFts(db, x.q, { lecteur: null, schoolId: "pilote", sourceId: id }).some(
          (c) => c.id === String(i),
        ),
      ).length;
    }
    console.log("Sonde FTS5 morphologie :", JSON.stringify(resultats), "sur 4 requêtes par langue");
    assertEquals(resultats.fr, 3);
    assertEquals(resultats.en, 4);
    const avertissements = (id: string) =>
      db.prepare("SELECT avertissements FROM ingestion_jobs WHERE source_id = ?").get(id)!
        .avertissements as string;
    assert(!avertissements(en).includes("Langue non prise en charge"));
    assertStringIncludes(avertissements(de), "Langue non prise en charge pour la recherche : de");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("langues : une question française trouve un passage anglais par ses racines anglaises et par sa traduction", async () => {
  const { db, dir } = await environnement();
  try {
    const dev = matiere(db, "Développement");
    const lire = cours(db, dev, "Lire du code"),
      autre = cours(db, dev, "Autre cours");
    const passageFr = "La mémoire de travail sature quand on lit un code inconnu.",
      passageEn =
        "Refactoring code frees the working memory. Short term memory holds information for thirty seconds.";
    const fr = await ressource(
      db,
      { langue: "fr" },
      [{ cours_id: lire, theme_id: null }],
      passageFr,
    );
    const en = await ressource(
      db,
      { langue: "en-GB" },
      [{ cours_id: lire, theme_id: null }],
      passageEn,
    );
    const seul = await ressource(
      db,
      { langue: "fr" },
      [{ cours_id: autre, theme_id: null }],
      passageFr,
    );
    // Une source française garde exactement ses racines françaises, une source anglaise prend les
    // racines anglaises.
    const index = (id: string) =>
      db
        .prepare(
          "SELECT c.titre, c.rappel, f.titre AS titre_fts, f.texte FROM chunks c JOIN chunks_fts f ON f.rowid = c.n WHERE c.source_id = ?",
        )
        .all(id) as { titre: string; rappel: string; titre_fts: string; texte: string }[];
    for (const [id, anglais] of [
      [fr, false],
      [seul, false],
      [en, true],
    ] as const) {
      for (const l of index(id)) {
        assertEquals(l.titre_fts, racines(l.titre, anglais).join(" "));
        assertEquals(l.texte, racines(l.rappel, anglais).join(" "));
      }
    }
    assertStringIncludes(index(en)[0].texte, "refactor code free the work memori");

    const p = (coursId: string) => ({ lecteur: null, schoolId: "pilote", coursId });
    const sources = (cs: { source_id: string }[]) => [...new Set(cs.map((c) => c.source_id))];
    // Racines anglaises : « refactoring » se racinise « refactoring » en français, « refactor » en
    // anglais, comme le passage anglais.
    assertEquals(sources(chercherFts(db, "Qu'est-ce que le refactoring ?", p(lire))), [en]);

    // Traduction : la question française n'a aucun mot du passage anglais, sa traduction si.
    const question = "Combien de temps dure la mémoire immédiate ?";
    assert(!chercherFts(db, question, p(lire)).some((c) => c.source_id === en));
    const f = fauxModeles();
    const traductions: string[] = [];
    f.modeles.traduire = (q) => {
      traductions.push(q);
      return Promise.resolve("How long does short term memory hold information?");
    };
    const reclassees: string[] = [];
    const reclasser = f.modeles.reclasser;
    f.modeles.reclasser = (q, docs, signal) => {
      reclassees.push(q);
      return reclasser(q, docs, signal);
    };
    const r = await chercher(db, f.modeles, question, p(lire), 0.5);
    assertEquals(r.traduction, "How long does short term memory hold information?");
    assert(r.retenus.some((c) => c.source_id === en));
    // Le reclasseur lit la question de l'élève, pas sa traduction.
    assertEquals(reclassees, [question]);

    // Un périmètre sans source anglaise ne traduit pas et cherche comme avant.
    const seule = await chercher(db, f.modeles, question, p(autre), 0.5);
    assertEquals(traductions, [question]);
    assertEquals(seule.traduction, undefined);
    assertEquals(sources(seule.candidats), [seul]);

    // La réponse reste en français et cite le passage anglais mot pour mot.
    const extrait = r.retenus.findIndex((c) => c.source_id === en) + 1;
    f.modeles.generer = () =>
      Promise.resolve({
        texte: JSON.stringify({
          affirmations: [
            {
              texte: "La mémoire à court terme garde une information trente secondes.",
              extrait,
              citation: "Short term memory holds information for thirty seconds.",
            },
          ],
        }),
        modele: "faux-llm",
      });
    const reponse = await demander(db, f.modeles, question, p(lire), 0.5);
    assertEquals(reponse.resultat.etat, "answered");
    assert(reponse.resultat.etat === "answered");
    assertEquals(reponse.resultat.affirmations[0].source_id, en);
    assertEquals(reponse.journal.traduction, "How long does short term memory hold information?");

    // Une traduction en panne laisse la question seule : elle aboutit sur la source française.
    f.modeles.traduire = () => Promise.reject(new PanneModele("traduction indisponible"));
    const sansTraduction = await chercher(db, f.modeles, question, p(lire), 0.5);
    assertEquals(sansTraduction.traduction, undefined);
    assertEquals(sources(sansTraduction.candidats), [fr]);
    f.modeles.generer = () =>
      Promise.resolve({
        texte: JSON.stringify({
          affirmations: [
            {
              texte: "La mémoire de travail sature devant un code inconnu.",
              extrait: 1,
              citation: "La mémoire de travail sature quand on lit un code inconnu.",
            },
          ],
        }),
        modele: "faux-llm",
      });
    const repli = await demander(db, f.modeles, question, p(lire), 0.5);
    assertEquals(repli.resultat.etat, "answered");
    assertEquals(repli.journal.traduction, undefined);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("CLI : configurer des collections, changer le profil, importer, rattacher, renommer, supprimer, refuser un second profil", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thot-"));
  try {
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
    const cli = async (...args: string[]) => {
      const r = lancer(...args);
      assert(r.status === 0, r.stderr);
      return r.stdout.trim();
    };
    const profils = async () =>
      JSON.parse(await cli("domaines")).matieres.map((m: { profil: string }) => m.profil);
    const arts = await cli("matiere", "Arts", "--profil=arts-appliques");
    const physique = await cli("matiere", "Physique");
    assertEquals(await profils(), ["arts-appliques", "arts-appliques"]);
    await cli("profil", "general");
    assertEquals(await profils(), ["general", "general"]);
    await cli("matiere", "REAPER");
    const socio = await cli("matiere", "Sociologie");
    const c = await cli("cours", physique, "Optique"),
      t = await cli("theme", c, "Introduction");
    await cli("compte", "lea", "Léa Martin", "eleve");
    const effectif = async () =>
      JSON.parse(await cli("domaines")).cours.find((x: { id: string }) => x.id === c).membres;
    assertEquals(await effectif(), 0);
    await cli("membre", c, "lea");
    await cli("membre", c, "LEA");
    assertEquals(await effectif(), 1);
    const inconnu = lancer("membre", c, "personne");
    assert(inconnu.status !== 0);
    assertStringIncludes(inconnu.stderr, "Compte introuvable");
    assert(lancer("membre", "absent", "lea").status !== 0);
    assertEquals(await effectif(), 1);
    await cli("retirer-membre", c, "lea");
    assertEquals(await effectif(), 0);
    // `compte --cours` inscrit le compte qu'il crée. Un cours inconnu ne crée aucun compte.
    await cli("compte", "noe", "Noé Petit", "eleve", `--cours=${c}`);
    assertEquals(await effectif(), 1);
    assert(lancer("compte", "max", "Max Roux", "eleve", "--cours=absent").status !== 0);
    assert(
      lancer("compte", "max", "Max Roux", "eleve").status === 0,
      "le cours inconnu a créé max",
    );
    await cli("retirer-membre", c, "noe");
    const fichier = join(dir, "physique.html");
    await writeFile(fichier, "<p>La lumière traverse le prisme transparent.</p>");
    // L'import prend les lecteurs par défaut de l'instance.
    const reglage = connexion(join(dir, "state.sqlite3"));
    reglage.prepare("UPDATE instance SET lecteurs = 'collegues'").run();
    reglage.close();
    await cli(
      "ingest",
      fichier,
      `--matiere-id=${physique}`,
      `--cours-id=${c}`,
      `--theme-id=${t}`,
      "--auteur=Newton",
      "--langue=en",
    );
    await cli("traiter");
    const db = connexion(join(dir, "state.sqlite3"));
    try {
      const s = db.prepare("SELECT * FROM sources").get()!;
      assertEquals(s.profil, "general");
      assertEquals(s.langue, "en");
      assertEquals(s.audience, "collegues");
      const meta = JSON.parse(s.metadonnees as string);
      assertEquals(meta.auteur, "Newton");
      assertEquals(meta.classe, "");
      assertEquals(db.prepare("SELECT theme_id FROM source_cours").get()!.theme_id, t);
      const c2 = await cli("cours", arts, "Images");
      await cli("rattacher", s.id as string, c2);
      assertEquals(db.prepare("SELECT count(*) n FROM source_cours").get()!.n, 2);
      assert(lancer("profil", "arts-appliques").status !== 0);
      assert(lancer("matiere", "Design", "--profil=arts-appliques").status !== 0);
      assert(lancer("supprimer", "matiere", physique).status !== 0);
      await cli("renommer", "cours", c, "Optique", "géométrique");
      await cli("supprimer", "matiere", socio);
      assertEquals(
        db.prepare("SELECT nom FROM cours WHERE id = ?").get(c)!.nom,
        "Optique géométrique",
      );
      await cli("reextraire");
      await cli("rebuild");
      assertEquals(db.prepare("SELECT profil FROM sources").get()!.profil, "general");
      assertEquals(db.prepare("SELECT enseignant FROM sources").get()!.enseignant, s.enseignant);
      assertEquals(JSON.parse(await cli("domaines")).matieres.length, 3);
      assertEquals(db.prepare("SELECT count(*) n FROM sources").get()!.n, 1);
      // Sans sa dernière ressource, la matière se supprime.
      await cli("supprimer", "source", s.id as string);
      assertEquals(db.prepare("SELECT count(*) n FROM sources").get()!.n, 0);
      await cli("supprimer", "matiere", physique);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});

async function enseignantDe(db: ReturnType<typeof connexion>, cours_id: string[]) {
  const prof = await session(db, fauxModeles().modeles, "enseignant", false);
  const id = db.prepare("SELECT id FROM comptes ORDER BY rowid DESC LIMIT 1").get()!.id as string;
  for (const c of cours_id) inscrire(db, c, id);
  return { ...prof, id };
}

test("membres d'un cours : l'administrateur inscrit et retire, les autres comptes reçoivent 403", async () => {
  const { db, dir } = await environnement();
  try {
    const admin = await administrateur(db);
    const c = cours(db, matiere(db, "Physique"), "Optique");
    const eleve = await session(db, fauxModeles().modeles, "eleve", false);
    const prof = await session(db, fauxModeles().modeles, "enseignant", false);
    const eleveId = db.prepare("SELECT id FROM comptes WHERE role = 'eleve'").get()!.id as string;
    const champs = new URLSearchParams({ cours_id: c, compte_id: eleveId });
    for (const autre of [eleve, prof]) {
      assertEquals((await autre.requete("/administration/domaines")).status, 403);
      const refus = await autre.requete("/administration/domaines/inscrire", {
        method: "POST",
        body: champs,
      });
      assertEquals(refus.status, 403);
    }
    assertEquals(coursDuCompte(db, eleveId).size, 0);

    let page = await (await admin.requete("/administration/domaines")).text();
    assertStringIncludes(page, "Membres : 0");
    assertStringIncludes(page, "Aucun membre.");
    assertStringIncludes(page, `<option value="${eleveId}">Compte eleve`);
    const ajout = await admin.poster("inscrire", { cours_id: c, compte_id: eleveId });
    assertEquals(ajout.status, 303);
    assertStringIncludes(ajout.headers.get("location")!, `ouvert=${c}`);
    assert(coursDuCompte(db, eleveId).has(c));
    page = await (await admin.requete(`/administration/domaines?ouvert=${c}`)).text();
    assertStringIncludes(page, "Membres : 1");
    assertStringIncludes(page, `<details id="membres-${c}" open>`);
    assertStringIncludes(page, "Compte eleve");
    assertStringIncludes(page, ", élève</span>");
    assert(!page.includes(`<option value="${eleveId}">`));

    // Un seul rang par compte et par cours.
    assertEquals((await admin.poster("inscrire", { cours_id: c, compte_id: eleveId })).status, 303);
    assertEquals(db.prepare("SELECT count(*) n FROM membres_cours").get()!.n, 1);
    for (const mauvais of [
      { cours_id: "absent", compte_id: eleveId },
      { cours_id: c, compte_id: "x" },
    ]) {
      const refus = await admin.poster("inscrire", mauvais);
      assertEquals(refus.status, 400);
      assertStringIncludes(await refus.text(), "inconnu");
    }

    assertEquals(
      (await admin.poster("desinscrire", { cours_id: c, compte_id: eleveId })).status,
      303,
    );
    assertEquals(coursDuCompte(db, eleveId).size, 0);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("CSV élèves : les nouveaux comptes rejoignent les cours cochés, jamais ceux d'un autre enseignant", async () => {
  const { db, dir } = await environnement();
  try {
    const m = matiere(db, "Physique");
    const [optique, mecanique] = [cours(db, m, "Optique"), cours(db, m, "Mécanique")];
    const prof = await enseignantDe(db, [optique]);
    const classe = (lignes: string, coches: string[]) => {
      const f = new FormData();
      f.append("fichier", new File([`identifiant,nom\n${lignes}\n`], "classe.csv"));
      for (const id of coches) f.append("cours", id);
      return f;
    };
    const eleves = () => db.prepare("SELECT count(*) n FROM comptes WHERE role = 'eleve'").get()!.n;

    const page = await (await prof.requete("/prof/eleves")).text();
    assertStringIncludes(page, `name="cours" value="${optique}" checked`);
    assert(!page.includes(mecanique));

    const refus = await prof.requete("/prof/eleves/importer", {
      method: "POST",
      body: classe("lea,Léa Martin", [optique, mecanique]),
    });
    assertEquals(refus.status, 400);
    assertStringIncludes(await refus.text(), "vos cours");
    assertEquals(eleves(), 0);

    const bon = await prof.requete("/prof/eleves/importer", {
      method: "POST",
      body: classe("lea,Léa Martin\nnoe,Noé Petit", [optique]),
    });
    assertEquals(bon.status, 200);
    const lea = db.prepare("SELECT id FROM comptes WHERE identifiant = 'lea'").get()!.id as string;
    assertEquals([...coursDuCompte(db, lea)], [optique]);

    // Sans cours coché, l'élève échapperait à l'enseignant qui l'a créé.
    const sans = await prof.requete("/prof/eleves/importer", {
      method: "POST",
      body: classe("max,Max Roux", []),
    });
    assertEquals(sans.status, 400);
    assertEquals(eleves(), 2);

    // Un administrateur choisit parmi tous les cours, un cours inconnu annule l'import.
    const admin = await administrateur(db);
    assertStringIncludes(await (await admin.requete("/prof/eleves")).text(), mecanique);
    const ajout = await admin.requete("/prof/eleves/importer", {
      method: "POST",
      body: classe("eva,Éva Roy", [mecanique]),
    });
    assertEquals(ajout.status, 200);
    const eva = db.prepare("SELECT id FROM comptes WHERE identifiant = 'eva'").get()!.id as string;
    assertEquals([...coursDuCompte(db, eva)], [mecanique]);
    const inconnu = await admin.requete("/prof/eleves/importer", {
      method: "POST",
      body: classe("zoe,Zoé Blanc", [optique, "absent"]),
    });
    assertEquals(inconnu.status, 400);
    assertEquals(
      db.prepare("SELECT count(*) n FROM comptes WHERE identifiant = 'zoe'").get()!.n,
      0,
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("élèves : un enseignant sans cours ne crée pas d'élève, un administrateur si", async () => {
  const { db, dir } = await environnement();
  try {
    const prof = await session(db, fauxModeles().modeles, "enseignant");
    const page = await (await prof.requete("/prof/eleves")).text();
    assertStringIncludes(page, "Vous n'avez pas encore de cours");
    assert(!page.includes("/prof/eleves/importer"));
    const f = new FormData();
    f.append("fichier", new File(["identifiant,nom\nlea,Léa Martin\n"], "classe.csv"));
    assertEquals(
      (await prof.requete("/prof/eleves/importer", { method: "POST", body: f })).status,
      400,
    );
    const admin = await administrateur(db);
    assert(!(await (await admin.requete("/prof/eleves")).text()).includes("Cours des nouveaux"));
    assertEquals(
      (await admin.requete("/prof/eleves/importer", { method: "POST", body: f })).status,
      200,
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("l'élève apprend qui lit ses questions, sauf en mode personnel", async () => {
  const { db, dir } = await environnement();
  try {
    cours(db, matiere(db, "Physique"), "Optique");
    const inscrit = await session(db, fauxModeles().modeles, "eleve");
    const libre = await session(db, fauxModeles().modeles, "eleve", false);
    for (const chemin of ["/eleve", "/eleve/chat"]) {
      assertStringIncludes(
        await (await inscrit.requete(chemin)).text(),
        "Les enseignants de tes cours lisent tes questions.",
      );
      const sans = await (await libre.requete(chemin)).text();
      assertStringIncludes(sans, "Les enseignants lisent tes questions.");
      assert(!sans.includes("de tes cours"));
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
  const perso = await environnement();
  try {
    configurerInstance(perso.db, "Mon étude", "personal");
    const moi = await session(perso.db, fauxModeles().modeles, "enseignant");
    for (const chemin of ["/eleve", "/eleve/chat"]) {
      const r = await moi.requete(chemin);
      assertEquals(r.status, 200);
      assert(!(await r.text()).includes("lisent tes questions"));
    }
  } finally {
    perso.db.close();
    await rm(perso.dir, { recursive: true });
  }
});

test("champs du dépôt : « Norme » se coche par matière, se valide, se masque sans perdre ses valeurs", async () => {
  const { db, dir } = await environnement();
  try {
    const elec = matiere(db, "Électricité", "arts-appliques");
    const cles = (profil: "general" | "arts-appliques") =>
      champsMatiere(db, elec, profil).map((c) => c.cle);
    // Une matière arts garde les champs que le quiz lit, même décochés.
    assert(enregistrerChamps(db, elec, [], 0));
    assertEquals(cles("arts-appliques"), ["date", "artiste", "mouvement"]);
    // Changer de profil ne réécrit pas une liste enregistrée.
    changerProfil(db, "general");
    assertEquals(cles("general"), ["date", "artiste", "mouvement"]);

    const admin = await administrateur(db);
    const prof = await session(db, fauxModeles().modeles, "enseignant");
    assertEquals((await admin.poster("champ", { nom: "Norme", type: "text" })).status, 303);
    assertEquals((await admin.poster("champ", { nom: "Norme", type: "date" })).status, 400);
    const norme = db.prepare("SELECT id FROM champs_personnalises").get()!.id as string;
    const champs = (version: string, ...liste: string[]) =>
      admin.requete("/administration/domaines/champs", {
        method: "POST",
        body: new URLSearchParams([
          ["matiere_id", elec],
          ["version", version],
          ...liste.map((c) => ["champs", c]),
        ]),
      });
    const refus = await prof.requete("/administration/domaines/champs", {
      method: "POST",
      body: new URLSearchParams({ matiere_id: elec, version: "1", champs: norme }),
    });
    assertEquals(refus.status, 403);
    const enregistre = await champs("1", "auteur", norme);
    assertEquals(enregistre.status, 303);
    const page = await (await admin.requete(enregistre.headers.get("location")!)).text();
    assertStringIncludes(page, `<details id="champs-${elec}" open>`);
    assertStringIncludes(page, "Réglages enregistrés.");
    assertStringIncludes(page, "Champs du dépôt : 2");
    assertStringIncludes(page, "Texte, 1 matière, 0 ressource");

    // Une version périmée n'enregistre rien et rend la saisie avec la version actuelle.
    const conflit = await champs("1", norme);
    assertEquals(conflit.status, 409);
    const saisie = await conflit.text();
    assertStringIncludes(saisie, "Ces réglages ont changé pendant votre saisie.");
    assertStringIncludes(saisie, `name="version" value="2"`);
    assertStringIncludes(saisie, `value="${norme}" checked`);
    assert(!saisie.includes(`value="auteur" checked`));
    assertEquals(cles("general"), ["auteur", norme]);

    const formulaire = await (await admin.requete(`/prof/depot?matiere_id=${elec}`)).text();
    assertStringIncludes(formulaire, `<label for="${norme}">Norme</label>`);
    assert(!formulaire.includes('name="juridiction"'));
    const deposer = (valeur: string) => {
      const f = new FormData();
      for (const [k, v] of Object.entries({
        titre: "Tableau",
        type_document: "cours",
        matiere_id: elec,
        [norme]: valeur,
      }))
        f.set(k, v);
      f.set("fichier", new File(["<p>Chaque circuit a son disjoncteur.</p>"], "tableau.html"));
      return admin.requete("/prof/depot", { method: "POST", body: f });
    };
    const long = await deposer("x".repeat(121));
    assertEquals(long.status, 400);
    assertStringIncludes(await long.text(), "Norme : 120 caractères maximum.");
    assertEquals((await deposer("NF C 15-100")).status, 200);
    const id = db.prepare("SELECT id FROM sources").get()!.id as string;
    await traiter(db, revendiquer(db)!, fauxModeles().modeles);
    statuer(db, id, "certifiee", "Test");
    const eleve = await session(db, fauxModeles().modeles, "eleve");
    const lecture = async () => (await eleve.requete(`/eleve/sources/${id}`)).text();
    assertStringIncludes(await lecture(), "<dt>Norme</dt>");
    assertStringIncludes(await lecture(), "NF C 15-100");

    // Retiré de la matière, le champ quitte les pages et garde sa valeur, même après une
    // modification de la ressource.
    assertEquals((await champs("2", "auteur")).status, 303);
    assert(!(await lecture()).includes("NF C 15-100"));
    assert(!(await (await admin.requete(`/prof/sources/${id}`)).text()).includes(norme));
    assertEquals(
      (
        await admin.requete(`/prof/sources/${id}/modifier`, {
          method: "POST",
          body: new URLSearchParams({ titre: "Tableau électrique", sequence: "" }),
        })
      ).status,
      303,
    );
    const valeur = () =>
      JSON.parse(
        db.prepare("SELECT metadonnees FROM sources WHERE id = ?").get(id)!.metadonnees as string,
      )[norme];
    assertEquals(valeur(), "NF C 15-100");
    const suppression = await admin.poster("supprimer", { genre: "champ", id: norme });
    assertEquals(suppression.status, 400);
    assertStringIncludes(
      await suppression.text(),
      "« Norme » est rempli sur 1 ressource. Retirez-le des matières pour le masquer.",
    );

    // Recoché puis renommé, il montre la même valeur sous la même clé.
    assertEquals((await champs("3", "auteur", norme)).status, 303);
    await admin.poster("renommer", { genre: "champ", id: norme, nom: "Norme NF" });
    assertStringIncludes(await lecture(), "<dt>Norme NF</dt>");
    assertStringIncludes(await lecture(), "NF C 15-100");
    // Un champ que rien ne remplit se supprime.
    await admin.poster("champ", { nom: "Version du logiciel", type: "text" });
    const vide = db
      .prepare("SELECT id FROM champs_personnalises WHERE nom = 'Version du logiciel'")
      .get()!.id as string;
    assertEquals((await admin.poster("supprimer", { genre: "champ", id: vide })).status, 303);
    assertEquals(db.prepare("SELECT count(*) n FROM champs_personnalises").get()!.n, 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("réglages de l'instance : « Module » change les pages, pas les consignes, et les lecteurs par défaut valent pour les dépôts suivants", async () => {
  const { db, dir } = await environnement();
  const cle = config.modeles.cle;
  try {
    const citation =
      "La lumière traverse le prisme transparent et se décompose en couleurs visibles.";
    const id = await ressource(
      db,
      { matiere: "arts-appliques", sequence: "Lumière" },
      undefined,
      Array(5).fill(citation).join(" "),
    );
    const [t] = catalogue(db).themes;
    const echanges = async () => {
      const sortie = JSON.stringify({ affirmations: [{ texte: citation, extrait: 1, citation }] });
      const faux = fauxModeles({ sorties: [sortie] });
      await demander(db, faux.modeles, "lumière", { lecteur: null, schoolId: "pilote" }, 0.01);
      return JSON.stringify(faux.vus);
    };
    const avant = await echanges();
    const admin = await administrateur(db);
    const prof = await session(db, fauxModeles().modeles, "enseignant");
    const eleve = await session(db, fauxModeles().modeles, "eleve");
    const reglages = (champs: Record<string, string>, qui = admin.requete) =>
      qui("/administration", {
        method: "POST",
        body: new URLSearchParams({
          nom: "Thot",
          niveau: "",
          regroupement: "Module",
          regroupements: "Modules",
          lecteurs: "collegues",
          version: "0",
          ...champs,
        }),
      });

    assertEquals((await reglages({}, prof.requete)).status, 403);
    // Une saisie invalide n'enregistre rien et revient avec ses valeurs.
    const invalide = await reglages({ nom: "", regroupements: "" });
    assertEquals(invalide.status, 400);
    const erreurs = await invalide.text();
    assertStringIncludes(erreurs, "Rien n'a été enregistré. Corrigez les champs signalés.");
    assertStringIncludes(erreurs, 'value="Module"');
    assertEquals(lireInstance(db).version, 0);

    const ok = await reglages({});
    assertEquals(ok.headers.get("location"), "/administration?enregistre");
    assertStringIncludes(
      await (await admin.requete("/administration?enregistre")).text(),
      "Réglages enregistrés.",
    );
    const conflit = await reglages({ nom: "Autre nom" });
    assertEquals(conflit.status, 409);
    const saisie = await conflit.text();
    assertStringIncludes(saisie, "Ces réglages ont changé pendant votre saisie.");
    assertStringIncludes(saisie, 'value="Autre nom"');
    assertStringIncludes(saisie, 'name="version" value="1"');
    assertEquals(lireInstance(db).nom, "Thot");

    for (const [qui, chemin, attendu] of [
      [admin, "/prof/depot", `<label>Module <select name="theme_${t.cours_id}">`],
      [admin, "/administration/domaines", "<h2>Modules</h2>"],
      [admin, "/prof", 'aria-label="Modules"'],
      [eleve, "/eleve", '<h2 id="tes-chapitres">Modules</h2>'],
      [eleve, `/eleve/themes/${t.id}`, "<dt>Module</dt>"],
      [eleve, `/eleve/sources/${id}`, "<dt>Module</dt>"],
    ] as const) {
      assertStringIncludes(await (await qui.requete(chemin)).text(), attendu);
    }
    // Le thème est le seul regroupement : le champ libre a quitté le dépôt.
    assert(!(await (await admin.requete("/prof/depot")).text()).includes('name="sequence"'));
    assertEquals(await echanges(), avant);

    // Les ressources déposées gardent leurs lecteurs, le dépôt suivant prend les nouveaux.
    assertEquals(db.prepare("SELECT audience FROM sources").get()!.audience, "eleves");
    assertStringIncludes(
      await (await admin.requete("/prof/depot")).text(),
      'value="collegues" checked',
    );
    const f = new FormData();
    f.set("titre", "Suivant");
    f.set("type_document", "cours");
    f.set("fichier", new File(["<p>Un second cours.</p>"], "suivant.html"));
    assertEquals((await admin.requete("/prof/depot", { method: "POST", body: f })).status, 200);
    assertEquals(
      db.prepare("SELECT audience FROM sources WHERE titre = 'Suivant'").get()!.audience,
      "collegues",
    );
    config.modeles.cle = "cle-secrete-de-test";
    assert(!(await (await admin.requete("/administration")).text()).includes("cle-secrete"));
  } finally {
    config.modeles.cle = cle;
    db.close();
    await rm(dir, { recursive: true });
  }
});
