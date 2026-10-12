import { serve } from "@hono/node-server";
import { openrouter } from "./core/modeles.ts";
import { config, preparerDonnees } from "./app/config.ts";
import { cacheModeles, connexion } from "./app/db.ts";
import { creerApp } from "./app/routes.ts";

preparerDonnees();
const db = connexion();
const app = creerApp(db, openrouter(config.modeles, cacheModeles(db)));
serve({ fetch: app.fetch, port: config.port, hostname: process.env["THOT_HOST"] ?? "127.0.0.1" });
