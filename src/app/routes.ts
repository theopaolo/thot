import { type Context, Hono } from "hono";
import { html } from "hono/html";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Modeles } from "../core/modeles.ts";
import { MAX_IMAGE } from "./activites.ts";
import { config } from "./config.ts";
import type { Db } from "./db.ts";
import { boucleReponses } from "./reponses.ts";
import { routesActivites } from "./routes/activites.ts";
import { routesPratique } from "./routes/pratique.ts";
import { routesPreparation } from "./routes/preparation.ts";
import { routesReponses } from "./routes/reponses.ts";
import { routesRelecture } from "./routes/relecture.ts";
import { routesChat } from "./routes/chat.ts";
import { routesComptes } from "./routes/comptes.ts";
import { routesDomaines } from "./routes/domaines.ts";
import { routesEleve } from "./routes/eleve.ts";
import { routesMedia } from "./routes/media.ts";
import { routesProf } from "./routes/prof.ts";
import { routesDepot } from "./routes/prof-depot.ts";
import { routesProfEleves } from "./routes/prof-eleves.ts";
import { sessions } from "./routes/session.ts";
import { contexteWeb, type Env, retenirPerimetre } from "./routes/web.ts";
import { routesRechargement } from "./rechargement.ts";
import { icone } from "./icones.ts";

export function creerApp(db: Db, modeles: Modeles, reponses = boucleReponses(db, modeles)) {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    if (config.origine && new URL(c.req.url).host !== new URL(config.origine).host) {
      return c.text("Origine incorrecte.", 421);
    }
    await next();
  });

  // Sous pnpm dev, une page rechargée relit aussi la feuille de style, pas sa copie en cache.
  app.use(config.dev ? "/static/*" : "/static/dist/*", async (c, next) => {
    c.header("Cache-Control", "no-cache");
    await next();
  });
  app.use("/static/*", serveStatic({ root: "./" }));
  if (config.dev) routesRechargement(app);
  app.use("*", csrf(config.origine ? { origin: config.origine } : undefined));

  const session = sessions(db);
  app.use("*", session.verifier);
  for (const chemin of ["/prof", "/prof/eleves", "/eleve", "/eleve/recherche"]) {
    app.use(chemin, retenirPerimetre);
  }

  const w = contexteWeb(db, modeles, reponses);
  routesComptes(app, w, session);
  routesDomaines(app, w);
  routesMedia(app, w);
  routesProf(app, w);
  routesProfEleves(app, w);
  routesDepot(app, w);
  routesRelecture(app, w);
  // Une question porte au plus une image déposée, le quiz importé pèse moins.
  app.use(
    "/prof/activites/*",
    bodyLimit({
      maxSize: MAX_IMAGE + 256 * 1024,
      onError: (c) => c.text("Envoi trop volumineux : une image de 5 Mo au plus.", 413),
    }),
  );
  // `/prof/activites/nouvelle` passe avant `/prof/activites/:id`.
  routesPreparation(app, w);
  routesReponses(app, w);
  routesActivites(app, w);
  routesPratique(app, w);
  routesEleve(app, w);
  routesChat(app, w);

  // Une page d'erreur garde la mise en page et dit où aller. Une requête htmx garde un texte court :
  // le client affiche son propre message sans remplacer la page.
  const erreur = (c: Context<Env>, statut: 404 | 500) => {
    if (c.req.header("HX-Request") && !c.req.header("HX-Boosted")) {
      return c.text(statut === 404 ? "Introuvable." : "Erreur interne.", statut);
    }
    const tu = c.get("compte")?.role === "eleve";
    // Une base en panne ferait échouer la page elle-même : le texte court reste.
    try {
      return c.html(
        w.rendre(
          c,
          statut === 404 ? "Page introuvable" : "Erreur du serveur",
          statut === 404
            ? html`<h1>Page introuvable</h1>
              <p>${
                tu
                  ? "Cette adresse ne mène à aucune page que ton compte peut ouvrir."
                  : "Cette adresse ne mène à aucune page que votre compte peut ouvrir."
              }</p>
              <p><a class="bouton" href="/">${icone("arrow-left")}Retour à l'accueil</a></p>`
            : html`<h1>Erreur du serveur</h1>
              <p>${
                tu
                  ? "Une erreur de Thot a interrompu la page. Ce n'est pas une limite du cours. Réessaie dans un instant."
                  : "Une erreur du serveur a interrompu la page. Réessayez dans un instant. Si elle revient, le journal du serveur en donne la cause."
              }</p>
              <p><a class="bouton" href="/">${icone("arrow-left")}Retour à l'accueil</a></p>`,
        ),
        statut,
      );
    } catch {
      return c.text(statut === 404 ? "Page introuvable." : "Erreur du serveur.", statut);
    }
  };
  app.notFound((c) => erreur(c, 404));
  app.onError((e, c) => {
    if (e instanceof HTTPException) return e.getResponse();
    console.error(e);
    return erreur(c, 500);
  });

  return app;
}
