import { config, RACINE } from "./app/config.ts";
import { connexion, migrer } from "./app/db.ts";

// Les migrations tournent une fois, avant les deux processus.
const db = connexion();
const faites = migrer(db);
db.close();
if (faites.length) console.log(`migrations appliquées: ${faites.join(", ")}`);

const dev = Deno.args.includes("--watch");
const surveiller = dev ? ["--watch=src/,static/"] : [];
const envFile = ["--env-file=.env"];
const lancer = (fichier: string, droits: string[]) =>
  new Deno.Command(Deno.execPath(), {
    args: ["run", ...droits, ...envFile, ...surveiller, fichier],
    cwd: RACINE,
    stdin: "null",
  }).spawn();

const serveur = lancer("src/server.ts", ["-RWNE"]);
const worker = lancer("src/worker.ts", ["-RWNE", "--allow-run=pdftotext"]);
const processus = [serveur, worker];
if (dev) {
  processus.push(new Deno.Command(Deno.execPath(), {
    args: ["task", "build", "--watch"],
    cwd: RACINE,
    stdin: "null",
  }).spawn());
}
console.log(`Thot sur http://127.0.0.1:${config.port}`);

// Un processus arrêté entraîne les autres: le serveur ne doit pas accepter de dépôts sans worker.
const arreter = () => {
  for (const p of processus) {
    try {
      p.kill("SIGTERM");
    } catch { /* déjà sorti */ }
  }
};
for (const signal of ["SIGINT", "SIGTERM"] as const) Deno.addSignalListener(signal, arreter);
const premier = await Promise.race(processus.map((p) => p.status));
arreter();
await Promise.allSettled(processus.map((p) => p.status));
Deno.exit(premier.success ? 0 : 1);
