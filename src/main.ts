import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { config, preparerDonnees, RACINE } from "./app/config.ts";
import { connexion, migrer } from "./app/db.ts";

// Les migrations tournent une fois, avant les deux processus.
preparerDonnees();
const db = connexion();
const faites = migrer(db);
db.close();
if (faites.length) console.log(`migrations appliquées: ${faites.join(", ")}`);

const dev = process.argv.includes("--watch");
const surveiller = dev ? ["--watch-path=src/", "--watch-path=static/"] : [];
// Lecture du code et des données, écriture des données seules. Le worker lance pdftotext.
const droits = [
  "--permission",
  `--allow-fs-read=${RACINE}`,
  `--allow-fs-read=${config.donnees}`,
  `--allow-fs-write=${config.donnees}`,
  "--allow-net",
];
const lancer = (args: string[]) =>
  spawn(process.execPath, args, {
    cwd: RACINE,
    env: { ...process.env, THOT_DATA_DIR: config.donnees, ...(dev ? { THOT_DEV: "1" } : {}) },
    stdio: ["ignore", "inherit", "inherit"],
  });

const commun = ["--env-file-if-exists=.env", ...surveiller];
const processus = [
  lancer([...droits, ...commun, "src/server.ts"]),
  lancer([...droits, "--allow-child-process", ...commun, "src/worker.ts"]),
];
if (dev) processus.push(lancer([join(RACINE, "node_modules/vite-plus/bin/vp"), "build", "--watch"]));
console.log(`Thot sur http://127.0.0.1:${config.port}`);

// Un processus arrêté entraîne les autres: le serveur ne doit pas accepter de dépôts sans worker.
const arreter = () => {
  for (const p of processus) p.kill("SIGTERM");
};
// Un arrêt demandé sort en 0, même si un processus meurt du signal transmis.
let demande = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    demande = true;
    arreter();
  });
}
const fins = processus.map((p) => once(p, "exit"));
const [code] = await Promise.race(fins);
arreter();
await Promise.allSettled(fins);
process.exit(demande || code === 0 ? 0 : 1);
