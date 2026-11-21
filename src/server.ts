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
const serveur = serve({ fetch: app.fetch, port: config.port, hostname: hote });
// Les questions restées en file repartent, et une réponse qu'un arrêt brutal a interrompue reprend
// une fois son verrou expiré.
reponses.reveiller();
setInterval(() => reponses.reveiller(), 10_000);
// Un arrêt demandé, par un déploiement ou `docker stop` : plus de nouvelle connexion, les réponses
// en cours retournent en file pour le prochain serveur, puis la base se ferme.
// ponytail: les requêtes en cours sont coupées. Attendre leur fin si un dépôt interrompu gêne.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    serveur.close();
    reponses.arreter();
    db.close();
    process.exit(0);
  });
}
