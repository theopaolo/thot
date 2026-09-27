import { openrouter } from "./core/modeles.ts";
import { config } from "./app/config.ts";
import { cacheModeles, connexion, purgerMessages } from "./app/db.ts";
import {
  proposerInformations,
  revendiquer,
  sourceSansInformations,
  traiter,
} from "./app/ingestion.ts";
import {
  genererSuggestions,
  marquerSuggestions,
  sourceSansSuggestions,
} from "./app/suggestions.ts";

const db = connexion();
const modeles = openrouter(config.modeles, cacheModeles(db));
let arret = false;
let prochainePurge = 0;
Deno.addSignalListener("SIGTERM", () => (arret = true));

console.log("worker: en attente de travaux");

while (!arret) {
  if (Date.now() >= prochainePurge) {
    purgerMessages(db, config.retentionJours);
    prochainePurge = Date.now() + 3_600_000;
  }
  const job = revendiquer(db);
  if (job) {
    await traiter(db, job, modeles);
    continue;
  }
  // File vide: date, artiste et mouvement proposés, puis questions suggérées, une source à la fois.
  const aDecrire = sourceSansInformations(db);
  if (aDecrire) {
    await proposerInformations(db, modeles, aDecrire);
    continue;
  }
  const source = sourceSansSuggestions(db);
  if (source) {
    try {
      await genererSuggestions(db, modeles, source);
    } catch (e) {
      // ponytail: une panne marque la source comme traitée pour ne pas boucler.
      // `thot suggestions --tout` relance le calcul.
      console.error(`suggestions ${source}: ${(e as Error).message}`);
      marquerSuggestions(db, source);
    }
    continue;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
db.close();
