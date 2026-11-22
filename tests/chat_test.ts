import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { lecteur, lireCompte } from "../src/app/comptes.ts";
import { contenu } from "../src/app/config.ts";
import { resumeQuestionsDesEleves } from "../src/app/conversations.ts";
import { maintenant } from "../src/app/db.ts";
import { chunksSource, relireLegende, statuer, supprimerSource } from "../src/app/ingestion.ts";
import { affiliations, cours, theme } from "../src/app/domaines.ts";
import { environnement, fauxModeles, session } from "./outils.ts";
import { CHAMPS, poserQuestion, REPONSE_CITEE, sourceTraitee } from "./source_outils.ts";

test("le chat: question, flux SSE, réponse citée, panneau source", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  statuer(db, id, "certifiee", "test");
  const bonne = JSON.stringify({
    affirmations: [
      {
        texte: "Gaudí refuse la ligne droite.",
        extrait: 1,
        citation: "Gaudí refuse la ligne droite dans toute la façade",
      },
    ],
  });
  const { requete } = await session(db, fauxModeles({ sorties: [bonne] }).modeles, "eleve");
  const q = await requete("/eleve/questions", {
    method: "POST",
    headers: { "HX-Request": "true" },
    body: new URLSearchParams({ texte: "Pourquoi pas de ligne droite ?" }),
  });
  const fragment = await q.text();
  const mid = fragment.match(/messages\/([\w-]+)\/flux/)![1];
  const flux = await (await requete(`/eleve/messages/${mid}/flux`)).text();
  assertStringIncludes(flux, "event: reponse");
  assertStringIncludes(flux, "Gaudí refuse la ligne droite.");
  // Une reconnexion relit la réponse enregistrée sans rappeler le générateur, qui n'a plus de sortie.
  assertStringIncludes(
    await (await requete(`/eleve/messages/${mid}/flux`)).text(),
    "event: reponse",
  );
  const panneau = await (await requete(`/eleve/messages/${mid}/citations/0`)).text();
  assertStringIncludes(panneau, "<mark>Gaudí refuse la ligne droite dans toute la façade</mark>");
  assertStringIncludes(panneau, `/eleve/sources/${id}?debut=`);
});

test("chapitre, suivi, avis et revue enseignant restent liés à la question", async () => {
  const { db } = await environnement();
  const source = await sourceTraitee(db);
  statuer(db, source, "certifiee", "test");
  // L'ancien chapitre « ATC Art Nouveau » est le thème de même nom de la source.
  const c = cours(db, db.prepare("SELECT id FROM matieres").get()!.id as string, "Design");
  const t = theme(db, c, CHAMPS.sequence);
  affiliations(db, source, [{ cours_id: c, theme_id: t }]);
  const bonne = JSON.stringify({
    affirmations: [
      {
        texte: "Gaudí refuse la ligne droite.",
        extrait: 1,
        citation: "Gaudí refuse la ligne droite dans toute la façade",
      },
    ],
  });
  const f = fauxModeles({ sorties: [bonne, bonne, bonne] });
  let reformulation = "";
  f.modeles.reformuler = (precedente, question) => {
    reformulation = `${precedente} / ${question}`;
    return Promise.resolve("Casa Batlló façade ligne droite");
  };
  const eleve = await session(db, f.modeles, "eleve");
  const premier = await eleve.requete("/eleve/questions", {
    method: "POST",
    headers: { "HX-Request": "true" },
    body: new URLSearchParams({
      texte: "Pourquoi Gaudí refuse la ligne droite ?",
      chapitre: "ATC Art Nouveau",
    }),
  });
  const id1 = (await premier.text()).match(/messages\/([\w-]+)\/flux/)![1];
  assertStringIncludes(
    await (await eleve.requete(`/eleve/messages/${id1}/flux`)).text(),
    "Gaudí refuse",
  );
  // Une page d'avant les thèmes envoie un chapitre : la question part dans son thème.
  const conversation = db.prepare("SELECT conversation_id FROM messages WHERE id = ?").get(id1)!
    .conversation_id as string;
  const portee = db
    .prepare(
      `SELECT m.theme_id || ' ' || v.theme_id AS t FROM messages m
       JOIN conversations v ON v.id = m.conversation_id WHERE m.id = ?`,
    )
    .get(id1)!.t;
  assertEquals(portee, `${t} ${t}`);
  const second = await eleve.requete("/eleve/questions", {
    method: "POST",
    headers: { "HX-Request": "true" },
    body: new URLSearchParams({ texte: "Et la façade ?", conversation }),
  });
  const id2 = (await second.text()).match(/messages\/([\w-]+)\/flux/)![1];
  assertStringIncludes(
    await (await eleve.requete(`/eleve/messages/${id2}/flux`)).text(),
    "Gaudí refuse",
  );
  assertStringIncludes(reformulation, "Pourquoi Gaudí refuse la ligne droite ? / Et la façade ?");
  const demande = f.vus.at(-1)![1].content as string;
  assertStringIncludes(demande, "Question précédente : Pourquoi Gaudí refuse la ligne droite ?");
  assertStringIncludes(demande, "Question de l'eleve : Et la façade ?");
  assert(!demande.includes("Casa Batlló façade ligne droite"));
  assertEquals(
    JSON.parse(db.prepare("SELECT journal FROM messages WHERE id = ?").get(id2)!.journal as string)
      .question_recherche,
    "Casa Batlló façade ligne droite",
  );
  reformulation = "";
  assertEquals(
    (
      await eleve.requete(`/eleve/chat/${conversation}/perimetre`, {
        method: "POST",
        body: new URLSearchParams({ matiere_id: "", cours_id: "", theme_id: "" }),
      })
    ).status,
    303,
  );
  const sansChapitre = await eleve.requete("/eleve/questions", {
    method: "POST",
    headers: { "HX-Request": "true" },
    body: new URLSearchParams({ texte: "Et Gaudí ?", conversation }),
  });
  const id3 = (await sansChapitre.text()).match(/messages\/([\w-]+)\/flux/)![1];
  await eleve.requete(`/eleve/messages/${id3}/flux`);
  assertEquals(
    reformulation,
    "",
    "après un changement de périmètre, la question ne reprend pas la précédente",
  );
  assertStringIncludes(
    await (await eleve.requete(`/eleve/chat/${conversation}`)).text(),
    "Périmètre changé : toutes tes ressources",
  );
  assertEquals(
    (
      await eleve.requete("/eleve/questions", {
        method: "POST",
        body: new URLSearchParams({ texte: "Question", chapitre: "Chapitre absent" }),
      })
    ).status,
    400,
  );
  assertEquals(
    (
      await eleve.requete(`/eleve/messages/${id2}/avis`, {
        method: "POST",
        body: new URLSearchParams({ avis: "faux" }),
      })
    ).status,
    200,
  );
  // hono/html rend `true` en attribut vide: l'avis choisi doit rester marqué au rechargement.
  assertStringIncludes(
    await (await eleve.requete("/eleve/chat")).text(),
    'aria-pressed="true" name="avis" value="faux"',
  );
  const prof = await session(db, fauxModeles().modeles, "enseignant");
  const revue = await (await prof.requete("/prof/questions")).text();
  assertStringIncludes(revue, "ATC Art Nouveau");
  assertStringIncludes(revue, "Fausse");
  db.prepare("UPDATE messages SET etat = 'failed', resultat = ? WHERE id = ?").run(
    JSON.stringify({ etat: "failed", code: "CITATION_UNVERIFIED", message: "" }),
    id3,
  );
  assertStringIncludes(
    await (await prof.requete("/prof/questions")).text(),
    "Citation non vérifiée",
  );
  db.prepare("UPDATE messages SET resultat = NULL WHERE id = ?").run(id3);
  assertEquals(
    (await eleve.requete(`/eleve/messages/${id3}/relancer`, { method: "POST" })).status,
    200,
    "une panne sans résultat enregistré reste relançable",
  );
});

test("un retrait pendant la génération ou le reclassement n'est pas publié", async () => {
  const { db } = await environnement();
  try {
    const id = await sourceTraitee(db);
    statuer(db, id, "certifiee", "Prof");
    const fake = fauxModeles({ sorties: [REPONSE_CITEE] });
    const generer = fake.modeles.generer;
    fake.modeles.generer = (messages) => {
      statuer(db, id, "rejetee", "Prof");
      return generer(messages);
    };
    const eleve = await session(db, fake.modeles, "eleve");
    const mid = await poserQuestion(eleve.requete);
    const flux = await (await eleve.requete(`/eleve/messages/${mid}/flux`)).text();
    assert(!flux.includes("Gaudí refuse la ligne droite."));
    assertEquals(
      JSON.parse(
        db.prepare("SELECT resultat FROM messages WHERE id = ?").get(mid)!.resultat as string,
      ).code,
      "EVIDENCE_WITHDRAWN",
    );
    statuer(db, id, "certifiee", "Prof");
    const reclasser = fake.modeles.reclasser;
    fake.modeles.reclasser = (q, docs) => {
      statuer(db, id, "rejetee", "Prof");
      return reclasser(q, docs);
    };
    const recherche = await (await eleve.requete("/eleve/recherche?q=ligne")).text();
    assert(!recherche.includes(CHAMPS.titre));
    assert(!recherche.includes("Gaudí refuse la ligne droite"));
  } finally {
    db.close();
  }
});

test("les réponses conservées et leurs panneaux revérifient la preuve actuelle", async () => {
  for (const retrait of ["legende", "source", "public", "titre"] as const) {
    const { db } = await environnement();
    try {
      const prof = await session(db, fauxModeles().modeles, "enseignant");
      const id = await sourceTraitee(db, undefined, undefined, prof);
      statuer(db, id, "certifiee", "Prof");
      relireLegende(db, `${id}-0`, "certified", "", "Prof");
      const sortie =
        retrait === "legende"
          ? JSON.stringify({
              affirmations: [
                {
                  texte: "Les balcons ressemblent à des masques.",
                  extrait: 1,
                  citation: "Façade ondulée aux balcons en forme de masques",
                },
              ],
            })
          : REPONSE_CITEE;
      const eleve = await session(db, fauxModeles({ sorties: [sortie] }).modeles, "eleve");
      const mid = await poserQuestion(eleve.requete, "ligne droite balcons masques");
      await (await eleve.requete(`/eleve/messages/${mid}/flux`)).text();
      assertStringIncludes(
        await (await eleve.requete(`/eleve/messages/${mid}/citations/0`)).text(),
        "<mark>",
      );
      if (retrait === "legende") relireLegende(db, `${id}-0`, "rejected", "", "Prof");
      if (retrait === "source") statuer(db, id, "rejetee", "Prof");
      if (retrait === "public") {
        db.prepare("UPDATE sources SET reponses = 0 WHERE id = ?").run(id);
      }
      if (retrait === "titre") {
        await prof.requete(`/prof/sources/${id}/modifier`, {
          method: "POST",
          body: new URLSearchParams({ titre: "Autre œuvre" }),
        });
      }
      for (const route of ["/eleve/chat", `/eleve/messages/${mid}/flux`]) {
        const vue = await (await eleve.requete(route)).text();
        assertStringIncludes(vue, "Une source de cette réponse a été retirée ou modifiée.");
        assert(!vue.includes(JSON.parse(sortie).affirmations[0].texte));
      }
      assert(
        !(await (await eleve.requete(`/eleve/messages/${mid}/citations/0`)).text()).includes(
          "<mark>",
        ),
      );
      assertEquals(
        (await eleve.requete(`/eleve/messages/${mid}/relancer`, { method: "POST" })).status,
        200,
      );
    } finally {
      db.close();
    }
  }
});

test("suivi des questions : synthèse sur /prof et liste /prof/questions bornée à 100 avec ?toutes=1", async () => {
  const { db } = await environnement();
  try {
    const prof = await session(db, fauxModeles().modeles, "enseignant");
    const eleve = await session(db, fauxModeles().modeles, "eleve");
    const sourceId = await sourceTraitee(db, undefined, undefined, prof);
    statuer(db, sourceId, "certifiee", "Prof");
    const eleveId = db.prepare("SELECT id FROM comptes WHERE role = 'eleve'").get()!.id as string;
    const profCompte = lireCompte(
      db,
      db.prepare("SELECT id FROM comptes WHERE role = 'enseignant'").get()!.id as string,
    )!;
    const matiereId = db.prepare("SELECT id FROM matieres LIMIT 1").get()!.id as string;
    const coursId = cours(db, matiereId, "Design");
    db.prepare("INSERT OR IGNORE INTO membres_cours VALUES (?, ?)").run(coursId, profCompte.id);
    const convId = crypto.randomUUID();
    const tNow = Date.now();
    const recent = maintenant(tNow - 3_600_000);
    const ancien = maintenant(tNow - 10 * 86_400_000);
    db.prepare(
      `INSERT INTO conversations (id, compte_id, titre, matiere_id, cours_id, theme_id, matieres, active_le, cree_le)
       VALUES (?, ?, 'Conv', '', '', '', '', ?, ?)`,
    ).run(convId, eleveId, recent, ancien);
    const ins = db.prepare(
      `INSERT INTO messages (id, compte_id, conversation_id, rang, question, matiere_id, cours_id, theme_id, matieres, etat, cree_le, maj_le)
       VALUES (?, ?, ?, ?, ?, '', '', '', '', ?, ?, ?)`,
    );
    // 102 questions : 2 récentes (dont 1 hors corpus) et 100 anciennes.
    for (let i = 1; i <= 100; i++) {
      ins.run(`m-${i}`, eleveId, convId, i, `Question ancienne ${i}`, "answered", ancien, ancien);
    }
    ins.run("m-101", eleveId, convId, 101, "Question récente 1", "answered", recent, recent);
    ins.run(
      "m-102",
      eleveId,
      convId,
      102,
      "Question récente hors cours",
      "out_of_corpus",
      maintenant(tNow - 1000),
      maintenant(tNow - 1000),
    );

    const resume = resumeQuestionsDesEleves(db, lecteur(profCompte), tNow);
    assertEquals(resume.total, 102);
    assertEquals(resume.semaine, 2);
    assertEquals(resume.sansReponse, 1);
    assertEquals(
      resume.dernieres.map((d) => d.id),
      ["m-102", "m-101", "m-100"],
    );

    const bibliotheque = await (await prof.requete("/prof")).text();
    assertStringIncludes(bibliotheque, "2 cette semaine");
    assertStringIncludes(bibliotheque, "dont 1 sans passage");
    assertStringIncludes(bibliotheque, "Question récente hors cours");

    const bornee = await (await prof.requete("/prof/questions")).text();
    assertEquals((bornee.match(/href="\/prof\/questions\/m-/g) ?? []).length, 100);
    assertStringIncludes(bornee, 'href="/prof/questions?toutes=1"');

    const toutes = await (await prof.requete("/prof/questions?toutes=1")).text();
    assertEquals((toutes.match(/href="\/prof\/questions\/m-/g) ?? []).length, 102);
    assert(!toutes.includes("?toutes=1"));
    assert(eleve.requete);
  } finally {
    db.close();
  }
});

test("anciennes révisions : les chunks découpés restent en cache mémoire et suivent les métadonnées", async () => {
  const { db } = await environnement();
  try {
    const id = await sourceTraitee(db);
    statuer(db, id, "certifiee", "Prof");
    // Passe la source en révision 2 pour que la révision 1 soit une ancienne révision immuable.
    db.prepare("UPDATE sources SET revision = 2 WHERE id = ?").run(id);
    const premier = chunksSource(db, id, 1);
    assert(premier.length > 0);
    // Supprimer les fichiers de révision 1 prouve que le second appel lit le cache mémoire.
    await rm(contenu(id, "document.txt"));
    db.prepare("UPDATE sources SET titre = 'Titre renommé' WHERE id = ?").run(id);
    const second = chunksSource(db, id, 1);
    assertEquals(second.length, premier.length);
    assertStringIncludes(second[0].titre, "Titre renommé");
    // Supprimer la source vide aussi son entrée en cache.
    await supprimerSource(db, id);
  } finally {
    db.close();
  }
});
