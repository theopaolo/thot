import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { activitesEleve, lireImage, ordreLecture } from "../src/app/activites.ts";
import { lireCompte } from "../src/app/comptes.ts";
import { cours, matiere } from "../src/app/domaines.ts";
import { lireDocument, rattacher } from "../src/app/ingestion.ts";
import type { Question } from "../src/core/activite.ts";
import { tranche } from "../src/core/texte.ts";
import {
  actions,
  cadre,
  compte,
  envoyer,
  ligne,
  modifier,
  OBJECTIF,
  page,
  premiere,
  preparer,
  relirePublier,
  RETOUR,
  serie,
  sortie,
  statut,
} from "./activites_outils.ts";

test("sources citables : sans thème d'abord, puis l'ordre de lecture, puis le titre en français", () => {
  const s = (titre: string, ordre: number | null, theme: string | null = null) => ({
    id: titre,
    titre,
    ordre,
    theme,
  });
  const sources = [
    s("Vers l'AI engineering", null),
    s("Écrire un AGENTS.md", null),
    s("Annexe", 1, "Pour aller plus loin"),
    s("Quiz", 13),
    s("MCP", 9),
    s("Agentic coding", 0),
  ];
  assertEquals(
    sources.toSorted(ordreLecture).map((x) => x.titre),
    ["Agentic coding", "MCP", "Quiz", "Écrire un AGENTS.md", "Vers l'AI engineering", "Annexe"],
  );
});

test("titre et date à rendre : réglés sans nouvelle version", async () => {
  const { db, dir, coursId, source, prof } = await cadre();
  try {
    const id = await preparer(prof, coursId, source);
    await relirePublier(prof, db, id);
    const regler = (titre: string, a_rendre_le: string) =>
      statut(envoyer(prof, `/prof/activites/${id}/reglages`, { titre, a_rendre_le }));
    assertEquals(await regler("Série Gaudí", "2026-12-01"), 303);
    assertEquals(
      { ...db.prepare("SELECT titre, a_rendre_le FROM activites").get() },
      { titre: "Série Gaudí", a_rendre_le: "2026-12-01" },
    );
    assertEquals([ligne(db, id).etat, ligne(db, id).revision], ["publiee", 1]);
    assertStringIncludes(await page(prof, `/prof/activites/${id}`), "<h1>Série Gaudí</h1>");
    const liste = await page(prof, "/prof/activites");
    assertStringIncludes(liste, `<a href="/prof/activites/${id}">Série Gaudí</a>`);
    assertStringIncludes(liste, OBJECTIF, "l'objectif reste lisible sous le titre");
    assertEquals(await regler("Série Gaudí", "demain"), 400);
    assertEquals(await regler("", ""), 400);
    assertEquals(await regler("Série Gaudí", ""), 303);
    assertEquals(db.prepare("SELECT a_rendre_le FROM activites").get()!.a_rendre_le, null);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("objectifs : un même intitulé est repris, un objectif se renomme, se change et se fusionne", async () => {
  const { db, dir, coursId, source, prof } = await cadre(false, undefined, [
    sortie(),
    sortie(),
    sortie(),
  ]);
  try {
    const a = await preparer(prof, coursId, source);
    const b = await preparer(
      prof,
      coursId,
      source,
      "expliquer le refus de la LIGNE  droite chez Gaudi",
    );
    assertEquals(
      ligne(db, a).objectif_id,
      ligne(db, b).objectif_id,
      "sans casse, accents ni espaces",
    );
    const c = await preparer(prof, coursId, source, "Lire une façade");
    const [premier, second] = [ligne(db, a).objectif_id, ligne(db, c).objectif_id];
    assert(premier !== second);

    const liste = await page(prof, "/prof/objectifs");
    assertStringIncludes(liste, `value="${OBJECTIF}"`);
    assertStringIncludes(liste, "<td>Design</td><td>2</td><td>0</td><td>0</td>");

    const renommer = (id: string, intitule: string) =>
      envoyer(prof, `/prof/objectifs/${id}/renommer`, { intitule });
    assertEquals(await statut(renommer(premier, "Comprendre la ligne droite")), 303);
    assertStringIncludes(await page(prof, `/prof/activites/${a}`), "Comprendre la ligne droite");
    const doublon = await renommer(second, "comprendre la LIGNE droite");
    assertEquals(doublon.status, 400);
    assertMatch(await doublon.text(), /role="alert">« Comprendre la ligne droite » existe déjà/);

    // Changer l'objectif d'une activité, dans son cours seulement.
    const changer = (objectif_id: string) =>
      statut(envoyer(prof, `/prof/activites/${b}/reglages`, { objectif_id }));
    assertEquals(await changer(second), 303);
    assertEquals(ligne(db, b).objectif_id, second);
    assertEquals(await changer("inconnu"), 400);

    const fusion = envoyer(prof, `/prof/objectifs/${second}/fusionner`, { vers: premier });
    assertEquals(await statut(fusion), 303);
    assertEquals(db.prepare("SELECT count(*) n FROM objectifs").get()!.n, 1);
    for (const id of [a, b, c]) assertEquals(ligne(db, id).objectif_id, premier);
    const seul = envoyer(prof, `/prof/objectifs/${premier}/fusionner`, { vers: premier });
    assertEquals(await statut(seul), 400);
    // Un enseignant hors du cours ne touche pas à ses objectifs.
    const etranger = await compte(db, "enseignant", undefined, false);
    assertEquals(
      await statut(envoyer(etranger, `/prof/objectifs/${premier}/renommer`, { intitule: "X" })),
      400,
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("cours : une activité rejoint un autre cours une fois ses sources citées rattachées, le cours d'origine reste", async () => {
  const { db, dir, coursId, source, prof } = await cadre();
  try {
    const id = await preparer(prof, coursId, source);
    const matiereHistoire = matiere(db, "Histoire");
    const histoire = cours(db, matiereHistoire, "Histoire");
    db.prepare("INSERT INTO membres_cours VALUES (?, ?)").run(histoire, prof.id);
    const ajouter = () => envoyer(prof, `/prof/activites/${id}/reglages`, { cours_id: histoire });
    const refus = await ajouter();
    assertEquals(refus.status, 400);
    assertStringIncludes(
      await refus.text(),
      "Rattachez d&#39;abord à Histoire la source citée : Casa Batlló.",
    );
    const liens = () =>
      db
        .prepare("SELECT cours_id FROM activite_cours")
        .all()
        .map((l) => l.cours_id);
    assertEquals(liens(), [coursId]);
    // Les réglages s'enregistrent ensemble : un cours refusé n'enregistre pas le titre.
    const ensemble = envoyer(prof, `/prof/activites/${id}/reglages`, {
      titre: "Autre titre",
      a_rendre_le: "",
      cours_id: histoire,
    });
    assertEquals(await statut(ensemble), 400);
    assert(db.prepare("SELECT titre FROM activites").get()!.titre !== "Autre titre");

    rattacher(db, source, [
      { cours_id: coursId, theme_id: null },
      { cours_id: histoire, theme_id: null },
    ]);
    assertEquals(await statut(ajouter()), 303);
    assertEquals(new Set(liens()), new Set([coursId, histoire]));
    const liste = await page(prof, "/prof/activites");
    assertMatch(liste, /Design, Histoire|Histoire, Design/);
    assertStringIncludes(await page(prof, `/prof/activites?cours_id=${histoire}`), id);
    // La grille du choix du cours propose aussi la matière.
    assertStringIncludes(await page(prof, `/prof/activites?matiere_id=${matiereHistoire}`), id);

    const retirer = (c: string) =>
      statut(envoyer(prof, `/prof/activites/${id}/cours/${c}/retirer`));
    assertEquals(await retirer(coursId), 400, "le cours d'origine porte l'objectif");
    assertEquals(await retirer(histoire), 303);
    assertEquals(liens(), [coursId]);
    assert(!(await page(prof, `/prof/activites?cours_id=${histoire}`)).includes(id));
    assert(!(await page(prof, `/prof/activites?matiere_id=${matiereHistoire}`)).includes(id));
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("champ rédigé par l'enseignant : sans passage il s'enregistre, un passage collé s'ancre, un faux est refusé", async () => {
  const { db, dir, coursId, source, prof } = await cadre();
  try {
    const id = await preparer(prof, coursId, source);
    const ecrit = "Une explication de l'enseignant.";
    assertEquals(await statut(modifier(prof, db, id, { retour: ecrit, retour_p0: "" })), 303);
    assertEquals(premiere(db, id).retour, { texte: ecrit, citations: [] });
    assertStringIncludes(await page(prof, `/prof/activites/${id}`), "Rédigé par l'enseignant");

    // Ajouter un passage : la source choisie et le texte collé, retrouvé mot pour mot.
    const colle = "La façade de la Casa Batlló est couverte de céramique irisée";
    const r = modifier(prof, db, id, { retour: RETOUR, retour_s0: source, retour_p0: colle });
    assertEquals(await statut(r), 303);
    const [c] = premiere(db, id).retour.citations;
    assertEquals([c.source_id, c.revision, c.citation], [source, 1, colle]);
    assertEquals(tranche(lireDocument(source, 1).texte, c.debut, c.fin), colle);
    assertEquals(ligne(db, id).revision, 3);

    const faux = await modifier(prof, db, id, {
      retour_s1: source,
      retour_p1: "Gaudí adore les angles droits partout",
    });
    assertEquals(faux.status, 400);
    const html = await faux.text();
    assertStringIncludes(html, "Retour : passage introuvable mot pour mot dans « Casa Batlló ».");
    assertStringIncludes(html, 'name="retour_p1"', "le formulaire reste ouvert avec la saisie");
    const ailleurs = await modifier(prof, db, id, { retour_s1: "inconnue", retour_p1: colle });
    assertEquals(ailleurs.status, 400);
    assertEquals(ligne(db, id).revision, 3);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("série : ajouter, dupliquer, monter, déplacer et supprimer une question créent chacun une version", async () => {
  const { db, dir, coursId, source, prof } = await cadre();
  try {
    const id = await preparer(prof, coursId, source);
    const q1 = premiere(db, id).id;
    const ouvert = await page(prof, `/prof/activites/${id}?modifier=nouvelle&type=terme`);
    assertStringIncludes(ouvert, `action="/prof/activites/${id}/questions"`);
    assertStringIncludes(ouvert, 'name="accepte"');

    const r = await envoyer(prof, `/prof/activites/${id}/questions`, {
      revision: "1",
      type: "terme",
      consigne: "Quel architecte a dessiné la Casa Batlló ?",
      accepte: "Gaudí\r\nAntoni Gaudí\r\n\r\nGaudí",
    });
    assertEquals(r.status, 303, await r.text());
    const [, terme] = serie(db, id).questions;
    assertEquals(r.headers.get("location"), `/prof/activites/${id}#q-${terme.id}`);
    assertEquals(terme.type, "terme");
    assertEquals(terme.type === "terme" && terme.accepte, ["Gaudí", "Antoni Gaudí"]);
    assertEquals(terme.consigne.citations, []);

    const op = (qid: string, nom: string, revision = ligne(db, id).revision) =>
      envoyer(prof, `/prof/activites/${id}/questions/${qid}/${nom}`, {
        revision: String(revision),
      });
    assertEquals(await statut(op(q1, "dupliquer")), 303);
    const apres = serie(db, id).questions;
    assertEquals(apres.length, 3);
    assertEquals(apres[1].consigne.texte, apres[0].consigne.texte);
    assert(apres[1].id !== q1);
    assertEquals(await statut(op(terme.id, "monter")), 303);
    assertEquals(
      serie(db, id).questions.map((q) => q.id),
      [q1, terme.id, apres[1].id],
    );
    assertEquals(await statut(op(q1, "monter")), 303, "la première ne monte pas plus haut");
    assertEquals(await statut(op(q1, "descendre")), 303);
    assertEquals(
      serie(db, id).questions.map((q) => q.id),
      [terme.id, q1, apres[1].id],
    );
    // Déplacer en position : la question saute d'un coup, les autres glissent d'un rang.
    const deplacer = (qid: string, rang: string) =>
      envoyer(prof, `/prof/activites/${id}/questions/${qid}/deplacer`, {
        revision: String(ligne(db, id).revision),
        rang,
      });
    assertEquals(await statut(deplacer(apres[1].id, "1")), 303);
    assertEquals(
      serie(db, id).questions.map((q) => q.id),
      [apres[1].id, terme.id, q1],
    );
    assertEquals(await statut(deplacer(q1, "9")), 303, "hors de la série, rien ne bouge");
    assertEquals(ligne(db, id).revision, 6);
    assertEquals(await statut(op(apres[1].id, "supprimer")), 303);
    assertEquals(await statut(op(terme.id, "supprimer")), 303);
    assertEquals(
      serie(db, id).questions.map((q) => q.id),
      [q1],
    );
    assertEquals(
      actions(db, id),
      [2, 3, 4, 5, 6, 7, 8].map((n) => `modifiee ${n}`),
    );
    assertEquals(await statut(op(q1, "supprimer")), 400, "une série garde une question");
    assertEquals(await statut(op(q1, "dupliquer", 1)), 409, "une page d'une version précédente");
    assertEquals(await statut(op("inconnue", "dupliquer")), 404);
    assertEquals(ligne(db, id).revision, 8);

    // Le corrigé se règle sur toute la série, comme une nouvelle version.
    const corrige = (correction: string) =>
      envoyer(prof, `/prof/activites/${id}/reglages`, {
        revision: String(ligne(db, id).revision),
        correction,
      });
    assertEquals(await statut(corrige("question")), 303);
    assertEquals([serie(db, id).correction, ligne(db, id).revision], ["question", 9]);
    assertEquals(await statut(corrige("jamais")), 400);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("série : une question à choix garde ses options, sa bonne réponse et son image", async () => {
  const { db, dir, coursId, source, prof } = await cadre();
  try {
    const id = await preparer(prof, coursId, source);
    const ouvert = await page(prof, `/prof/activites/${id}?modifier=nouvelle&type=choix`);
    assertStringIncludes(ouvert, 'name="option_7"');
    assertStringIncludes(ouvert, 'type="radio" name="juste" value="0"');

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const choix = (change: Record<string, string>, image = true) => {
      const f = new FormData();
      const corps = {
        revision: String(ligne(db, id).revision),
        type: "choix",
        consigne: "Que refuse Gaudí ?",
        option_0: "La ligne droite",
        option_0_s0: source,
        option_0_p0: "Gaudí refuse la ligne droite dans toute la façade",
        option_1: "La couleur",
        option_2: "",
        option_3: "La céramique",
        juste: "0",
        image_alt: "La façade de la Casa Batlló",
        ...change,
      };
      for (const [k, v] of Object.entries(corps)) f.append(k, v);
      if (image) f.append("image_fichier", new File([png], "facade.png"));
      return prof.requete(`/prof/activites/${id}/questions`, { method: "POST", body: f });
    };
    const sansBonne = await choix({ juste: "" });
    assertEquals(sansBonne.status, 400);
    assertStringIncludes(await sansBonne.text(), "Il faut exactement une bonne option.");
    assertEquals(await statut(choix({ image_alt: "" })), 400, "une image sans texte alternatif");
    assertEquals(await statut(choix({ juste: "9" })), 400, "un indice d'option hors des options");
    assertEquals(ligne(db, id).revision, 1);

    assertEquals(await statut(choix({})), 303);
    const q = serie(db, id).questions[1] as Extract<Question, { options: unknown }>;
    assertEquals(
      q.options.map((o) => [o.texte.texte, o.juste, o.texte.citations.length]),
      [
        ["La ligne droite", true, 1],
        ["La couleur", false, 0],
        ["La céramique", false, 0],
      ],
    );
    assertEquals(new Set(q.options.map((o) => o.id)).size, 3);
    assertMatch(q.image!.fichier!, /^[0-9a-f-]{36}\.png$/);
    assertEquals(q.image!.alt, "La façade de la Casa Batlló");
    assert(await lireImage(id, q.image!.fichier!));
    const detail = await page(prof, `/prof/activites/${id}`);
    assertEquals(detail.split("Bonne réponse").length - 1, 1);
    assertStringIncludes(detail, `/activites/${id}/images/${q.image!.fichier}`);

    // Rouvrir et enregistrer sans changement garde les identifiants, l'image et la version.
    assertEquals(await statut(modifier(prof, db, id, {}, q.id)), 303);
    assertEquals(ligne(db, id).revision, 2);
    // Une bonne option qui change garde l'identifiant de chaque option.
    assertEquals(await statut(modifier(prof, db, id, { juste: "1" }, q.id)), 303);
    const apres = serie(db, id).questions[1] as Extract<Question, { options: unknown }>;
    assertEquals(
      apres.options.map((o) => o.id),
      q.options.map((o) => o.id),
    );
    assertEquals(
      apres.options.map((o) => o.juste),
      [false, true, false],
    );
    // Un identifiant d'option inventé par le formulaire n'est pas repris.
    await modifier(prof, db, id, { option_1_id: "zzz", option_2_id: q.options[0].id }, q.id);
    const ids = (serie(db, id).questions[1] as typeof q).options.map((o) => o.id);
    assert(!ids.includes("zzz") && new Set(ids).size === 3);
    assertEquals(await statut(modifier(prof, db, id, { image_retirer: "1" }, q.id)), 303);
    assertEquals(serie(db, id).questions[1].image, undefined);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("brouillon : supprimé s'il n'a jamais été publié, une activité publiée s'archive", async () => {
  const { db, dir, coursId, source, prof, eleve } = await cadre(false, undefined, [
    sortie(),
    sortie(),
  ]);
  try {
    const brouillon = await preparer(prof, coursId, source);
    assertStringIncludes(
      await page(prof, `/prof/activites/${brouillon}`),
      "Supprimer le brouillon",
    );
    const r = await envoyer(prof, `/prof/activites/${brouillon}/supprimer`);
    assertEquals([r.status, r.headers.get("location")], [303, "/prof/activites"]);
    assertEquals(db.prepare("SELECT count(*) n FROM activites").get()!.n, 0);

    const id = await preparer(prof, coursId, source);
    await relirePublier(prof, db, id);
    assert(!(await page(prof, `/prof/activites/${id}`)).includes("Supprimer le brouillon"));
    assertEquals(await statut(envoyer(prof, `/prof/activites/${id}/supprimer`)), 409);

    const moi = lireCompte(db, eleve.id)!;
    assertEquals(
      activitesEleve(db, moi).map((a) => a.id),
      [id],
    );
    const archiver = (oui: string) =>
      statut(envoyer(prof, `/prof/activites/${id}/archiver`, { oui }));
    assertEquals(await archiver("1"), 303);
    assertEquals(activitesEleve(db, moi), []);
    assertEquals(ligne(db, id).etat, "publiee");
    assert(!(await page(prof, "/prof/activites")).includes(id), "la liste cache les archivées");
    assertStringIncludes(await page(prof, "/prof/activites?etat=archivee"), id);
    assertStringIncludes(await page(prof, `/prof/activites/${id}`), "Désarchiver");
    assertEquals(await archiver("0"), 303);
    assertEquals(
      activitesEleve(db, moi).map((a) => a.id),
      [id],
    );
    assert(!(await page(prof, "/prof/activites?etat=brouillon")).includes(id));
    assertStringIncludes(await page(prof, "/prof/activites?etat=publiee"), id);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});
