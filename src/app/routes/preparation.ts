import { type Context, Hono } from "hono";
import type { Contenu } from "../../core/activite.ts";
import { PanneModele } from "../../core/modeles.ts";
import { depuisCarnet } from "../../core/questions.ts";
import { libelles, lireInstance } from "../instance.ts";
import * as Domaines from "../domaines.ts";
import * as Activites from "../activites.ts";
import type { Env, Web } from "./web.ts";
import * as PreparationVue from "../vues/preparation.ts";

/** Préparer une activité : la faire rédiger par Thot, ou importer un quiz. */
export function routesPreparation(app: Hono<Env>, w: Web) {
  const { db, modeles, rendre } = w;
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
    return rendre(
      c,
      "Préparer une activité",
      PreparationVue.preparation({
        catalogue: cat,
        libelles: libelles(db),
        coursId: cours?.id ?? "",
        objectifs: cours ? Activites.objectifs(db, cours.id) : [],
        sources: cours
          ? Activites.sourcesCitables(db, Activites.cibleDe(db, compte, cours.id))
          : [],
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
        nombre: Number(b.nombre || 1),
        types: [b.types ?? []].flat().map(String),
        correction: b.correction === "question" ? "question" : "serie",
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

  const CONFLIT = "Cette activité a changé pendant la rédaction. Relisez sa version actuelle.";
  /** Rédige une question puis revient à l'activité, avec le motif de l'échec dans l'adresse. */
  const regenerer = async (c: Context<Env>, cible: { question: string } | { type: string }) => {
    const a = Activites.activiteProf(db, c.get("compte"), c.req.param("id")!);
    if (!a) return c.notFound();
    const b = await c.req.parseBody();
    const retour = (erreur: string) =>
      c.redirect(`/prof/activites/${a.id}?erreur=${encodeURIComponent(erreur)}`, 303);
    try {
      // Sans `revision` dans le formulaire, la version lue ici fait foi.
      const revision = b.revision === undefined ? a.revision : Number(b.revision);
      const r = await Activites.regenerer(db, modeles, c.get("compte"), a, revision, cible);
      if (r === "conflit") return retour(CONFLIT);
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_SQLITE_ERROR") throw e;
      return retour((e as Error).message);
    }
    // Une question rédigée de nouveau change d'identifiant : l'ancre vise celle qui a pris son rang.
    const lire = (x: Activites.Activite) => (JSON.parse(x.contenu) as Contenu).questions;
    const rang = "question" in cible ? lire(a).findIndex((q) => q.id === cible.question) : -1;
    const id = rang < 0 ? "" : lire(Activites.activiteProf(db, c.get("compte"), a.id)!)[rang].id;
    return c.redirect(`/prof/activites/${a.id}${id ? `#q-${id}` : ""}`, 303);
  };
  app.post("/prof/activites/:id/questions/proposer", async (c) =>
    regenerer(c, { type: String((await c.req.parseBody()).type ?? "") }),
  );
  app.post("/prof/activites/:id/questions/:q/regenerer", (c) =>
    regenerer(c, { question: c.req.param("q")! }),
  );

  const pageImport = (
    c: Context<Env>,
    saisie: Record<string, unknown> = {},
    erreurs: string[] = [],
  ) => {
    const cat = Domaines.catalogueDe(db, c.get("compte"));
    const voulu = String(saisie.cours_id ?? c.req.query("cours_id") ?? "");
    const cours = cat.cours.find((x) => x.id === voulu) ?? cat.cours[0];
    return rendre(
      c,
      "Importer un quiz",
      PreparationVue.importation({
        catalogue: cat,
        libelles: libelles(db),
        coursId: cours?.id ?? "",
        objectifs: cours ? Activites.objectifs(db, cours.id) : [],
        saisie,
        erreurs,
      }),
    );
  };
  app.get("/prof/activites/importer", (c) => c.html(pageImport(c)));
  app.post("/prof/activites/importer", async (c) => {
    const b = await c.req.parseBody();
    const refus = (...erreurs: string[]) => c.html(pageImport(c, b, erreurs), 400);
    const fichier = b.fichier;
    if (!(fichier instanceof File) || !fichier.size) return refus("Choisissez un fichier JSON.");
    if (fichier.size > 1_000_000) return refus("Le fichier dépasse 1 Mo.");
    let json: unknown;
    try {
      json = JSON.parse(await fichier.text());
    } catch {
      return refus("Le fichier n'est pas du JSON valide.");
    }
    const quiz = depuisCarnet(json);
    if ("erreurs" in quiz) return refus(...quiz.erreurs);
    let id;
    try {
      id = Activites.inserer(db, c.get("compte"), {
        type: "exercice",
        coursId: String(b.cours_id ?? ""),
        objectifId: String(b.objectif_id ?? ""),
        intitule: String(b.intitule ?? ""),
        reference: "",
        titre: quiz.titre,
        // Un quiz de carnet-quiz donne un indice après une première erreur.
        contenu: { correction: "question", questions: quiz.questions },
      });
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_SQLITE_ERROR") throw e;
      return refus((e as Error).message);
    }
    return c.html(
      rendre(
        c,
        "Quiz importé",
        PreparationVue.importee({
          id,
          titre: quiz.titre,
          questions: quiz.questions.length,
          ignores: quiz.ignores,
        }),
      ),
    );
  });
}
