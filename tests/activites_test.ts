import { readFile, rm, writeFile } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { contenu as chemin } from "../src/app/config.ts";
import type { Db } from "../src/app/db.ts";
import { cours, matiere, supprimer } from "../src/app/domaines.ts";
import { lireDocument, reextraire, statuer, supprimerSource } from "../src/app/ingestion.ts";
import { configurerInstance } from "../src/app/instance.ts";
import type { Contenu } from "../src/core/activite.ts";
import type { Modeles } from "../src/core/modeles.ts";
import { tranche } from "../src/core/texte.ts";
import { environnement, fauxModeles, publier, session } from "./outils.ts";

const cite = (texte: string, citation: string) => ({
  texte,
  citations: [{ extrait: 1, citation }],
});
const ATTENDU = "Gaudí refuse la ligne droite.";
const CRITERE = "La réponse nomme la ligne droite.";
const RETOUR = "Sa façade est couverte de céramique irisée.";
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

/** Un cours, sa source publiée aux élèves, un enseignant et un élève du cours. */
async function cadre(personnel = false) {
  const { db, dir } = await environnement();
  if (personnel) configurerInstance(db, "Mon étude", "personal");
  const coursId = cours(db, matiere(db, "Arts appliqués"), "Design");
  const source = await publier(db, "Casa Batlló", coursId);
  const generateur = fauxModeles({ sorties: [sortie()] });
  const prof = await compte(db, "enseignant", generateur.modeles);
  const eleve = await compte(db, "eleve");
  return { db, dir, coursId, source, prof, eleve, vus: generateur.vus };
}

async function preparer(s: Session, coursId: string, source: string) {
  const r = await envoyer(s, "/prof/activites", {
    cours_id: coursId,
    intitule: "Expliquer le refus de la ligne droite chez Gaudí",
    reference: "STD2A, référentiel 2024, C3",
    sources: source,
  });
  assertEquals(r.status, 303, await r.text());
  return r.headers.get("location")!.split("/").at(-1)!;
}

const ligne = (db: Db, id: string) =>
  db.prepare("SELECT etat, revision, contenu, rejets FROM activites WHERE id = ?").get(id) as {
    etat: string;
    revision: number;
    contenu: string;
    rejets: string;
  };
const champsDe = (c: Contenu) => [c.consigne, c.attendu, ...c.criteres, c.retour];

/** Le formulaire de modification rempli avec la version enregistrée, puis `change`. */
function formulaire(db: Db, id: string, change: Record<string, string> = {}) {
  const a = ligne(db, id);
  const corps: Record<string, string> = { revision: String(a.revision) };
  champsDe(JSON.parse(a.contenu)).forEach((ch, i) => {
    corps[`texte_${i}`] = ch.texte;
    ch.citations.forEach((c, j) => (corps[`citation_${i}_${j}`] = c.citation));
  });
  return { ...corps, ...change };
}

async function relirePublier(prof: Session, db: Db, id: string) {
  const revision = String(ligne(db, id).revision);
  assertEquals(await statut(envoyer(prof, `/prof/activites/${id}/relire`, { revision })), 303);
  assertEquals(await statut(envoyer(prof, `/prof/activites/${id}/publier`, { revision })), 303);
  assertEquals(ligne(db, id).etat, "publiee");
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
    const contenu = JSON.parse(a.contenu) as Contenu;
    assertEquals(contenu.criteres.length, 2);
    assertEquals(JSON.parse(a.rejets), [
      "Critère 3 : une citation ne se retrouve pas mot pour mot dans le texte des extraits.",
    ]);
    const texte = lireDocument(source, 1).texte;
    for (const c of champsDe(contenu).flatMap((ch) => ch.citations)) {
      assertEquals([c.source_id, c.revision], [source, 1]);
      assertEquals(tranche(texte, c.debut, c.fin), c.citation);
    }
    assertEquals(
      { ...db.prepare("SELECT intitule, reference, cours_id FROM objectifs").get() },
      {
        intitule: "Expliquer le refus de la ligne droite chez Gaudí",
        reference: "STD2A, référentiel 2024, C3",
        cours_id: coursId,
      },
    );
    const detail = await page(prof, `/prof/activites/${id}`);
    assertStringIncludes(detail, "1 champ rejeté à la génération");
    assertStringIncludes(detail, `revision=1#passage`);
    assertStringIncludes(await page(prof, "/prof/activites"), "Expliquer le refus");

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
    const refus = await r.text();
    assertStringIncludes(refus, "Champs rejetés : 2");
    assertStringIncludes(refus, "Réponse attendue : une citation ne se retrouve pas");
    assertEquals(db.prepare("SELECT count(*) n FROM activites").get()!.n, 1);
    assertEquals(db.prepare("SELECT count(*) n FROM objectifs").get()!.n, 1);
    // Un cours qui porte un objectif ne se supprime pas.
    assertThrows(() => supprimer(db, "cours", coursId), Error, "1 objectif(s)");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("exercice : le corrigé n'est ni dans la page ni servi avant une tentative, un autre compte reçoit 404", async () => {
  const { db, dir, coursId, source, prof, eleve } = await cadre();
  try {
    const id = await preparer(prof, coursId, source);
    assertEquals(await statut(eleve.requete(`/eleve/activites/${id}`)), 404, "brouillon");
    await relirePublier(prof, db, id);

    const secrets = [ATTENDU, CRITERE, RETOUR, "dans toute la façade", "debut=", "/eleve/sources/"];
    for (const html of [
      await page(eleve, `/eleve/activites/${id}`),
      await page(prof, `/prof/activites/${id}/apercu`),
    ]) {
      assertStringIncludes(html, "Que refuse Gaudí dans la façade de la Casa Batlló ?");
      for (const s of secrets) assert(!html.includes(s), s);
    }
    assertStringIncludes(await page(eleve, "/eleve"), `/eleve/activites/${id}`);
    const avant = `/eleve/activites/${id}/tentatives/inconnue/criteres`;
    assertEquals(await statut(envoyer(eleve, avant, { criteres: "0" })), 404);

    const r = await envoyer(eleve, `/eleve/activites/${id}/tentatives`, { reponse: "Les angles." });
    assertEquals(r.status, 303);
    const corrige = await page(eleve, `/eleve/activites/${id}`);
    for (const s of [ATTENDU, CRITERE, RETOUR, "Les angles.", "revision=1#passage"]) {
      assertStringIncludes(corrige, s);
    }
    const lien = corrige.match(/href="(\/eleve\/sources\/[^"#]+)/)![1].replaceAll("&amp;", "&");
    assertStringIncludes(await page(eleve, lien), '<mark id="passage">');
    const t = db.prepare("SELECT id, revision, criteres FROM tentatives").get()!;
    const coches = `/eleve/activites/${id}/tentatives/${t.id}/criteres`;
    assertEquals(await statut(envoyer(eleve, coches, { criteres: ["1", "7"] })), 303);
    assertEquals(
      { ...db.prepare("SELECT revision, criteres, reponse FROM tentatives").get() },
      { revision: 1, criteres: "[1]", reponse: "Les angles." },
    );
    assertStringIncludes(
      await page(eleve, `/eleve/activites/${id}`),
      "Tu as coché 1 critère sur 2.",
    );

    // La tentative d'un élève n'ouvre pas le corrigé d'un autre.
    const camarade = await compte(db, "eleve");
    assert(!(await page(camarade, `/eleve/activites/${id}`)).includes(ATTENDU));
    assertEquals(await statut(envoyer(camarade, coches, { criteres: "0" })), 404);

    // Hors du cours : ni l'exercice, ni sa préparation, ni ses actions.
    const dehors = await compte(db, "eleve", undefined, false);
    const etranger = await compte(db, "enseignant", undefined, false);
    assertEquals(await statut(dehors.requete(`/eleve/activites/${id}`)), 404);
    assertEquals(
      await statut(envoyer(dehors, `/eleve/activites/${id}/tentatives`, { reponse: "x" })),
      404,
    );
    assert(!(await page(dehors, "/eleve")).includes(`/eleve/activites/${id}`));
    for (const url of [`/prof/activites/${id}`, `/prof/activites/${id}/apercu`]) {
      assertEquals(await statut(etranger.requete(url)), 404, url);
    }
    const modifier = envoyer(etranger, `/prof/activites/${id}/modifier`, formulaire(db, id));
    assertEquals(await statut(modifier), 404);
    assert(!(await page(etranger, "/prof/activites")).includes(id));
    const ailleurs = { cours_id: coursId, intitule: "Objectif", sources: source };
    assertEquals(await statut(envoyer(etranger, "/prof/activites", ailleurs)), 400);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("exercice : une modification crée une version et retire la relecture", async () => {
  const { db, dir, coursId, source, prof, eleve } = await cadre();
  try {
    const id = await preparer(prof, coursId, source);
    await relirePublier(prof, db, id);
    const collegue = await compte(db, "enseignant");

    const r = await envoyer(
      prof,
      `/prof/activites/${id}/modifier`,
      formulaire(db, id, { texte_1: "Il refuse la ligne droite." }),
    );
    assertEquals(r.status, 303);
    assertEquals([ligne(db, id).etat, ligne(db, id).revision], ["brouillon", 2]);
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
    assertEquals(
      db
        .prepare("SELECT action, revision FROM relectures WHERE activite_id = ? ORDER BY rowid")
        .all(id)
        .map((l) => `${l.action} ${l.revision}`),
      ["relue 1", "publiee 1", "modifiee 2", "relue 2"],
    );
    assertStringIncludes(await page(prof, `/prof/activites/${id}`), "Compte enseignant");

    // Un passage absent de la source, ou un seul critère, ne s'enregistre pas.
    const faux = formulaire(db, id, { citation_1_0: "Gaudí adore la ligne droite partout" });
    const refus = await envoyer(prof, `/prof/activites/${id}/modifier`, faux);
    assertEquals(refus.status, 400);
    assertStringIncludes(await refus.text(), "passage introuvable mot pour mot");
    const seul = formulaire(db, id, { texte_3: "" });
    assertEquals(await statut(envoyer(prof, `/prof/activites/${id}/modifier`, seul)), 400);
    // Enregistrer sans changement garde la version et sa relecture.
    assertEquals(
      await statut(envoyer(prof, `/prof/activites/${id}/modifier`, formulaire(db, id))),
      303,
    );
    assertEquals([ligne(db, id).etat, ligne(db, id).revision], ["relue", 2]);
    // Un formulaire d'une version précédente est refusé.
    assertEquals(
      await statut(
        envoyer(
          prof,
          `/prof/activites/${id}/modifier`,
          formulaire(db, id, { revision: "1", texte_0: "Autre ?" }),
        ),
      ),
      409,
    );
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
    await envoyer(eleve, `/eleve/activites/${id}/tentatives`, { reponse: "Ma réponse." });

    // Une phrase de plus avant le passage cité déplace ses offsets dans la révision 2.
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
    assertEquals(ligne(db, id).etat, "publiee", "une révision en attente ne sert pas encore");
    statuer(db, source, "certifiee", "Prof", 2);
    assertEquals(ligne(db, id).etat, "a_revoir");
    assertEquals(await statut(eleve.requete(`/eleve/activites/${id}`)), 404);
    assert(!(await page(eleve, "/eleve")).includes(`/eleve/activites/${id}`));
    assertStringIncludes(
      await page(prof, `/prof/activites/${id}`),
      "version 1 citée, la source sert la version 2",
    );

    // Enregistrer recherche chaque passage dans la révision servie.
    assertEquals(
      await statut(envoyer(prof, `/prof/activites/${id}/modifier`, formulaire(db, id))),
      303,
    );
    const a = ligne(db, id);
    assertEquals([a.etat, a.revision], ["brouillon", 2]);
    const texte = lireDocument(source, 2).texte;
    for (const c of champsDe(JSON.parse(a.contenu)).flatMap((ch) => ch.citations)) {
      assertEquals(c.revision, 2);
      assertEquals(tranche(texte, c.debut, c.fin), c.citation);
    }
    await relirePublier(prof, db, id);
    assertEquals(
      { ...db.prepare("SELECT revision, reponse FROM tentatives").get() },
      { revision: 1, reponse: "Ma réponse." },
      "la tentative garde la version à laquelle elle répondait",
    );
    assert(
      !(await page(eleve, `/eleve/activites/${id}`)).includes(ATTENDU),
      "nouvelle version, pas de tentative",
    );

    // Des lecteurs sans les élèves retirent la preuve aux élèves du cours.
    const lecteurs = (audience: string) =>
      envoyer(prof, "/prof/sources/statut", { ids: source, statut: "lecteurs", audience });
    assertEquals(await statut(lecteurs("collegues")), 303);
    assertEquals(ligne(db, id).etat, "a_revoir");
    await lecteurs("eleves");
    assertEquals(
      await statut(
        envoyer(
          prof,
          `/prof/activites/${id}/modifier`,
          formulaire(db, id, { texte_0: "Que refuse Gaudí ?" }),
        ),
      ),
      303,
    );
    await relirePublier(prof, db, id);

    statuer(db, source, "rejetee", "Prof");
    assertEquals(ligne(db, id).etat, "a_revoir");
    assertEquals(
      await statut(envoyer(prof, `/prof/activites/${id}/modifier`, formulaire(db, id))),
      400,
      "une source rejetée n'est plus citable",
    );

    // Supprimer la source retire ses passages et les champs rédigés d'après elle.
    await supprimerSource(db, source);
    for (const l of db.prepare("SELECT * FROM activites").all()) {
      assert(!/ligne droite|céramique|Batlló|façade/.test(JSON.stringify(l)), "texte de la source");
      assert(!JSON.stringify(l).includes(source));
    }
    assertEquals(ligne(db, id).etat, "a_revoir");
    assertEquals(
      { ...db.prepare("SELECT revision, reponse FROM tentatives").get() },
      { revision: 1, reponse: "Ma réponse." },
    );
    assertStringIncludes(
      await page(prof, `/prof/activites/${id}`),
      "Vide : sa source a été supprimée.",
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
    assertStringIncludes(
      await page(prof, `/prof/activites/${id}`),
      "Votre relecture ne vaut pas relecture indépendante.",
    );
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
