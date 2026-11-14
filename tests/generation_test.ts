import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Db } from "../src/app/db.ts";
import { cours, matiere } from "../src/app/domaines.ts";
import { CONSIGNE_ACTIVITE, type Contenu, type Question } from "../src/core/activite.ts";
import { environnement, fauxModeles, publier, session } from "./outils.ts";

const P1 = "Gaudí refuse la ligne droite dans toute la façade";
const P2 = "La façade de la Casa Batlló est couverte de céramique irisée";
const cite = (texte: string, citation: string) => ({
  texte,
  citations: [{ extrait: 1, citation }],
});

const redigee = (consigne = "Que refuse Gaudí dans la façade ?", citation = P1) =>
  JSON.stringify({
    consigne: cite(consigne, citation),
    attendu: cite("Gaudí refuse la ligne droite.", P1),
    criteres: [
      cite("La réponse nomme la ligne droite.", P1),
      cite("La réponse vise la façade.", P1),
    ],
    retour: cite("Sa façade est couverte de céramique irisée.", P2),
  });
const option = (
  texte: string,
  juste: boolean,
  citations = juste ? [{ extrait: 1, citation: P1 }] : undefined,
) => ({
  texte,
  juste,
  ...(citations && { citations }),
});
const choix = (
  options = [
    option("La ligne droite", true),
    option("Le plan libre", false),
    option("Le béton armé", false),
  ],
  consigne = "Que refuse Gaudí ?",
) =>
  JSON.stringify({
    consigne: cite(consigne, P1),
    options,
    retour: cite("Sa façade est irisée.", P2),
  });
const terme = (accepte = ["ligne droite", "droite"]) =>
  JSON.stringify({
    consigne: cite("Quelle forme Gaudí refuse-t-il ?", P1),
    accepte,
    retour: cite("Sa façade est irisée.", P2),
  });
const REFUS = JSON.stringify({ refus: true });

async function cadre(sorties: string[]) {
  const { db } = await environnement();
  const coursId = cours(db, matiere(db, "Arts appliqués"), "Design");
  const source = await publier(db, "Casa Batlló", coursId);
  const g = fauxModeles({ sorties });
  const prof = await session(db, g.modeles, "enseignant");
  return { db, coursId, source, prof, vus: g.vus };
}
type Cadre = Awaited<ReturnType<typeof cadre>>;
type Profil = Cadre["prof"];

const envoyer = (s: Profil, url: string, corps: Record<string, string | string[]> = {}) => {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(corps)) for (const x of [v].flat()) f.append(k, x);
  return s.requete(url, { method: "POST", body: f });
};

/** Prépare une série : `nombre` questions des types choisis. */
const preparer = (c: Cadre, corps: Record<string, string | string[]> = {}) =>
  envoyer(c.prof, "/prof/activites", {
    cours_id: c.coursId,
    intitule: "Expliquer le refus de la ligne droite chez Gaudí",
    sources: c.source,
    ...corps,
  });

const ligne = (db: Db, id: string) =>
  db
    .prepare("SELECT etat, revision, contenu, rejets, titre FROM activites WHERE id = ?")
    .get(id) as {
    etat: string;
    revision: number;
    contenu: string;
    rejets: string;
    titre: string;
  };
const identifiant = (r: Response) => r.headers.get("location")!.split("/").at(-1)!;
const serie = (db: Db, id: string) => JSON.parse(ligne(db, id).contenu) as Contenu;
const rejetsDe = (db: Db, id: string) => JSON.parse(ligne(db, id).rejets) as string[];

test("une question rédigée : un appel, la consigne d'aujourd'hui, la correction après la série", async () => {
  const c = await cadre([redigee()]);
  const r = await preparer(c);
  assertEquals(r.status, 303);
  assertEquals(c.vus.length, 1);
  assertEquals(c.vus[0][0].content, CONSIGNE_ACTIVITE);
  assert(!c.vus[0][1].content.includes("Question 1 sur"));
  const s = serie(c.db, identifiant(r));
  assertEquals(s.correction, "serie");
  assertEquals(
    s.questions.map((q) => q.type),
    ["redigee"],
  );
});

test("une série de trois types : trois appels, les questions gardent l'ordre et le type", async () => {
  const c = await cadre([redigee(), choix(), terme()]);
  const r = await preparer(c, {
    nombre: "3",
    types: ["redigee", "choix", "terme"],
    correction: "question",
  });
  assertEquals(r.status, 303);
  assertEquals(c.vus.length, 3);
  assertStringIncludes(c.vus[1][1].content, "Question 2 sur 3.");
  assertEquals(new Set(c.vus.map((v) => v[0].content)).size, 3, "une consigne par type");
  const s = serie(c.db, identifiant(r));
  assertEquals(s.correction, "question");
  assertEquals(
    s.questions.map((q) => q.type),
    ["redigee", "choix", "terme"],
  );
  assertEquals(new Set(s.questions.map((q) => q.id)).size, 3);
  const q = s.questions[1] as Extract<Question, { options: unknown }>;
  assertEquals(q.options.filter((o) => o.juste).length, 1);
  assertEquals(
    q.options.map((o) => o.id),
    ["A", "B", "C"],
  );
});

test("les types se répètent en boucle sur le nombre demandé", async () => {
  const c = await cadre([choix(), terme(), choix(), terme()]);
  const r = await preparer(c, { nombre: "4", types: ["choix", "terme"] });
  assertEquals(
    serie(c.db, identifiant(r)).questions.map((q) => q.type),
    ["choix", "terme", "choix", "terme"],
  );
});

test("une question mal ancrée est rejetée et comptée, les autres restent", async () => {
  const c = await cadre([
    redigee("Que refuse Gaudí ?", "Le Corbusier invente le plan libre"),
    choix(),
  ]);
  const r = await preparer(c, { nombre: "2", types: ["redigee", "choix"] });
  assertEquals(r.status, 303);
  const id = identifiant(r);
  assertEquals(
    serie(c.db, id).questions.map((q) => q.type),
    ["choix"],
  );
  const rejets = rejetsDe(c.db, id);
  assert(rejets.length > 0 && rejets.every((m) => m.startsWith("Question 1 : ")), rejets.join("|"));
});

test("choix : une option fausse sans citation reste, ses citations éventuelles tombent", async () => {
  const c = await cadre([
    choix([
      option("La ligne droite", true),
      option("Le plan libre", false, [{ extrait: 1, citation: "invente" }]),
      option("Le béton armé", false),
    ]),
  ]);
  const r = await preparer(c, { types: "choix" });
  assertEquals(r.status, 303);
  const q = serie(c.db, identifiant(r)).questions[0] as Extract<Question, { options: unknown }>;
  assertEquals(q.options.length, 3);
  for (const o of q.options) assertEquals(o.texte.citations.length, o.juste ? 1 : 0);
});

test("choix : une bonne option sans passage trouvé, ou deux bonnes options, rejettent la question", async () => {
  const sansPassage = choix([
    option("La ligne droite", true, [
      { extrait: 1, citation: "Le Corbusier invente le plan libre" },
    ]),
    option("Le plan libre", false),
    option("Le béton armé", false),
  ]);
  const deux = choix([
    option("La ligne droite", true),
    option("La façade", true),
    option("Le béton armé", false),
  ]);
  for (const sortie of [sansPassage, deux]) {
    const c = await cadre([sortie]);
    const r = await preparer(c, { types: "choix" });
    assertEquals(r.status, 422);
    assertStringIncludes(await r.text(), "Thot n&#39;a pas pu ancrer");
  }
});

test("choix multiple : une bonne option mal ancrée fait tomber la question", async () => {
  const c = await cadre([
    choix([
      option("La ligne droite", true),
      option("La façade", true, [{ extrait: 1, citation: "texte inventé" }]),
      option("Le béton armé", false),
    ]),
  ]);
  const r = await preparer(c, { types: "choix_multiple" });
  assertEquals(r.status, 422);
});

test("terme : une réponse que les citations ne contiennent pas est rejetée, sans accents ni casse sinon", async () => {
  const absente = await cadre([terme(["plan libre"])]);
  assertEquals((await preparer(absente, { types: "terme" })).status, 422);
  const presente = await cadre([terme(["GAUDÍ REFUSE LA LIGNE DROITE"]), terme(["Gaudi"])]);
  const r = await preparer(presente, { nombre: "2", types: "terme" });
  assertEquals(serie(presente.db, identifiant(r)).questions.length, 2);
});

test("un refus pour une question sur trois laisse les deux autres, un refus général garde le message", async () => {
  const c = await cadre([choix(), REFUS, choix()]);
  const r = await preparer(c, { nombre: "3", types: ["choix", "terme"] });
  assertEquals(r.status, 303);
  assertEquals(serie(c.db, identifiant(r)).questions.length, 2);
  assertEquals(rejetsDe(c.db, identifiant(r)), []);
  const tous = await cadre([REFUS, REFUS]);
  const refus = await preparer(tous, { nombre: "2" });
  assertEquals(refus.status, 422);
  assertStringIncludes(await refus.text(), "ne trouve pas dans ces sources");
});

/** Une série d'une question rédigée, relue, puis ce que fait la page de détail de ses boutons. */
async function activite(sorties: string[], types = ["redigee"]) {
  const c = await cadre(sorties);
  const r = await preparer(c, { types });
  assertEquals(r.status, 303);
  return { ...c, id: identifiant(r) };
}

test("régénérer une question garde son identifiant, change son contenu et crée une version en brouillon", async () => {
  const c = await activite([redigee(), redigee("Quelle est la matière de la façade ?")]);
  const avant = serie(c.db, c.id).questions[0];
  const revision = String(ligne(c.db, c.id).revision);
  assertEquals((await envoyer(c.prof, `/prof/activites/${c.id}/relire`, { revision })).status, 303);
  assertEquals(ligne(c.db, c.id).etat, "relue");
  const r = await envoyer(c.prof, `/prof/activites/${c.id}/questions/${avant.id}/regenerer`, {
    revision,
  });
  assertEquals(r.status, 303);
  assertEquals(r.headers.get("location"), `/prof/activites/${c.id}#q-${avant.id}`);
  const apres = serie(c.db, c.id).questions;
  assertEquals(apres.length, 1);
  assertEquals(apres[0].id, avant.id);
  assertEquals(apres[0].consigne.texte, "Quelle est la matière de la façade ?");
  assertEquals(ligne(c.db, c.id).revision, 2);
  assertEquals(ligne(c.db, c.id).etat, "brouillon");
  assertStringIncludes(c.vus[1][1].content, "Que refuse Gaudí dans la façade ?");
});

test("proposer ajoute une question du type demandé, avec la même version attendue", async () => {
  const c = await activite([redigee(), choix()]);
  const r = await envoyer(c.prof, `/prof/activites/${c.id}/questions/proposer`, { type: "choix" });
  assertEquals(r.status, 303);
  const questions = serie(c.db, c.id).questions;
  assertEquals(
    questions.map((q) => q.type),
    ["redigee", "choix"],
  );
  assertEquals(ligne(c.db, c.id).revision, 2);
  assertStringIncludes(c.vus[1][1].content, "Question 2 sur 2.");
});

test("régénérer échoue lisiblement : explication, question inconnue, refus du modèle, version dépassée", async () => {
  const c = await activite([redigee(), REFUS, redigee()]);
  const q = serie(c.db, c.id).questions[0].id;
  const erreur = (r: Response) => {
    assertEquals(r.status, 303);
    const l = r.headers.get("location")!;
    assertStringIncludes(l, `/prof/activites/${c.id}?erreur=`);
    return decodeURIComponent(l.split("erreur=")[1]);
  };
  assertStringIncludes(
    erreur(await envoyer(c.prof, `/prof/activites/${c.id}/questions/zzz/regenerer`)),
    "Question inconnue",
  );
  assertStringIncludes(
    erreur(await envoyer(c.prof, `/prof/activites/${c.id}/questions/proposer`, { type: "autre" })),
    "Type de question inconnu",
  );
  assertStringIncludes(
    erreur(await envoyer(c.prof, `/prof/activites/${c.id}/questions/${q}/regenerer`)),
    "ne trouve pas dans ces sources",
  );
  assertStringIncludes(
    erreur(
      await envoyer(c.prof, `/prof/activites/${c.id}/questions/${q}/regenerer`, { revision: "7" }),
    ),
    "a changé",
  );
  c.db.prepare("UPDATE activites SET type = 'explication' WHERE id = ?").run(c.id);
  assertStringIncludes(
    erreur(await envoyer(c.prof, `/prof/activites/${c.id}/questions/${q}/regenerer`)),
    "Une explication ne se modifie pas",
  );
  assertEquals(ligne(c.db, c.id).revision, 1);
});

// Le quiz de démonstration de carnet-quiz (public/exemple.json).
const EXEMPLE = {
  title: "Exemple : les quatre types de questions",
  courseUrl: "https://developer.mozilla.org/fr/docs/Learn_web_development",
  timeLimit: 60,
  questions: [
    {
      id: "q1",
      type: "choice",
      question: "Quelle balise HTML crée un lien vers une autre page ?",
      options: [
        { id: "A", label: "`<link>`" },
        { id: "B", label: "`<a>`" },
        { id: "C", label: "`<href>`" },
        { id: "D", label: "`<nav>`" },
      ],
      correctAnswer: "B",
      hint: "La balise tient en une lettre.",
      explanation: '`<a href="…">` crée un lien.',
    },
    {
      id: "q2",
      type: "multiple",
      timeLimit: 90,
      question: "Lesquelles de ces balises sont des titres de la page ?",
      options: [
        { id: "A", label: "`<h1>`" },
        { id: "B", label: "`<title>`" },
        { id: "C", label: "`<h2>`" },
        { id: "D", label: "`<header>`" },
        { id: "E", label: "`<h6>`" },
      ],
      correctAnswers: ["A", "C", "E"],
      hint: "Il existe six niveaux de titres.",
      explanation: "`<h1>` à `<h6>` sont les titres de la page.",
    },
    {
      id: "q3",
      type: "text",
      question: "Quel attribut donne un texte de remplacement à une image ?",
      accept: ["alt", "attribut alt"],
      hint: 'Trois lettres, pour "alternative".',
      explanation: "`alt` décrit l'image pour les lecteurs d'écran.",
    },
    {
      id: "q4",
      type: "open",
      timeLimit: 180,
      question: "Expliquez pourquoi un bouton doit avoir un texte visible.",
      expected: "Le texte dit ce que fait le bouton.",
      explanation: "Barème : 0,5 point pour la compréhension.",
    },
  ],
};

const importer = (c: Cadre, quiz: unknown, nom = "quiz.json") => {
  const f = new FormData();
  f.set("cours_id", c.coursId);
  f.set("intitule", "Les bases du HTML");
  f.set("fichier", new File([typeof quiz === "string" ? quiz : JSON.stringify(quiz)], nom));
  return c.prof.requete("/prof/activites/importer", { method: "POST", body: f });
};

test("importer le quiz de démonstration de carnet-quiz crée un brouillon de 4 questions écrites par l'enseignant", async () => {
  const c = await cadre([]);
  const form = await c.prof.requete(`/prof/activites/importer?cours_id=${c.coursId}`);
  assertEquals(form.status, 200);
  const r = await importer(c, EXEMPLE);
  assertEquals(r.status, 200);
  const page = await r.text();
  assertStringIncludes(page, "4 questions");
  assertStringIncludes(page, "chrono");
  assertStringIncludes(page, "lien vers le cours");
  const id = /\/prof\/activites\/([0-9a-f-]{36})/.exec(page)![1];
  const a = ligne(c.db, id);
  assertEquals(a.etat, "brouillon");
  assertEquals(a.titre, EXEMPLE.title);
  const s = serie(c.db, id);
  assertEquals(s.correction, "question");
  assertEquals(
    s.questions.map((q) => q.type),
    ["choix", "choix_multiple", "terme", "redigee"],
  );
  assertEquals(s.questions[0].indice, "La balise tient en une lettre.");
  for (const q of s.questions) {
    assertEquals(q.consigne.citations, []);
    assert(q.retour.texte);
  }
  assertEquals(
    (s.questions[1] as Extract<Question, { options: unknown }>).options
      .filter((o) => o.juste)
      .map((o) => o.id),
    ["A", "C", "E"],
  );
});

test("un quiz invalide ou illisible réaffiche le formulaire avec ses erreurs, en 400", async () => {
  const c = await cadre([]);
  const invalide = {
    title: "Quiz cassé",
    questions: [
      {
        type: "choice",
        question: "Une question",
        options: [
          { id: "A", label: "a" },
          { id: "B", label: "b" },
        ],
        correctAnswer: "Z",
      },
    ],
  };
  const r = await importer(c, invalide);
  assertEquals(r.status, 400);
  const page = await r.text();
  assertStringIncludes(page, 'role="alert"');
  assertStringIncludes(page, "Question 1 : il faut exactement une bonne option.");
  const casse = await importer(c, "{pas du json");
  assertEquals(casse.status, 400);
  assertStringIncludes(await casse.text(), "n&#39;est pas du JSON valide");
  assertEquals(c.db.prepare("SELECT count(*) AS n FROM activites").get()!.n, 0);
});
