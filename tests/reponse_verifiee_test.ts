import { readFile } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { openrouter, PanneModele } from "../src/core/modeles.ts";
import { demander, ranger } from "../src/core/reponse.ts";
import { statuer } from "../src/app/ingestion.ts";
import { genererSuggestions } from "../src/app/suggestions.ts";
import { config } from "../src/app/config.ts";
import { reponse } from "../src/app/vues/echange.ts";
import { environnement, fauxModeles } from "./outils.ts";
import { REPONSE_CITEE, sourceTraitee } from "./source_outils.ts";

test("sans reclasseur, la réponse suit l'ordre de FTS5 et le journal le dit", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  statuer(db, id, "certifiee", "test");
  const q = "Pourquoi la façade de la Casa Batlló n'a pas de ligne droite ?";
  const p = { lecteur: null, schoolId: "pilote" };
  const panne = (f: ReturnType<typeof fauxModeles>, erreur: Error) => {
    f.modeles.reclasser = () => Promise.reject(erreur);
    return f.modeles;
  };

  const ok = await demander(
    db,
    panne(fauxModeles({ sorties: [REPONSE_CITEE] }), new PanneModele("reclasseur 503")),
    q,
    p,
    0.023,
  );
  assertEquals(ok.resultat.etat, "answered");
  assertEquals(ok.journal.reclasseur_indisponible, "reclasseur 503");
  assertEquals((ok.journal.candidats as { rang_fts: number }[])[0].rang_fts, 1);

  const refus = await demander(
    db,
    panne(fauxModeles({ sorties: ['{"refus": true}'] }), new PanneModele("reclasseur 503")),
    q,
    p,
    0.023,
  );
  assertEquals(
    refus.resultat,
    { etat: "failed", code: "MODEL_UNAVAILABLE", message: "reclasseur 503" },
    "un refus sans reclasseur n'est pas une limite du cours",
  );

  const bug = await demander(db, panne(fauxModeles(), new TypeError("bug")), q, p, 0.023);
  assertEquals(bug.resultat.etat === "failed" && bug.resultat.code, "INTERNAL_ERROR");

  const questions = JSON.stringify({ questions: ["Pourquoi Gaudí refuse-t-il la ligne droite ?"] });
  await assertRejects(
    () =>
      genererSuggestions(
        db,
        panne(
          fauxModeles({ sorties: [questions, REPONSE_CITEE] }),
          new PanneModele("reclasseur 503"),
        ),
        id,
      ),
    PanneModele,
  );
  assertEquals(db.prepare("SELECT count(*) n FROM suggestions").get()!.n, 0);
});

test("trois états de réponse distincts, et une citation fausse ne passe jamais", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  statuer(db, id, "certifiee", "test");
  const q = "Pourquoi la façade de la Casa Batlló n'a pas de ligne droite ?";
  const p = { lecteur: null, schoolId: "pilote" };

  const bonne = JSON.stringify({
    affirmations: [
      {
        texte: "Gaudí refuse la ligne droite.",
        extrait: 1,
        citation: "Gaudí refuse la ligne droite dans toute la façade",
      },
    ],
  });
  const ok = await demander(db, fauxModeles({ sorties: [bonne] }).modeles, q, p, 0.023);
  assertEquals(ok.resultat.etat, "answered");
  if (ok.resultat.etat === "answered") {
    const a = ok.resultat.affirmations[0];
    const texte = await readFile(
      `${(await import("../src/app/config.ts")).config.donnees}/content/${id}/document.txt`,
      "utf8",
    );
    assertEquals(
      Array.from(texte).slice(a.debut, a.fin).join(""),
      "Gaudí refuse la ligne droite dans toute la façade",
    );
  }

  const bas = await demander(db, fauxModeles({ score: 0.01 }).modeles, q, p, 0.023);
  assertEquals(bas.resultat, { etat: "out_of_corpus", raison: "seuil" });

  const fausse = JSON.stringify({
    affirmations: [
      {
        texte: "Gaudí utilisait du plutonium.",
        extrait: 1,
        citation: "Gaudí refuse la ligne droite … plutonium radioactif",
      },
    ],
  });
  const repare = await demander(db, fauxModeles({ sorties: [fausse, bonne] }).modeles, q, p, 0.023);
  assertEquals(repare.resultat.etat, "answered", "une réparation est permise");
  const malformee = '{"affirmations": [{"texte": 3, "citation": null}, null]}';
  const forme = await demander(
    db,
    fauxModeles({ sorties: [malformee, bonne] }).modeles,
    q,
    p,
    0.023,
  );
  assertEquals(forme.resultat.etat, "answered", "une sortie mal formée se répare aussi");
  const melange = JSON.stringify({
    affirmations: [JSON.parse(bonne).affirmations[0], JSON.parse(fausse).affirmations[0]],
  });
  const partielle = await demander(
    db,
    fauxModeles({ sorties: [melange, fausse] }).modeles,
    q,
    p,
    0.023,
  );
  assertEquals(partielle.resultat.etat, "answered");
  if (partielle.resultat.etat === "answered") {
    assertEquals(partielle.resultat.affirmations.length, 1);
    assertEquals(partielle.resultat.affirmations[0].texte, "Gaudí refuse la ligne droite.");
    assertEquals(partielle.resultat.partielle, true);
    assertStringIncludes(String(reponse("test", partielle.resultat)), "Réponse partielle");
  }
  const refuse = await demander(
    db,
    fauxModeles({ sorties: [fausse, fausse] }).modeles,
    q,
    p,
    0.023,
  );
  assertEquals(refuse.resultat.etat, "failed");
  if (refuse.resultat.etat === "failed") {
    assertEquals(refuse.resultat.code, "CITATION_UNVERIFIED");
    assertStringIncludes(String(reponse("test", refuse.resultat)), "vérifier les citations");
  }

  // Une citation réelle qui ne prouve pas sa phrase: le juge la refuse, le générateur la répare.
  const excessive = JSON.stringify({
    affirmations: [
      {
        texte: "Gaudí refuse la ligne droite dans toutes ses œuvres.",
        extrait: 1,
        citation: "Gaudí refuse la ligne droite dans toute la façade",
      },
    ],
  });
  const juge = (texte: string) => (texte.includes("toutes ses œuvres") ? 0.1 : 0.9);
  const corrige = fauxModeles({ sorties: [excessive, bonne], soutien: juge });
  const juge1 = await demander(db, corrige.modeles, q, p, 0.023);
  assertEquals(juge1.resultat.etat, "answered", "le juge renvoie en réparation");
  assertStringIncludes(corrige.vus[1].at(-1)!.content, "dit plus que sa citation");
  const avecExces = JSON.stringify({
    affirmations: [JSON.parse(bonne).affirmations[0], JSON.parse(excessive).affirmations[0]],
  });
  const juge2 = await demander(
    db,
    fauxModeles({ sorties: [avecExces, avecExces], soutien: juge }).modeles,
    q,
    p,
    0.023,
  );
  assertEquals(juge2.resultat.etat, "answered");
  if (juge2.resultat.etat === "answered") {
    assertEquals(
      juge2.resultat.affirmations.map((a) => a.texte),
      ["Gaudí refuse la ligne droite."],
    );
    assertEquals(juge2.resultat.partielle, true, "l'affirmation refusée deux fois disparaît");
  }
  const juge3 = await demander(
    db,
    fauxModeles({ sorties: [excessive, excessive], soutien: juge }).modeles,
    q,
    p,
    0.023,
  );
  assertEquals(juge3.resultat.etat, "failed");
  if (juge3.resultat.etat === "failed") assertEquals(juge3.resultat.code, "CITATION_UNVERIFIED");
  const sansJuge = fauxModeles({ sorties: [bonne] });
  sansJuge.modeles.soutenir = () => Promise.reject(new PanneModele("juge injoignable"));
  const juge4 = await demander(db, sansJuge.modeles, q, p, 0.023);
  assertEquals(juge4.resultat.etat, "answered", "un juge en panne ne bloque pas la réponse");
  assertEquals(juge4.journal.juge_indisponible, "juge injoignable");
  assertEquals(juge4.resultat.etat === "answered" && juge4.resultat.juge_indisponible, true);
  assert(ok.resultat.etat === "answered" && !ok.resultat.juge_indisponible);

  // Les consignes d'arts appliqués ne demandent pas de blocs : une réponse d'arts reste plate.
  const avecBlocs = JSON.stringify({
    ...JSON.parse(bonne),
    blocs: [{ type: "etapes", affirmations: [1] }],
  });
  const arts = await demander(db, fauxModeles({ sorties: [avecBlocs] }).modeles, q, p, 0.023);
  assert(arts.resultat.etat === "answered" && !arts.resultat.blocs);

  const vide = fauxModeles();
  vide.modeles.generer = () => {
    throw new PanneModele("Le générateur a rendu une sortie vide.", "MODEL_EMPTY_RESPONSE");
  };
  const panne = await demander(db, vide.modeles, q, p, 0.023);
  assertEquals(panne.resultat.etat, "failed", "une sortie vide est une panne, pas un refus");
  if (panne.resultat.etat === "failed") assertEquals(panne.resultat.code, "MODEL_EMPTY_RESPONSE");
});

test("les blocs rangent les affirmations retenues dans l'ordre de lecture, une structure invalide donne un paragraphe", () => {
  const [un, deux, trois, quatre] = ["Un", "Deux", "Trois", "Quatre"].map((texte) => ({
    texte,
    citation: texte,
    source_id: "s",
    chunk_id: "c",
    titre: "T",
  }));
  // La troisième affirmation du modèle a été refusée.
  const parRang = [un, deux, undefined, trois, quatre];
  assertEquals(
    ranger(
      [
        { type: "etapes", titre: " Dans l'ordre ", affirmations: [2, 1] },
        { type: "liste", affirmations: [3] },
        {
          type: "tableau",
          colonnes: ["A", "B"],
          lignes: [
            { titre: "Rôle", affirmations: [null, 4] },
            { titre: "Vide", affirmations: [] },
          ],
        },
      ],
      parRang,
    ),
    {
      affirmations: [deux, un, trois, quatre],
      blocs: [
        { type: "etapes", titre: "Dans l'ordre", affirmations: [0, 1] },
        {
          type: "tableau",
          colonnes: ["A", "B"],
          lignes: [{ titre: "Rôle", affirmations: [null, 2] }],
        },
        { type: "paragraphe", affirmations: [3] },
      ],
    },
  );
  for (const blocs of [
    undefined,
    "etapes",
    [{ type: "schema", affirmations: [1] }],
    Array(5).fill({ type: "liste", affirmations: [] }),
    [{ type: "liste", titre: "x".repeat(61), affirmations: [1] }],
    [{ type: "liste", affirmations: [1, 1] }],
    [{ type: "liste", affirmations: [6] }],
    [{ type: "liste", affirmations: [1.5] }],
    [{ type: "tableau", colonnes: ["A"], lignes: [{ titre: "x", affirmations: [1, 2] }] }],
    [{ type: "tableau", colonnes: Array(5).fill("A"), lignes: [] }],
    [{ type: "tableau", colonnes: ["A"], lignes: [{ titre: "", affirmations: [1] }] }],
  ]) {
    assertEquals(ranger(blocs, parRang), { affirmations: [un, deux, trois, quatre] });
  }
});

test("un schéma ne garde que des relations prouvées, une structure hors bornes donne un paragraphe", () => {
  const [un, deux, trois, quatre] = ["Un", "Deux", "Trois", "Quatre"].map((texte) => ({
    texte,
    citation: texte,
    source_id: "s",
    chunk_id: "c",
    titre: "T",
  }));
  // La troisième affirmation du modèle a été refusée.
  const parRang = [un, deux, undefined, trois, quatre];
  const noeuds = [{ titre: "A", affirmation: 1 }, { titre: "B" }, { titre: "C" }, { titre: "D" }];
  // La relation de C à D cite l'affirmation refusée : elle part, et C et D avec elle.
  const relations = [
    { de: 1, vers: 2, lien: "cause", affirmation: 2 },
    { de: 3, vers: 4, lien: "suite", affirmation: 3 },
  ];
  assertEquals(ranger([{ type: "schema", titre: "Chaîne", noeuds, relations }], parRang), {
    affirmations: [un, deux, trois, quatre],
    blocs: [
      {
        type: "schema",
        titre: "Chaîne",
        noeuds: [{ titre: "A", affirmation: 0 }, { titre: "B" }],
        relations: [{ de: 0, vers: 1, lien: "cause", affirmation: 1 }],
      },
      { type: "paragraphe", affirmations: [2, 3] },
    ],
  });
  // Un schéma dont aucune preuve ne reste disparaît.
  assertEquals(
    ranger(
      [
        {
          type: "schema",
          noeuds: noeuds.slice(1),
          relations: [{ ...relations[1], de: 1, vers: 2 }],
        },
      ],
      parRang,
    ),
    {
      affirmations: [un, deux, trois, quatre],
      blocs: [{ type: "paragraphe", affirmations: [0, 1, 2, 3] }],
    },
  );
  // La preuve d'une relation que le modèle donne aussi à un nœud reste à la relation.
  assertEquals(
    ranger([{ type: "schema", noeuds, relations: [{ ...relations[0], affirmation: 1 }] }], parRang),
    {
      affirmations: [un, deux, trois, quatre],
      blocs: [
        {
          type: "schema",
          noeuds: [{ titre: "A" }, { titre: "B" }],
          relations: [{ de: 0, vers: 1, lien: "cause", affirmation: 0 }],
        },
        { type: "paragraphe", affirmations: [1, 2, 3] },
      ],
    },
  );
  const avec = (modif: Record<string, unknown>) => [
    { type: "schema", noeuds, relations, ...modif },
  ];
  for (const blocs of [
    avec({ noeuds: noeuds.slice(0, 1), relations: [] }),
    avec({ noeuds: Array(9).fill({ titre: "N" }) }),
    avec({ noeuds: "A, B" }),
    avec({ noeuds: [...noeuds.slice(0, 3), { titre: "x".repeat(61) }] }),
    avec({ noeuds: [...noeuds.slice(0, 3), { titre: " " }] }),
    avec({ relations: [] }),
    avec({ relations: Array(9).fill(relations[0]) }),
    avec({ relations: [{ ...relations[0], affirmation: undefined }] }),
    avec({ relations: [{ ...relations[0], lien: "oppose" }] }),
    avec({ relations: [{ ...relations[0], lien: "toString" }] }),
    avec({ relations: [{ ...relations[0], vers: 1 }] }),
    avec({ relations: [{ ...relations[0], vers: 5 }] }),
    avec({ relations: [{ ...relations[0], de: "1" }] }),
    // Une preuve sert une seule relation.
    avec({ relations: [relations[0], { ...relations[1], affirmation: 2 }] }),
    avec({ relations: [{ ...relations[0], affirmation: 6 }] }),
  ]) {
    assertEquals(ranger(blocs, parRang), { affirmations: [un, deux, trois, quatre] });
  }
});

test("une sortie vide du reclasseur déclenche le repli, celle du générateur reste une panne", async () => {
  const { db } = await environnement();
  const fetch = globalThis.fetch;
  try {
    const id = await sourceTraitee(db);
    statuer(db, id, "certifiee", "Prof");
    globalThis.fetch = () => Promise.resolve(Response.json({ results: [] }));
    const modeles = openrouter({ ...config.modeles, cle: "test" });
    const { resultat, journal } = await demander(
      db,
      modeles,
      "ligne droite",
      {
        lecteur: null,
        schoolId: "pilote",
      },
      0.023,
    );
    assertEquals(journal.reclasseur_indisponible, "Résultat du reclasseur invalide.");
    assertEquals(resultat.etat, "failed");
    if (resultat.etat === "failed") assertEquals(resultat.code, "MODEL_EMPTY_RESPONSE");
  } finally {
    globalThis.fetch = fetch;
    db.close();
  }
});

test("le délai du juge annule son signal avant de laisser passer la citation", async () => {
  const { db } = await environnement();
  const timeout = globalThis.setTimeout;
  try {
    const id = await sourceTraitee(db);
    statuer(db, id, "certifiee", "Prof");
    globalThis.setTimeout = ((callback: () => void, delai?: number) =>
      timeout(callback, delai === 4000 ? 10 : delai)) as typeof setTimeout;
    let annule = false;
    const fake = fauxModeles({ sorties: [REPONSE_CITEE] });
    fake.modeles.soutenir = (_texte, _citation, _titre, signal) =>
      new Promise((_oui, non) => {
        signal!.addEventListener(
          "abort",
          () => {
            annule = true;
            non(signal!.reason);
          },
          { once: true },
        );
      });
    const r = await demander(
      db,
      fake.modeles,
      "ligne droite",
      {
        lecteur: null,
        schoolId: "pilote",
      },
      0.023,
    );
    assertEquals(r.resultat.etat, "answered");
    assertEquals(annule, true);
    assertStringIncludes(String(r.journal.juge_indisponible), "délai");
  } finally {
    globalThis.setTimeout = timeout;
    db.close();
  }
});

test("une réponse interrompue pendant le juge ne passe pas pour vérifiée", async () => {
  const { db } = await environnement();
  try {
    const id = await sourceTraitee(db);
    statuer(db, id, "certifiee", "Prof");
    const controle = new AbortController();
    const fake = fauxModeles({ sorties: [REPONSE_CITEE] });
    fake.modeles.soutenir = () => {
      controle.abort(new Error("Réponse arrêtée."));
      return Promise.reject(controle.signal.reason);
    };
    const r = await demander(
      db,
      fake.modeles,
      "ligne droite",
      { lecteur: null, schoolId: "pilote" },
      0.023,
      undefined,
      undefined,
      controle.signal,
    );
    assertEquals(r.resultat.etat, "failed");
    assertEquals(r.journal.juge_indisponible, undefined);
  } finally {
    db.close();
  }
});
