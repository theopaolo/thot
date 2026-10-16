import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { creerCompte } from "../src/app/comptes.ts";
import type { Db } from "../src/app/db.ts";
import { type Audience, deposer, valider } from "../src/app/depot.ts";
import { cours, inscrire, matiere, supprimer } from "../src/app/domaines.ts";
import { revendiquer, statuer, traiter } from "../src/app/ingestion.ts";
import { lireInstance } from "../src/app/instance.ts";
import type { Modeles } from "../src/core/modeles.ts";
import { chercher, type Perimetre } from "../src/core/recherche.ts";
import { demander } from "../src/core/reponse.ts";
import { environnement, fauxModeles, session } from "./outils.ts";

/** Une source certifiée de la matière, rattachée au cours. */
async function source(
  db: Db,
  matiereId: string,
  coursId: string,
  corps: string,
  audience: Audience = "eleves",
) {
  const v = valider({ titre: "Cours", type_document: "cours", matiere_id: matiereId });
  assert("meta" in v);
  const { source_id } = await deposer(db, {
    meta: v.meta,
    liens: [{ cours_id: coursId, theme_id: null }],
    nomFichier: "cours.html",
    format: "html",
    schoolId: lireInstance(db).school_id,
    enseignant: "Prof",
    audience,
    reponses: true,
    octets: new TextEncoder().encode(`<html>${corps}</html>`),
  });
  await traiter(db, revendiquer(db)!, fauxModeles().modeles);
  statuer(db, source_id, "certifiee", "Test");
}

const PRISME = "La lumière blanche traverse le prisme et se décompose en couleurs";
const VITRAIL = "La lumière du vitrail filtre la lumière du jour en couleurs";

/**
 * Physique a douze sections sur la lumière, l'histoire de l'art deux passages publiés et une note
 * réservée aux enseignants, la philosophie un passage sous le seuil. Le vitrail, rangé en physique
 * et rattaché au cours d'histoire de l'art, appartient aux deux.
 */
async function corpus(db: Db) {
  const physique = matiere(db, "Physique");
  const art = matiere(db, "Histoire de l'art");
  const philo = matiere(db, "Philosophie");
  const [cp, ca, cf] = [physique, art, philo].map((m) => cours(db, m, "Cours"));
  const sections = Array.from({ length: 12 }, (_, i) => `<h2>Optique ${i}</h2><p>${PRISME}.</p>`);
  await source(db, physique, cp, sections.join(""));
  await source(db, physique, ca, `<p>${VITRAIL}.</p>`);
  await source(db, art, ca, "<p>Les impressionnistes peignent la lumière en plein air.</p>");
  await source(db, art, ca, "<p>Turner dissout la lumière dans la brume.</p>", "collegues");
  await source(db, philo, cf, "<p>Goethe oppose sa théorie de la lumière à Newton.</p>");
  return { physique, art, philo, cours: { physique: cp, art: ca, philo: cf } };
}

/** Le prisme passe devant tout, Goethe reste sous le seuil de 0,01. Un seul appel attendu. */
function reclasseur(modeles: Modeles) {
  const appels: number[] = [];
  modeles.reclasser = (_q, docs) => {
    appels.push(docs.length);
    const score = (d: string) =>
      d.includes("prisme") ? 0.9 : d.includes("vitrail") ? 0.6 : d.includes("Goethe") ? 0.001 : 0.5;
    return Promise.resolve(
      docs.map((d, index) => ({ index, score: score(d) })).sort((a, b) => b.score - a.score),
    );
  };
  return appels;
}

test("comparaison : une place par matière, une matière sous le seuil signalée, rien de réservé", async () => {
  const { db, dir } = await environnement();
  try {
    const m = await corpus(db);
    const { modeles } = fauxModeles();
    const appels = reclasseur(modeles);
    const p: Perimetre = {
      schoolId: lireInstance(db).school_id,
      lecteur: null,
      matieres: [m.physique, m.art, m.philo],
    };
    const r = await chercher(db, modeles, "lumière", p, 0.01);
    // 20 candidats partagés en trois : six au plus par matière, un seul reclassement.
    assertEquals(appels.length, 1);
    assert(r.candidats.filter((c) => c.matieres!.includes("Physique")).length <= 6);
    assertEquals(r.retenus.length, 5);
    assertEquals(
      r.retenus.map((c) => c.matieres!.join(", ")),
      ["Physique", "Physique", "Physique", "Physique", "Histoire de l'art, Physique"],
    );
    assertEquals(r.sansPassage, ["Philosophie"]);
    assert(!r.candidats.some((c) => c.preuve.includes("Turner")));

    await creerCompte(db, "prof-art", "Prof d'art", "enseignant");
    const id = db.prepare("SELECT id FROM comptes WHERE identifiant = 'prof-art'").get()!.id;
    inscrire(db, m.cours.art, id as string);
    const collegue = { id: id as string, enseignant: true, administrateur: false };
    const pourProf = await chercher(db, modeles, "lumière", { ...p, lecteur: collegue }, 0.01);
    assert(pourProf.candidats.some((c) => c.preuve.includes("Turner")));

    // Une matière seule garde le chemin ordinaire : ni noms de matière ni place réservée.
    const seule = await chercher(db, modeles, "lumière", { ...p, matieres: [m.art] }, 0.01);
    assertEquals(seule.sansPassage, undefined);
    assert(seule.retenus.every((c) => !c.matieres));
    assertEquals(seule.retenus.length, 2);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("comparaison : les extraits nomment leur matière, chaque phrase garde la sienne", async () => {
  const { db, dir } = await environnement();
  try {
    const m = await corpus(db);
    const sortie = JSON.stringify({
      affirmations: [
        { texte: "La lumière se décompose.", extrait: 1, citation: PRISME },
        { texte: "Le vitrail filtre la lumière.", extrait: 5, citation: VITRAIL },
      ],
    });
    const f = fauxModeles({ sorties: [sortie, sortie] });
    reclasseur(f.modeles);
    const p = { schoolId: lireInstance(db).school_id, lecteur: null };
    const { resultat, journal } = await demander(
      db,
      f.modeles,
      "lumière",
      { ...p, matieres: [m.physique, m.art, m.philo] },
      0.01,
    );
    const [systeme, demande] = f.vus[0].map((x) => x.content);
    assert(systeme.endsWith("dans un tableau, une colonne par matiere."));
    assertStringIncludes(demande, "(matière : Physique)");
    assertStringIncludes(demande, "(matière : Histoire de l'art, Physique)");
    assert(resultat.etat === "answered");
    assertEquals(
      resultat.affirmations.map((a) => a.matiere),
      ["Physique", "Histoire de l'art, Physique"],
    );
    assertEquals(resultat.sans_passage, ["Philosophie"]);
    assertEquals(journal.sans_passage, ["Philosophie"]);

    await demander(db, f.modeles, "lumière", { ...p, matiereId: m.physique }, 0.01);
    const [systemeSeul, demandeSeule] = f.vus[1].map((x) => x.content);
    assert(!systemeSeul.includes("colonne par matiere") && !demandeSeule.includes("matière :"));
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("comparaison dans le chat : choisie par cases, gardée sur chaque échange, lue par les bons enseignants", async () => {
  const { db, dir } = await environnement();
  try {
    const m = await corpus(db);
    // L'élève suit aussi un cours de mathématiques, dont l'enseignant ne lit pas la comparaison.
    const maths = cours(db, matiere(db, "Mathématiques"), "Cours");
    const sortie = JSON.stringify({
      affirmations: [{ texte: "La lumière se décompose.", extrait: 1, citation: PRISME }],
    });
    const f = fauxModeles({ sorties: [sortie] });
    reclasseur(f.modeles);
    const eleve = await session(db, f.modeles, "eleve");
    const texte = async (chemin: string) => (await eleve.requete(chemin)).text();
    const poster = (chemin: string, corps: URLSearchParams) =>
      eleve.requete(chemin, { method: "POST", body: corps });

    assertStringIncludes(await texte("/eleve/chat/nouvelle"), "Comparer des matières");
    const nouvelle = await texte(
      `/eleve/chat/nouvelle?matieres=${m.physique}&matieres=${m.art}&matieres=${m.philo}`,
    );
    assertStringIncludes(nouvelle, "Dans : Histoire de l&#39;art, Philosophie et Physique");
    const liste = [m.physique, m.art, m.philo].sort().join(",");
    assertStringIncludes(nouvelle, `name="matieres" value="${liste}"`);

    const envoi = await poster(
      "/eleve/questions",
      new URLSearchParams({ texte: "Question de comparaison sur la lumière", matieres: liste }),
    );
    const conv = envoi.headers.get("location")!.split("/").pop()!;
    const message = db.prepare("SELECT id, matieres FROM messages").get()!;
    assertEquals(message.matieres, liste);
    const flux = await texte(`/eleve/messages/${message.id}/flux`);
    assertStringIncludes(flux, '<span class="discret">Physique</span>');
    assertStringIncludes(flux, "Aucun passage trouvé en Philosophie.");

    // Une case cochée vaut la matière seule. Un formulaire sans case est refusé.
    const perimetre = (ids: string[]) =>
      poster(
        `/eleve/chat/${conv}/perimetre`,
        new URLSearchParams(ids.map((id) => ["matieres", id])),
      );
    assertEquals((await perimetre([m.art])).status, 303);
    assertEquals(
      { ...db.prepare("SELECT matiere_id, matieres FROM conversations").get() },
      { matiere_id: m.art, matieres: "" },
    );
    assertEquals((await perimetre([])).status, 400);
    assertEquals(
      await (await perimetre(["a", "b", "c", "d", "e"])).text(),
      "Compare 4 matières au plus.",
    );
    assertEquals((await perimetre([m.art, "inconnue"])).status, 400);
    assertEquals((await perimetre([m.physique, m.art])).status, 303);
    assertStringIncludes(
      await texte(`/eleve/chat/${conv}`),
      "Dans : Histoire de l&#39;art et Physique",
    );

    // L'échange va aux enseignants des matières comparées, pas à un autre collègue de l'élève.
    const voit = async (coursId: string) => {
      const prof = await session(db, f.modeles, "enseignant", false);
      const id = db.prepare("SELECT id FROM comptes ORDER BY rowid DESC LIMIT 1").get()!.id;
      inscrire(db, coursId, id as string);
      const page = await (await prof.requete("/prof/questions")).text();
      return page.includes("Question de comparaison");
    };
    assertEquals([await voit(m.cours.art), await voit(maths)], [true, false]);

    const chimie = matiere(db, "Chimie");
    db.prepare("UPDATE messages SET matieres = ?").run(`${chimie},${m.physique}`);
    assertThrows(() => supprimer(db, "matiere", chimie), Error, "1 question(s)");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});
