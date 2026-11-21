import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { environnement, fauxModeles, session } from "./outils.ts";

test("dépôt sans JavaScript : deux fichiers différents du même lot donnent deux sources", async () => {
  const { db, dir } = await environnement();
  try {
    const { requete } = await session(db, fauxModeles().modeles, "enseignant");
    // Le formulaire que le navigateur garde renvoie le même lot, sans clé.
    const deposer = async (nom: string, texte: string) => {
      const f = new FormData();
      f.append("type_document", "cours");
      f.append("lot", "lot-du-formulaire");
      f.append("fichier", new File([texte], nom));
      const r = await requete("/prof/depot", { method: "POST", body: f });
      assertEquals(r.status, 200);
      return r.text();
    };
    const sources = () => db.prepare("SELECT titre FROM sources ORDER BY rowid").all();
    await deposer("gaudi.md", "# Gaudí\n\nLa Casa Batlló.\n");
    const second = await deposer("horta.md", "# Horta\n\nL'hôtel Tassel.\n");
    assertEquals(
      sources().map((s) => s.titre),
      ["gaudi", "horta"],
    );
    assertStringIncludes(second, "« horta » est déposé.");

    // Le même fichier renvoyé avec le même lot retrouve sa source.
    const renvoi = await deposer("horta.md", "# Horta\n\nL'hôtel Tassel.\n");
    assertEquals(sources().length, 2);
    assertStringIncludes(renvoi, "« horta » est déposé.");
    assert(!renvoi.includes("Doublon"), "un renvoi n'est pas un doublon");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});
