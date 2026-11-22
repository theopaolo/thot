import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  compteSaisi,
  creerEleves,
  creerLien,
  eleveGere,
  elevesSansCours,
  estEleveDuCours,
  importerEleves,
  liensGeres,
  reinitialiserMotDePasse,
  revoquerLien,
} from "../comptes.ts";
import { config } from "../config.ts";
import { libelles, lireInstance } from "../instance.ts";
import * as ProfEleves from "../vues/prof-eleves.ts";
import * as Domaines from "../domaines.ts";
import type { Env, Web } from "./web.ts";

export function routesProfEleves(app: Hono<Env>, w: Web) {
  const { db, rendre } = w;
  // Derrière un proxy TLS, la requête arrive en HTTP : l'origine configurée donne la bonne adresse.
  const adresse = (c: Context<Env>) => config.origine || new URL(c.req.url).origin;
  /**
   * Les élèves d'un cours, ou de tous les cours de l'enseignant. Le cours vient de l'adresse, ou du
   * périmètre retenu quand un formulaire refusé rend la page. Un enseignant d'un seul cours y est
   * d'office. Ceux sans cours ne se montrent qu'aux administrateurs, seuls à les gérer.
   */
  const pageEleves = (c: Context<Env>, erreur?: string) => {
    const compte = c.get("compte");
    const cat = Domaines.catalogueDe(db, compte);
    const url = new URL(c.req.url);
    const p = new URLSearchParams(url.search || (getCookie(c, "perimetre") ?? ""));
    const actuel =
      cat.cours.find((x) => x.id === p.get("cours_id")) ??
      (cat.cours.length === 1 ? cat.cours[0] : undefined);
    const matiere = actuel ? "" : (p.get("matiere_id") ?? "");
    const groupes = (actuel ? [actuel] : cat.cours)
      .filter((x) => !matiere || x.matiere_id === matiere)
      .map((cours) => ({
        cours,
        eleves: Domaines.membres(db, cours.id).filter((m) => m.role === "eleve"),
      }));
    const liens =
      lireInstance(db).mode === "personal"
        ? undefined
        : liensGeres(db, compte).filter((x) => !actuel || x.cours.includes(actuel.id));
    return rendre(
      c,
      "Élèves",
      ProfEleves.eleves({
        cat,
        actuel,
        groupes,
        sansCours: actuel ? undefined : elevesSansCours(db, compte),
        liens,
        adresse: adresse(c),
        l: libelles(db),
        matiere,
        erreur,
      }),
    );
  };
  /**
   * Les cours cochés, ou `undefined` si un enseignant n'en coche aucun ou coche un cours qui n'est
   * pas le sien. Un élève sans cours échappe à l'enseignant qui l'a créé.
   */
  const coursCoches = (c: Context<Env>, b: Record<string, unknown>) => {
    const cours = [...new Set([b.cours ?? []].flat().map(String))];
    if (c.get("compte").administrateur) return cours;
    const siens = Domaines.coursDuCompte(db, c.get("compte").id);
    return cours.length && cours.every((id) => siens.has(id)) ? cours : undefined;
  };
  const REFUS_COURS = "Inscription refusée : cochez un ou plusieurs de vos cours.";
  /** Crée les élèves et montre une seule fois leurs identifiants à remettre. */
  const remettre = async (c: Context<Env>, creer: () => ReturnType<typeof creerEleves>) => {
    try {
      const comptes = await creer();
      c.header("Cache-Control", "no-store");
      return c.html(
        rendre(c, "Identifiants élèves", ProfEleves.feuilleIdentifiants(comptes, adresse(c))),
      );
    } catch (e) {
      return c.html(pageEleves(c, (e as Error).message), 400);
    }
  };
  app.get("/prof/eleves", (c) => c.html(pageEleves(c)));
  app.post("/prof/eleves/importer", async (c) => {
    const b = await c.req.parseBody({ all: true });
    const fichier = b.fichier;
    if (!(fichier instanceof File) || fichier.size > 100_000) {
      return c.text("Fichier CSV invalide (100 Ko maximum).", 400);
    }
    const cours = coursCoches(c, b);
    if (!cours) return c.html(pageEleves(c, REFUS_COURS), 400);
    const csv = await fichier.text();
    return remettre(c, () => importerEleves(db, csv, cours));
  });
  app.post("/prof/eleves/ajouter", async (c) => {
    const b = await c.req.parseBody({ all: true });
    const cours = coursCoches(c, b);
    if (!cours) return c.html(pageEleves(c, REFUS_COURS), 400);
    const eleve = compteSaisi(String(b.identifiant ?? ""), String(b.nom ?? ""));
    if (!eleve) {
      return c.html(
        pageEleves(
          c,
          "Élève refusé : un identifiant de 3 à 40 caractères parmi a-z, 0-9, point, tiret et tiret bas, et un nom de 100 caractères au maximum.",
        ),
        400,
      );
    }
    return remettre(c, () => creerEleves(db, [eleve], cours));
  });
  app.post("/prof/eleves/liens", async (c) => {
    if (lireInstance(db).mode === "personal") return c.notFound();
    const b = await c.req.parseBody({ all: true });
    const cours = coursCoches(c, b);
    if (!cours?.length) return c.html(pageEleves(c, REFUS_COURS), 400);
    try {
      creerLien(db, c.get("compte").id, cours, Number(b.jours), Number(b.places));
    } catch (e) {
      return c.html(pageEleves(c, (e as Error).message), 400);
    }
    return c.redirect("/prof/eleves#liens", 303);
  });
  // Révoquer garde les élèves que le lien a inscrits.
  app.post("/prof/eleves/liens/:cle/revoquer", (c) =>
    revoquerLien(db, c.get("compte"), c.req.param("cle"))
      ? c.redirect("/prof/eleves#liens", 303)
      : c.notFound(),
  );
  // Retirer d'un cours laisse le compte. Un enseignant ne retire que des élèves de ses cours.
  app.post("/prof/eleves/:id/retirer", async (c) => {
    const id = c.req.param("id");
    const coursId = String((await c.req.parseBody()).cours_id ?? "");
    if (!estEleveDuCours(db, coursId, id) || !coursCoches(c, { cours: coursId })) {
      return c.notFound();
    }
    Domaines.desinscrire(db, coursId, id);
    return c.redirect(`/prof/eleves?cours_id=${coursId}`, 303);
  });
  app.post("/prof/eleves/:id/reinitialiser", async (c) => {
    const id = c.req.param("id");
    const eleve = eleveGere(db, c.get("compte"), id);
    if (!eleve) return c.notFound();
    const motDePasse = await reinitialiserMotDePasse(db, id);
    c.header("Cache-Control", "no-store");
    return c.html(
      rendre(
        c,
        "Nouveau mot de passe",
        ProfEleves.feuilleIdentifiants([{ ...eleve, motDePasse: motDePasse! }], adresse(c)),
      ),
    );
  });
}
