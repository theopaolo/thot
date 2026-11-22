import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { config } from "../src/app/config.ts";
import {
  catalogue,
  champsMatiere,
  changerProfil,
  enregistrerChamps,
  matiere,
} from "../src/app/domaines.ts";
import { lireInstance } from "../src/app/instance.ts";
import { revendiquer, statuer, traiter } from "../src/app/ingestion.ts";
import { demander } from "../src/core/reponse.ts";
import { decouperPdf } from "../src/core/pdf.ts";
import { CHAMPS, PROFILS, validerInformations } from "../src/core/profils.ts";
import { openrouter } from "../src/core/modeles.ts";
import { genererSuggestions } from "../src/app/suggestions.ts";
import { environnement, fauxModeles, session } from "./outils.ts";
import { administrateur, ressource } from "./domaines_outils.ts";

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
    assertStringIncludes(page, `<details class="ajout" id="champs-${elec}" open>`);
    assertStringIncludes(page, "Réglages enregistrés.");
    assertStringIncludes(page, "Informations demandées au dépôt : 2");
    assertStringIncludes(page, "Texte, 1 matière, 0 ressource");

    // Une version périmée n'enregistre rien et rend la saisie avec la version actuelle.
    const conflit = await champs("1", norme);
    assertEquals(conflit.status, 409);
    const saisie = await conflit.text();
    assertStringIncludes(saisie, "Quelqu'un a modifié ces réglages pendant votre saisie.");
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
          matiere: "Sujet",
          matieres: "Sujets",
          matiere_genre: "m",
          cours: "Chapitre",
          cours_pluriel: "Chapitres",
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
    assertEquals((await reglages({ matiere_genre: "neutre" })).status, 400);
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
    assertStringIncludes(saisie, "Quelqu'un a modifié ces réglages pendant votre saisie.");
    assertStringIncludes(saisie, 'value="Autre nom"');
    assertStringIncludes(saisie, 'name="version" value="1"');
    assertEquals(lireInstance(db).nom, "Thot");

    for (const [qui, chemin, attendu] of [
      [
        admin,
        "/prof/depot",
        `<label class="theme-cours">Module <select name="theme_${t.cours_id}"`,
      ],
      [admin, "/administration/domaines", "<h3>Modules</h3>"],
      [admin, "/administration/domaines", "Chapitre à créer"],
      [admin, "/administration", ">Sujets et chapitres</a>"],
      // Les phrases prennent le terme réglé, accordé au genre réglé avec lui.
      [admin, "/administration", 'name="matiere_genre" value="m" checked'],
      [admin, "/prof/depot", "Créer un sujet</option>"],
      [admin, "/prof/depot", "Choisissez vos fichiers et leur chapitre."],
      [admin, "/administration/domaines", "Renommer ou supprimer ce chapitre"],
      [admin, "/administration/domaines", "partagé par tous ses sujets."],
      [admin, "/prof", "<span>Mes chapitres</span>"],
      [eleve, "/eleve", 'aria-label="Chercher dans le chapitre"'],
      [eleve, `/eleve/sources/${id}`, "Que dit le chapitre sur «"],
      [admin, "/prof/depot", "</span></span>Chapitre</li>"],
      [admin, "/prof", '<span class="etiquette" id="etiquette-cours">Chapitre</span>'],
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
