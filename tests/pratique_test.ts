import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  activiteProf,
  ajouterCours,
  ancrerPassage,
  aReprendre,
  avecAvancement,
  deposerImage,
  enregistrer,
  inserer,
  noter,
  publier,
  regler,
  relire,
  tentative,
} from "../src/app/activites.ts";
import { type Compte, lireCompte, type Role } from "../src/app/comptes.ts";
import type { Db } from "../src/app/db.ts";
import { cours, matiere } from "../src/app/domaines.ts";
import { configurerInstance } from "../src/app/instance.ts";
import { optionsAffichees } from "../src/app/vues/pratique.ts";
import { lettre } from "../src/app/vues/questions.ts";
import type { Champ, Citation, Contenu, Option, Question } from "../src/core/activite.ts";
import { environnement, fauxModeles, publier as publierSource, session } from "./outils.ts";

const libre = (texte: string): Champ => ({ texte, citations: [] });

type Session = Awaited<ReturnType<typeof session>> & { id: string; compte: Compte };

async function compte(db: Db, role: Role, inscrit = true): Promise<Session> {
  const s = await session(db, fauxModeles().modeles, role, inscrit);
  const id = db.prepare("SELECT id FROM comptes ORDER BY rowid DESC LIMIT 1").get()!.id as string;
  return { ...s, id, compte: lireCompte(db, id)! };
}

/** Un formulaire de réponse de l'élève porte la version lue : la version 1, sauf si `corps` en dit une autre. */
const envoyer = (s: Session, url: string, corps: Record<string, string | string[]> = {}) => {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(corps)) for (const x of [v].flat()) f.append(k, x);
  if (/^\/eleve\/activites\/[^/]+\/(reponses|questions\/)/.test(url) && !("revision" in corps)) {
    f.append("revision", "1");
  }
  return s.requete(url, { method: "POST", body: f });
};
const page = async (s: Session, url: string) => (await s.requete(url)).text();
const statut = async (r: Response | Promise<Response>) => (await r).status;

/** Un cours, sa source publiée aux élèves, un enseignant et un élève du cours. */
async function cadre(personnel = false) {
  const { db, dir } = await environnement();
  if (personnel) configurerInstance(db, "Mon étude", "personal");
  const coursId = cours(db, matiere(db, "Arts appliqués"), "Design");
  const source = await publierSource(db, "Casa Batlló", coursId);
  const prof = await compte(db, "enseignant");
  const eleve = await compte(db, "eleve");
  // Un passage de la source, tel qu'un champ rédigé par Thot le cite.
  const passage = ancrerPassage(
    db,
    { cours_id: coursId, audience: personnel ? "prive" : "cours", auteur_id: prof.id },
    source,
    "Gaudí refuse la ligne droite dans toute la façade",
    "Passage",
  );
  return { db, dir, coursId, source, prof, eleve, passage };
}

const fermer = async (db: Db, dir: string) => {
  db.close();
  await rm(dir, { recursive: true });
};

function exercice(
  db: Db,
  prof: Compte,
  coursId: string,
  contenu: Contenu,
  titre = "Lire une façade",
) {
  return inserer(db, prof, {
    type: "exercice",
    coursId,
    objectifId: "",
    intitule: "Lire la façade de la Casa Batlló",
    reference: "",
    titre,
    contenu,
  });
}

function publie(db: Db, prof: Compte, id: string) {
  const a = activiteProf(db, prof, id)!;
  assert(relire(db, prof, a, a.revision));
  assertEquals(publier(db, prof, id, a.revision), "publiee");
  return activiteProf(db, prof, id)!;
}

/** L'enseignant enregistre un nouveau contenu, le relit et le publie. */
async function nouvelleVersion(db: Db, prof: Compte, id: string, contenu: Contenu) {
  const a = activiteProf(db, prof, id)!;
  assertEquals(
    await enregistrer(db, fauxModeles().modeles, prof, a, a.revision, contenu),
    "modifie",
  );
  return publie(db, prof, id);
}

/**
 * Une question de chaque type. Chaque champ que le corrigé seul doit montrer porte un marqueur
 * unique, suffixé de l'identifiant de la question. Le retour du choix et la réponse attendue citent
 * un passage de la source.
 */
const serie = (correction: Contenu["correction"], passage: Citation): Contenu => ({
  correction,
  questions: [
    {
      id: "qc",
      type: "choix",
      consigne: libre("CONSIGNE-qc"),
      retour: { texte: "RETOUR-qc", citations: [passage] },
      indice: "INDICE-qc",
      options: [
        { id: "opt-juste-qc", texte: libre("OPTION1-qc"), juste: true },
        { id: "opt-b-qc", texte: libre("OPTION2-qc"), juste: false },
        { id: "opt-c-qc", texte: libre("OPTION3-qc"), juste: false },
      ],
    },
    {
      id: "qm",
      type: "choix_multiple",
      consigne: libre("CONSIGNE-qm"),
      retour: libre("RETOUR-qm"),
      indice: "INDICE-qm",
      options: [
        { id: "opt-juste1-qm", texte: libre("OPTION1-qm"), juste: true },
        { id: "opt-juste2-qm", texte: libre("OPTION2-qm"), juste: true },
        { id: "opt-c-qm", texte: libre("OPTION3-qm"), juste: false },
      ],
    },
    {
      id: "qt",
      type: "terme",
      consigne: libre("CONSIGNE-qt"),
      retour: libre("RETOUR-qt"),
      indice: "INDICE-qt",
      accepte: ["ACCEPTE-qt", "VARIANTE-qt"],
    },
    {
      id: "qr",
      type: "redigee",
      consigne: libre("CONSIGNE-qr"),
      retour: libre("RETOUR-qr"),
      indice: "INDICE-qr",
      attendu: { texte: "ATTENDU-qr", citations: [passage] },
      criteres: [libre("CRITERE1-qr"), libre("CRITERE2-qr")],
    },
  ],
});

/** Ce que seul le corrigé de la question peut montrer. */
const SECRETS: Record<string, string[]> = {
  qc: ["RETOUR-qc", "INDICE-qc"],
  qm: ["RETOUR-qm", "INDICE-qm"],
  qt: ["RETOUR-qt", "INDICE-qt", "ACCEPTE-qt", "VARIANTE-qt"],
  qr: ["RETOUR-qr", "INDICE-qr", "ATTENDU-qr", "CRITERE1-qr", "CRITERE2-qr"],
};
/** Les marques d'un corrigé, cherchées dans la section d'une question. */
const MARQUES = [
  "Bonne réponse",
  "Réponse attendue",
  "debut=",
  "dans toute la façade",
  "Rédigé par l",
  "/criteres/",
];

/** La section d'une question dans la page. */
const section = (html: string, id: string) => {
  const debut = html.indexOf(`id="q-${id}"`);
  assert(debut >= 0, `question ${id}`);
  const fin = html.indexOf('<section class="question-serie"', debut);
  return html.slice(debut, fin < 0 ? undefined : fin);
};

/** Le texte lu, sans balises. */
const texte = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

const sansCorrige = (html: string, id: string, indice = false) => {
  for (const s of SECRETS[id].filter((s) => indice || !s.startsWith("INDICE"))) {
    assert(!html.includes(s), `${s} sort avant le corrigé`);
  }
  for (const m of MARQUES) assert(!section(html, id).includes(m), `${id} : ${m}`);
  assertStringIncludes(html, `CONSIGNE-${id}`);
};

/** La lettre que l'élève voit devant chaque option demandée. */
const lettres = (q: Question, compteId: string, ...ids: string[]) => {
  const affichees = optionsAffichees(q as Question & { options: Option[] }, compteId);
  return ids.map((id) => lettre(affichees.findIndex((o) => o.id === id)));
};

test("série : le corrigé ne sort qu'à la remise, ni l'aperçu ni le brouillon ne le montrent", async () => {
  const { db, dir, coursId, prof, eleve, passage } = await cadre();
  try {
    const contenu = serie("serie", passage);
    const id = exercice(db, prof.compte, coursId, contenu);
    assertEquals(await statut(eleve.requete(`/eleve/activites/${id}`)), 404, "brouillon");
    const avant = await page(prof, `/prof/activites/${id}/apercu`);
    publie(db, prof.compte, id);
    const url = `/eleve/activites/${id}`;
    const vierge = await page(eleve, url);
    for (const html of [avant, vierge, await page(prof, `/prof/activites/${id}/apercu`)]) {
      for (const q of ["qc", "qm", "qt", "qr"]) sansCorrige(html, q, true);
      assert(!html.includes("opt-"), "les identifiants d'options restent sur le serveur");
    }
    assertStringIncludes(avant, "Aperçu de la page élève.");
    assertStringIncludes(avant, "quand il la remet");
    assertStringIncludes(avant, "disabled");
    assertStringIncludes(vierge, "4 questions.");
    assertStringIncludes(vierge, "Le corrigé s&#39;affiche quand tu remets la série.");
    // Les options suivent l'ordre mélangé de l'élève, lettrées dans cet ordre.
    const qc = contenu.questions[0] as Question & { options: Option[] };
    const ordre = optionsAffichees(qc, eleve.id);
    ordre.forEach((o, i) =>
      assert(
        new RegExp(`value="${lettre(i)}"[^>]*> ${lettre(i)}\\. ${o.texte.texte}<`).test(vierge),
      ),
    );

    // Un brouillon enregistré n'ouvre rien.
    const reponses = {
      qc: lettres(contenu.questions[0], eleve.id, "opt-juste-qc"),
      qm: lettres(contenu.questions[1], eleve.id, "opt-juste1-qm", "opt-juste2-qm"),
      qt: "accepte qt",
      qr: "Ma réponse rédigée.",
    };
    assertEquals(await statut(envoyer(eleve, `${url}/reponses`, reponses)), 303);
    const brouillon = await page(eleve, url);
    for (const q of ["qc", "qm", "qt", "qr"]) sansCorrige(brouillon, q, true);

    const r = await envoyer(eleve, `${url}/reponses`, { ...reponses, remettre: "1" });
    assertEquals(r.headers.get("location"), `${url}#bilan`);
    const corrige = await page(eleve, url);
    for (const s of [
      "RETOUR-qc",
      "RETOUR-qm",
      "RETOUR-qt",
      "RETOUR-qr",
      "ACCEPTE-qt",
      "ATTENDU-qr",
      "CRITERE1-qr",
      "CRITERE2-qr",
      "Bonne réponse",
      "revision=1#passage",
      "dans toute la façade",
      "Ma réponse rédigée.",
    ]) {
      assertStringIncludes(corrige, s);
    }
    assertStringIncludes(texte(section(corrige, "qc")), "Juste, 1 point.");
    assertStringIncludes(texte(section(corrige, "qm")), "Juste, 1 point.");
    assertStringIncludes(texte(section(corrige, "qt")), "Juste, 1 point.");
    assertStringIncludes(texte(section(corrige, "qr")), "pas encore noté");
    assertStringIncludes(corrige, "3 points sur 3. 1 réponse rédigée attend la note");
    // Une seule réponse acceptée est montrée. L'indice ne sert pas quand la série se corrige d'un coup.
    for (const s of ["VARIANTE-qt", "INDICE-"]) assert(!corrige.includes(s), s);
    // L'aperçu de l'enseignant reste celui d'un élève qui n'a pas répondu.
    sansCorrige(await page(prof, `/prof/activites/${id}/apercu`), "qr", true);
    // La tentative d'un élève n'ouvre pas le corrigé d'un camarade.
    const camarade = await compte(db, "eleve");
    sansCorrige(await page(camarade, url), "qc", true);
  } finally {
    await fermer(db, dir);
  }
});

test("question par question : l'indice après un essai faux, le corrigé quand la question est finie", async () => {
  const { db, dir, coursId, prof, eleve, passage } = await cadre();
  try {
    const contenu = serie("question", passage);
    const id = exercice(db, prof.compte, coursId, contenu);
    const avant = await page(prof, `/prof/activites/${id}/apercu`);
    assertStringIncludes(avant, "dès qu&#39;il l&#39;a finie");
    publie(db, prof.compte, id);
    const url = `/eleve/activites/${id}`;
    for (const html of [avant, await page(eleve, url)]) {
      for (const q of ["qc", "qm", "qt", "qr"]) sansCorrige(html, q, true);
    }
    const [qc, qm] = contenu.questions;
    const essai = (q: string, v: string | string[]) =>
      envoyer(eleve, `${url}/questions/${q}`, { [q]: v });

    // La position de chaque question, et l'avancement en haut de la série.
    assertStringIncludes(texte(avant), "Question 2 sur 4");
    assertStringIncludes(texte(avant), "0 faite sur 4");

    // Un essai faux : l'indice, rien du corrigé. La question n'est pas encore faite.
    assertEquals(await statut(essai("qc", lettres(qc, eleve.id, "opt-b-qc"))), 303);
    let html = await page(eleve, url);
    assertStringIncludes(
      section(html, "qc"),
      "Pas tout à fait. Indice : INDICE-qc Il te reste 1 essai.",
    );
    assertStringIncludes(texte(html), "0 faite sur 4");
    sansCorrige(html, "qc");
    for (const q of ["qm", "qt", "qr"]) sansCorrige(html, q, true);

    // Juste au deuxième essai : la question est finie, son corrigé sort, pas celui des autres.
    assertEquals(await statut(essai("qc", lettres(qc, eleve.id, "opt-juste-qc"))), 303);
    html = await page(eleve, url);
    const corrigeQc = section(html, "qc");
    for (const s of ["RETOUR-qc", "Bonne réponse", "revision=1#passage", "INDICE-qc"]) {
      assertStringIncludes(corrigeQc, s);
    }
    assertStringIncludes(texte(corrigeQc), "Juste au deuxième essai, 0,5 point.");
    assertStringIncludes(texte(html), "1 faite sur 4 Aller à la question 2");
    for (const q of ["qm", "qt", "qr"]) sansCorrige(html, q, true);
    assertEquals(await statut(essai("qc", lettres(qc, eleve.id, "opt-juste-qc"))), 409);

    assertEquals(
      await statut(essai("qm", lettres(qm, eleve.id, "opt-juste1-qm", "opt-juste2-qm"))),
      303,
    );
    assertEquals(await statut(essai("qt", "autre chose")), 303);
    assertEquals(await statut(essai("qt", "encore faux")), 303);
    assertEquals(await statut(essai("qr", "Ma réponse.")), 303);
    html = await page(eleve, url);
    assertStringIncludes(texte(section(html, "qm")), "Juste, 1 point.");
    const qt = section(html, "qt");
    assertStringIncludes(texte(qt), "Faux, 0 point.");
    assertStringIncludes(texte(qt), "Tes essais : « autre chose », puis « encore faux ».");
    assertStringIncludes(texte(qt), "Réponse attendue : ACCEPTE-qt");
    assert(!qt.includes("VARIANTE-qt"));
    for (const s of ["ATTENDU-qr", "CRITERE1-qr", "RETOUR-qr"]) assertStringIncludes(html, s);
    const t = tentative(db, eleve.compte, activiteProf(db, prof.compte, id)!)!;
    assert(t.rendue_le, "toutes les questions finies rendent la tentative");
    assertEquals(t.reponses.qt, { essais: ["autre chose", "encore faux"], finie: true });
    assertStringIncludes(html, "1,5 point sur 3. 1 réponse rédigée attend la note");
  } finally {
    await fermer(db, dir);
  }
});

test("série : enregistrer garde le brouillon, remettre avec un trou demande confirmation, puis plus rien ne change", async () => {
  const { db, dir, coursId, prof, eleve, passage } = await cadre();
  try {
    const contenu = serie("serie", passage);
    const id = exercice(db, prof.compte, coursId, contenu);
    publie(db, prof.compte, id);
    const url = `/eleve/activites/${id}`;
    const [qc, qm] = contenu.questions;
    const brouillon = {
      qc: lettres(qc, eleve.id, "opt-b-qc"),
      qm: lettres(qm, eleve.id, "opt-juste1-qm", "opt-c-qm"),
      qt: "céramique",
    };
    const r = await envoyer(eleve, `${url}/reponses`, brouillon);
    assertEquals(r.headers.get("location"), `${url}?enregistree#remise`);
    let html = await page(eleve, `${url}?enregistree`);
    assertStringIncludes(html, "Tes réponses sont enregistrées.");
    assertStringIncludes(html, `value="${brouillon.qc[0]}" checked`);
    for (const l of brouillon.qm) assertStringIncludes(html, `value="${l}" checked`);
    assertStringIncludes(html, 'value="céramique"');
    // Dans une série, une réponse enregistrée compte comme faite.
    assertStringIncludes(texte(html), "3 faites sur 4 Aller à la question 4");
    assert(!(await page(eleve, url)).includes("Tes réponses sont enregistrées."));

    // Remettre avec la réponse rédigée vide : le brouillon reste, la page demande confirmation.
    const remise = await envoyer(eleve, `${url}/reponses`, { ...brouillon, qt: "", remettre: "1" });
    assertEquals(remise.headers.get("location"), `${url}?confirmer#remise`);
    html = await page(eleve, `${url}?confirmer`);
    assertStringIncludes(html, "2 questions n&#39;ont pas de réponse et vaudront 0 point.");
    assertStringIncludes(html, "Remettre quand même");
    assertStringIncludes(html, 'name="confirmer"');
    const a = activiteProf(db, prof.compte, id)!;
    assertEquals(tentative(db, eleve.compte, a)!.rendue_le, null);
    assertEquals(tentative(db, eleve.compte, a)!.reponses.qt, { essais: [] });

    const confirmee = { ...brouillon, qt: "", remettre: "1", confirmer: "1" };
    assertEquals(await statut(envoyer(eleve, `${url}/reponses`, confirmee)), 303);
    html = await page(eleve, url);
    assertStringIncludes(texte(section(html, "qc")), "Faux, 0 point.");
    assertStringIncludes(texte(section(html, "qm")), "Faux, 0 point.");
    assertStringIncludes(texte(section(html, "qt")), "Pas de réponse, 0 point.");
    assertStringIncludes(texte(section(html, "qr")), "Pas de réponse.");
    assertStringIncludes(html, "Série remise le");
    assertStringIncludes(html, "0 point sur 4.");
    assert(!html.includes('action="/eleve/activites/' + id + '/reponses"'), "plus de formulaire");
    assertEquals(
      await statut(envoyer(eleve, `${url}/reponses`, { qt: "trop tard", remettre: "1" })),
      409,
    );
    assertEquals(
      await statut(envoyer(eleve, `${url}/questions/qt`, { qt: "trop tard" })),
      404,
      "une série se remet en entier",
    );
    assertEquals(tentative(db, eleve.compte, a)!.reponses.qt, { essais: [], finie: true });
  } finally {
    await fermer(db, dir);
  }
});

test("question par question : choix multiple, réponse à taper sans accents ni faute, saisie invalide", async () => {
  const { db, dir, coursId, prof, eleve } = await cadre();
  try {
    const multiple: Question = {
      id: "m",
      type: "choix_multiple",
      consigne: libre("Quels matériaux couvrent la façade ?"),
      retour: libre(""),
      indice: "Regarde le toit.",
      options: [
        { id: "x", texte: libre("La céramique"), juste: true },
        { id: "y", texte: libre("Le verre"), juste: true },
        { id: "z", texte: libre("Le béton"), juste: false },
      ],
    };
    const terme: Question = {
      id: "t",
      type: "terme",
      consigne: libre("De quoi la façade est-elle couverte ?"),
      retour: libre(""),
      accepte: ["Céramique irisée"],
    };
    const id = exercice(db, prof.compte, coursId, {
      correction: "question",
      questions: [multiple, terme],
    });
    publie(db, prof.compte, id);
    const url = `/eleve/activites/${id}`;
    const essai = (q: string, v: string | string[]) =>
      envoyer(eleve, `${url}/questions/${q}`, { [q]: v });

    const r = await essai("m", []);
    assertEquals(r.status, 400);
    assertEquals(await r.text(), "Coche au moins une option.");
    assertEquals(await statut(essai("m", ["Q"])), 400, "une lettre qui n'est pas affichée");
    assertEquals(await statut(essai("m", lettres(multiple, eleve.id, "x"))), 303);
    let html = await page(eleve, url);
    assertStringIncludes(html, "Pas tout à fait. Indice : Regarde le toit.");
    // L'essai faux reste coché pour être corrigé.
    assertStringIncludes(html, `value="${lettres(multiple, eleve.id, "x")[0]}" checked`);
    assertEquals(await statut(essai("m", lettres(multiple, eleve.id, "y", "x"))), 303);
    html = await page(eleve, url);
    assertStringIncludes(texte(section(html, "m")), "Juste au deuxième essai, 0,5 point.");
    const [x, y] = lettres(multiple, eleve.id, "x", "y").sort();
    assertStringIncludes(
      section(html, "m"),
      `Tes essais : ${lettres(multiple, eleve.id, "x")[0]}, puis ${x}, ${y}.`,
    );

    assertEquals(await statut(essai("t", "ceramiqe irisee")), 303);
    html = await page(eleve, url);
    assertStringIncludes(texte(section(html, "t")), "Juste, 1 point.");
    assertStringIncludes(texte(section(html, "t")), "Réponse attendue : Céramique irisée");
    assertStringIncludes(html, "1,5 point sur 2.");
  } finally {
    await fermer(db, dir);
  }
});

test("version périmée : la réponse reçoit 409, rien n'est enregistré et le texte reste dans son champ", async () => {
  const { db, dir, coursId, prof, eleve, passage } = await cadre();
  try {
    const contenu = serie("serie", passage);
    const id = exercice(db, prof.compte, coursId, contenu);
    publie(db, prof.compte, id);
    const url = `/eleve/activites/${id}`;
    assertStringIncludes(await page(eleve, url), 'name="revision" value="1"');
    // L'enseignant publie la version 2 pendant que l'élève lit la version 1.
    const [qc, ...reste] = contenu.questions;
    assert(qc.type === "choix");
    await nouvelleVersion(db, prof.compte, id, {
      ...contenu,
      questions: [{ ...qc, options: qc.options.toReversed() }, ...reste],
    });
    const lue = {
      qc: lettres(qc, eleve.id, "opt-b-qc"),
      qt: "mon terme",
      qr: "Mon long texte\r\nsur deux lignes",
      remettre: "1",
      confirmer: "1",
    };
    // La version 1, puis un formulaire sans version.
    for (const corps of [lue, { ...lue, revision: [] }]) {
      const r = await envoyer(eleve, `${url}/reponses`, corps);
      assertEquals(r.status, 409);
      const html = await r.text();
      assertStringIncludes(html, "Cette série a changé pendant que tu répondais");
      assertStringIncludes(html, 'value="mon terme"');
      assertStringIncludes(html, "Mon long texte\nsur deux lignes</textarea>");
      assert(!html.includes("checked"), "un choix lu sur l'ancienne version n'est pas repris");
      assertStringIncludes(html, 'name="revision" value="2"');
      for (const q of ["qc", "qm", "qt", "qr"]) sansCorrige(html, q, true);
    }
    assertEquals(db.prepare("SELECT count(*) AS n FROM tentatives").get()!.n, 0);
    assertEquals(await statut(envoyer(eleve, `${url}/reponses`, { ...lue, revision: "2" })), 303);

    // Une question corrigée seule porte aussi sa version.
    const pas = serie("question", passage);
    const id2 = exercice(db, prof.compte, coursId, pas, "Question par question");
    publie(db, prof.compte, id2);
    assertStringIncludes(
      section(await page(eleve, `/eleve/activites/${id2}`), "qt"),
      'name="revision" value="1"',
    );
    await nouvelleVersion(db, prof.compte, id2, {
      ...pas,
      questions: pas.questions.map((q) =>
        q.id === "qt" ? { ...q, consigne: libre("CONSIGNE-qt corrigée") } : q,
      ),
    });
    const r = await envoyer(eleve, `/eleve/activites/${id2}/questions/qt`, { qt: "accepte qt" });
    assertEquals(r.status, 409);
    const html = await r.text();
    assertStringIncludes(html, "Cette série a changé pendant que tu répondais");
    assertStringIncludes(html, 'value="accepte qt"');
    sansCorrige(html, "qt", true);
    assertEquals(
      db.prepare("SELECT count(*) AS n FROM tentatives WHERE activite_id = ?").get(id2)!.n,
      0,
    );
  } finally {
    await fermer(db, dir);
  }
});

test("nouvelle version : l'élève retrouve sa remise, sa note et le commentaire, avec la version à laquelle il répondait", async () => {
  const { db, dir, coursId, prof, eleve, passage } = await cadre();
  try {
    const contenu = serie("serie", passage);
    const id = exercice(db, prof.compte, coursId, contenu);
    const v1 = publie(db, prof.compte, id);
    const url = `/eleve/activites/${id}`;
    const [qc, qm, qt, qr] = contenu.questions;
    const reponses = {
      qc: lettres(qc, eleve.id, "opt-juste-qc"),
      qm: lettres(qm, eleve.id, "opt-juste1-qm", "opt-juste2-qm"),
      qt: "accepte qt",
      qr: "Ma réponse rédigée.",
    };
    assertEquals(
      await statut(envoyer(eleve, `${url}/reponses`, { ...reponses, remettre: "1" })),
      303,
    );
    // Un camarade s'arrête au brouillon.
    const camarade = await compte(db, "eleve");
    assertEquals(await statut(envoyer(camarade, `${url}/reponses`, { qt: "brouillon" })), 303);
    const t = tentative(db, eleve.compte, v1)!;
    assert(noter(db, prof.compte, v1, t.id, "qm", 0, "COMMENTAIRE-qm"));

    // Version 2 : une faute corrigée dans qt, qm retirée, une question ajoutée.
    const ajoutee: Question = {
      id: "qn",
      type: "terme",
      consigne: libre("CONSIGNE-qn"),
      retour: libre("RETOUR-qn"),
      accepte: ["ACCEPTE-qn"],
    };
    const v2 = await nouvelleVersion(db, prof.compte, id, {
      ...contenu,
      questions: [qc, { ...qt, consigne: libre("CONSIGNE-qt corrigée") }, qr, ajoutee],
    });
    assert(noter(db, prof.compte, v2, t.id, "qr", 0.5, "COMMENTAIRE-qr"));

    const html = await page(eleve, url);
    assertStringIncludes(html, "Série remise le");
    assertStringIncludes(texte(html), "Tu répondais à la version 1 de cette série");
    assertStringIncludes(texte(section(html, "qr")), "Note de ton enseignant : 0,5 point.");
    for (const s of ["COMMENTAIRE-qr", "COMMENTAIRE-qm", "RETOUR-qc", "ACCEPTE-qt"]) {
      assertStringIncludes(html, s);
    }
    // qc et qt justes, qr notée 0,5. La question ajoutée n'a pas été posée : elle ne compte pas.
    assertStringIncludes(html, "2,5 points sur 3.");
    // Rien de la question ajoutée ne sort, et elle n'a pas de champ.
    for (const s of ["RETOUR-qn", "ACCEPTE-qn", 'name="qn"']) assert(!html.includes(s), s);
    assertStringIncludes(texte(section(html, "qn")), "pas dans la version que tu as remise");
    assertEquals(avecAvancement(db, eleve.compte, [v2])[0].avancement, "retour");
    assertEquals(
      await statut(envoyer(eleve, `${url}/reponses`, { qn: "accepte qn", revision: "2" })),
      409,
      "une série remise ne se rouvre pas sans l'enseignant",
    );

    // Le brouillon du camarade répondait à la version 1 : il repart d'une série vierge.
    const vierge = await page(camarade, url);
    assert(!vierge.includes('value="brouillon"'));
    assertEquals(avecAvancement(db, camarade.compte, [v2])[0].avancement, "a_faire");

    // À reprendre : l'élève recommence sur la version actuelle.
    assert(aReprendre(db, prof.compte, v2, t.id, true));
    assertEquals(await statut(envoyer(eleve, `${url}/recommencer`)), 303);
    assertEquals(tentative(db, eleve.compte, v2)!.revision, 2);
    const reprise = await page(eleve, url);
    assertStringIncludes(reprise, 'name="qn"');
    for (const q of ["qc", "qt", "qr"]) sansCorrige(reprise, q, true);
  } finally {
    await fermer(db, dir);
  }
});

test("réponse refusée : le texte déjà enregistré reste, la page le dit et garde la saisie", async () => {
  const { db, dir, coursId, prof, eleve, passage } = await cadre();
  try {
    const id = exercice(db, prof.compte, coursId, serie("serie", passage));
    const a = publie(db, prof.compte, id);
    const url = `/eleve/activites/${id}`;
    // 3 990 caractères sur 20 lignes : le navigateur les envoie avec des fins de ligne CRLF.
    const lignes = Array.from({ length: 20 }, (_, i) => "x".repeat(i ? 199 : 190));
    assertEquals(lignes.join("\n").length, 3990);
    assertEquals(await statut(envoyer(eleve, `${url}/reponses`, { qr: lignes.join("\r\n") })), 303);
    assertEquals(tentative(db, eleve.compte, a)!.reponses.qr.essais, [lignes.join("\n")]);

    const trop = "y".repeat(4001);
    const refusees: Record<string, string>[] = [
      { qr: trop, qt: "accepte qt" },
      { qr: trop, qt: "accepte qt", remettre: "1", confirmer: "1" },
    ];
    for (const corps of refusees) {
      const r = await envoyer(eleve, `${url}/reponses`, corps);
      assertEquals(r.status, 400);
      const html = await r.text();
      assertStringIncludes(html, "La réponse à la question 4 n&#39;est pas enregistrée");
      assertStringIncludes(html, `${trop}</textarea>`);
      assert(!html.includes("Tes réponses sont enregistrées."));
      for (const q of ["qc", "qm", "qt", "qr"]) sansCorrige(html, q, true);
      const t = tentative(db, eleve.compte, a)!;
      assertEquals(t.reponses.qr.essais, [lignes.join("\n")], "le texte précédent reste");
      assertEquals(t.reponses.qt.essais, ["accepte qt"], "les autres réponses s'enregistrent");
      assertEquals(t.rendue_le, null, "une série ne se remet pas avec une réponse refusée");
    }
  } finally {
    await fermer(db, dir);
  }
});

test("critères : l'élève les coche après le corrigé seulement, sur sa propre tentative", async () => {
  const { db, dir, coursId, prof, eleve, passage } = await cadre();
  try {
    const id = exercice(db, prof.compte, coursId, serie("serie", passage));
    publie(db, prof.compte, id);
    const url = `/eleve/activites/${id}`;
    const cocher = (s: Session, t: string, criteres: string[]) =>
      envoyer(s, `${url}/tentatives/${t}/criteres/qr`, { criteres });
    assertEquals(await statut(cocher(eleve, "inconnue", ["0"])), 404);
    await envoyer(eleve, `${url}/reponses`, { qr: "Brouillon." });
    const a = activiteProf(db, prof.compte, id)!;
    const t = tentative(db, eleve.compte, a)!.id;
    assertEquals(await statut(cocher(eleve, t, ["0"])), 404, "avant la remise");

    await envoyer(eleve, `${url}/reponses`, { qr: "Ma réponse.", remettre: "1", confirmer: "1" });
    assertEquals(await statut(cocher(eleve, t, ["1", "7"])), 303);
    assertEquals(tentative(db, eleve.compte, a)!.reponses.qr.criteres, [1]);
    assertStringIncludes(await page(eleve, url), "Tu as coché 1 critère sur 2.");
    assertEquals(
      await statut(envoyer(eleve, `${url}/tentatives/${t}/criteres/qc`, { criteres: "0" })),
      404,
    );
    const camarade = await compte(db, "eleve");
    assertEquals(await statut(cocher(camarade, t, ["0"])), 404);
  } finally {
    await fermer(db, dir);
  }
});

test("recommencer : refusé tant que l'enseignant n'a pas marqué la tentative à reprendre", async () => {
  const { db, dir, coursId, prof, eleve, passage } = await cadre();
  try {
    const id = exercice(db, prof.compte, coursId, serie("serie", passage));
    publie(db, prof.compte, id);
    const url = `/eleve/activites/${id}`;
    assertEquals(await statut(envoyer(eleve, `${url}/recommencer`)), 409, "sans tentative");
    await envoyer(eleve, `${url}/reponses`, { qt: "accepte qt", remettre: "1", confirmer: "1" });
    assertEquals(
      await statut(envoyer(eleve, `${url}/recommencer`)),
      409,
      "rendue, pas à reprendre",
    );
    assert(!(await page(eleve, url)).includes("Recommencer"));

    const a = activiteProf(db, prof.compte, id)!;
    const t = tentative(db, eleve.compte, a)!;
    assert(aReprendre(db, prof.compte, a, t.id, true));
    assertStringIncludes(
      await page(eleve, url),
      "Ton enseignant te propose de reprendre cette série.",
    );
    assertEquals(await statut(envoyer(eleve, `${url}/recommencer`)), 303);
    const neuve = tentative(db, eleve.compte, a)!;
    assert(neuve.id !== t.id && !neuve.rendue_le);
    const html = await page(eleve, url);
    sansCorrige(html, "qt", true);
    assertStringIncludes(html, `action="/eleve/activites/${id}/reponses"`);
  } finally {
    await fermer(db, dir);
  }
});

test("image déposée : l'enseignant du cours et l'élève qui reçoit l'activité, personne d'autre", async () => {
  const { db, dir, coursId, prof, eleve } = await cadre();
  try {
    const contenu: Contenu = {
      correction: "serie",
      questions: [
        {
          id: "q1",
          type: "terme",
          consigne: libre("Quel matériau ?"),
          retour: libre(""),
          accepte: ["céramique"],
        },
      ],
    };
    const id = exercice(db, prof.compte, coursId, contenu);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const fichier = await deposerImage(id, png);
    const autre = await deposerImage(id, png);
    contenu.questions[0].image = { fichier, alt: "La façade" };
    db.prepare("UPDATE activites SET contenu = ? WHERE id = ?").run(JSON.stringify(contenu), id);
    const url = `/activites/${id}/images/${fichier}`;

    const r = await prof.requete(url);
    assertEquals(r.status, 200);
    assertEquals(r.headers.get("content-type"), "image/png");
    assertEquals(r.headers.get("cache-control"), "private, no-cache");
    assertEquals(r.headers.get("x-content-type-options"), "nosniff");
    assertEquals(new Uint8Array(await r.arrayBuffer()), png);
    assertStringIncludes(await page(prof, `/prof/activites/${id}/apercu`), `src="${url}"`);
    assertEquals(await statut(eleve.requete(url)), 404, "brouillon");

    publie(db, prof.compte, id);
    assertEquals(await statut(eleve.requete(url)), 200);
    assertStringIncludes(await page(eleve, `/eleve/activites/${id}`), `alt="La façade"`);
    assertEquals(
      await statut(eleve.requete(`/activites/${id}/images/${autre}`)),
      404,
      "pas dans la série",
    );
    assertEquals(await statut(prof.requete(`/activites/${id}/images/${autre}`)), 200);
    const inconnue = `/activites/${id}/images/${crypto.randomUUID()}.png`;
    assertEquals(await statut(prof.requete(inconnue)), 404);
    assertEquals(await statut(prof.requete(`/activites/${id}/images/..%2Fstate.sqlite3`)), 404);
    const dehors = await compte(db, "eleve", false);
    const etranger = await compte(db, "enseignant", false);
    assertEquals(await statut(dehors.requete(url)), 404);
    assertEquals(await statut(etranger.requete(url)), 404);
  } finally {
    await fermer(db, dir);
  }
});

test("plusieurs cours : l'élève d'un cours ajouté reçoit l'activité, celui d'un autre cours non", async () => {
  const { db, dir, coursId, prof, eleve } = await cadre();
  try {
    const contenu: Contenu = {
      correction: "serie",
      questions: [
        { id: "q1", type: "terme", consigne: libre("Q ?"), retour: libre(""), accepte: ["r"] },
      ],
    };
    const id = exercice(db, prof.compte, coursId, contenu);
    const a = publie(db, prof.compte, id);
    const m = matiere(db, "Histoire");
    const [deuxieme, troisieme] = [cours(db, m, "Histoire de l'art"), cours(db, m, "Patrimoine")];
    db.prepare("INSERT INTO membres_cours VALUES (?, ?)").run(deuxieme, prof.id);
    const e2 = await compte(db, "eleve", false);
    const e3 = await compte(db, "eleve", false);
    db.prepare("INSERT INTO membres_cours VALUES (?, ?)").run(deuxieme, e2.id);
    db.prepare("INSERT INTO membres_cours VALUES (?, ?)").run(troisieme, e3.id);
    const url = `/eleve/activites/${id}`;
    assertEquals(await statut(e2.requete(url)), 404);

    assertEquals(ajouterCours(db, prof.compte, a, deuxieme), []);
    const html = await page(e2, url);
    assertStringIncludes(html, `<a href="/eleve?cours_id=${deuxieme}">Histoire de l&#39;art</a>`);
    assertStringIncludes(await page(eleve, url), `<a href="/eleve?cours_id=${coursId}">Design</a>`);
    assertEquals(await statut(e3.requete(url)), 404);
    assertEquals(await statut(envoyer(e3, `${url}/reponses`, { q1: "r" })), 404);
    assertEquals(await statut(envoyer(e2, `${url}/reponses`, { q1: "r", remettre: "1" })), 303);
  } finally {
    await fermer(db, dir);
  }
});

test("lecteur : Précédente et Suivante restent dans le cours de la ressource", async () => {
  const { db, dir, coursId, eleve } = await cadre();
  try {
    const histoire = cours(db, matiere(db, "Histoire"), "Histoire");
    db.prepare("INSERT INTO membres_cours VALUES (?, ?)").run(histoire, eleve.id);
    const parc = await publierSource(db, "Parc Güell", coursId);
    await publierSource(db, "Bauhaus", histoire);
    const lecture = await page(eleve, `/eleve/sources/${parc}`);
    assertStringIncludes(lecture, `<a href="/eleve?cours_id=${coursId}">Design</a>`);
    assertStringIncludes(lecture, "<span>Précédente</span>Casa Batlló");
    assert(!lecture.includes("Bauhaus"), "une ressource d'un autre cours n'est pas voisine");
  } finally {
    await fermer(db, dir);
  }
});

test("accueil de l'élève : l'activité suit les ressources de son cours, avec son titre et où il en est", async () => {
  const { db, dir, coursId, prof, eleve } = await cadre();
  try {
    const histoire = cours(db, matiere(db, "Histoire"), "Histoire");
    db.prepare("INSERT INTO membres_cours VALUES (?, ?)").run(histoire, eleve.id);
    await publierSource(db, "Source d'histoire", histoire);
    const contenu: Contenu = {
      correction: "serie",
      questions: [
        {
          id: "q1",
          type: "redigee",
          consigne: libre("Q ?"),
          retour: libre(""),
          attendu: libre("R."),
          criteres: [],
        },
      ],
    };
    const id = exercice(db, prof.compte, coursId, contenu, "Titre propre de la série");
    const a = publie(db, prof.compte, id);
    regler(db, a, "Titre propre de la série", "2026-12-01");

    // L'accueil liste les cours et compte les activités à faire. Le sommaire du cours les montre.
    const design = async () => {
      const accueil = await page(eleve, "/eleve");
      const [debut, fin] = [
        accueil.indexOf(`<a href="/eleve?cours_id=${coursId}">Design</a>`),
        accueil.indexOf(`<a href="/eleve?cours_id=${histoire}">Histoire</a>`),
      ];
      assert(debut >= 0 && fin > debut, "deux cours, Design d'abord");
      const sommaire = await page(eleve, `/eleve?cours_id=${coursId}`);
      assertEquals(sommaire.split(`/eleve/activites/${id}`).length - 1, 1, "une seule fois");
      return { ligne: accueil.slice(debut, fin), sommaire };
    };
    const { ligne, sommaire: liste } = await design();
    assertStringIncludes(ligne, '<span class="chiffres">1</span> à faire');
    assertStringIncludes(liste, `<a href="/eleve/activites/${id}">Titre propre de la série</a>`);
    assertStringIncludes(liste, '<span class="chiffres">1</span> question');
    assert(!liste.includes("Lire la façade de la Casa Batlló"), "le titre remplace l'objectif");
    assertStringIncludes(liste, "À faire");

    const url = `/eleve/activites/${id}`;
    const pratique = await page(eleve, url);
    assertStringIncludes(pratique, "<h1>Titre propre de la série</h1>");
    assertStringIncludes(pratique, "1 question. À rendre le 1 décembre 2026.");
    await envoyer(eleve, `${url}/reponses`, { q1: "Brouillon" });
    const enCours = await design();
    assertStringIncludes(enCours.sommaire, "En cours");
    assert(!enCours.ligne.includes("à faire"), "une activité commencée n'est plus à faire");
    await envoyer(eleve, `${url}/reponses`, { q1: "Ma réponse", remettre: "1" });
    assertStringIncludes((await design()).sommaire, "Remise");
    const t = tentative(db, eleve.compte, a)!;
    assert(noter(db, prof.compte, a, t.id, "q1", 1, "Bien vu."));
    assertStringIncludes((await design()).sommaire, "Retour reçu");
    const corrige = await page(eleve, url);
    assertStringIncludes(corrige, "Note de ton enseignant : 1 point.");
    assertStringIncludes(corrige, "Bien vu.");
    assertStringIncludes(corrige, "1 point sur 1.");
    // Le périmètre d'un autre cours ne montre pas l'activité.
    assert(!(await page(eleve, `/eleve?cours_id=${histoire}`)).includes(`/eleve/activites/${id}`));
  } finally {
    await fermer(db, dir);
  }
});

test("lecteur : « S'entraîner » liste les activités qui citent la ressource, la montrent ou y renvoient", async () => {
  const { db, dir, coursId, source, prof, eleve, passage } = await cadre();
  try {
    const seconde = await publierSource(db, "Casa Milà", coursId);
    const seule = await publierSource(db, "Parc Güell", coursId);
    const q = (id: string, extra: Partial<Question>): Question =>
      ({
        id,
        type: "terme",
        consigne: libre("Q ?"),
        retour: libre(""),
        accepte: ["r"],
        ...extra,
      }) as Question;
    const cite = exercice(
      db,
      prof.compte,
      coursId,
      {
        correction: "serie",
        questions: [q("a", { retour: { texte: "R", citations: [passage] } })],
      },
      "Série qui cite",
    );
    const renvoie = exercice(
      db,
      prof.compte,
      coursId,
      { correction: "serie", questions: [q("b", { ou: seconde })] },
      "Série qui renvoie",
    );
    const montre = exercice(
      db,
      prof.compte,
      coursId,
      {
        correction: "serie",
        questions: [q("c", { image: { media: "x", source: seconde, alt: "Image" } })],
      },
      "Série qui montre",
    );
    exercice(
      db,
      prof.compte,
      coursId,
      { correction: "serie", questions: [q("d", { ou: seule })] },
      "Brouillon",
    );
    for (const id of [cite, renvoie, montre]) publie(db, prof.compte, id);

    const premiere = await page(eleve, `/eleve/sources/${source}`);
    assertStringIncludes(premiere, "S'entraîner");
    assertStringIncludes(premiere, `<a href="/eleve/activites/${cite}">Série qui cite</a>`);
    assertStringIncludes(premiere, "À faire");
    assert(!premiere.includes(renvoie) && !premiere.includes(montre));
    const suite = premiere.indexOf('class="suite-lecture"');
    if (suite >= 0) assert(premiere.indexOf("S'entraîner") < suite, "avant la ressource suivante");

    const autre = await page(eleve, `/eleve/sources/${seconde}`);
    for (const id of [renvoie, montre]) assertStringIncludes(autre, `/eleve/activites/${id}`);
    assert(!autre.includes(cite));
    assertStringIncludes(
      await page(eleve, `/eleve/activites/${renvoie}`),
      `Où chercher : <a href="/eleve/sources/${seconde}">Casa Milà</a>`,
    );
    assert(
      !(await page(eleve, `/eleve/sources/${seule}`)).includes("S'entraîner"),
      "un brouillon ne compte pas",
    );

    await envoyer(eleve, `/eleve/activites/${cite}/reponses`, { a: "r", remettre: "1" });
    assertStringIncludes(await page(eleve, `/eleve/sources/${source}`), "Remise");
  } finally {
    await fermer(db, dir);
  }
});

test("exercice personnel : la page dit que Thot l'a généré et que personne d'autre ne l'a relu", async () => {
  const { db, dir, coursId, prof } = await cadre(true);
  try {
    const contenu: Contenu = {
      correction: "question",
      questions: [
        { id: "q1", type: "terme", consigne: libre("Q ?"), retour: libre(""), accepte: ["r"] },
      ],
    };
    const id = exercice(db, prof.compte, coursId, contenu);
    publie(db, prof.compte, id);
    const pratique = await page(prof, `/eleve/activites/${id}`);
    assertStringIncludes(pratique, "Exercice généré par Thot à partir de tes documents.");
    assertStringIncludes(pratique, "Personne d&#39;autre que toi ne l&#39;a relu.");
    assert(!pratique.includes("relu par"));
    const autre = await compte(db, "enseignant");
    assertEquals(await statut(autre.requete(`/eleve/activites/${id}`)), 404);
  } finally {
    await fermer(db, dir);
  }
});

test("explication : elle se lit sans tentative, avec la feuille de ses passages", async () => {
  const { db, dir, coursId, prof, eleve, passage } = await cadre();
  try {
    const id = inserer(db, prof.compte, {
      type: "explication",
      coursId,
      objectifId: "",
      intitule: "Comprendre la façade",
      reference: "",
      contenu: { affirmations: [{ ...passage, texte: "Gaudí refuse la ligne droite." }] },
    });
    publie(db, prof.compte, id);
    const html = await page(eleve, `/eleve/activites/${id}`);
    assertStringIncludes(html, "Gaudí refuse la ligne droite.");
    assertStringIncludes(html, "Explication préparée par");
    assertEquals(await statut(eleve.requete(`/eleve/activites/${id}/citations/0`)), 200);
    assertEquals(await statut(prof.requete(`/prof/activites/${id}/citations/0`)), 200);
    assertEquals(await statut(envoyer(eleve, `/eleve/activites/${id}/reponses`, {})), 404);
  } finally {
    await fermer(db, dir);
  }
});
