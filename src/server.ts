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
const hote = process.env["THOT_HOST"] ?? "127.0.0.1";
// `pnpm dev` ouvre tous les comptes sans mot de passe : il n'écoute que cette machine.
if (config.dev && !["127.0.0.1", "::1", "localhost"].includes(hote)) {
  throw new Error(`pnpm dev ouvre tous les comptes sans mot de passe : THOT_HOST=${hote} refusé.`);
}
serve({ fetch: app.fetch, port: config.port, hostname: hote });
// Les questions restées en file repartent, et une réponse qu'un arrêt a interrompue reprend une
// fois son verrou expiré.
reponses.reveiller();
setInterval(() => reponses.reveiller(), 10_000);
