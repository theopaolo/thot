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
  changerProfil,
  cours,
  coursDuCompte,
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
import { chercherFts, indexerSource, lireChunk } from "../src/core/recherche.ts";
import { demander } from "../src/core/reponse.ts";
import { decouperPdf } from "../src/core/pdf.ts";
import { CHAMPS, PROFILS, validerInformations } from "../src/core/profils.ts";
import { openrouter } from "../src/core/modeles.ts";
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
    assertEquals(migrer(db), ["0007_domaines.sql", "0008_acces.sql", "0009_membres.sql"]);
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
    assertEquals(
      (
        await prof.requete(`/prof/sources/${id}/modifier`, {
          method: "POST",
          body: new URLSearchParams({ titre: "ATC Lumière", sequence: "", langue: "en" }),
        })
      ).status,
      303,
    );
    assertEquals(db.prepare("SELECT langue FROM sources WHERE id = ?").get(id)!.langue, "en");
    assertStringIncludes(
      await (await eleve.requete(`/eleve/sources/${id}`)).text(),
      "Langue non prise en charge",
    );
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
    assertThrows(() =>
      validerInformations({ valide_du: "2026-01-01", valide_au: "2025-01-01" }, "general"),
    );
    assertThrows(() => validerInformations({ date_publication: "2025-02-30" }, "general"));
    await assertRejects(() => ressource(db, { matiere_id: "inconnue" }));
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
    assertStringIncludes(await (await eleve.requete("/eleve")).text(), "Tes séquences");
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
    renommer(db, "theme", t.id, "Art nouveau et Arts and Crafts");
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
    // Les métadonnées gardent le nom du dossier d’origine: les anciennes adresses répondent.
    assertEquals((await eleve.requete("/eleve/sequences/Art%20Nouveau")).status, 200);
    assertStringIncludes(
      await (await prof.requete("/prof?sequence=Art%20Nouveau")).text(),
      `/prof/sources/${id}`,
    );
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

test("sonde lexicale français / anglais : français conservé, anglais non qualifié", async () => {
  const { db, dir } = await environnement();
  try {
    const fr = await ressource(db, { langue: "fr" }),
      en = await ressource(db, { langue: "en" });
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
    assert(resultats.en < 4);
    const avertissements = db
      .prepare("SELECT avertissements FROM ingestion_jobs WHERE source_id = ?")
      .get(en)!.avertissements as string;
    assertStringIncludes(avertissements, "Langue non prise en charge");
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
