import { test } from "vite-plus/test";
import { assertEquals } from "@std/assert";
import { cacheModeles, migrer } from "../src/app/db.ts";
import { environnement } from "./outils.ts";

test("les migrations se rejouent sans effet", async () => {
  const { db } = await environnement();
  try {
    assertEquals(migrer(db), []);
    const index = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .map((r) => r.name as string),
    );
    for (const nom of [
      "ingestion_jobs_source",
      "source_cours_cours",
      "source_cours_theme",
      "relectures_activite",
      "tentatives_compte",
      "tentatives_cree",
      "messages_cree",
      "lectures_lu",
      "sources_ecole_statut",
      "activites_etat",
    ]) {
      assertEquals(index.has(nom), true, `index ${nom} manquant`);
    }
  } finally {
    db.close();
  }
});

test("la migration efface les jugements anciens et ne se rejoue pas", async () => {
  const { db } = await environnement();
  try {
    db.exec("ALTER TABLE messages DROP COLUMN generation_id");
    db.prepare("DELETE FROM migrations WHERE nom = '0005_coherence.sql'").run();
    cacheModeles(db).ecrire("ancien", JSON.stringify({ reasoning: "PrivateName" }));
    assertEquals(migrer(db), ["0005_coherence.sql"]);
    assertEquals(db.prepare("SELECT count(*) n FROM cache_modeles").get()!.n, 0);
    cacheModeles(db).ecrire("legende", "image");
    assertEquals(migrer(db), []);
    assertEquals(cacheModeles(db).lire("legende"), "image");
  } finally {
    db.close();
  }
});
