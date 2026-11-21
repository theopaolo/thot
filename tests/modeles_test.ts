import { test } from "vite-plus/test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Cache,
  cleLegende,
  type ConfigModeles,
  openrouter,
  PanneModele,
} from "../src/core/modeles.ts";
import { cours, matiere } from "../src/app/domaines.ts";
import { chercher } from "../src/core/recherche.ts";
import { demander } from "../src/core/reponse.ts";
import { BONNE, environnement, fauxModeles, publier } from "./outils.ts";

const config: ConfigModeles = {
  cle: "test",
  legende: "vision",
  reclasseur: "rerank",
  generation: "generation",
  soutien: "juge",
  soutienMistral: "juge",
};

test("le reclasseur refuse les sorties vides, scores invalides et indices incohérents", async () => {
  const fetch = globalThis.fetch;
  try {
    for (const results of [
      undefined,
      [],
      [null],
      [{ index: -1, relevance_score: 1 }],
      [{ index: 1, relevance_score: 1 }],
      [{ index: 0.5, relevance_score: 1 }],
      [{ index: 0, relevance_score: "0.9" }],
      [{ index: 0, relevance_score: null }],
      [
        { index: 0, relevance_score: 1 },
        { index: 0, relevance_score: 0.5 },
      ],
    ]) {
      globalThis.fetch = () => Promise.resolve(Response.json({ results }));
      const e = await assertRejects(
        () => openrouter(config).reclasser("question", ["texte"]),
        PanneModele,
      );
      assertEquals(e.code, "MODEL_INVALID_RESPONSE");
    }
    globalThis.fetch = () =>
      Promise.resolve(Response.json({ results: [{ index: 0, relevance_score: 0 }] }));
    assertEquals(await openrouter(config).reclasser("question", ["texte"]), [
      {
        index: 0,
        score: 0,
      },
    ]);
    for (const body of ["null", "[]", "not JSON"]) {
      globalThis.fetch = () => Promise.resolve(new Response(body));
      const e = await assertRejects(
        () => openrouter(config).reclasser("question", ["texte"]),
        PanneModele,
      );
      assertEquals(e.code, "MODEL_INVALID_RESPONSE");
    }
  } finally {
    globalThis.fetch = fetch;
  }
});

test("seules les légendes alimentent le cache, jamais les jugements", async () => {
  const fetch = globalThis.fetch;
  const valeurs = new Map<string, string>();
  const cache: Cache = {
    lire: (k) => valeurs.get(k),
    ecrire: (k, v) => {
      valeurs.set(k, v);
    },
  };
  try {
    let appels = 0;
    globalThis.fetch = () => {
      appels++;
      return Promise.resolve(
        Response.json({ choices: [{ message: { content: "non", reasoning: "PrivateName" } }] }),
      );
    };
    const modeles = openrouter(config, cache);
    await modeles.soutenir("PrivateName", "citation", "titre");
    await modeles.soutenir("PrivateName", "citation", "titre");
    assertEquals(appels, 2);
    assertEquals(valeurs.size, 0);
    await modeles.legender(new Uint8Array([0]), "image/png");
    // Supprimer une source retrouve la légende de ses images par cette clé.
    assertEquals(
      [...valeurs.keys()],
      [await cleLegende("vision", new Uint8Array([0]), "image/png")],
    );
  } finally {
    globalThis.fetch = fetch;
  }
});

test("annuler le juge interrompt la requête et interdit les reprises et la relève", async () => {
  const fetch = globalThis.fetch;
  try {
    for (const cleMistral of [undefined, "test"]) {
      const controle = new AbortController();
      let signal: AbortSignal | undefined;
      let appels = 0;
      const commence = Promise.withResolvers<void>();
      globalThis.fetch = (_url, init) => {
        appels++;
        signal = init!.signal!;
        commence.resolve();
        return new Promise((_oui, non) => {
          signal!.addEventListener("abort", () => non(signal!.reason), { once: true });
        });
      };
      const attente = openrouter({ ...config, cleMistral }).soutenir(
        "phrase",
        "citation",
        "titre",
        controle.signal,
      );
      const refuse = assertRejects(() => attente, Error, "délai du juge");
      await commence.promise;
      controle.abort(new Error("délai du juge"));
      await refuse;
      assert(signal?.aborted);
      assertEquals(appels, 1);
    }
    const controle = new AbortController();
    let appels = 0;
    globalThis.fetch = () => {
      appels++;
      setTimeout(() => controle.abort(new Error("arrêt pendant la reprise")), 10);
      return Promise.resolve(new Response("indisponible", { status: 503 }));
    };
    await assertRejects(() =>
      openrouter(config).soutenir("phrase", "citation", "titre", controle.signal),
    );
    assertEquals(appels, 1);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("la reformulation et la traduction ne raisonnent pas, quel que soit l'effort du générateur", async () => {
  const fetch = globalThis.fetch;
  try {
    const corps: { max_tokens: number; reasoning?: unknown }[] = [];
    let content = "Une question ?";
    globalThis.fetch = (_url, init) => {
      corps.push(JSON.parse(init!.body as string));
      return Promise.resolve(Response.json({ choices: [{ message: { content } }] }));
    };
    const modeles = openrouter({ ...config, effort: "high" });
    await modeles.reformuler("Que refuse Gaudí ?", "Et pourquoi ?");
    await modeles.traduire("Et pourquoi ?");
    await modeles.generer([{ role: "user", content: "Question" }]);
    assertEquals(
      corps.map((c) => c.reasoning),
      [{ effort: "none" }, { effort: "none" }, { effort: "high" }],
    );
    // Une sortie vide est une panne, que l'appelant note au journal.
    content = " ";
    for (const appel of [
      () => modeles.reformuler("Que refuse Gaudí ?", "Et pourquoi ?"),
      () => modeles.traduire("Et pourquoi ?"),
    ]) {
      assertEquals((await assertRejects(appel, PanneModele)).code, "MODEL_EMPTY_RESPONSE");
    }
  } finally {
    globalThis.fetch = fetch;
  }
});

test("une reformulation en panne donne une panne, pas une limite du cours", async () => {
  const { db } = await environnement();
  try {
    await publier(db, "Casa Batlló");
    const p = { lecteur: null, schoolId: "pilote" };
    const relance = (modeles = fauxModeles({ sorties: [BONNE] }).modeles, precedente?: string) =>
      demander(db, modeles, "Et pourquoi ?", p, 0.023, undefined, precedente);
    const f = fauxModeles();
    f.modeles.reformuler = () => Promise.reject(new PanneModele("OpenRouter 429: quota"));
    const { resultat, journal } = await relance(f.modeles, "Que refuse Gaudí dans la façade ?");
    assertEquals(resultat, {
      etat: "failed",
      code: "MODEL_UNAVAILABLE",
      message: "OpenRouter 429: quota",
    });
    assertEquals(journal.reformulation_indisponible, "OpenRouter 429: quota");
    assertEquals(journal.question_recherche, "Et pourquoi ?");
    // La même relance aboutit quand la reformulation répond.
    const g = fauxModeles({ sorties: [BONNE] });
    g.modeles.reformuler = () => Promise.resolve("Pourquoi Gaudí refuse-t-il la ligne droite ?");
    const ok = await relance(g.modeles, "Que refuse Gaudí dans la façade ?");
    assertEquals(ok.resultat.etat, "answered");
    assertEquals(ok.journal.reformulation_indisponible, undefined);
    // Sans panne, une question sans mot utile reste hors du cours.
    assertEquals((await relance()).resultat, { etat: "out_of_corpus", raison: "seuil" });
    // Une panne qui n'empêche pas de trouver des passages laisse répondre, et reste au journal.
    const h = fauxModeles({ sorties: [BONNE] });
    h.modeles.reformuler = () => Promise.resolve("");
    const trouve = await demander(db, h.modeles, "Et la façade ?", p, 0.023, undefined, "Gaudí ?");
    assertEquals(trouve.resultat.etat, "answered");
    assert(trouve.journal.reformulation_indisponible);
    // Le refus du générateur devant ces passages ne prouve pas non plus une limite du cours.
    const i = fauxModeles({ sorties: ['{"refus": true}'] });
    i.modeles.reformuler = h.modeles.reformuler;
    const refus = await demander(db, i.modeles, "Et la façade ?", p, 0.023, undefined, "Gaudí ?");
    assertEquals(refus.resultat.etat, "failed");
  } finally {
    db.close();
  }
});

test("une traduction en panne sur un périmètre anglais donne une panne, pas une limite du cours", async () => {
  const { db } = await environnement();
  try {
    const design = matiere(db, "Design");
    const source = await publier(db, "Casa Batlló", cours(db, design, "Cours"));
    const p = { lecteur: null, schoolId: "pilote" };
    const question = "Combien de temps dure la mémoire immédiate ?";
    const f = fauxModeles({ sorties: [BONNE] });
    f.modeles.traduire = () => Promise.reject(new PanneModele("OpenRouter 429: quota"));
    // Sans source anglaise, aucune traduction n'a lieu : la question est hors du cours.
    assertEquals((await demander(db, f.modeles, question, p, 0.023)).resultat, {
      etat: "out_of_corpus",
      raison: "seuil",
    });
    db.prepare("UPDATE sources SET langue = 'en' WHERE id = ?").run(source);
    assertEquals(
      (await chercher(db, f.modeles, question, p, 0.023)).panneTraduction,
      "OpenRouter 429: quota",
    );
    const { resultat, journal } = await demander(db, f.modeles, question, p, 0.023);
    assertEquals(resultat, {
      etat: "failed",
      code: "MODEL_UNAVAILABLE",
      message: "OpenRouter 429: quota",
    });
    assertEquals(journal.traduction_indisponible, "OpenRouter 429: quota");
    // Comparaison : la matière sans passage ne s'annonce pas vide après une panne.
    const matieres = [design, matiere(db, "Philosophie")];
    const compare = (modeles = f.modeles) =>
      demander(db, modeles, "Gaudí et la façade ?", { ...p, matieres }, 0.023);
    assertEquals((await compare()).resultat.etat, "failed");
    const sain = await compare(fauxModeles({ sorties: [BONNE] }).modeles);
    assert(sain.resultat.etat === "answered");
    assertEquals(sain.resultat.sans_passage, ["Philosophie"]);
  } finally {
    db.close();
  }
});
