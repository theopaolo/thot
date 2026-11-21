import { existsSync, readFileSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { maintenant } from "../src/app/db.ts";
import { config } from "../src/app/config.ts";
import { lireInstance } from "../src/app/instance.ts";
import { chercherFts } from "../src/core/recherche.ts";
import { demander } from "../src/core/reponse.ts";
import { cleLegende } from "../src/core/modeles.ts";
import type { Profil } from "../src/core/profils.ts";
import { cours, matiere } from "../src/app/domaines.ts";
import { environnement, fauxModeles } from "./outils.ts";
import { commeEleve, compte, envoyer, type Qui, source, statut, texteDe } from "./acces_outils.ts";

const BAUHAUS = "L'école du Bauhaus réunit les arts et l'artisanat à Weimar.";

test("supprimer : le propriétaire efface la source, ses fichiers et ses citations, rien n'en reste en base", async () => {
  const { db, dir } = await environnement();
  try {
    const c1 = cours(db, matiere(db, "Arts appliqués"), "Design");
    const proprio = await compte(db, "enseignant", undefined, [c1]);
    const collegue = await compte(db, "enseignant", undefined, [c1]);
    const eleve = await compte(db, "eleve", undefined, [c1]);
    const cible = await source(db, "Bauhaus", "eleves", proprio.id, c1, BAUHAUS);
    const autre = await source(db, "Casa Batlló", "eleves", proprio.id, c1);
    const schoolId = lireInstance(db).school_id;
    const repondre = async (
      sourceId: string,
      question: string,
      texte: string,
      citation: string,
    ) => {
      const sortie = JSON.stringify({ affirmations: [{ texte, extrait: 1, citation }] });
      const p = { schoolId, lecteur: commeEleve(eleve.id), sourceId };
      const r = await demander(db, fauxModeles({ sorties: [sortie] }).modeles, question, p, 0);
      assert(r.resultat.etat === "answered");
      return { resultat: r.resultat, journal: r.journal };
    };
    const seule = await repondre(
      cible,
      "Que réunit l'école ?",
      "Arts et artisanat.",
      "réunit les arts et l'artisanat",
    );
    const batllo = await repondre(
      autre,
      "Pourquoi pas de ligne droite ?",
      "Pas de ligne droite.",
      "Gaudí refuse la ligne droite dans toute la façade",
    );
    // Les titres de blocs viennent du modèle : ils peuvent nommer la source supprimée.
    const mixte = {
      ...batllo.resultat,
      affirmations: [...seule.resultat.affirmations, ...batllo.resultat.affirmations],
      blocs: [
        {
          type: "tableau",
          colonnes: ["Bauhaus", "Gaudí"],
          lignes: [{ titre: "Idée", affirmations: [0, 1] }],
        },
      ],
    };
    const candidats = [seule, batllo].flatMap((r) => r.journal.candidats as unknown[]);
    const t = maintenant();
    db.prepare(
      "INSERT INTO conversations (id, compte_id, titre, active_le, cree_le) VALUES ('conv', ?, 'Révisions', ?, ?)",
    ).run(eleve.id, t, t);
    const message = (id: string, etat: string, resultat: unknown, journal: unknown, rang: number) =>
      db
        .prepare(
          `INSERT INTO messages (id, compte_id, question, etat, resultat, journal, cree_le, maj_le,
             conversation_id, rang) VALUES (?, ?, 'Question', ?, ?, ?, ?, ?, 'conv', ?)`,
        )
        .run(id, eleve.id, etat, JSON.stringify(resultat), JSON.stringify(journal), t, t, rang);
    message("seule", "answered", seule.resultat, seule.journal, 1);
    message("mixte", "answered", mixte, { ...seule.journal, candidats }, 2);
    message(
      "refus",
      "out_of_corpus",
      { etat: "out_of_corpus", raison: "refus_modele" },
      seule.journal,
      3,
    );
    const img = db
      .prepare(
        "SELECT i.fichier, i.mime, s.profil FROM images i JOIN sources s ON s.id = i.source_id WHERE s.id = ?",
      )
      .get(cible) as { fichier: string; mime: string; profil: Profil };
    const octets = readFileSync(join(dir, "content", cible, "assets", img.fichier));
    const cle = await cleLegende(config.modeles.legende, octets, img.mime, img.profil);
    db.prepare(
      "INSERT INTO cache_modeles VALUES (?, 'Une affiche du Bauhaus.', ?), ('autre', 'Une façade.', ?)",
    ).run(cle, t, t);
    db.prepare(
      "INSERT INTO suggestions VALUES ('sg', ?, 'Que réunit le Bauhaus ?', 'faux', ?)",
    ).run(cible, t);

    const supprimer = (qui: Qui) => statut(envoyer(qui, `/prof/sources/${cible}/supprimer`));
    assert(
      !(await texteDe(collegue, `/prof/sources/${cible}`)).includes("Supprimer définitivement"),
    );
    assertEquals(
      await supprimer(collegue),
      403,
      "un enseignant du cours modifie, il ne supprime pas",
    );
    assertStringIncludes(
      await texteDe(proprio, `/prof/sources/${cible}`),
      "Supprimer définitivement",
    );
    const job = db.prepare(
      "UPDATE ingestion_jobs SET etat = ?, verrou_expire_le = ? WHERE source_id = ?",
    );
    job.run("enriching", maintenant(Date.now() + 60_000), cible);
    assertEquals(
      await supprimer(proprio),
      409,
      "le worker réécrirait des fichiers après la suppression",
    );
    job.run("awaiting_review", null, cible);
    const r = await envoyer(proprio, `/prof/sources/${cible}/supprimer`);
    assertEquals([r.status, r.headers.get("location")], [303, "/prof?supprimee"]);
    assertStringIncludes(
      await texteDe(proprio, "/prof?supprimee"),
      "Source supprimée définitivement.",
    );

    for (const table of [
      "revisions",
      "chunks",
      "images",
      "source_cours",
      "suggestions",
      "ingestion_jobs",
    ]) {
      const n = db.prepare(`SELECT count(*) n FROM ${table} WHERE source_id = ?`).get(cible)!.n;
      assertEquals(n, 0, table);
    }
    const compter = (table: string) => db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n;
    assertEquals(compter("chunks_fts"), compter("chunks"));
    assertEquals(
      db
        .prepare("SELECT cle FROM cache_modeles")
        .all()
        .map((l) => l.cle),
      ["autre"],
    );
    // Ni une ligne, ni un segment de l'index plein texte, ni une page libérée ne garde la source.
    const garde = /bauhaus|weimar|artisanat/i;
    const texte = (v: unknown) =>
      v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : String(v);
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()) {
      const lignes = db.prepare(`SELECT * FROM "${name}"`).all().flatMap(Object.values);
      assert(!garde.test(lignes.map(texte).join(" ")), `${name} garde la source`);
    }
    for (const f of readdirSync(dir).filter((f) => f.startsWith("state.sqlite3"))) {
      assert(!garde.test(readFileSync(join(dir, f)).toString("latin1")), `${f} garde la source`);
    }
    assert(!existsSync(join(dir, "content", cible)));
    const trouvees = chercherFts(db, "façade ligne droite", {
      schoolId,
      lecteur: commeEleve(eleve.id),
    }).map((c) => c.source_id);
    assertEquals(new Set(trouvees), new Set([autre]));
    for (const chemin of [`/prof/sources/${cible}`, `/media/${cible}-0`]) {
      assertEquals(await statut(proprio.requete(chemin)), 404, chemin);
    }
    assertEquals(await statut(eleve.requete(`/eleve/sources/${cible}`)), 404);

    // La réponse qui ne citait que la source devient indisponible, l'autre garde la Casa Batlló.
    const ligne = (id: string) =>
      db.prepare("SELECT etat, resultat, journal FROM messages WHERE id = ?").get(id)!;
    assertEquals(ligne("seule").etat, "failed");
    const reste = JSON.parse(ligne("mixte").resultat as string);
    assertEquals(
      reste.affirmations.map((a: { source_id: string }) => a.source_id),
      [autre],
    );
    assertEquals([reste.blocs, reste.source_supprimee], [undefined, true]);
    const journal = JSON.parse(ligne("refus").journal as string);
    assertEquals(
      [ligne("refus").etat, journal.candidats, journal.tentatives],
      ["out_of_corpus", [], undefined],
    );
    const page = await texteDe(eleve, "/eleve/chat/conv");
    assertStringIncludes(page, "Une source citée a été supprimée.");
    assertStringIncludes(page, "la partie de la réponse qui la citait est retirée");
    assertStringIncludes(page, "Pas de ligne droite.");
    assertStringIncludes(
      await texteDe(eleve, "/eleve/messages/mixte/citations/0"),
      "refuse la ligne droite",
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});
