import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { LISIBLE, parametresLisible } from "../../core/recherche.ts";
import { peutModifier } from "../comptes.ts";
import { cheminImage, imageEnAttente } from "../ingestion.ts";
import type { Env, Web } from "./web.ts";

export function routesMedia(app: Hono<Env>, w: Web) {
  const { db, instance, lu } = w;

  app.get("/media/:id", async (c) => {
    const i = db
      .prepare(
        `SELECT i.fichier, i.revision, i.mime, i.source_id, i.checksum
         FROM images i JOIN sources s ON s.id = i.source_id
         WHERE i.id = ? AND ${LISIBLE}`,
      )
      .get(parametresLisible(instance.school_id, lu(c)), c.req.param("id")) as
      | { fichier: string; revision: number; mime: string; source_id: string; checksum: string }
      | undefined;
    if (!i) return c.notFound();
    // Le navigateur revalide à chaque affichage : une source devenue privée cesse aussitôt de servir.
    const entetes = { "cache-control": "private, no-cache", etag: `"${i.checksum}"` };
    if (c.req.header("if-none-match") === entetes.etag) return c.body(null, 304, entetes);
    const octets = await readFile(cheminImage(i.source_id, i));
    return c.body(octets, 200, { ...entetes, "content-type": i.mime });
  });

  // Une image d'une version à relire. Aucun enseignant ne l'a certifiée : elle ne sort que pour
  // ceux qui modifient la source, sous `/prof` que la session ferme aux élèves, et sans cache.
  app.get("/prof/sources/:id/revisions/:n{[0-9]+}/images/:fichier", async (c) => {
    const id = c.req.param("id");
    const i =
      peutModifier(db, c.get("compte"), id) &&
      imageEnAttente(db, id, Number(c.req.param("n")), c.req.param("fichier"));
    if (!i) return c.notFound();
    return c.body(await readFile(i.chemin), 200, { "content-type": i.mime });
  });
}
