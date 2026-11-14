import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  activiteProf,
  type Activite,
  cocher,
  enregistrer,
  enregistrerReponses,
  inserer,
  publier,
  relire,
  tentativesLues,
} from "../src/app/activites.ts";
import { creerCompte, lireCompte, type Role } from "../src/app/comptes.ts";
import type { Db } from "../src/app/db.ts";
import { cours, matiere } from "../src/app/domaines.ts";
import { creerApp } from "../src/app/routes.ts";
import type { Champ, Contenu, Question } from "../src/core/activite.ts";
import { environnement, fauxModeles, ORIGINE } from "./outils.ts";

const libre = (texte: string): Champ => ({ texte, citations: [] });

async function compte(db: Db, role: Role, nom: string, ...coursIds: string[]) {
  const identifiant = `${role}-${crypto.randomUUID().slice(0, 6)}`;
  const mot_de_passe = await creerCompte(db, identifiant, nom, role);
  const id = db.prepare("SELECT id FROM comptes WHERE identifiant = ?").get(identifiant)!
    .id as string;
  for (const c of coursIds) db.prepare("INSERT INTO membres_cours VALUES (?, ?)").run(c, id);
  return { ...lireCompte(db, id)!, identifiant, mot_de_passe };
}
type Compte = Awaited<ReturnType<typeof compte>>;

/** Un enseignant connecté, avec de quoi lire une page et envoyer un formulaire. */
async function connecter(db: Db, c: Compte) {
  const app = creerApp(db, fauxModeles().modeles);
  const r = await app.request("/connexion", {
    method: "POST",
    headers: { origin: ORIGINE },
    body: new URLSearchParams({ identifiant: c.identifiant, mot_de_passe: c.mot_de_passe }),
  });
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const requete = (chemin: string, init: RequestInit = {}) =>
    app.request(chemin, { ...init, headers: { cookie, origin: ORIGINE } });
  return {
    lire: (chemin: string) => requete(chemin),
    envoyer: (chemin: string, corps: Record<string, string>) =>
      requete(chemin, { method: "POST", body: new URLSearchParams(corps) }),
  };
}

const choix: Question = {
  id: "q1",
  type: "choix",
  consigne: libre("Que refuse Gaudí ?"),
  retour: libre("La ligne droite."),
  options: [
    { id: "A", texte: libre("La ligne droite"), juste: true },
    { id: "B", texte: libre("La couleur"), juste: false },
    { id: "C", texte: libre("La céramique"), juste: false },
  ],
};
const terme: Question = {
  id: "q2",
  type: "terme",
  consigne: libre("Quel architecte a bâti la Casa Batlló ?"),
  retour: libre(""),
  accepte: ["Gaudí"],
};
const redigee: Question = {
  id: "q3",
  type: "redigee",
  consigne: libre("Décris la façade."),
  attendu: libre("Céramique irisée."),
  criteres: [libre("Nomme la céramique."), libre("Parle de la couleur.")],
  retour: libre(""),
  langage: undefined,
};

/** Trois cours, un enseignant des deux premiers, un du deuxième, un d'un autre cours, trois élèves. */
async function cadre() {
  const { db } = await environnement();
  const m = matiere(db, "Arts appliqués");
  const [c1, c2, c3] = ["Design", "Histoire de l'art", "Dessin"].map((n) => cours(db, m, n));
  const prof = await compte(db, "enseignant", "Prof", c1, c2);
  const prof2 = await compte(db, "enseignant", "Prof 2", c2);
  const etranger = await compte(db, "enseignant", "Étranger", c3);
  const e1 = await compte(db, "eleve", "Alice", c1);
  const e1b = await compte(db, "eleve", "Bob", c1);
  const e2 = await compte(db, "eleve", "Chloé", c2);
  return { db, c1, c2, prof, prof2, etranger, e1, e1b, e2 };
}

function serie(db: Db, prof: Compte, coursId: string, questions: Question[]) {
  const id = inserer(db, prof, {
    type: "exercice",
    coursId,
    objectifId: "",
    intitule: "Lire une façade",
    reference: "",
    contenu: { correction: "serie", questions },
  });
  const a = activiteProf(db, prof, id)!;
  assert(relire(db, prof, a, a.revision));
  assertEquals(publier(db, prof, id, a.revision), "publiee");
  return activiteProf(db, prof, id)!;
}

const lireTentative = (db: Db, id: string) =>
  db.prepare("SELECT retours, a_reprendre FROM tentatives WHERE id = ?").get(id) as {
    retours: string;
    a_reprendre: number;
  };

test("grille : l'enseignant du cours lit les élèves qui ont remis et ceux qui n'ont rien remis", async () => {
  const { db, c1, prof, e1 } = await cadre();
  const a = serie(db, prof, c1, [choix, terme, redigee]);
  enregistrerReponses(db, e1, a, { q1: "A", q2: "Gropius", q3: "Une céramique bleue" }, true);
  const t = tentativesLues(db, prof, a)![0];
  assert(cocher(db, e1, a, t.id, "q3", [0]));

  const s = await connecter(db, prof);
  const r = await s.lire(`/prof/activites/${a.id}/reponses`);
  assertEquals(r.status, 200);
  const page = await r.text();
  assertStringIncludes(page, "2 élèves suivis. 1 remise.");
  assertStringIncludes(page, "1 réponse rédigée à noter");
  assertStringIncludes(page, "ce qui a été pratiqué, pas un niveau");
  assertStringIncludes(page, '<th scope="row">Alice</th>');
  assertStringIncludes(page, "Remise le ");
  assertStringIncludes(page, "Rien remis");
  assertStringIncludes(page, "1 / 3");
  assertStringIncludes(page, '<td class="case s-ok">1</td>');
  assertStringIncludes(page, `<td class="case s-ko"><a href="#r-${t.id}-q2">0</a></td>`);
  assertStringIncludes(
    page,
    `<td class="case s-attente"><a href="#r-${t.id}-q3" title="À noter">?</a></td>`,
  );
  // Le taux de réussite : 100 % au choix, 0 % au terme, rien pour la réponse rédigée.
  assertStringIncludes(
    page,
    '<td class="case">100 %</td><td class="case">0 %</td><td class="case"></td>',
  );
  // La réponse rédigée avec le critère coché, la réponse refusée avec ses réponses acceptées.
  assertStringIncludes(page, "Une céramique bleue");
  assertStringIncludes(page, "Critères cochés par l'élève : Nomme la céramique.");
  assertStringIncludes(page, "Réponses acceptées : Gaudí");
  assertStringIncludes(page, "Gropius");
  // Le premier choix de chaque élève : une seule voix, sur la bonne option.
  assertStringIncludes(page, '<li class="juste">');
  assertStringIncludes(page, '<span style="width: 100%"></span>');
  assertStringIncludes(page, "100 % de réussite");
  db.close();
});

test("accès : un enseignant hors des cours de l'activité reçoit 404, comme pour une explication", async () => {
  const { db, c1, prof, etranger, e1 } = await cadre();
  const a = serie(db, prof, c1, [choix]);
  enregistrerReponses(db, e1, a, { q1: "A" }, true);
  const t = tentativesLues(db, prof, a)![0];

  const s = await connecter(db, etranger);
  for (const chemin of [
    `/prof/activites/${a.id}/reponses`,
    `/prof/activites/${a.id}/reponses.csv`,
  ]) {
    assertEquals((await s.lire(chemin)).status, 404);
  }
  const post = await s.envoyer(`/prof/activites/${a.id}/reponses/${t.id}/q1`, { note: "1" });
  assertEquals(post.status, 404);
  assertEquals(
    (await s.envoyer(`/prof/activites/${a.id}/reponses/${t.id}/reprendre`, { oui: "1" })).status,
    404,
  );
  assertEquals(lireTentative(db, t.id).a_reprendre, 0);

  const id = inserer(db, prof, {
    type: "explication",
    coursId: c1,
    objectifId: "",
    intitule: "Une explication",
    reference: "",
    contenu: { affirmations: [] },
  });
  assertEquals(
    (await (await connecter(db, prof)).lire(`/prof/activites/${id}/reponses`)).status,
    404,
  );
  db.close();
});

test("plusieurs cours : l'enseignant du cours 2 ne voit que les élèves du cours 2, grille et CSV", async () => {
  const { db, c1, c2, prof, prof2, e1, e1b, e2 } = await cadre();
  const a = serie(db, prof, c1, [choix]);
  db.prepare("INSERT INTO activite_cours VALUES (?, ?)").run(a.id, c2);
  enregistrerReponses(db, e1, a, { q1: "A" }, true);
  enregistrerReponses(db, e2, a, { q1: "B" }, true);

  const tous = await (await connecter(db, prof)).lire(`/prof/activites/${a.id}/reponses`);
  const page = await tous.text();
  for (const nom of ["Alice", "Bob", "Chloé"]) assertStringIncludes(page, `>${nom}</th>`);
  assert(e1b.id);

  const s2 = await connecter(db, prof2);
  const seul = await (await s2.lire(`/prof/activites/${a.id}/reponses`)).text();
  assertStringIncludes(seul, ">Chloé</th>");
  assert(!seul.includes("Alice") && !seul.includes("Bob"));
  const csv = await (await s2.lire(`/prof/activites/${a.id}/reponses.csv`)).text();
  assertStringIncludes(csv, "Chloé");
  assert(!csv.includes("Alice") && !csv.includes("Bob"));
  db.close();
});

test("notes : 0,5 et un commentaire se gardent, recliquer la note l'enlève et garde le commentaire", async () => {
  const { db, c1, prof, e1 } = await cadre();
  const a = serie(db, prof, c1, [redigee]);
  enregistrerReponses(db, e1, a, { q3: "Une céramique irisée" }, true);
  const t = tentativesLues(db, prof, a)![0];
  const s = await connecter(db, prof);
  const url = `/prof/activites/${a.id}/reponses/${t.id}/q3`;
  const ancre = `/prof/activites/${a.id}/reponses#r-${t.id}-q3`;

  const r = await s.envoyer(url, { note: "0.5", commentaire: "Il manque la couleur." });
  assertEquals(r.status, 303);
  assertEquals(r.headers.get("location"), ancre);
  assertEquals(JSON.parse(lireTentative(db, t.id).retours), {
    q3: { note: 0.5, commentaire: "Il manque la couleur." },
  });
  const page = await (await s.lire(`/prof/activites/${a.id}/reponses`)).text();
  assertStringIncludes(page, '<td class="case s-half"><a href="#');
  assertStringIncludes(page, 'name="note" value="" aria-pressed="true">0,5</button>');
  assertStringIncludes(page, "Recliquez sur la note pour l&#39;enlever.");

  // Le bouton pressé renvoie une note vide, le commentaire du formulaire reste.
  await s.envoyer(url, { note: "", commentaire: "Il manque la couleur." });
  assertEquals(JSON.parse(lireTentative(db, t.id).retours), {
    q3: { commentaire: "Il manque la couleur." },
  });
  assertStringIncludes(
    await (await s.lire(`/prof/activites/${a.id}/reponses`)).text(),
    '<td class="case s-attente">',
  );
  await s.envoyer(url, { note: "", commentaire: "" });
  assertEquals(lireTentative(db, t.id).retours, "{}");

  assertEquals((await s.envoyer(url, { note: "2", commentaire: "" })).status, 400);
  assertEquals((await s.envoyer(`${url}x`, { note: "1", commentaire: "" })).status, 404);
  db.close();
});

test("note sur une réponse fermée : la note de l'enseignant remplace les points automatiques", async () => {
  const { db, c1, prof, e1 } = await cadre();
  const a = serie(db, prof, c1, [terme]);
  enregistrerReponses(db, e1, a, { q2: "Gropius" }, true);
  const t = tentativesLues(db, prof, a)![0];
  const s = await connecter(db, prof);
  const page = async () => (await s.lire(`/prof/activites/${a.id}/reponses`)).text();

  assertStringIncludes(await page(), '<td class="case s-ko">');
  assertStringIncludes(await page(), "Note automatique : 0");
  const r = await s.envoyer(`/prof/activites/${a.id}/reponses/${t.id}/q2`, {
    note: "1",
    commentaire: "",
  });
  assertEquals(r.status, 303);
  const apres = await page();
  assertStringIncludes(apres, `<td class="case s-ok"><a href="#r-${t.id}-q2">1</a></td>`);
  assertStringIncludes(apres, "1 / 1");
  db.close();
});

test("à reprendre : l'enseignant marque une tentative remise, puis retire la marque", async () => {
  const { db, c1, prof, e1, e1b } = await cadre();
  const a = serie(db, prof, c1, [choix]);
  enregistrerReponses(db, e1, a, { q1: "B" }, true);
  enregistrerReponses(db, e1b, a, { q1: "A" }, false);
  const [encours, rendue] = [
    tentativesLues(db, prof, a)!.find((t) => t.compte_id === e1b.id)!,
    tentativesLues(db, prof, a)!.find((t) => t.compte_id === e1.id)!,
  ];
  const s = await connecter(db, prof);
  const chemin = (id: string) => `/prof/activites/${a.id}/reponses/${id}/reprendre`;

  assertEquals(
    (await s.envoyer(chemin(encours.id), { oui: "1" })).status,
    404,
    "pas encore remise",
  );
  const r = await s.envoyer(chemin(rendue.id), { oui: "1" });
  assertEquals(r.status, 303);
  assertEquals(lireTentative(db, rendue.id).a_reprendre, 1);
  const page = await (await s.lire(`/prof/activites/${a.id}/reponses`)).text();
  assertStringIncludes(page, '<span class="statut en-cours">À reprendre</span>');
  assertStringIncludes(page, "En cours");
  assertStringIncludes(page, "Annuler la reprise");
  await s.envoyer(chemin(rendue.id), { oui: "" });
  assertEquals(lireTentative(db, rendue.id).a_reprendre, 0);
  db.close();
});

test("tentatives d'une ancienne version : la grille les marque et laisse vides les questions absentes", async () => {
  const { db, c1, prof, e1 } = await cadre();
  const a = serie(db, prof, c1, [choix, redigee]);
  enregistrerReponses(db, e1, a, { q1: "A", q3: "Une céramique" }, true);
  const contenu: Contenu = { correction: "serie", questions: [choix, terme, redigee] };
  assertEquals(
    await enregistrer(db, fauxModeles().modeles, prof, a, a.revision, contenu),
    "modifie",
  );
  const neuve = activiteProf(db, prof, a.id) as Activite;
  assertEquals(neuve.revision, 2);

  const s = await connecter(db, prof);
  const page = await (await s.lire(`/prof/activites/${a.id}/reponses`)).text();
  assertStringIncludes(page, '<span class="discret">version 1</span>');
  // Q1 juste, Q2 absente de la version 1, Q3 à noter.
  assertStringIncludes(
    page,
    '<td class="case s-ok">1</td><td class="case"></td><td class="case s-attente">',
  );
  assertStringIncludes(page, "Une céramique");
  db.close();
});

test("CSV : une ligne par élève suivi, des guillemets, aucune formule", async () => {
  const { db, c1, prof, e1, e1b } = await cadre();
  db.prepare("UPDATE comptes SET nom = ? WHERE id = ?").run('=HYPERLINK("http://x")', e1.id);
  db.prepare("UPDATE comptes SET nom = ? WHERE id = ?").run('Bob; "Bobby"', e1b.id);
  const a = serie(db, prof, c1, [choix, redigee]);
  enregistrerReponses(db, e1, a, { q1: "B", q3: "Une céramique" }, true);
  const t = tentativesLues(db, prof, a)![0];
  const s = await connecter(db, prof);
  await s.envoyer(`/prof/activites/${a.id}/reponses/${t.id}/q3`, {
    note: "0.5",
    commentaire: "+bien\net court",
  });

  const r = await s.lire(`/prof/activites/${a.id}/reponses.csv`);
  assertEquals(r.headers.get("content-type"), "text/csv; charset=utf-8");
  assertStringIncludes(r.headers.get("content-disposition") ?? "", "attachment");
  const octets = new Uint8Array(await r.clone().arrayBuffer());
  assertEquals(Array.from(octets.slice(0, 3)), [0xef, 0xbb, 0xbf], "BOM pour Excel");
  const csv = await r.text();
  const lignes = csv.split("\r\n");
  assertEquals(lignes[0], '"Élève";"État";"Total";"Sur";"Q1";"Q2";"Commentaire Q2"');
  assertEquals(lignes.length, 4, "un en-tête, deux élèves, une fin de ligne");
  assertStringIncludes(csv, '"\'=HYPERLINK(""http://x"")"');
  assertStringIncludes(csv, '"Bob; ""Bobby""";"Rien remis";"";"2";"";"";""');
  assertStringIncludes(csv, ';"0,5";"\'+bien\net court"');
  db.close();
});
