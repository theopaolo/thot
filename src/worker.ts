import { openrouter } from "./core/modeles.ts";
import { config, preparerDonnees } from "./app/config.ts";
import { cacheModeles, connexion, purgerMessages } from "./app/db.ts";
import {
  proposerInformations,
  relacher,
  revendiquer,
  sourceSansInformations,
  traiter,
} from "./app/ingestion.ts";
import {
  genererSuggestions,
  marquerSuggestions,
  sourceSansSuggestions,
} from "./app/suggestions.ts";

preparerDonnees();
const db = connexion();
const modeles = openrouter(config.modeles, cacheModeles(db));
let prochainePurge = 0;
let enCours: ReturnType<typeof revendiquer>;
const arret = new AbortController();
// Un arrêt demandé, par un déploiement ou `docker stop` : coupe le convertisseur enfant éventuel
// (`pdftotext`), remet le travail en cours en file pour le prochain worker, puis ferme la base.
// Attendre la fin d'une extraction dépasserait le délai de `docker stop`, et le travail tué
// resterait derrière son verrou.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    arret.abort();
    if (enCours) relacher(db, enCours);
    db.close();
    process.exit(0);
  });
}

console.log("worker: en attente de travaux");

while (true) {
  if (Date.now() >= prochainePurge) {
    purgerMessages(db, config.retentionJours);
    prochainePurge = Date.now() + 3_600_000;
  }
  enCours = revendiquer(db);
  if (enCours) {
    try {
      await traiter(db, enCours, modeles, arret.signal);
    } finally {
      enCours = undefined;
    }
    continue;
  }
  // File vide : propositions du profil arts, puis questions suggérées, une source à la fois.
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
