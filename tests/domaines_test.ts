import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { connexion, migrer } from "../src/app/db.ts";
import { config, RACINE } from "../src/app/config.ts";
import { deposer, valider } from "../src/app/depot.ts";
import {
  affiliations,
  catalogue,
  catalogueVisible,
  cours,
  matiere,
  profilMatiere,
  theme,
} from "../src/app/domaines.ts";
import { lireInstance } from "../src/app/instance.ts";
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
  const v = valider({ titre: "ATC Lumière", type_document: "cours", ...champs }, [
    "enseignants",
    "eleves",
    "thot",
  ]);
  assert("meta" in v);
  const { source_id } = await deposer(db, {
    meta: v.meta,
    liens,
    nomFichier: "cours.html",
    format: "html",
    schoolId: lireInstance(db).school_id,
    enseignant: "Prof original",
    octets: new TextEncoder().encode(
      `<html><h1>Lumière</h1><img src="data:image/jpeg;base64,/9j/4AAQ"><p>${texte}</p></html>`,
    ),
  });
  await traiter(db, revendiquer(db)!, fauxModeles().modeles);
  statuer(db, source_id, "certifiee", "Test");
  return source_id;
}

Deno.test("migration des matières : métadonnées intactes, thèmes homonymes séparés, inconnus visibles", async () => {
  const dir = await Deno.makeTempDir();
  config.donnees = dir;
  const db = connexion(join(dir, "state.sqlite3"));
  try {
    db.exec("CREATE TABLE migrations (nom TEXT PRIMARY KEY, applique_le TEXT NOT NULL)");
    for (
      const nom of [
        "0001_depot.sql",
        "0002_mvp.sql",
        "0003_suggestions.sql",
        "0004_pilote.sql",
        "0005_coherence.sql",
        "0006_instance.sql",
      ]
    ) {
      db.exec(Deno.readTextFileSync(join(RACINE, "migrations", nom)));
      db.prepare("INSERT INTO migrations VALUES (?, 'fixture')").run(nom);
    }
    const metas = [{ matiere: "arts-appliques", sequence: "Lumière", artiste: "Auteur relu" }, {
      matiere: "Physique",
      sequence: "Lumière",
      auteur: "Newton",
    }, { sequence: "Non classée", auteur: "Inconnu" }];
    for (const [i, m] of metas.entries()) {
      db.prepare(
        `INSERT INTO sources (id,school_id,titre,metadonnees,fichier,format,checksum,octets,enseignant,cree_le) VALUES (?, 'pilote', 'Cours', ?, 'cours.html', 'html', 'x', 1, 'Prof historique', 'fixture')`,
      ).run(String(i), JSON.stringify(m));
    }
    assertEquals(migrer(db), ["0007_domaines.sql"]);
    assertEquals(migrer(db), []);
    const sources = db.prepare("SELECT * FROM sources ORDER BY id").all();
    assertEquals(sources.map((s) => s.metadonnees), metas.map((m) => JSON.stringify(m)));
    assertEquals(sources.map((s) => s.profil), ["arts-appliques", "general", "general"]);
    assertEquals(sources[2].matiere_id, null);
    const cat = catalogue(db);
    assertEquals(cat.matieres.map((m) => m.nom), ["Arts appliqués", "Physique"]);
    assertEquals(cat.themes.map((t) => t.nom), ["Lumière", "Lumière"]);
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
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("général : champs facultatifs, attribution, profil unique et rattachements sans copie ni publication", async () => {
  const { db, dir } = await environnement();
  try {
    const physique = matiere(db, "Physique");
    const reaper = matiere(db, "REAPER");
    const socio = matiere(db, "Sociologie");
    const c1 = cours(db, physique, "Optique", "", "Comprendre la lumière"),
      c2 = cours(db, reaper, "Manuel");
    cours(db, socio, "Auteurs");
    const t1 = theme(db, c1, "Introduction"), t2 = theme(db, c2, "Introduction");
    const id = await ressource(db, {
      matiere_id: physique,
      auteur: "Isaac Newton",
      version: "2",
      date_evenement: "1704-01-01",
      date_publication: "2025-01-01",
    }, [{ cours_id: c1, theme_id: t1 }, { cours_id: c2, theme_id: t2 }]);
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
      chercherFts(db, "lumière", { schoolId: "pilote", coursId: c1, themeId: t1 }).map((c) =>
        c.source_id
      ),
      [id],
    );
    assertEquals(
      chercherFts(db, "lumière", { schoolId: "pilote", coursId: c1, themeId: t2 }).length,
      0,
    );
    const chunk = chercherFts(db, "lumière", { schoolId: "pilote", coursId: c1, themeId: t1 })[0];
    assert(lireChunk(db, id, chunk.id, { schoolId: "pilote", coursId: c1, themeId: t1 }));
    assertEquals(
      lireChunk(db, id, chunk.id, { schoolId: "pilote", coursId: c1, themeId: t2 }),
      undefined,
    );
    assertEquals(lireChunk(db, id, chunk.id, { schoolId: "pilote", sourceId: "autre" }), undefined);
    assertEquals(
      chercherFts(db, "lumière", { schoolId: "pilote", matiereId: physique, coursId: c2 }).length,
      0,
    );
    assertEquals(
      chercherFts(db, "lumière", { schoolId: "pilote", coursId: c2, themeId: t2 }).map((c) =>
        c.source_id
      ),
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
      (await prof.requete(`/prof/sources/${id}/modifier`, {
        method: "POST",
        body: new URLSearchParams({ titre: "ATC Lumière", sequence: "", langue: "en" }),
      })).status,
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
    assertThrows(() => profilMatiere(db, physique, "arts-appliques"), Error, "un seul profil");
    assertThrows(() => matiere(db, "Arts", "arts-appliques"), Error, "un seul profil");
    indexer(db, id);
    await reextraire(db, id);
    assertEquals(db.prepare("SELECT profil FROM sources WHERE id = ?").get(id)!.profil, "general");
    db.prepare(
      "UPDATE sources SET metadonnees = json_set(metadonnees, '$.publics', json('[\"enseignants\"]')) WHERE id = ?",
    ).run(id);
    assertEquals(chercherFts(db, "lumière", { schoolId: "pilote", coursId: c2 }).length, 0);
    assertEquals((await eleve.requete(`/eleve/themes/${t2}`)).status, 404);
    assert(!catalogueVisible(db).themes.some((t) => t.id === t2));
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
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dépôt web et questions : périmètres par identifiants conservés jusqu’au flux, erreurs sans données partielles", async () => {
  const { db, dir } = await environnement();
  try {
    const m = matiere(db, "Sociologie"), c = cours(db, m, "Théories"), t = theme(db, c, "Auteurs");
    const citation = "Durkheim décrit les faits sociaux comme des manières collectives de penser.";
    const faux = fauxModeles({
      sorties: [JSON.stringify({ affirmations: [{ texte: citation, extrait: 1, citation }] })],
    });
    const prof = await session(db, faux.modeles, "enseignant");
    const form = new FormData();
    for (
      const [k, v] of Object.entries({
        titre: "Faits sociaux",
        type_document: "cours",
        matiere_id: m,
        auteur: "Durkheim",
        cours: c,
        [`theme_${c}`]: t,
      })
    ) form.set(k, v);
    for (const p of ["enseignants", "eleves", "thot"]) form.append("publics", p);
    form.set("fichier", new File([`<p>${citation}</p>`], "social.html"));
    assertEquals((await prof.requete("/prof/depot", { method: "POST", body: form })).status, 200);
    await traiter(db, revendiquer(db)!, faux.modeles);
    const id = db.prepare("SELECT id FROM sources").get()!.id as string;
    statuer(db, id, "certifiee", "Prof");
    const eleve = await session(db, faux.modeles, "eleve");
    const page = await (await eleve.requete(`/eleve?cours_id=${c}&theme_id=${t}`)).text();
    assertStringIncludes(page, "Faits sociaux");
    assertStringIncludes(page, "Théories / Auteurs");
    const recherche =
      await (await eleve.requete(`/eleve/recherche?q=faits&cours_id=${c}&theme_id=${t}`)).text();
    assertStringIncludes(recherche, `name="cours_id" value="${c}"`);
    assertStringIncludes(recherche, `name="theme_id" value="${t}"`);
    assertEquals(
      (await eleve.requete("/eleve/questions", {
        method: "POST",
        body: new URLSearchParams({ texte: "faits sociaux", cours_id: c, theme_id: t }),
      })).status,
      303,
    );
    const message = db.prepare("SELECT * FROM messages").get()!;
    assertEquals(message.cours_id, c);
    assertEquals(message.theme_id, t);
    assertEquals(message.chapitre, "");
    const flux = await (await eleve.requete(`/eleve/messages/${message.id}/flux`)).text();
    assertStringIncludes(flux, "Durkheim");
    assertEquals(
      (await eleve.requete("/eleve/questions", {
        method: "POST",
        body: new URLSearchParams({ texte: "Question", theme_id: "absent" }),
      })).status,
      400,
    );
    form.set(`theme_${c}`, "absent");
    const refus = await prof.requete("/prof/depot", { method: "POST", body: form });
    assertEquals(refus.status, 400);
    assertStringIncludes(await refus.text(), "Cours ou thème inconnu");
    assertEquals(db.prepare("SELECT count(*) n FROM sources").get()!.n, 1);
    assertEquals([...Deno.readDirSync(join(dir, "content"))].length, 1);
    assertEquals((await eleve.requete("/administration/domaines")).status, 403);
    assertEquals((await prof.requete("/administration/domaines")).status, 403);
    const compte = db.prepare("SELECT id FROM comptes WHERE role = 'enseignant'").get()!.id;
    db.prepare("UPDATE comptes SET administrateur = 1 WHERE id = ?").run(compte!);
    assertEquals((await prof.requete("/administration/domaines")).status, 200);
    assertEquals(
      (await prof.requete("/administration/domaines/matiere", {
        method: "POST",
        body: new URLSearchParams({ nom: "REAPER", profil: "general" }),
      })).status,
      303,
    );
    assertEquals(
      (await prof.requete("/administration/domaines/matiere", {
        method: "POST",
        body: new URLSearchParams({ nom: "Invalide", profil: "arbitraire" }),
      })).status,
      400,
    );
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("prompts neutres, preuves conservées, rubriques ATC et légendes réservées au profil arts", async () => {
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
      (await demander(db, faux.modeles, "lumière", { schoolId: "pilote" }, 0.01)).resultat.etat,
      "answered",
    );
    await genererSuggestions(db, faux.modeles, id);
    const prompts = faux.vus.flat().filter((m) => m.role === "system").map((m) => m.content).join(
      "\n",
    );
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
      const modeles = openrouter({ ...config.modeles, cle: "factice" }, {
        lire: () => undefined,
        ecrire: () => {},
      });
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
      validerInformations({ valide_du: "2026-01-01", valide_au: "2025-01-01" }, "general")
    );
    assertThrows(() => validerInformations({ date_publication: "2025-02-30" }, "general"));
    await assertRejects(() => ressource(db, { matiere_id: "inconnue" }));
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("arts appliqués : consignes mesurées, matière proposée, profil de l’instance pour les ressources", async () => {
  const { db, dir } = await environnement();
  const empreinte = async (t: string) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
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
    await demander(db, faux.modeles, "lumière", { schoolId: "pilote" }, 0.01);
    await genererSuggestions(db, faux.modeles, arts);
    const systeme = faux.vus.flat().filter((m) => m.role === "system").map((m) => m.content);
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
      const modeles = openrouter({ ...config.modeles, cle: "factice" }, {
        lire: () => undefined,
        ecrire: () => {},
      });
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
    for (
      const [k, v] of Object.entries({
        titre: "Prisme",
        type_document: "cours",
        matiere_id: m.id,
        sequence: "Lumière",
        affiliations_presentes: "1",
      })
    ) form.set(k, v);
    form.set("fichier", new File([`<p>${citation}</p>`], "prisme.html"));
    assertEquals((await prof.requete("/prof/depot", { method: "POST", body: form })).status, 200);
    assertEquals(
      db.prepare(
        `SELECT t.nom FROM sources s JOIN source_cours sc ON sc.source_id = s.id
        JOIN themes t ON t.id = sc.theme_id WHERE s.titre = 'Prisme'`,
      ).get()?.nom,
      "Lumière",
    );
    await traiter(db, revendiquer(db)!, faux.modeles);
    const rattachee = await ressource(db, {}, [{
      cours_id: catalogue(db).cours[0].id,
      theme_id: null,
    }]);
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
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sonde lexicale français / anglais : français conservé, anglais non qualifié", async () => {
  const { db, dir } = await environnement();
  try {
    const fr = await ressource(db, { langue: "fr" }), en = await ressource(db, { langue: "en" });
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
        chercherFts(db, x.q, { schoolId: "pilote", sourceId: id }).some((c) =>
          c.id === String(i)
        )
      ).length;
    }
    console.log("Sonde FTS5 morphologie :", JSON.stringify(resultats), "sur 4 requêtes par langue");
    assertEquals(resultats.fr, 3);
    assert(resultats.en < 4);
    const avertissements = db.prepare(
      "SELECT avertissements FROM ingestion_jobs WHERE source_id = ?",
    ).get(en)!.avertissements as string;
    assertStringIncludes(avertissements, "Langue non prise en charge");
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI : configurer quatre collections, importer, rattacher, refuser un second profil", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const lancer = (...args: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "-RWNE", "--allow-run=pdftotext", "src/cli.ts", ...args],
        cwd: RACINE,
        env: {
          THOT_DATA_DIR: dir,
          THOT_ORIGIN: "",
          THOT_OPENROUTER_ENABLED: "0",
          THOT_MISTRAL_ENABLED: "0",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
    const cli = async (...args: string[]) => {
      const r = await lancer(...args);
      assert(r.success, new TextDecoder().decode(r.stderr));
      return new TextDecoder().decode(r.stdout).trim();
    };
    const arts = await cli("matiere", "Arts");
    const physique = await cli("matiere", "Physique");
    await cli("matiere", "REAPER");
    await cli("matiere", "Sociologie");
    const c = await cli("cours", physique, "Optique"), t = await cli("theme", c, "Introduction");
    const fichier = join(dir, "physique.html");
    await Deno.writeTextFile(fichier, "<p>La lumière traverse le prisme transparent.</p>");
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
      assert(!(await lancer("profil", physique, "arts-appliques")).success);
      assert(!(await lancer("matiere", "Design", "--profil=arts-appliques")).success);
      await cli("reextraire");
      await cli("rebuild");
      assertEquals(db.prepare("SELECT profil FROM sources").get()!.profil, "general");
      assertEquals(db.prepare("SELECT enseignant FROM sources").get()!.enseignant, s.enseignant);
      assertEquals(JSON.parse(await cli("domaines")).matieres.length, 4);
      assertEquals(db.prepare("SELECT count(*) n FROM sources").get()!.n, 1);
    } finally {
      db.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
