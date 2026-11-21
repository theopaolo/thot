import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cours, matiere } from "../src/app/domaines.ts";
import { chercher, chercherFts, indexerSource, racines } from "../src/core/recherche.ts";
import { demander } from "../src/core/reponse.ts";
import { PanneModele } from "../src/core/modeles.ts";
import { environnement, fauxModeles, session } from "./outils.ts";
import { ressource } from "./domaines_outils.ts";

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

test("la page de recherche dit qu'une traduction en panne la laisse incomplète, au lieu de « rien dans le cours »", async () => {
  const { db, dir } = await environnement();
  try {
    await ressource(
      db,
      { langue: "en" },
      undefined,
      "Short term memory holds information for thirty seconds.",
    );
    const adresse = `/eleve/recherche?q=${encodeURIComponent("Combien de temps dure le souvenir immédiat ?")}`;
    // La traduction trouve le passage anglais, que les mots français seuls ne trouvent pas.
    const traduit = fauxModeles();
    traduit.modeles.traduire = () =>
      Promise.resolve("How long does short term memory hold information?");
    const trouve = await (
      await (await session(db, traduit.modeles, "eleve")).requete(adresse)
    ).text();
    assertStringIncludes(trouve, "Un document proche");
    assert(!trouve.includes("recherche est incomplète"));

    const panne = fauxModeles();
    panne.modeles.traduire = () => Promise.reject(new PanneModele("traduction indisponible"));
    const page = await (await (await session(db, panne.modeles, "eleve")).requete(adresse)).text();
    assert(!page.includes("Rien dans le cours ne ressemble"), "panne montrée comme une limite");
    assertStringIncludes(page, "recherche est incomplète");
    assertStringIncludes(page, "Réessayer");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});
