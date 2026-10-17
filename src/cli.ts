import { openrouter } from "./core/modeles.ts";
import { config, preparerDonnees } from "./app/config.ts";
import { cacheModeles, connexion, migrer } from "./app/db.ts";
import { catalogue } from "./cli/catalogue.ts";
import type { Commande } from "./cli/commun.ts";
import { comptes } from "./cli/comptes.ts";
import { evaluation } from "./cli/evaluation.ts";
import { sources } from "./cli/sources.ts";

// L'ordre des commandes est celui de l'aide.
const COMMANDES: Record<string, Commande> = { ...comptes, ...catalogue, ...sources, ...evaluation };

const [nom = "", ...argv] = process.argv.slice(2);
if (!Object.hasOwn(COMMANDES, nom)) {
  console.log(
    `thot <commande>\n\n${Object.values(COMMANDES)
      .map((c) => c.aide)
      .join("\n")}`,
  );
} else {
  preparerDonnees();
  const db = connexion();
  migrer(db);
  try {
    await COMMANDES[nom].lancer(db, openrouter(config.modeles, cacheModeles(db)), argv);
  } finally {
    db.close();
  }
}
