import { test } from "vite-plus/test";
import { assertEquals } from "@std/assert";
import { cacheModeles, migrer } from "../src/app/db.ts";
import { environnement } from "./outils.ts";

test("les migrations se rejouent sans effet", async () => {
  const { db } = await environnement();
  assertEquals(migrer(db), []);
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
