import { readFileSync } from "node:fs";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
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
  matiere,
  renommer,
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
import { chercherFts, lireChunk } from "../src/core/recherche.ts";
import { environnement, fauxModeles, session } from "./outils.ts";
import { administrateur, ressource } from "./domaines_outils.ts";

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
      "0025_termes.sql",
      "0026_series.sql",
      "0027_lectures.sql",
      "0028_connexions.sql",
      "0029_images_revision.sql",
      "0030_images_numero.sql",
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
    assertStringIncludes(bibliotheque, `href="/prof/sources/${id}"`);
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

test("ordre de lecture : le front matter range le thème, l'enseignant le change", async () => {
  const { db, dir } = await environnement();
  try {
    const m = matiere(db, "Développement", "general");
    const c = cours(db, m, "Codebase");
    const t = theme(db, c, "Codebase");
    const eleve = await session(db, fauxModeles().modeles, "eleve");
    const prof = await session(db, fauxModeles().modeles, "enseignant");
    const lecon = async (titre: string, order?: number) => {
      const v = valider({ titre, type_document: "cours", matiere_id: m, langue: "fr" });
      assert("meta" in v);
      const { source_id } = await deposer(db, {
        meta: v.meta,
        liens: [{ cours_id: c, theme_id: t }],
        nomFichier: `${titre}.md`,
        format: "md",
        schoolId: lireInstance(db).school_id,
        enseignant: "Compte enseignant",
        audience: "eleves",
        reponses: true,
        octets: new TextEncoder().encode(
          `---\ntitle: ${titre}\n${order === undefined ? "" : `order: ${order}\n`}---\n\n` +
            `La leçon ${titre} explique comment lire du code.\n`,
        ),
      });
      await traiter(db, revendiquer(db)!, fauxModeles().modeles);
      statuer(db, source_id, "certifiee", "Test");
      return source_id;
    };
    const alpha = await lecon("Alpha", 10);
    const beta = await lecon("Bêta", 2);
    const annexe = await lecon("Annexe");
    const ordre = async () => [
      ...new Set(
        [
          ...(await (await eleve.requete(`/eleve/themes/${t}`)).text()).matchAll(
            /\/eleve\/sources\/([\w-]+)/g,
          ),
        ].map((x) => x[1]),
      ),
    ];
    // Une leçon sans ordre suit celles qui en ont, même si son titre vient avant.
    assertEquals(await ordre(), [beta, alpha, annexe]);

    const lecture = await (await eleve.requete(`/eleve/sources/${beta}`)).text();
    assertStringIncludes(lecture, `<a href="/eleve/sources/${beta}" aria-current="page">Bêta`);
    assertStringIncludes(lecture, `<a href="/eleve/sources/${alpha}" rel="next">`);
    assert(!lecture.includes('rel="prev"'));

    const modifier = (ordre: string) =>
      prof.requete(`/prof/sources/${annexe}/modifier`, {
        method: "POST",
        body: new URLSearchParams({ titre: "Annexe", ordre }),
      });
    assertEquals((await modifier("1")).status, 303);
    assertEquals(await ordre(), [annexe, beta, alpha]);
    assertEquals((await modifier("premier")).status, 400);
    assertEquals((await modifier("")).status, 303);
    assertEquals(await ordre(), [beta, alpha, annexe]);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});
