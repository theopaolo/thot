import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { assert, assertEquals } from "@std/assert";
import type { Champ, Question } from "../src/core/activite.ts";
import {
  approchee,
  correspond,
  depuisCarnet,
  erreursQuestion,
  essaisMax,
  finie,
  juste,
  melanger,
  points,
  valeur,
} from "../src/core/questions.ts";

const c = (texte: string): Champ => ({ texte, citations: [] });
const options = (...ids: string[]) =>
  ids.map((id) => ({ id, texte: c(`Option ${id}`), juste: false }));
const base = { consigne: c("Q"), retour: c("") };

const optsChoix = options("A", "B", "C", "D").map((o) => ({ ...o, juste: o.id === "B" }));
const optsMultiple = options("A", "B", "C").map((o) => ({ ...o, juste: o.id !== "B" }));
const choix: Question = { ...base, id: "q1", type: "choix", options: optsChoix };
const multiple: Question = { ...base, id: "q2", type: "choix_multiple", options: optsMultiple };
const terme: Question = { ...base, id: "q3", type: "terme", accepte: ["Jakob"] };
const redigee: Question = {
  ...base,
  id: "q4",
  type: "redigee",
  attendu: c("E"),
  criteres: [],
};

test("réponses tapées : variantes, mots de liaison et fautes de frappe", () => {
  assert(correspond("C'est la loi de Jakob !", ["Jakob"]));
  assert(correspond("jakop", ["Jakob"]));
  assert(correspond("L'effet de gradation du but", ["gradation du but"]));
  assert(correspond("proximite", ["proximité"]));
  assert(!correspond("Jakob Hick Fitts", ["Jakob"]));
  assert(!correspond("Hick", ["Jakob"]));
  assert(!correspond("fit", ["Fitts"]));
});

test("réponses tapées : une réponse fausse à une lettre, un chiffre ou un signe près est refusée", () => {
  assert(!correspond("hépatite C", ["Hépatite A"]));
  assert(!correspond("1", ["-1"]));
  assert(!correspond("H2SO3", ["H2SO4"]));
  assert(!correspond("14 juillet 1798", ["14 juillet 1789"]));
  assert(!correspond("balise", ["balise a"]));
  assert(correspond("Wiliam Morris", ["William Morris"]));
  // Le dernier mot reste, même s'il est de liaison.
  assert(correspond("la balise A", ["balise a"]));
  assert(correspond("la loi", ["la loi", "Jakob"]));
  assert(!correspond("la loi", ["Jakob"]));
  // Le signe moins se garde devant un chiffre, le trait d'union sépare des mots.
  assert(correspond("−1", ["-1"]));
  assert(!correspond("-1", ["1"]));
  assert(correspond("Jean Paul", ["Jean-Paul"]));
  assert(correspond("1789 1799", ["1789-1799"]));
  // La faute de frappe se compte dans chaque mot : un mot court ne se devine pas.
  assert(!correspond("du bit", ["du but"]));
  assert(!correspond("jak0b", ["Jakob"]));
  assert(correspond("architectre", ["architecture"]));
});

test("réponse tapée acceptée avec une différence : tout sauf la casse et les espaces", () => {
  assert(!approchee("  william   MORRIS ", ["William Morris"]));
  assert(approchee("Wiliam Morris", ["William Morris"]));
  assert(approchee("proximite", ["proximité"]));
  assert(approchee("la loi de Jakob", ["Jakob"]));
  assert(!approchee("Hick", ["Jakob"]), "refusée, donc pas acceptée avec une différence");
});

test("valeurs envoyées", () => {
  assertEquals(valeur(multiple, ["C", "A", "A"]), "A,C");
  assertEquals(valeur(multiple, "A"), "A");
  assertEquals(valeur(multiple, ["Z"]), null);
  assertEquals(valeur(multiple, []), null);
  assertEquals(valeur(choix, "B"), "B");
  assertEquals(valeur(choix, "Z"), null);
  assertEquals(valeur(choix, ["B"]), null);
  assertEquals(valeur(terme, "  Jakob "), "Jakob");
  assertEquals(valeur(terme, "   "), null);
  assertEquals(valeur(terme, "x".repeat(201)), null);
  assertEquals(valeur(redigee, "x".repeat(4000))?.length, 4000);
  assertEquals(valeur(redigee, "x".repeat(4001)), null);
  assertEquals(valeur(redigee, 12), null);
  // `maxlength` compte une fin de ligne pour un caractère, le navigateur en envoie deux.
  assertEquals(valeur(redigee, `${"x".repeat(1999)}\r\n${"x".repeat(2000)}`)?.length, 4000);
  assertEquals(valeur(redigee, "a\r\nb\rc"), "a\nb\nc");
});

test("correction de chaque type", () => {
  assert(juste(choix, "B"));
  assert(!juste(choix, "A"));
  assert(juste(multiple, "A,C"));
  assert(!juste(multiple, "A"));
  assert(juste(terme, "jakob"));
  assert(!juste(redigee, "tout"));
});

test("essais et fin de question", () => {
  assertEquals(essaisMax(choix, "question"), 2);
  assertEquals(
    essaisMax({ ...choix, options: options("A", "B").slice() } as Question, "question"),
    1,
  );
  assertEquals(essaisMax(multiple, "question"), 2);
  assertEquals(essaisMax(terme, "question"), 2);
  assertEquals(essaisMax(redigee, "question"), 1);
  assertEquals(essaisMax(choix, "serie"), 1);
  assertEquals(essaisMax(terme, "serie"), 1);
  assert(!finie(choix, [], "question"));
  assert(!finie(choix, ["A"], "question"));
  assert(finie(choix, ["A", "C"], "question"));
  assert(finie(choix, ["B"], "question"));
  assert(finie(choix, ["A"], "serie"));
  assert(finie(redigee, ["texte"], "question"));
});

test("points : 1 au premier essai, 0,5 au deuxième, la note du professeur l'emporte", () => {
  assertEquals(points(choix, ["B"], "question"), 1);
  assertEquals(points(choix, ["A", "B"], "question"), 0.5);
  assertEquals(points(choix, ["A", "C"], "question"), 0);
  assertEquals(points(choix, [], "question"), 0);
  assertEquals(points(choix, ["A", "C"], "question", 1), 1);
  assertEquals(points(choix, ["B"], "question", 0), 0);
  assertEquals(points(terme, ["faux", "jakob"], "question"), 0.5);
  assertEquals(points(terme, ["faux", "jakob"], "serie"), 0);
  assertEquals(points(redigee, ["texte"], "question"), null);
  assertEquals(points(redigee, [], "question"), 0);
  assertEquals(points(redigee, ["texte"], "question", 0.5), 0.5);
});

test("melanger est déterministe et ne fait que permuter", () => {
  const liste = Array.from({ length: 20 }, (_, i) => i);
  const a = melanger(liste, "compte-1:q1");
  assertEquals(melanger(liste, "compte-1:q1"), a);
  assertEquals(
    [...a].sort((x, y) => x - y),
    liste,
  );
  assert(a.some((x, i) => x !== i));
  assert(melanger(liste, "compte-2:q1").some((x, i) => x !== a[i]));
  assertEquals(
    liste,
    Array.from({ length: 20 }, (_, i) => i),
  );
  assertEquals(melanger([], "x"), []);
});

test("erreursQuestion attrape chaque règle", () => {
  assertEquals([choix, multiple, terme, redigee].flatMap(erreursQuestion), []);
  const n = (q: Question) => erreursQuestion(q).length;
  assertEquals(n({ ...choix, consigne: c("  ") }), 1);
  assertEquals(n({ ...choix, retour: c("x".repeat(2001)) }), 1);
  const opts = optsChoix;
  assertEquals(n({ ...choix, options: opts.slice(0, 1) } as Question), 2);
  assertEquals(
    n({ ...choix, options: options("A", "B", "C", "D", "E", "F", "G", "H", "I") } as Question),
    2,
  );
  assertEquals(n({ ...choix, options: [...opts, ...opts] } as Question), 2);
  assertEquals(
    n({ ...choix, options: opts.map((o, i) => (i ? { ...o, id: "A" } : o)) } as Question),
    1,
  );
  assertEquals(n({ ...choix, options: opts.map((o) => ({ ...o, texte: c("") })) } as Question), 1);
  assertEquals(n({ ...choix, options: opts.map((o) => ({ ...o, juste: false })) } as Question), 1);
  assertEquals(n({ ...choix, options: opts.map((o) => ({ ...o, juste: true })) } as Question), 1);
  const mopts = optsMultiple;
  assertEquals(
    n({ ...multiple, options: mopts.map((o) => ({ ...o, juste: false })) } as Question),
    1,
  );
  assertEquals(n({ ...terme, accepte: [] } as Question), 1);
  assertEquals(n({ ...terme, accepte: ["la loi"] } as Question), 0);
  assertEquals(n({ ...terme, accepte: ["?!"] } as Question), 1);
  assertEquals(n({ ...terme, accepte: ["Jakob", " "] } as Question), 1);
  assertEquals(n({ ...terme, image: { alt: "", fichier: "a.png" } }), 1);
  assertEquals(n({ ...terme, image: { alt: "A" } }), 1);
  assertEquals(n({ ...terme, image: { alt: "A", fichier: "a.png", media: "m" } }), 1);
  assertEquals(n({ ...terme, image: { alt: "A", media: "m" } }), 0);
  assertEquals(n({ ...terme, langage: "js" } as Question), 1);
  assertEquals(n({ ...redigee, langage: "c++" } as Question), 0);
  assertEquals(n({ ...redigee, langage: "JS script" } as Question), 1);
  assertEquals(n({ ...redigee, langage: "a".repeat(21) } as Question), 1);
});

test("un quiz carnet devient des questions Thot", () => {
  const r = depuisCarnet({
    title: "Exemple",
    courseUrl: "https://exemple.fr/",
    timeLimit: 60,
    questions: [
      {
        id: "q1",
        question: "Quelle balise crée un lien ?",
        options: [
          { id: "A", label: "`<link>`" },
          { id: "B", label: "`<a>`" },
        ],
        correctAnswer: "B",
        hint: "Une seule lettre.",
        explanation: "`<a href>` crée un lien.",
        trap: "Piège",
        lookup: "le cours",
        lookupUrl: "https://exemple.fr/#a",
      },
      {
        id: "q2",
        type: "multiple",
        question: "Titres ?",
        options: [
          { id: "A", label: "h1" },
          { id: "B", label: "title" },
          { id: "C", label: "h2" },
        ],
        correctAnswers: ["A", "C"],
      },
      { id: "q3", type: "text", question: "Attribut ?", accept: ["alt", "attribut alt"] },
      {
        id: "q4",
        type: "open",
        question: "Pourquoi ?",
        expected: "Attendu",
        image: "https://a/b.png",
        imageAlt: "B",
      },
    ],
  });
  assert("questions" in r);
  assertEquals(r.titre, "Exemple");
  assertEquals(r.ignores, [
    "pièges anti-IA",
    "chrono",
    "liens de recherche",
    "images : déposez-les dans Thot",
    "lien vers le cours (courseUrl)",
  ]);
  const [q1, q2, q3, q4] = r.questions;
  assertEquals(q1.type, "choix");
  assertEquals(q1.indice, "Une seule lettre. Cherchez dans le cours.");
  assertEquals(q1.retour, c("`<a href>` crée un lien."));
  assertEquals(q1.type === "choix" && q1.options.map((o) => [o.id, o.juste]), [
    ["A", false],
    ["B", true],
  ]);
  assertEquals(q2.type === "choix_multiple" && q2.options.filter((o) => o.juste).map((o) => o.id), [
    "A",
    "C",
  ]);
  assertEquals(q3.type === "terme" && q3.accepte, ["alt", "attribut alt"]);
  assertEquals(q4.type === "redigee" && q4.attendu, c("Attendu"));
  assertEquals(q4.image, undefined);
  assertEquals(
    r.questions.map((q) => q.id),
    ["q1", "q2", "q3", "q4"],
  );
});

test("un ancien deck de flashcards devient des questions à choix", () => {
  const r = depuisCarnet({
    title: "T",
    flashcards: [
      { question: "Q1", choices: ["a", "b"], correct_choice_index: 1 },
      { question: "Q2", choices: ["`x`", "y"], reponse: "x, parce que" },
      { question: "Q3", choices: ["a", "b"], reponse: "rien de tout ça" },
    ],
  });
  assert("questions" in r);
  assertEquals(r.ignores, []);
  assertEquals(
    r.questions.map((q) => [q.id, q.type === "choix" && q.options.find((o) => o.juste)?.id]),
    [
      ["q1", "B"],
      ["q2", "A"],
    ],
  );
});

test("un quiz carnet inutilisable renvoie ses erreurs numérotées", () => {
  const q = {
    question: "Q",
    options: [
      { id: "A", label: "a" },
      { id: "B", label: "b" },
    ],
  };
  assertEquals(depuisCarnet({ questions: [] }), {
    erreurs: ["Il manque le titre (title).", "Il n'y a aucune question."],
  });
  assertEquals(depuisCarnet(null), {
    erreurs: ["Il manque le titre (title).", "Il n'y a aucune question."],
  });
  assertEquals(
    depuisCarnet({
      title: "T",
      questions: [
        { ...q, correctAnswer: "A" },
        { ...q, correctAnswer: "Z" },
        { ...q, type: "multiple", correctAnswers: ["A", "Z"] },
        { id: "q4", type: "text", question: "Q", accept: ["?!"] },
        { ...q, type: "essai" },
      ],
    }),
    {
      erreurs: [
        "Question 2 : il faut exactement une bonne option.",
        "Question 3 : correctAnswers cite une option qui n'existe pas.",
        "Question 4 : la réponse acceptée « ?! » n'a ni lettre ni chiffre.",
        "Question 5 : type inconnu « essai ».",
      ],
    },
  );
});

test("les identifiants d'un quiz carnet sont ceux de Thot, pas ceux du fichier", () => {
  const q = {
    question: "Q",
    options: [
      { id: "x,y", label: "a" },
      { id: "remettre", label: "b" },
    ],
    correctAnswer: "remettre",
  };
  const r = depuisCarnet({
    title: "T",
    questions: [{ ...q, id: "a/b?c" }, { ...q, id: "a/b?c" }, { ...q, id: "confirmer" }, q],
  });
  assert("questions" in r);
  assertEquals(
    r.questions.map((x) => x.id),
    ["q1", "q2", "q3", "q4"],
  );
  for (const x of r.questions) {
    assertEquals(x.type === "choix" && x.options.map((o) => [o.id, o.juste]), [
      ["A", false],
      ["B", true],
    ]);
  }
  // Deux options du fichier sous le même identifiant restent une erreur.
  const double = { ...q, options: q.options.map((o) => ({ ...o, id: "A" })), correctAnswer: "A" };
  assert("erreurs" in depuisCarnet({ title: "T", questions: [double] }));
});

test("les vrais decks de carnet-quiz se convertissent sans erreur", () => {
  const dossier = "/Users/theogoedert/Documents/Webworks/0-education/CarneDuDdev/carnet-quiz/decks";
  if (!existsSync(dossier)) return;
  // Le dossier vit hors du dépôt et grandit : seule la conversion de chaque deck est vérifiée.
  // Un questionnaire de satisfaction (questions « scale ») n'a pas de corrigé : Thot le refuse.
  const fichiers = readdirSync(dossier).filter(
    (f) => f.endsWith(".json") && !f.startsWith("questionnaire-"),
  );
  assert(fichiers.length > 0);
  for (const f of fichiers) {
    const r = depuisCarnet(JSON.parse(readFileSync(join(dossier, f), "utf8")));
    assert("questions" in r, `${f} : ${"erreurs" in r ? r.erreurs.join(" | ") : ""}`);
    assert(r.questions.length > 0, f);
  }
});
