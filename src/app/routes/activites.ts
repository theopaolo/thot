import { type Context, Hono } from "hono";
import { PanneModele } from "../../core/modeles.ts";
import { citationsDe, type Explication } from "../../core/activite.ts";
import { lireInstance } from "../instance.ts";
import * as Domaines from "../domaines.ts";
import * as Activites from "../activites.ts";
import * as ActiviteVue from "../vues/activites.ts";
import type { Env, Web } from "./web.ts";

export function routesActivites(app: Hono<Env>, w: Web) {
  const { db, modeles, rendre, feuilleCitation } = w;

  app.get("/prof/activites", (c) => {
    const compte = c.get("compte");
    return c.html(
      rendre(
        c,
        "Activités",
        ActiviteVue.listeProf(
          Activites.activitesProf(db, compte),
          Activites.suiviObjectifs(db, compte),
        ),
      ),
    );
  });
  const pagePreparation = (
    c: Context<Env>,
    saisie: Record<string, unknown> = {},
    erreur = "",
    rejets: string[] = [],
  ) => {
    const compte = c.get("compte");
    const cat = Domaines.catalogueDe(db, compte);
    const voulu = String(saisie.cours_id ?? c.req.query("cours_id") ?? "");
    const cours = cat.cours.find((x) => x.id === voulu) ?? cat.cours[0];
    const personnel = lireInstance(db).mode === "personal";
    const cible = {
      cours_id: cours?.id ?? "",
      audience: personnel ? ("prive" as const) : ("cours" as const),
      auteur_id: compte.id,
    };
    return rendre(
      c,
      "Préparer une activité",
      ActiviteVue.preparation({
        catalogue: cat,
        coursId: cible.cours_id,
        objectifs: cours ? Activites.objectifs(db, cours.id) : [],
        sources: cours ? Activites.sourcesCitables(db, cible) : [],
        personnel,
        saisie,
        erreur,
        rejets,
      }),
    );
  };
  app.get("/prof/activites/nouvelle", (c) => c.html(pagePreparation(c)));
  // La génération tient la requête : les appels de modèle, sans file de travaux.
  app.post("/prof/activites", async (c) => {
    const b = await c.req.parseBody({ all: true });
    let r;
    try {
      r = await Activites.preparer(db, modeles, c.get("compte"), {
        type: b.type === "explication" ? "explication" : "exercice",
        coursId: String(b.cours_id ?? ""),
        objectifId: String(b.objectif_id ?? ""),
        intitule: String(b.intitule ?? ""),
        reference: String(b.reference ?? ""),
        sources: [b.sources ?? []].flat().map(String),
      });
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_SQLITE_ERROR") throw e;
      return c.html(
        pagePreparation(c, b, (e as Error).message),
        e instanceof PanneModele ? 503 : 400,
      );
    }
    if ("erreur" in r) return c.html(pagePreparation(c, b, r.erreur, r.rejets), 422);
    return c.redirect(`/prof/activites/${r.id}`, 303);
  });
  const activiteProf = (c: Context<Env>) =>
    Activites.activiteProf(db, c.get("compte"), c.req.param("id")!);
  const detailActivite = (c: Context<Env>, a: Activites.Activite, erreur?: string) => {
    const contenu = JSON.parse(a.contenu);
    const titre = db.prepare("SELECT titre FROM sources WHERE id = ?");
    return rendre(
      c,
      a.intitule,
      ActiviteVue.detailProf({
        a,
        contenu,
        relectures: Activites.relectures(db, a.id),
        servies: Activites.servies(db, a),
        titres: new Map(
          citationsDe(contenu).map((x) => [
            x.source_id,
            String(titre.get(x.source_id)?.titre ?? ""),
          ]),
        ),
        tentatives: Activites.tentativesLues(db, c.get("compte"), a),
        erreur,
      }),
    );
  };
  app.get("/prof/activites/:id", (c) => {
    const a = activiteProf(c);
    return a ? c.html(detailActivite(c, a)) : c.notFound();
  });
  /** La page de l'élève, ou son aperçu : la consigne d'un exercice sans corrigé avant la réponse. */
  const pageActivite = (c: Context<Env>, a: Activites.Activite, apercu = false) => {
    const vue = {
      a,
      contenu: JSON.parse(a.contenu),
      relecteur: Activites.relecteur(db, a),
      apercu,
    };
    return rendre(
      c,
      a.intitule,
      a.type === "explication"
        ? ActiviteVue.explication(vue)
        : ActiviteVue.pratique({
            ...vue,
            tentative: apercu ? undefined : Activites.tentative(db, c.get("compte"), a),
          }),
    );
  };
  app.get("/prof/activites/:id/apercu", (c) => {
    const a = activiteProf(c);
    return a ? c.html(pageActivite(c, a, true)) : c.notFound();
  });
  const CONFLIT = "Cette activité a changé pendant votre saisie. Relisez sa version actuelle.";
  app.post("/prof/activites/:id/:action{(?:modifier|relire|publier)}", async (c) => {
    const a = activiteProf(c);
    if (!a) return c.notFound();
    const b = await c.req.parseBody();
    const compte = c.get("compte");
    let refus = "";
    try {
      const action = c.req.param("action");
      if (action === "modifier") {
        if ((await Activites.modifier(db, modeles, compte, a, b)) === "conflit") refus = CONFLIT;
      } else if (action === "relire") {
        if (!Activites.relire(db, compte, a, Number(b.revision))) refus = CONFLIT;
      } else {
        const r = Activites.publier(db, compte, a.id, Number(b.revision));
        if (r === "refus") refus = "Seule la version relue d'une activité se publie.";
        if (r === "preuves") refus = "Une source citée ne tient plus : l'activité est à revoir.";
      }
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_SQLITE_ERROR") throw e;
      return c.html(detailActivite(c, a, (e as Error).message), 400);
    }
    if (refus) return c.html(detailActivite(c, activiteProf(c)!, refus), 409);
    return c.redirect(`/prof/activites/${a.id}`, 303);
  });
  // Une activité se lit publiée, dans un cours du compte, tant que ses preuves tiennent. Le corrigé
  // d'un exercice n'est rendu qu'avec une tentative sur sa version actuelle. Une explication n'a ni
  // tentative ni corrigé.
  const activiteEleve = (c: Context<Env>) =>
    Activites.activiteEleve(db, c.get("compte"), c.req.param("id")!);
  const exerciceEleve = (c: Context<Env>) => {
    const a = activiteEleve(c);
    return a?.type === "exercice" ? a : undefined;
  };
  app.get("/eleve/activites/:id", (c) => {
    const a = activiteEleve(c);
    return a ? c.html(pageActivite(c, a)) : c.notFound();
  });
  // Les passages d'une explication, pour l'élève ou dans l'aperçu de l'enseignant.
  const passagesExplication = (c: Context<Env>, a?: Activites.Activite) =>
    a?.type === "explication"
      ? feuilleCitation(c, (JSON.parse(a.contenu) as Explication).affirmations, a.id)
      : c.notFound();
  app.get("/eleve/activites/:id/citations/:n", (c) => passagesExplication(c, activiteEleve(c)));
  app.get("/prof/activites/:id/citations/:n", (c) => passagesExplication(c, activiteProf(c)));
  app.post("/eleve/activites/:id/tentatives", async (c) => {
    const a = exerciceEleve(c);
    if (!a) return c.notFound();
    const reponse = String((await c.req.parseBody()).reponse ?? "").trim();
    if (!reponse || reponse.length > 4000) return c.text("Ta réponse : 1 à 4000 caractères.", 400);
    Activites.repondre(db, c.get("compte"), a, reponse);
    return c.redirect(`/eleve/activites/${a.id}#corrige`, 303);
  });
  app.post("/eleve/activites/:id/tentatives/:tentative/criteres", async (c) => {
    const a = exerciceEleve(c);
    if (!a) return c.notFound();
    const b = await c.req.parseBody({ all: true });
    const coches = [b.criteres ?? []].flat().map(Number);
    return Activites.evaluer(db, c.get("compte"), a, c.req.param("tentative"), coches)
      ? c.redirect(`/eleve/activites/${a.id}#corrige`, 303)
      : c.notFound();
  });
}
