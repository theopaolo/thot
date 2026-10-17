import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { FILTRE_ACCES, parametresAcces } from "../../core/recherche.ts";
import { contenu } from "../config.ts";
import type { Env, Web } from "./web.ts";

export function routesMedia(app: Hono<Env>, w: Web) {
  const { db, instance, lu } = w;

  app.get("/media/:id", async (c) => {
    const i = db
      .prepare(
        `SELECT i.fichier, i.mime, i.source_id, i.checksum FROM images i JOIN sources s ON s.id = i.source_id
       WHERE i.id = ? AND s.school_id = ? AND ${FILTRE_ACCES} AND (s.statut = 'certifiee' OR ?)`,
      )
      .get(
        c.req.param("id"),
        instance.school_id,
        ...parametresAcces(lu(c)),
        lu(c).enseignant ? 1 : 0,
      ) as { fichier: string; mime: string; source_id: string; checksum: string } | undefined;
    if (!i) return c.notFound();
    // Le navigateur revalide à chaque affichage : une source devenue privée cesse aussitôt de servir.
    const entetes = { "cache-control": "private, no-cache", etag: `"${i.checksum}"` };
    if (c.req.header("if-none-match") === entetes.etag) return c.body(null, 304, entetes);
    const octets = await readFile(contenu(i.source_id, "assets", i.fichier));
    return c.body(octets, 200, { ...entetes, "content-type": i.mime });
  });
}
