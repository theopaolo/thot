import { type Context, Hono } from "hono";
import type { Contenu } from "../../core/activite.ts";
import * as Activites from "../activites.ts";
import { csv, lignes, pageReponses } from "../vues/reponses.ts";
import type { Env, Web } from "./web.ts";

/** Les réponses d'une série : la grille, les notes et commentaires de l'enseignant, l'export. */
export function routesReponses(app: Hono<Env>, w: Web) {
  const { db, rendre } = w;

  /** L'exercice, sa série et ses lignes, ou rien si le compte ne lit pas ses tentatives. */
  const lire = (c: Context<Env>) => {
    const compte = c.get("compte");
    const a = Activites.activiteProf(db, compte, c.req.param("id")!);
    const tentatives = a && Activites.tentativesLues(db, compte, a);
    if (!a || !tentatives || a.type !== "exercice") return undefined;
    const contenu = JSON.parse(a.contenu) as Contenu;
    return {
      a,
      contenu,
      liste: lignes(contenu, Activites.elevesSuivis(db, compte, a), tentatives),
    };
  };

  app.get("/prof/activites/:id/reponses", (c) => {
    const x = lire(c);
    return x
      ? c.html(rendre(c, `Réponses : ${x.a.titre}`, pageReponses(x.a, x.contenu, x.liste)))
      : c.notFound();
  });

  app.get("/prof/activites/:id/reponses.csv", (c) => {
    const x = lire(c);
    if (!x) return c.notFound();
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="reponses-${x.a.id}.csv"`);
    c.header("Cache-Control", "no-store");
    return c.body(csv(x.a, x.contenu, x.liste));
  });

  // Avant la route des notes : `reprendre` n'est pas un identifiant de question.
  app.post("/prof/activites/:id/reponses/:tentative/reprendre", async (c) => {
    const x = lire(c);
    if (!x) return c.notFound();
    const b = await c.req.parseBody();
    const ok = Activites.aReprendre(
      db,
      c.get("compte"),
      x.a,
      c.req.param("tentative")!,
      b.oui === "1",
    );
    return ok ? c.redirect(`/prof/activites/${x.a.id}/reponses`, 303) : c.notFound();
  });

  app.post("/prof/activites/:id/reponses/:tentative/:q", async (c) => {
    const x = lire(c);
    if (!x) return c.notFound();
    const b = await c.req.parseBody();
    const brute = String(b.note ?? "");
    const note = brute === "" ? null : Number(brute);
    if (note !== null && !Activites.NOTES.includes(note)) return c.text("Note invalide.", 400);
    const [tentative, q] = [c.req.param("tentative")!, c.req.param("q")!];
    try {
      if (
        !Activites.noter(db, c.get("compte"), x.a, tentative, q, note, String(b.commentaire ?? ""))
      ) {
        return c.notFound();
      }
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_SQLITE_ERROR") throw e;
      return c.text((e as Error).message, 400);
    }
    return c.redirect(
      `/prof/activites/${x.a.id}/reponses#r-${encodeURIComponent(tentative)}-${encodeURIComponent(q)}`,
      303,
    );
  });
}
