import { readFile, rm, writeFile } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertMatch, assertStringIncludes, assertThrows } from "@std/assert";
import { contenu as chemin } from "../src/app/config.ts";
import type { Db } from "../src/app/db.ts";
import { cours, matiere, supprimer } from "../src/app/domaines.ts";
import {
  lireDocument,
  rattacher,
  reextraire,
  statuer,
  supprimerSource,
} from "../src/app/ingestion.ts";
import type { Explication } from "../src/core/activite.ts";
import { tranche } from "../src/core/texte.ts";
import { BONNE, fauxModeles, publier } from "./outils.ts";
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
  type Redigee,
  relirePublier,
  RETOUR,
  serie,
  sortie,
  statut,
} from "./activites_outils.ts";

const champsDe = (q: Redigee) => [q.consigne, q.attendu, ...q.criteres, q.retour];

/** Une phrase de plus avant le passage cité déplace ses offsets dans une révision 2, à relire. */
async function reviser(db: Db, source: string) {
  const { fichier } = db.prepare("SELECT fichier FROM sources WHERE id = ?").get(source) as {
    fichier: string;
  };
  const original = chemin(source, "original", fichier);
  await writeFile(
    original,
    (await readFile(original, "utf8")).replace(
      "<p>La façade",
      "<p>Une phrase ajoutée.</p><p>La façade",
    ),
  );
  assertEquals(await reextraire(db, source), "revision");
}

test("exercice : un appel rédige les champs, chaque citation retombe sur la révision, un champ sans passage est rejeté et compté", async () => {
  const { db, dir, coursId, source, prof, vus } = await cadre();
  try {
    const id = await preparer(prof, coursId, source);
    assertEquals(vus.length, 1, "un seul appel du générateur");
    assertStringIncludes(vus[0][1].content, "Objectif : Expliquer le refus de la ligne droite");
    assertStringIncludes(vus[0][1].content, "Gaudí refuse la ligne droite dans toute la façade");
    const a = ligne(db, id);
    assertEquals(a.etat, "brouillon");
    assertEquals(serie(db, id).questions.length, 1);
    const q = premiere(db, id);
    assertEquals(q.type, "redigee");
    assertEquals(q.criteres.length, 2);
    assertEquals(JSON.parse(a.rejets), [
      "Critère 3 : une citation ne se retrouve pas mot pour mot dans le texte des extraits.",
    ]);
    const texte = lireDocument(source, 1).texte;
    for (const c of champsDe(q).flatMap((ch) => ch.citations)) {
      assertEquals([c.source_id, c.revision], [source, 1]);
      assertEquals(tranche(texte, c.debut, c.fin), c.citation);
    }
    assertEquals(
      { ...db.prepare("SELECT intitule, reference, cours_id FROM objectifs").get() },
      { intitule: OBJECTIF, reference: "STD2A, référentiel 2024, C3", cours_id: coursId },
    );
    const detail = await page(prof, `/prof/activites/${id}`);
    assertStringIncludes(detail, "1 champ rejeté à la génération");
    assertStringIncludes(detail, `revision=1#passage`);
    assertStringIncludes(detail, `id="q-${q.id}"`);
    assert(!detail.includes("Rédigé par l'enseignant"), "chaque champ de Thot est cité");
    const liste = await page(prof, "/prof/activites");
    assertStringIncludes(liste, OBJECTIF);
    assertStringIncludes(liste, "Exercice, 1 question");
    assert(!liste.includes("Par objectif"));

    // Sans réponse attendue ancrée, rien n'est enregistré, pas même le nouvel objectif.
    const autre = await compte(
      db,
      "enseignant",
      fauxModeles({ sorties: [sortie("Gaudí aime les angles droits")] }).modeles,
    );
    const r = await envoyer(autre, "/prof/activites", {
      cours_id: coursId,
      intitule: "Un autre objectif",
      sources: source,
    });
    assertEquals(r.status, 422);
    assertStringIncludes(await r.text(), "Réponse attendue : une citation ne se retrouve pas");
    assertEquals(db.prepare("SELECT count(*) n FROM activites").get()!.n, 1);
    assertEquals(db.prepare("SELECT count(*) n FROM objectifs").get()!.n, 1);
    // Un cours qui porte un objectif ne se supprime pas.
    assertThrows(() => supprimer(db, "cours", coursId), Error, "1 objectif(s)");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("exercice : hors du cours, un enseignant ne lit ni ne modifie l'activité, un administrateur l'ouvre sans les réponses", async () => {
  const { db, dir, coursId, source, prof } = await cadre();
  try {
    const id = await preparer(prof, coursId, source);
    const etranger = await compte(db, "enseignant", undefined, false);
    assertEquals(await statut(etranger.requete(`/prof/activites/${id}`)), 404);
    assertEquals(await statut(modifier(etranger, db, id, { consigne: "Autre ?" })), 404);
    for (const action of ["reglages", "archiver", "supprimer", "relire", "reancrer"]) {
      const r = envoyer(etranger, `/prof/activites/${id}/${action}`, { revision: "1" });
      assertEquals(await statut(r), 404, action);
    }
    assert(!(await page(etranger, "/prof/activites")).includes(id));
    assertEquals(ligne(db, id).revision, 1);

    db.prepare("UPDATE comptes SET administrateur = 1 WHERE id = ?").run(etranger.id);
    const admin = await page(etranger, `/prof/activites/${id}`);
    assertStringIncludes(admin, "Que refuse Gaudí");
    assert(!admin.includes("<h2>Réponses</h2>"), "un administrateur ne lit pas les réponses");
    assertStringIncludes(await page(prof, `/prof/activites/${id}`), "<h2>Réponses</h2>");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("exercice : modifier une question crée une version et retire la relecture", async () => {
  const { db, dir, coursId, source, prof, eleve } = await cadre();
  try {
    const id = await preparer(prof, coursId, source);
    await relirePublier(prof, db, id);
    const collegue = await compte(db, "enseignant");
    const qid = premiere(db, id).id;

    // « Modifier » ouvre le formulaire de la question à sa place.
    const ouvert = await page(prof, `/prof/activites/${id}?modifier=${qid}`);
    assertStringIncludes(ouvert, `action="/prof/activites/${id}/questions/${qid}/enregistrer"`);
    assertStringIncludes(ouvert, 'name="attendu_p0"');
    assertStringIncludes(ouvert, "Ajouter un passage");

    const r = await modifier(prof, db, id, { attendu: "Il refuse la ligne droite." });
    assertEquals(r.status, 303);
    assertEquals(r.headers.get("location"), `/prof/activites/${id}#q-${qid}`);
    assertEquals([ligne(db, id).etat, ligne(db, id).revision], ["brouillon", 2]);
    assertEquals(premiere(db, id).attendu.citations.length, 1, "le passage reste");
    assertEquals(await statut(eleve.requete(`/eleve/activites/${id}`)), 404);
    assertEquals(
      await statut(envoyer(prof, `/prof/activites/${id}/publier`, { revision: "2" })),
      409,
      "version non relue",
    );
    // Le collègue relit la page qu'il a chargée avant la modification : elle ne vaut pas pour la suivante.
    assertEquals(
      await statut(envoyer(collegue, `/prof/activites/${id}/relire`, { revision: "1" })),
      409,
    );
    assertEquals(
      await statut(envoyer(collegue, `/prof/activites/${id}/relire`, { revision: "2" })),
      303,
    );
    assertEquals(actions(db, id), ["relue 1", "publiee 1", "modifiee 2", "relue 2"]);
    assertStringIncludes(await page(prof, `/prof/activites/${id}`), "Compte enseignant");

    // Un passage absent de la source ne s'enregistre pas, et le formulaire reste ouvert.
    const refus = await modifier(prof, db, id, {
      attendu_p0: "Gaudí adore la ligne droite partout",
    });
    assertEquals(refus.status, 400);
    const html = await refus.text();
    assertStringIncludes(html, "passage introuvable mot pour mot");
    assertStringIncludes(html, "Gaudí adore la ligne droite partout");
    assertEquals(await statut(modifier(prof, db, id, { consigne: "" })), 400, "consigne vide");
    // Enregistrer sans changement garde la version et sa relecture.
    assertEquals(await statut(modifier(prof, db, id)), 303);
    assertEquals([ligne(db, id).etat, ligne(db, id).revision], ["relue", 2]);
    // Un formulaire d'une version précédente est refusé.
    assertEquals(await statut(modifier(prof, db, id, { revision: "1", consigne: "Autre ?" })), 409);
    // Le formulaire ne fait pas reprendre un avis de juge.
    await modifier(prof, db, id, { consigne: "Que refuse Gaudí ?", soutien: "0" });
    assert(champsDe(premiere(db, id)).every((ch) => ch.soutien === 1));
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("exercice : nouvelle version, lecteurs retirés, rejet et suppression de la source le signalent à revoir", async () => {
  const { db, dir, coursId, source, prof, eleve } = await cadre();
  try {
    const id = await preparer(prof, coursId, source);
    await relirePublier(prof, db, id);

    await reviser(db, source);
    assertEquals(ligne(db, id).etat, "publiee", "une révision en attente ne sert pas encore");
    statuer(db, source, "certifiee", "Prof", 2);
    assertEquals(ligne(db, id).etat, "a_revoir");
    assertEquals(await statut(eleve.requete(`/eleve/activites/${id}`)), 404);
    const revoir = await page(prof, `/prof/activites/${id}`);
    assertStringIncludes(revoir, "version 1 citée, la source sert la version 2");
    assertStringIncludes(revoir, "Ne tiennent plus : Casa Batlló dans Design");
    assertMatch(
      revoir,
      /<li><a href="#q-[^"]+">.*<span class="statut failed">À revoir<\/span><\/a><\/li>/,
    );

    // Chercher les passages de toute la série dans la révision servie.
    const r = envoyer(prof, `/prof/activites/${id}/reancrer`, { revision: "1" });
    assertEquals(await statut(r), 303);
    const a = ligne(db, id);
    assertEquals([a.etat, a.revision], ["brouillon", 2]);
    const texte = lireDocument(source, 2).texte;
    for (const c of champsDe(premiere(db, id)).flatMap((ch) => ch.citations)) {
      assertEquals(c.revision, 2);
      assertEquals(tranche(texte, c.debut, c.fin), c.citation);
    }
    await relirePublier(prof, db, id);

    // Des lecteurs sans les élèves retirent la preuve aux élèves du cours.
    const lecteurs = (audience: string) =>
      envoyer(prof, "/prof/sources/statut", { ids: source, statut: "lecteurs", audience });
    assertEquals(await statut(lecteurs("collegues")), 303);
    assertEquals(ligne(db, id).etat, "a_revoir");
    await lecteurs("eleves");
    assertEquals(await statut(modifier(prof, db, id, { consigne: "Que refuse Gaudí ?" })), 303);
    await relirePublier(prof, db, id);

    statuer(db, source, "rejetee", "Prof");
    assertEquals(ligne(db, id).etat, "a_revoir");
    const rejetee = await modifier(prof, db, id, { consigne: "Que refuse-t-il ?" });
    assertEquals(rejetee.status, 400, "une source rejetée n'est plus citable");
    assertStringIncludes(await rejetee.text(), "n&#39;est pas une source citable de ce cours");

    // Supprimer la source retire ses passages et les champs rédigés d'après elle.
    await supprimerSource(db, source);
    // Le titre reprend l'intitulé de l'objectif, écrit par l'enseignant : seul le contenu compte.
    const reste = ligne(db, id).contenu;
    assert(!/ligne droite|céramique|Batlló|façade/.test(reste), "texte de la source");
    assert(!reste.includes(source));
    assertEquals(ligne(db, id).etat, "a_revoir");
    assertStringIncludes(
      await page(prof, `/prof/activites/${id}`),
      "Vide : sa source a été supprimée.",
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("source supprimée : une question vidée se supprime ou se corrige seule, et la série vidée ne se relit ni ne se publie", async () => {
  const { db, dir, coursId, source, prof } = await cadre(false, undefined, [sortie(), sortie()]);
  try {
    const r = await envoyer(prof, "/prof/activites", {
      cours_id: coursId,
      intitule: OBJECTIF,
      sources: source,
      nombre: "2",
    });
    assertEquals(r.status, 303, await r.text());
    const id = r.headers.get("location")!.split("/").at(-1)!;
    const url = `/prof/activites/${id}`;
    // Une question écrite par l'enseignant, sans citation : la suppression ne la touche pas.
    const ecrite = {
      revision: "1",
      type: "terme",
      consigne: "Quel architecte ?",
      accepte: "Gaudí",
    };
    assertEquals(await statut(envoyer(prof, `${url}/questions`, ecrite)), 303);
    // Un second cours, que l'enseignant pourra retirer.
    const histoire = cours(db, matiere(db, "Histoire"), "Histoire");
    db.prepare("INSERT INTO membres_cours VALUES (?, ?)").run(histoire, prof.id);
    rattacher(db, source, [
      { cours_id: coursId, theme_id: null },
      { cours_id: histoire, theme_id: null },
    ]);
    assertEquals(await statut(envoyer(prof, `${url}/reglages`, { cours_id: histoire })), 303);
    await relirePublier(prof, db, id);

    // La suppression vide les deux questions rédigées d'après la source, et crée une version.
    await supprimerSource(db, source);
    assertEquals([ligne(db, id).etat, ligne(db, id).revision], ["a_revoir", 3]);
    assertEquals(actions(db, id).at(-1), "a_revoir 3");
    const [q1, q2, q3] = serie(db, id).questions;
    assertEquals(
      [q1.consigne.texte, q2.consigne.texte, q3.consigne.texte],
      ["", "", "Quel architecte ?"],
    );

    // Retirer un cours ne fait pas d'une série vidée un brouillon à relire.
    assertEquals(await statut(envoyer(prof, `${url}/cours/${histoire}/retirer`)), 303);
    assertEquals(ligne(db, id).etat, "a_revoir");
    // Une série vidée déjà redevenue brouillon, puis relue, dans une base existante.
    const forcer = (etat: string) =>
      db.prepare("UPDATE activites SET etat = ? WHERE id = ?").run(etat, id);
    for (const [etat, action] of [
      ["brouillon", "relire"],
      ["relue", "publier"],
    ]) {
      forcer(etat);
      const refus = await envoyer(prof, `${url}/${action}`, { revision: "3" });
      assertEquals(refus.status, 400, action);
      assertStringIncludes(await refus.text(), "Question 1 : la consigne est vide.");
      assertEquals(ligne(db, id).etat, etat);
    }
    forcer("a_revoir");

    // Supprimer la première question vidée sans toucher à la seconde.
    const supprimer = envoyer(prof, `${url}/questions/${q1.id}/supprimer`, { revision: "3" });
    assertEquals(await statut(supprimer), 303);
    assertEquals([ligne(db, id).etat, ligne(db, id).revision], ["a_revoir", 4]);
    // Une question vidée ne se duplique pas.
    const dupliquer = envoyer(prof, `${url}/questions/${q2.id}/dupliquer`, { revision: "4" });
    assertEquals(await statut(dupliquer), 400);
    // Corriger la seconde rend un brouillon, qui se relit et se publie.
    const corrigee = await modifier(
      prof,
      db,
      id,
      { consigne: "Que refuse Gaudí ?", attendu: "La ligne droite." },
      q2.id,
    );
    assertEquals(corrigee.status, 303, await corrigee.text());
    assertEquals([ligne(db, id).etat, ligne(db, id).revision], ["brouillon", 5]);
    assertEquals(
      serie(db, id).questions.map((q) => q.id),
      [q2.id, q3.id],
    );
    await relirePublier(prof, db, id);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("exercice : retirer le cours de sa source le signale à revoir, sans passer par une route", async () => {
  const { db, dir, coursId, source, prof } = await cadre();
  try {
    const id = await preparer(prof, coursId, source);
    await relirePublier(prof, db, id);
    rattacher(db, source, [{ cours_id: coursId, theme_id: null }]);
    assertEquals(ligne(db, id).etat, "publiee", "le même cours garde la preuve");
    rattacher(db, source, []);
    assertEquals(ligne(db, id).etat, "a_revoir");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("exercice : le juge marque un champ à vérifier sans le rejeter, une modification ne rejuge que les champs changés", async () => {
  const juges: string[] = [];
  const { db, dir, coursId, source, prof } = await cadre(false, (texte) => {
    juges.push(texte);
    return Promise.resolve({ probabilite: texte === RETOUR ? 0.1 : 1, modele: "faux-juge" });
  });
  try {
    const id = await preparer(prof, coursId, source);
    assertEquals(juges.length, 5, "un appel par champ gardé");
    assertEquals(
      champsDe(premiere(db, id)).map((ch) => ch.soutien),
      [1, 1, 1, 1, 0.1],
    );
    const detail = await page(prof, `/prof/activites/${id}`);
    // L'avis sous le champ, puis la question dans l'index de la série.
    assertEquals(detail.split("À vérifier").length - 1, 2);
    assertMatch(
      detail,
      /<li><a href="#q-[^"]+">[^<]*<span class="chiffres">1\.<\/span> Réponse rédigée <span class="statut failed">À vérifier<\/span><\/a><\/li>/,
    );
    assertStringIncludes(detail, "les passages cités n'établissent pas tout");
    // Afficher la page ne rappelle pas le juge.
    assertEquals(juges.length, 5);
    // Le juge ne bloque pas la publication : la relecture reste la barrière.
    await relirePublier(prof, db, id);

    const nouveau = "Il refuse la ligne droite.";
    assertEquals(await statut(modifier(prof, db, id, { attendu: nouveau })), 303);
    assertEquals(juges.slice(5), [nouveau], "seul le champ changé repasse");
    assertEquals(premiere(db, id).retour.soutien, 0.1, "le retour inchangé garde son avis");
    assertStringIncludes(await page(prof, `/prof/activites/${id}`), "À vérifier");
    // Un champ rédigé par l'enseignant, sans passage, n'a rien à juger.
    await modifier(prof, db, id, { attendu: "Les lignes droites.", attendu_p0: "" });
    assertEquals(juges.length, 6);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("exercice : un juge en panne laisse le brouillon et le dit", async () => {
  const { db, dir, coursId, source, prof } = await cadre(false, () =>
    Promise.reject(new Error("panne du juge")),
  );
  try {
    const id = await preparer(prof, coursId, source);
    assert(champsDe(premiere(db, id)).every((ch) => ch.soutien === null));
    assertEquals(ligne(db, id).etat, "brouillon");
    const detail = await page(prof, `/prof/activites/${id}`);
    assertStringIncludes(detail, "Juge indisponible");
    assert(!detail.includes("À vérifier"));
    await relirePublier(prof, db, id);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("explication : la réponse vérifiée à l'objectif, dans les sources choisies seulement, lue sans tentative et signalée à revoir", async () => {
  const { db, dir, coursId, source, prof, eleve, vus } = await cadre(false, undefined, [BONNE]);
  try {
    const ecartee = await publier(db, "Source écartée", coursId);
    const r = await envoyer(prof, "/prof/activites", {
      type: "explication",
      cours_id: coursId,
      intitule: "Gaudí et la ligne droite",
      sources: source,
    });
    assertEquals(r.status, 303, await r.text());
    const id = r.headers.get("location")!.split("/").at(-1)!;
    assertEquals(vus.length, 1);
    assertStringIncludes(vus[0][1].content, "Question de l'eleve : Gaudí et la ligne droite");
    assertStringIncludes(vus[0][1].content, "Casa Batlló");
    assert(!vus[0][1].content.includes("Source écartée"), "une source non choisie");

    const a = db.prepare("SELECT type, etat, contenu FROM activites WHERE id = ?").get(id)!;
    assertEquals([a.type, a.etat], ["explication", "brouillon"]);
    const contenu = JSON.parse(String(a.contenu)) as Explication;
    assertEquals(
      contenu.affirmations.map((x) => [x.texte, x.source_id, x.revision]),
      [["Gaudí refuse la ligne droite.", source, 1]],
    );
    const detail = await page(prof, `/prof/activites/${id}`);
    assertStringIncludes(detail, "« Gaudí refuse la ligne droite dans toute la façade »");
    assert(!detail.includes("Modifier"), "une explication ne se modifie pas");
    assertEquals(
      await statut(envoyer(prof, `/prof/activites/${id}/questions`, { revision: "1" })),
      404,
    );
    assertStringIncludes(
      await page(prof, `/prof/activites/${id}/apercu`),
      `/prof/activites/${id}/citations/0`,
    );
    assertStringIncludes(await page(prof, `/prof/activites/${id}/citations/0`), "<mark>");
    await relirePublier(prof, db, id);

    const lue = await page(eleve, `/eleve/activites/${id}`);
    assertStringIncludes(lue, "Gaudí refuse la ligne droite.");
    assertStringIncludes(lue, `hx-get="/eleve/activites/${id}/citations/0"`);
    assertStringIncludes(lue, "Explication préparée par Compte enseignant, relue par");
    for (const absent of ["Ta réponse", "/avis", "/eleve/messages/"]) {
      assert(!lue.includes(absent), absent);
    }
    assertStringIncludes(await page(eleve, `/eleve/activites/${id}/citations/0`), "<mark>");
    assertEquals(await statut(eleve.requete(`/eleve/activites/${id}/citations/0`)), 200);
    const dehors = await compte(db, "eleve", undefined, false);
    assertEquals(await statut(dehors.requete(`/eleve/activites/${id}/citations/0`)), 404);

    // Une nouvelle révision servie de la source citée retire l'explication aux élèves.
    await reviser(db, source);
    statuer(db, source, "certifiee", "Prof", 2);
    assertEquals(db.prepare("SELECT etat FROM activites WHERE id = ?").get(id)!.etat, "a_revoir");
    assertEquals(await statut(eleve.requete(`/eleve/activites/${id}`)), 404);
    assertStringIncludes(await page(prof, `/prof/activites/${id}`), "Préparez-en une autre.");

    // Supprimer la source retire ses phrases, l'autre source n'y change rien.
    await supprimerSource(db, ecartee);
    assertEquals((JSON.parse(ligne(db, id).contenu) as Explication).affirmations.length, 1);
    await supprimerSource(db, source);
    assert(!/ligne droite|Batlló|façade/.test(ligne(db, id).contenu), "texte de la source");
    assertStringIncludes(
      await page(prof, `/prof/activites/${id}`),
      "Vide : ses sources ont été supprimées.",
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("exercice personnel : privé à son auteur, publié sans relecture indépendante", async () => {
  const { db, dir, coursId, source, prof } = await cadre(true);
  try {
    db.prepare("UPDATE comptes SET administrateur = 1 WHERE id = ?").run(prof.id);
    assert(!(await page(prof, "/prof/activites/nouvelle")).includes("Référence"));
    const id = await preparer(prof, coursId, source);
    assertEquals(
      db.prepare("SELECT audience FROM activites WHERE id = ?").get(id)!.audience,
      "prive",
    );
    const detail = await page(prof, `/prof/activites/${id}`);
    assertStringIncludes(detail, "Votre relecture ne vaut pas relecture indépendante.");
    assert(!detail.includes('name="cours_id"'), "une activité privée ne rejoint pas d'autre cours");
    await relirePublier(prof, db, id);
    const pratique = await page(prof, `/eleve/activites/${id}`);
    assertStringIncludes(pratique, "Exercice généré par Thot à partir de tes documents.");
    assertStringIncludes(pratique, "Personne d&#39;autre que toi ne l&#39;a relu.");
    assert(!pratique.includes("relu par"));
    assertStringIncludes(await page(prof, `/eleve?cours_id=${coursId}`), `/eleve/activites/${id}`);

    // Un autre compte, même membre du cours, ne le voit nulle part.
    const autre = await compte(db, "enseignant");
    for (const url of [`/prof/activites/${id}`, `/eleve/activites/${id}`]) {
      assertEquals(await statut(autre.requete(url)), 404, url);
    }
    assert(!(await page(autre, "/prof/activites")).includes(id));
    for (const url of ["/eleve", `/eleve?cours_id=${coursId}`]) {
      assert(!(await page(autre, url)).includes(id), url);
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});
