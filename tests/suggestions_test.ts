import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { PanneModele } from "../src/core/modeles.ts";
import {
  DELAI_PROCHES_MS,
  MAX_CANDIDATES,
  questionsProches,
  renvoie,
} from "../src/core/suggestions.ts";
import { config, contenu } from "../src/app/config.ts";
import { revendiquer, statuer, traiter } from "../src/app/ingestion.ts";
import {
  faitAuHasard,
  genererSuggestions,
  suggestionsDuPerimetre,
} from "../src/app/suggestions.ts";
import { environnement, fauxModeles, session } from "./outils.ts";
import { ELEVE, PAGE, sourceTraitee } from "./source_outils.ts";

test("une suggestion qui renvoie à une image absente est écartée, une question qui la nomme passe", () => {
  for (const q of [
    "Quel est le sujet du motif de la tapisserie ?",
    "Quel principe du fauvisme se retrouve dans ce portrait ?",
    "Pourquoi les couleurs vert et bleu sont-elles alternées dans le motif ?",
    "Que montre cette œuvre ?",
    "Que dit l'extrait sur le Bauhaus ?",
  ]) {
    assertEquals(renvoie(q), true, q);
  }
  for (const q of [
    "Que représente le motif floral de William Morris ?",
    "Quel portrait Matisse a-t-il fait de sa femme ?",
    "Pourquoi les Arts and Crafts aiment-ils les motifs végétaux ?",
    "Pourquoi Gaudí refuse-t-il la ligne droite ?",
  ]) {
    assertEquals(renvoie(q), false, q);
  }
});

test("après un refus, seules les questions proches du sens de la question sont proposées", async () => {
  const candidates = [
    "Qui est Gaudí ?",
    "Qu'est-ce que l'Art nouveau ?",
    "Que réunit le Bauhaus ?",
  ];
  const proches = (scores: number[]) => {
    const { modeles } = fauxModeles();
    modeles.reclasser = (_q, docs) =>
      Promise.resolve(docs.map((_, index) => ({ index, score: scores[index] })));
    return questionsProches(modeles, "Où a vécu Gaudí ?", candidates, 0.5);
  };
  assertEquals(await proches([0.9, 0.1, 0.6]), ["Qui est Gaudí ?", "Que réunit le Bauhaus ?"]);
  assertEquals(await proches([0.01, 0.02, 0.03]), [], "rien de proche, rien de proposé");

  const { modeles } = fauxModeles();
  modeles.reclasser = () => Promise.reject(new PanneModele("reclasseur 503"));
  assertEquals(
    await questionsProches(modeles, "Où a vécu Gaudí ?", candidates, 0.5),
    null,
    "une panne ne vaut pas « rien de proche »",
  );
});

test("questions proches : le reclasseur reçoit un nombre borné de candidates et un délai", async () => {
  const { modeles } = fauxModeles();
  let recues = 0;
  modeles.reclasser = (_q, docs) => {
    recues = docs.length;
    return Promise.resolve(docs.map((_, index) => ({ index, score: 0.9 })));
  };
  const beaucoup = Array.from({ length: MAX_CANDIDATES + 20 }, (_, i) => `Question ${i} ?`);
  await questionsProches(modeles, "Où a vécu Gaudí ?", beaucoup, 0.5);
  assertEquals(recues, MAX_CANDIDATES);

  // Un reclasseur qui ne répond pas s'arrête au signal.
  modeles.reclasser = (_q, _docs, signal) =>
    new Promise((_, rejeter) => signal?.addEventListener("abort", () => rejeter(signal.reason)));
  const debut = Date.now();
  assertEquals(await questionsProches(modeles, "Où a vécu Gaudí ?", beaucoup, 0.5), null);
  assert(Date.now() - debut < DELAI_PROCHES_MS + 500);
});

test("une question proposée n'est gardée que si Thot y répond avec une citation vérifiée", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  statuer(db, id, "certifiee", "test");
  const bonne = JSON.stringify({
    affirmations: [
      {
        texte: "Gaudí refuse la ligne droite.",
        extrait: 1,
        citation: "Gaudí refuse la ligne droite dans toute la façade",
      },
    ],
  });
  const malformee = fauxModeles({ sorties: ['{"questions": "Pourquoi ?"}'] });
  assertEquals(await genererSuggestions(db, malformee.modeles, id), 0);
  const f = fauxModeles({
    sorties: [
      JSON.stringify({
        questions: [
          "Pourquoi le motif alterne-t-il le vert et le bleu ?",
          "Que montre cette œuvre ?",
          "Pourquoi Gaudí refuse-t-il la ligne droite ?",
          "Quel âge avait Gaudí ?",
        ],
      }),
      bonne,
      '{"refus": true}',
    ],
  });
  assertEquals(await genererSuggestions(db, f.modeles, id), 1);
  assertEquals(
    db
      .prepare("SELECT question FROM suggestions")
      .all()
      .map((l) => l.question),
    ["Pourquoi Gaudí refuse-t-il la ligne droite ?"],
  );
  assertEquals(suggestionsDuPerimetre(db, ELEVE, new Set([id])).length, 1);
  statuer(db, id, "rejetee", "test");
  assertEquals(
    suggestionsDuPerimetre(db, ELEVE, new Set([id])).length,
    0,
    "une source rejetée ne propose plus rien",
  );
});

test("certifier une nouvelle version retire les questions vérifiées sur l'ancienne", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  statuer(db, id, "certifiee", "test");
  db.prepare("INSERT INTO suggestions VALUES ('sg', ?, 'Qui est Gaudí ?', 'faux', 'test')").run(id);
  assertEquals(suggestionsDuPerimetre(db, ELEVE, new Set([id])).length, 1);

  // Le texte change : une version à relire, que l'enseignant certifie avant le passage du worker.
  const html = new TextDecoder().decode(PAGE).replace("Gaudí refuse", "L'architecte refuse");
  writeFileSync(contenu(id, "original", "casa.html"), html);
  db.prepare("UPDATE ingestion_jobs SET etat = 'received' WHERE source_id = ?").run(id);
  await traiter(db, revendiquer(db)!, fauxModeles().modeles);
  assertEquals(
    suggestionsDuPerimetre(db, ELEVE, new Set([id])).length,
    1,
    "l'ancienne sert encore",
  );
  statuer(db, id, "certifiee", "test", 2);
  assertEquals(suggestionsDuPerimetre(db, ELEVE, new Set([id])), []);
});

test("le saviez-vous recopie une phrase certifiée et pointe sa position exacte", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  assertEquals(faitAuHasard(db, ELEVE), undefined, "rien tant que la source n'est pas certifiée");
  statuer(db, id, "certifiee", "test");
  const fait = faitAuHasard(db, ELEVE)!;
  const texte = await readFile(`${config.donnees}/content/${id}/document.txt`, "utf8");
  assertEquals(Array.from(texte).slice(fait.debut, fait.fin).join(""), fait.phrase);
});

test("un refus propose les questions proches de la question, et rien si aucune ne l'est", async () => {
  const { db } = await environnement();
  const source = await sourceTraitee(db);
  statuer(db, source, "certifiee", "test");
  db.prepare("INSERT INTO suggestions VALUES ('sg', ?, 'Qui est Gaudí ?', 'faux', 'test')").run(
    source,
  );
  const f = fauxModeles();
  // Les passages restent sous le seuil, donc les deux questions sont refusées. Seule la suggestion
  // est proche, et seulement de la question qui parle de Gaudí.
  let appels = 0;
  f.modeles.reclasser = (q, docs) => {
    if (docs.includes("Qui est Gaudí ?")) appels++;
    return Promise.resolve(
      docs.map((d, index) => ({
        index,
        score: q.includes("Gaudí") && d.startsWith("Qui") ? 0.9 : 0.001,
      })),
    );
  };
  const eleve = await session(db, f.modeles, "eleve");
  const refus = async (texte: string) => {
    const r = await eleve.requete("/eleve/questions", {
      method: "POST",
      headers: { "HX-Request": "true" },
      body: new URLSearchParams({ texte }),
    });
    const id = (await r.text()).match(/messages\/([\w-]+)\/flux/)![1];
    return { id, html: await (await eleve.requete(`/eleve/messages/${id}/flux`)).text() };
  };
  const { id, html: proche } = await refus("Où Gaudí a-t-il vécu ?");
  assertStringIncludes(proche, "Ce que ton cours couvre");
  assertStringIncludes(proche, "Qui est Gaudí ?");
  // Relire le refus ne rappelle pas le reclasseur.
  assertStringIncludes(
    await (await eleve.requete(`/eleve/messages/${id}/flux`)).text(),
    "Qui est Gaudí ?",
  );
  assertEquals(appels, 1);
  const { html: loin } = await refus("Quelle est la capitale du Pérou ?");
  assertStringIncludes(loin, "Je ne trouve pas la réponse");
  assert(!loin.includes("Ce que ton cours couvre"));
});
