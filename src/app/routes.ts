import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Modeles } from "../core/modeles.ts";
import { config } from "./config.ts";
import type { Db } from "./db.ts";
import { boucleReponses } from "./reponses.ts";
import { routesActivites } from "./routes/activites.ts";
import { routesChat } from "./routes/chat.ts";
import { routesComptes } from "./routes/comptes.ts";
import { routesDomaines } from "./routes/domaines.ts";
import { routesEleve } from "./routes/eleve.ts";
import { routesMedia } from "./routes/media.ts";
import { routesProf } from "./routes/prof.ts";
import { routesDepot } from "./routes/prof-depot.ts";
import { routesProfEleves } from "./routes/prof-eleves.ts";
import { sessions } from "./routes/session.ts";
import { contexteWeb, type Env } from "./routes/web.ts";

export function creerApp(db: Db, modeles: Modeles, reponses = boucleReponses(db, modeles)) {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    if (config.origine && new URL(c.req.url).host !== new URL(config.origine).host) {
      return c.text("Origine incorrecte.", 421);
    }
    await next();
  });

  app.use("/static/dist/*", async (c, next) => {
    c.header("Cache-Control", "no-cache");
    await next();
  });
  app.use("/static/*", serveStatic({ root: "./" }));
  app.use("*", csrf(config.origine ? { origin: config.origine } : undefined));

  const session = sessions(db);
  app.use("*", session.verifier);

  const w = contexteWeb(db, modeles, reponses);
  routesComptes(app, w, session);
  routesDomaines(app, w);
  routesMedia(app, w);
  routesProf(app, w);
  routesProfEleves(app, w);
  routesDepot(app, w);
  routesActivites(app, w);
  routesEleve(app, w);
  routesChat(app, w);

  app.onError((e, c) => {
    if (e instanceof HTTPException) return e.getResponse();
    console.error(e);
    return c.text("Erreur interne.", 500);
  });

  return app;
}
