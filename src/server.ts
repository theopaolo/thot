import { serve } from "@hono/node-server";
import { openrouter } from "./core/modeles.ts";
import { config, preparerDonnees } from "./app/config.ts";
import { cacheModeles, connexion } from "./app/db.ts";
import { boucleReponses } from "./app/reponses.ts";
import { creerApp } from "./app/routes.ts";

preparerDonnees();
const db = connexion();
const modeles = openrouter(config.modeles, cacheModeles(db));
const reponses = boucleReponses(db, modeles);
const app = creerApp(db, modeles, reponses);
serve({ fetch: app.fetch, port: config.port, hostname: process.env["THOT_HOST"] ?? "127.0.0.1" });
// Les questions restées en file repartent, et une réponse qu'un arrêt a interrompue reprend une
// fois son verrou expiré.
reponses.reveiller();
setInterval(() => reponses.reveiller(), 10_000);
