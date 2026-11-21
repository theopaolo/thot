import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  ajouterCours,
  deposerImage,
  inserer,
  noter,
  regler,
  tentative,
} from "../src/app/activites.ts";
import { cours, matiere } from "../src/app/domaines.ts";
import type { Contenu, Question } from "../src/core/activite.ts";
import { publier as publierSource } from "./outils.ts";
import {
  cadre,
  compte,
  envoyer,
  exercice,
  fermer,
  libre,
  page,
  publie,
  statut,
} from "./pratique_outils.ts";

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
    // Une image montrée doit être servie par sa source.
    db.prepare(
      "INSERT INTO images (id, source_id, position, fichier, mime, checksum) VALUES ('x', ?, 0, 'x.png', 'image/png', 'x')",
    ).run(seconde);
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
