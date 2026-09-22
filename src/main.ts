import { config, RACINE } from "./app/config.ts";
import { connexion, migrer } from "./app/db.ts";

// Les migrations tournent une fois, avant les deux processus.
const db = connexion();
const faites = migrer(db);
db.close();
if (faites.length) console.log(`migrations appliquées: ${faites.join(", ")}`);

const surveiller = Deno.args.includes("--watch") ? ["--watch=src/,static/"] : [];
const envFile = ["--env-file=.env"];
const lancer = (fichier: string, droits: string[]) =>
  new Deno.Command(Deno.execPath(), {
    args: ["run", ...droits, ...envFile, ...surveiller, fichier],
    cwd: RACINE,
    stdin: "null",
  }).spawn();

const serveur = lancer("src/server.ts", ["-RWNE"]);
const worker = lancer("src/worker.ts", ["-RWNE", "--allow-run=pdftotext"]);
console.log(`Thot sur http://127.0.0.1:${config.port}`);

// Si l'un des deux sort, l'autre s'arrête aussi: un worker mort ne doit pas laisser le serveur
// accepter des dépôts que personne ne traite.
const arreter = () => {
  for (const p of [serveur, worker]) {
    try {
      p.kill("SIGTERM");
    } catch { /* déjà sorti */ }
  }
};
for (const signal of ["SIGINT", "SIGTERM"] as const) Deno.addSignalListener(signal, arreter);
const premier = await Promise.race([serveur.status, worker.status]);
arreter();
await Promise.allSettled([serveur.status, worker.status]);
Deno.exit(premier.success ? 0 : 1);
