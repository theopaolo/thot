import { readFileSync, readdirSync } from "node:fs";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { connexion, type Db, migrer } from "../src/app/db.ts";
import { config, RACINE } from "../src/app/config.ts";
import { type Audience } from "../src/app/depot.ts";
import { lireInstance } from "../src/app/instance.ts";
import { chercherFts } from "../src/core/recherche.ts";
import { faitAuHasard, suggestionsDuPerimetre } from "../src/app/suggestions.ts";
import {
  affiliations,
  cours,
  coursDuCompte,
  desinscrire,
  matiere,
  theme,
} from "../src/app/domaines.ts";
import { fauxModeles } from "./outils.ts";
import {
  administrateur,
  BONNE,
  commeEleve,
  compte,
  deuxCours,
  envoyer,
  image,
  nomme,
  type Qui,
  source,
  statut,
  TEXTE,
  texteDe,
} from "./acces_outils.ts";

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

test("questions des élèves : un enseignant du cours relit un échange sans sa conversation", async () => {
  const { db, dir, c1, profA, profB, eleveA } = await deuxCours(
    fauxModeles({ sorties: [BONNE] }).modeles,
  );
  try {
    const fragment = await (
      await eleveA.requete("/eleve/questions", {
        method: "POST",
        headers: { "HX-Request": "true" },
        body: new URLSearchParams({
          texte: "Pourquoi la façade refuse la ligne droite ?",
          cours_id: c1,
        }),
      })
    ).text();
    const id = fragment.match(/messages\/([\w-]+)\/flux/)![1];
    await (await eleveA.requete(`/eleve/messages/${id}/flux`)).text();
    const conversation = db.prepare("SELECT conversation_id FROM messages WHERE id = ?").get(id)!
      .conversation_id as string;
    db.prepare("UPDATE conversations SET titre = 'Titre privé' WHERE id = ?").run(conversation);

    assertStringIncludes(await texteDe(profA, "/prof/questions"), `/prof/questions/${id}"`);
    const page = await texteDe(profA, `/prof/questions/${id}`);
    assertStringIncludes(page, "Pourquoi la façade refuse la ligne droite ?");
    assertStringIncludes(page, "Gaudí refuse la ligne droite.");
    assertStringIncludes(page, `/prof/questions/${id}/citations/0`);
    assert(!page.includes("Titre privé") && !page.includes(conversation), "conversation montrée");
    const passage = await texteDe(profA, `/prof/questions/${id}/citations/0`);
    assertStringIncludes(passage, "Gaudí refuse la ligne droite dans toute la façade");
    assertStringIncludes(passage, "Dans le cours");

    // Hors de ses cours, l'échange n'existe pas. Le préfixe /prof refuse l'élève avant la route.
    assertEquals(await statut(profB.requete(`/prof/questions/${id}`)), 404);
    assertEquals(await statut(profB.requete(`/prof/questions/${id}/citations/0`)), 404);
    assertEquals(await statut(eleveA.requete(`/prof/questions/${id}`)), 403);

    // Sans passage dans le cours, la page mène au dépôt dans ce cours.
    poserQuestion(db, "hors", eleveA.id, "Qui fait des tartes ?", { cours_id: c1 });
    db.prepare("UPDATE messages SET etat = 'out_of_corpus' WHERE id = 'hors'").run();
    const hors = await texteDe(profA, "/prof/questions/hors");
    assertStringIncludes(hors, "Sans passage dans le cours");
    assertStringIncludes(hors, `/prof/depot?cours=${c1}`);
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
      "0025_termes.sql",
      "0026_series.sql",
      "0027_lectures.sql",
      "0028_connexions.sql",
      "0029_images_revision.sql",
      "0030_images_numero.sql",
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

/** Les rattachements d'une source, cours par cours : `{ cours_id: theme_id | null }`. */
const liens = (db: Db, sourceId: string) =>
  Object.fromEntries(
    db
      .prepare("SELECT cours_id, theme_id FROM source_cours WHERE source_id = ?")
      .all(sourceId)
      .map((l) => [l.cours_id as string, l.theme_id as string | null]),
  );

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

    // L'accueil liste les cours, le sommaire d'un cours ses ressources et ses thèmes.
    const accueilA = await texteDe(eleveA, "/eleve");
    const sommaireA = await texteDe(eleveA, `/eleve?cours_id=${c1}`);
    assertStringIncludes(sommaireA, "Cours du design");
    assert(nomme(accueilA, "Design"));
    for (const page of [accueilA, sommaireA]) {
      assert(!nomme(page, "Histoire de l'art"), "nom du cours c2 montré à un élève de c1");
      assert(!nomme(page, "Impressionnisme"), "nom du thème c2 montré à un élève de c1");
    }
    const accueilB = await texteDe(eleveB, "/eleve");
    const sommaireB = await texteDe(eleveB, `/eleve?cours_id=${c2}`);
    assert(nomme(accueilB, "Histoire de l'art") && nomme(sommaireB, "Impressionnisme"));
    assert(!nomme(accueilB, "Design") && !nomme(sommaireB, "Design"));

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

test("ancienne séquence : son adresse ne mène qu'à un thème que le lecteur peut ouvrir", async () => {
  const { db, dir, c2, profB, eleveA, eleveB } = await deuxCours();
  try {
    const t = theme(db, c2, "Corrigés d'histoire");
    const ranger = async (titre: string, audience: Audience, sequence: string) => {
      const id = await source(db, titre, audience, profB.id, c2);
      affiliations(db, id, [{ cours_id: c2, theme_id: t }]);
      db.prepare(
        "UPDATE sources SET metadonnees = json_set(metadonnees, '$.sequence', ?) WHERE id = ?",
      ).run(sequence, id);
    };
    await ranger("Cours de l'autre classe", "eleves", "Renaissance");
    await ranger("Corrigé privé", "prive", "Corrigés");
    const mene = async (qui: Qui, nom: string) =>
      (await qui.requete(`/eleve/sequences/${encodeURIComponent(nom)}`)).headers.get("location");
    assertEquals(await mene(eleveB, "Renaissance"), `/eleve/themes/${t}`);
    assertEquals(await mene(profB, "Corrigés"), `/eleve/themes/${t}`);
    // Ni une source d'un autre cours ni une source privée ne confirment le nom d'une séquence.
    assertEquals(await mene(eleveA, "Renaissance"), "/eleve/sans-sequence");
    assertEquals(await mene(eleveB, "Corrigés"), "/eleve/sans-sequence");
    assertEquals(await mene(eleveA, "Inconnue"), "/eleve/sans-sequence");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("équipe : un enseignant crée ses cours, y ajoute un collègue d'un coup et ne touche qu'aux siens", async () => {
  const { db, dir, m, c1, c2, profA, profB, profC, eleveA, eleveB } = await deuxCours();
  try {
    const membres = (coursId: string) =>
      db
        .prepare("SELECT compte_id FROM membres_cours WHERE cours_id = ? ORDER BY rowid")
        .all(coursId)
        .map((l) => l.compte_id);
    const nom = (table: string, id: string) =>
      db.prepare(`SELECT nom FROM ${table} WHERE id = ?`).get(id)!.nom;
    const collegue = (qui: Qui, compteId: string, cours: string[]) => {
      const corps = new URLSearchParams({ compte_id: compteId });
      for (const id of cours) corps.append("cours", id);
      return statut(qui.requete("/prof/cours/collegue", { method: "POST", body: corps }));
    };

    // Le créateur devient membre du cours, dans une matière existante seulement.
    const cree = await envoyer(profB, "/prof/cours/creer", { matiere_id: m, nom: "Typographie" });
    assertEquals(cree.status, 303);
    const c3 = db.prepare("SELECT id FROM cours WHERE nom = 'Typographie'").get()!.id as string;
    assertEquals(cree.headers.get("location"), `/prof/cours#cours-${c3}`);
    assertEquals(membres(c3), [profB.id]);
    const refus = await envoyer(profB, "/prof/cours/creer", { matiere_id: "absente", nom: "X" });
    assertEquals(refus.status, 400);
    assertStringIncludes(await refus.text(), "Matière inconnue");
    assertEquals(
      await statut(envoyer(profB, "/prof/cours/creer", { matiere_id: m, nom: " " })),
      400,
    );

    // Il crée et renomme les thèmes de ses cours, et renomme ses cours.
    const nouveau = { cours_id: c3, nom: "Caractères" };
    assertEquals(await statut(envoyer(profB, "/prof/cours/theme", nouveau)), 303);
    assertEquals(await statut(envoyer(profB, "/prof/cours/theme", nouveau)), 400);
    const t3 = db.prepare("SELECT id FROM themes WHERE cours_id = ?").get(c3)!.id as string;
    const renommer = (qui: Qui, genre: string, id: string, n: string) =>
      statut(envoyer(qui, "/prof/cours/renommer", { genre, id, nom: n }));
    assertEquals(await renommer(profB, "theme", t3, "Fontes"), 303);
    assertEquals(await renommer(profB, "cours", c3, "Typographie 1"), 303);
    assertEquals([nom("themes", t3), nom("cours", c3)], ["Fontes", "Typographie 1"]);
    let page = await texteDe(profB, "/prof/cours");
    for (const id of [c2, c3]) assertStringIncludes(page, `id="cours-${id}"`);
    assert(!page.includes(c1));
    assert(!page.includes("/supprimer"));

    // Un collègue rejoint deux cours d'une seule action et gère aussitôt leurs élèves.
    const identifiantB = db.prepare("SELECT identifiant FROM comptes WHERE id = ?").get(eleveB.id)!
      .identifiant as string;
    assert(!(await texteDe(profC, "/prof/eleves")).includes(identifiantB));
    assertEquals(await collegue(profB, profC.id, [c2, c3]), 303);
    assertEquals(
      [membres(c2), membres(c3)],
      [
        [profB.id, eleveB.id, profC.id],
        [profB.id, profC.id],
      ],
    );
    assertStringIncludes(await texteDe(profC, "/prof/eleves"), identifiantB);

    // Un élève existant ne s'inscrit pas ainsi : ses enseignants réinitialisent son mot de passe.
    const eleve = await profB.requete("/prof/cours/collegue", {
      method: "POST",
      body: new URLSearchParams({ compte_id: eleveA.id, cours: c2 }),
    });
    assertEquals(eleve.status, 400);
    assertStringIncludes(await eleve.text(), "lien d&#39;inscription");
    assertEquals(await collegue(profB, "inconnu", [c2]), 400);
    assert(!coursDuCompte(db, eleveA.id).has(c2));

    // Hors de ses cours, rien ne change : une case cochée rend 400, le reste 404.
    const t1 = theme(db, c1, "Couleur");
    assertEquals(await collegue(profB, profB.id, [c1]), 400);
    assertEquals(await collegue(profB, profC.id, []), 400);
    assertEquals(await renommer(profB, "cours", c1, "Pris"), 404);
    assertEquals(await renommer(profB, "theme", t1, "Pris"), 404);
    assertEquals(await renommer(profB, "matiere", m, "Pris"), 404);
    assertEquals(
      await statut(envoyer(profB, "/prof/cours/theme", { cours_id: c1, nom: "X" })),
      404,
    );
    const retirer = (qui: Qui, coursId: string, compteId: string) =>
      statut(envoyer(qui, "/prof/cours/retirer", { cours_id: coursId, compte_id: compteId }));
    assertEquals(await retirer(profB, c1, profA.id), 404);
    // Les élèves se retirent depuis /prof/eleves.
    assertEquals(await retirer(profA, c1, eleveA.id), 404);
    assertEquals(membres(c1), [profA.id, profC.id, eleveA.id]);
    assertEquals([nom("cours", c1), nom("themes", t1)], ["Design", "Couleur"]);

    // Il retire un collègue de ses cours, puis quitte lui-même un cours.
    assertEquals(await retirer(profB, c2, profC.id), 303);
    assert(!(await texteDe(profC, "/prof/eleves")).includes(identifiantB));
    assertEquals(await retirer(profC, c3, profC.id), 303);
    assertEquals([membres(c2), membres(c3)], [[profB.id, eleveB.id], [profB.id]]);
    assert(!(await texteDe(profC, "/prof/cours")).includes(c3));
    assertEquals(await retirer(profC, c3, profB.id), 404);

    // Un élève n'a pas cette page. Un administrateur y voit et gère tous les cours.
    assertEquals(await statut(eleveA.requete("/prof/cours")), 403);
    const admin = await administrateur(db);
    page = await texteDe(admin, "/prof/cours");
    for (const id of [c1, c2, c3]) assertStringIncludes(page, `id="cours-${id}"`);
    assertEquals(await renommer(admin, "cours", c1, "Design graphique"), 303);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});
