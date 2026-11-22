import { type Hono } from "hono";
import { peutModifier } from "../comptes.ts";
import { lireDocument, statuer } from "../ingestion.ts";
import { aRelire } from "../relecture.ts";
import { libelles } from "../instance.ts";
import { pageRelecture } from "../vues/relecture.ts";
import type { Env, Web } from "./web.ts";

/** La relecture en colonnes : la liste des ressources à relire et la ressource choisie à côté. */
export function routesRelecture(app: Hono<Env>, w: Web) {
  const { db, instance, rendre } = w;

  app.get("/prof/relecture", (c) => {
    const liste = aRelire(db, instance.school_id, c.get("compte"));
    const choisie = liste.find((a) => a.id === c.req.query("id")) ?? liste[0];
    let blocs: ReturnType<typeof lireDocument>["blocs"] = [];
    try {
      if (choisie) blocs = lireDocument(choisie.id, choisie.revision).blocs;
    } catch {
      /* pas encore extrait */
    }
    return c.html(
      rendre(
        c,
        "Relecture",
        pageRelecture(liste, choisie, blocs, `Sans ${libelles(db).formes.cours.nom}`),
      ),
    );
  });

  app.post("/prof/relecture/:id/:statut{(?:certifiee|rejetee)}", (c) => {
    const id = c.req.param("id");
    const compte = c.get("compte");
    if (!peutModifier(db, compte, id)) {
      return c.text(
        `Seuls son propriétaire, les administrateurs et les enseignants de ses ${libelles(db).formes.cours.noms} modifient cette source.`,
        403,
      );
    }
    const avant = aRelire(db, instance.school_id, compte);
    try {
      statuer(db, id, c.req.param("statut") as "certifiee" | "rejetee", compte.nom);
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_SQLITE_ERROR") throw e;
      return c.text((e as Error).message, 409);
    }
    // La suivante dans l'ordre de la liste qui attend encore, sinon la première restante.
    const restantes = new Set(aRelire(db, instance.school_id, compte).map((a) => a.id));
    const suivante = avant
      .slice(avant.findIndex((a) => a.id === id) + 1)
      .find((a) => restantes.has(a.id));
    return c.redirect(`/prof/relecture${suivante ? `?id=${suivante.id}` : ""}`, 303);
  });
}
