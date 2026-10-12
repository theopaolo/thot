import { test } from "vite-plus/test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { type Cache, type ConfigModeles, openrouter, PanneModele } from "../src/core/modeles.ts";

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
    assertEquals(valeurs.size, 1);
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
