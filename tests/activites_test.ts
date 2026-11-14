import { readFile, rm, writeFile } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertMatch, assertStringIncludes, assertThrows } from "@std/assert";
import { activitesEleve, lireImage } from "../src/app/activites.ts";
import { lireCompte } from "../src/app/comptes.ts";
import { contenu as chemin } from "../src/app/config.ts";
import type { Db } from "../src/app/db.ts";
import { cours, matiere, supprimer } from "../src/app/domaines.ts";
import { saisieDe } from "../src/app/edition.ts";
import {
  lireDocument,
  rattacher,
  reextraire,
  statuer,
  supprimerSource,
} from "../src/app/ingestion.ts";
import { configurerInstance } from "../src/app/instance.ts";
import type { Contenu, Explication, Question } from "../src/core/activite.ts";
import type { Modeles } from "../src/core/modeles.ts";
import { tranche } from "../src/core/texte.ts";
import { BONNE, environnement, fauxModeles, publier, session } from "./outils.ts";

const cite = (texte: string, citation: string) => ({
  texte,
  citations: [{ extrait: 1, citation }],
});
const ATTENDU = "Gaudí refuse la ligne droite.";
const CRITERE = "La réponse nomme la ligne droite.";
const RETOUR = "Sa façade est couverte de céramique irisée.";
const OBJECTIF = "Expliquer le refus de la ligne droite chez Gaudí";
/** Une sortie du générateur : le troisième critère cite un passage absent du cours. */
const sortie = (attendu = "Gaudí refuse la ligne droite dans toute la façade") =>
  JSON.stringify({
    consigne: cite(
      "Que refuse Gaudí dans la façade de la Casa Batlló ?",
      "Gaudí refuse la ligne droite dans toute la façade",
    ),
    attendu: cite(ATTENDU, attendu),
    criteres: [
      cite(CRITERE, "refuse la ligne droite dans toute la façade"),
      cite("La réponse vise toute la façade.", "la ligne droite dans toute la façade"),
      cite("La réponse cite le plan libre.", "Le Corbusier invente le plan libre"),
    ],
    retour: cite(RETOUR, "La façade de la Casa Batlló est couverte de céramique irisée"),
  });

type Session = Awaited<ReturnType<typeof session>> & { id: string };

async function compte(
  db: Db,
  role: "enseignant" | "eleve",
  modeles: Modeles = fauxModeles().modeles,
  inscrit = true,
): Promise<Session> {
  const s = await session(db, modeles, role, inscrit);
  const id = db.prepare("SELECT id FROM comptes ORDER BY rowid DESC LIMIT 1").get()!.id as string;
  return { ...s, id };
}

const envoyer = (s: Session, url: string, corps: Record<string, string | string[]> = {}) => {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(corps)) for (const x of [v].flat()) f.append(k, x);
  return s.requete(url, { method: "POST", body: f });
};
const page = async (s: Session, url: string) => (await s.requete(url)).text();
const statut = async (r: Response | Promise<Response>) => (await r).status;

/**
 * Un cours, sa source publiée aux élèves, un enseignant et un élève du cours. `juge` remplace le
 * juge de soutien de l'enseignant.
 */
async function cadre(personnel = false, juge?: Modeles["soutenir"], sorties = [sortie()]) {
  const { db, dir } = await environnement();
  if (personnel) configurerInstance(db, "Mon étude", "personal");
  const coursId = cours(db, matiere(db, "Arts appliqués"), "Design");
  const source = await publier(db, "Casa Batlló", coursId);
  const generateur = fauxModeles({ sorties });
  if (juge) generateur.modeles.soutenir = juge;
  const prof = await compte(db, "enseignant", generateur.modeles);
  const eleve = await compte(db, "eleve");
  return { db, dir, coursId, source, prof, eleve, vus: generateur.vus };
}

async function preparer(s: Session, coursId: string, source: string, intitule = OBJECTIF) {
  const r = await envoyer(s, "/prof/activites", {
    cours_id: coursId,
    intitule,
    reference: "STD2A, référentiel 2024, C3",
    sources: source,
  });
  assertEquals(r.status, 303, await r.text());
  return r.headers.get("location")!.split("/").at(-1)!;
}

const ligne = (db: Db, id: string) =>
  db
    .prepare("SELECT etat, revision, contenu, rejets, objectif_id FROM activites WHERE id = ?")
    .get(id) as {
    etat: string;
    revision: number;
    contenu: string;
    rejets: string;
    objectif_id: string;
  };
const serie = (db: Db, id: string) => JSON.parse(ligne(db, id).contenu) as Contenu;
type Redigee = Extract<Question, { type: "redigee" }>;
const premiere = (db: Db, id: string) => serie(db, id).questions[0] as Redigee;
const champsDe = (q: Redigee) => [q.consigne, q.attendu, ...q.criteres, q.retour];

/** Le formulaire de la question `qid` rempli avec sa version enregistrée, puis `change`. */
function formulaire(db: Db, id: string, qid: string, change: Record<string, string | string[]>) {
  const q = serie(db, id).questions.find((x) => x.id === qid)!;
  return { revision: String(ligne(db, id).revision), ...saisieDe(q), ...change };
}
/** Enregistre la question `qid`, la première par défaut, avec les changements demandés. */
const modifier = (
  s: Session,
  db: Db,
  id: string,
  change: Record<string, string | string[]> = {},
  qid = serie(db, id).questions[0].id,
) =>
  envoyer(
    s,
    `/prof/activites/${id}/questions/${encodeURIComponent(qid)}/enregistrer`,
    formulaire(db, id, qid, change),
  );

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

async function relirePublier(prof: Session, db: Db, id: string) {
  const revision = String(ligne(db, id).revision);
  assertEquals(await statut(envoyer(prof, `/prof/activites/${id}/relire`, { revision })), 303);
  assertEquals(await statut(envoyer(prof, `/prof/activites/${id}/publier`, { revision })), 303);
  assertEquals(ligne(db, id).etat, "publiee");
}

const actions = (db: Db, id: string) =>
  db
    .prepare("SELECT action, revision FROM relectures WHERE activite_id = ? ORDER BY rowid")
    .all(id)
    .map((l) => `${l.action} ${l.revision}`);

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
    assertEquals(detail.split("À vérifier").length - 1, 1);
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
      statut(envoyer(prof, `/prof/activites/${b}/objectif`, { objectif_id }));
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
    const histoire = cours(db, matiere(db, "Histoire"), "Histoire");
    db.prepare("INSERT INTO membres_cours VALUES (?, ?)").run(histoire, prof.id);
    const ajouter = () => envoyer(prof, `/prof/activites/${id}/cours`, { cours_id: histoire });
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

    rattacher(db, source, [
      { cours_id: coursId, theme_id: null },
      { cours_id: histoire, theme_id: null },
    ]);
    assertEquals(await statut(ajouter()), 303);
    assertEquals(new Set(liens()), new Set([coursId, histoire]));
    const liste = await page(prof, "/prof/activites");
    assertMatch(liste, /Design, Histoire|Histoire, Design/);
    assertStringIncludes(await page(prof, `/prof/activites?cours_id=${histoire}`), id);

    const retirer = (c: string) =>
      statut(envoyer(prof, `/prof/activites/${id}/cours/${c}/retirer`));
    assertEquals(await retirer(coursId), 400, "le cours d'origine porte l'objectif");
    assertEquals(await retirer(histoire), 303);
    assertEquals(liens(), [coursId]);
    assert(!(await page(prof, `/prof/activites?cours_id=${histoire}`)).includes(id));
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

test("série : ajouter, dupliquer, monter et supprimer une question créent chacun une version", async () => {
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
    assertEquals(await statut(op(apres[1].id, "supprimer")), 303);
    assertEquals(await statut(op(terme.id, "supprimer")), 303);
    assertEquals(
      serie(db, id).questions.map((q) => q.id),
      [q1],
    );
    assertEquals(
      actions(db, id),
      [2, 3, 4, 5, 6, 7].map((n) => `modifiee ${n}`),
    );
    assertEquals(await statut(op(q1, "supprimer")), 400, "une série garde une question");
    assertEquals(await statut(op(q1, "dupliquer", 1)), 409, "une page d'une version précédente");
    assertEquals(await statut(op("inconnue", "dupliquer")), 404);
    assertEquals(ligne(db, id).revision, 7);

    // Le corrigé se règle sur toute la série, comme une nouvelle version.
    const corrige = (correction: string) =>
      envoyer(prof, `/prof/activites/${id}/correction`, {
        revision: String(ligne(db, id).revision),
        correction,
      });
    assertEquals(await statut(corrige("question")), 303);
    assertEquals([serie(db, id).correction, ligne(db, id).revision], ["question", 8]);
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
    assert(!detail.includes('/cours"'), "une activité privée ne rejoint pas d'autre cours");
    await relirePublier(prof, db, id);
    const pratique = await page(prof, `/eleve/activites/${id}`);
    assertStringIncludes(pratique, "Exercice généré par Thot à partir de tes documents.");
    assertStringIncludes(pratique, "Personne d&#39;autre que toi ne l&#39;a relu.");
    assert(!pratique.includes("relu par"));
    assertStringIncludes(await page(prof, "/eleve"), `/eleve/activites/${id}`);

    // Un autre compte, même membre du cours, ne le voit nulle part.
    const autre = await compte(db, "enseignant");
    for (const url of [`/prof/activites/${id}`, `/eleve/activites/${id}`]) {
      assertEquals(await statut(autre.requete(url)), 404, url);
    }
    assert(!(await page(autre, "/prof/activites")).includes(id));
    assert(!(await page(autre, "/eleve")).includes(id));
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});
