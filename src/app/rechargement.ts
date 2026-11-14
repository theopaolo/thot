import { watch } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { RACINE } from "./config.ts";
import type { Env } from "./routes/web.ts";

/** Change à chaque relance du serveur par `node --watch`. */
const DEMARRAGE = String(Date.now());

/**
 * Sous `pnpm dev`, la page ouverte suit le code. Une feuille de style modifiée se remplace sans
 * recharger la page. Un fichier reconstruit sous `static/dist/` recharge la page. Un serveur
 * relancé coupe le flux : le navigateur se reconnecte, lit un autre démarrage et recharge.
 */
export function routesRechargement(app: Hono<Env>) {
  const abonnes = new Set<(evenement: "css" | "page") => void>();
  let feuilleSeule = true;
  let attente: ReturnType<typeof setTimeout> | undefined;
  watch(join(RACINE, "static"), { recursive: true }, (_, fichier) => {
    // Une reconstruction écrit plusieurs fichiers d'un coup : la rafale ne donne qu'un signal.
    feuilleSeule &&= fichier === "style.css";
    clearTimeout(attente);
    attente = setTimeout(() => {
      for (const envoyer of abonnes) envoyer(feuilleSeule ? "css" : "page");
      feuilleSeule = true;
    }, 100);
  });
  app.get("/__dev/rechargement", (c) =>
    streamSSE(c, async (flux) => {
      const envoyer = (event: "css" | "page") => void flux.writeSSE({ event, data: "" });
      abonnes.add(envoyer);
      flux.onAbort(() => void abonnes.delete(envoyer));
      await flux.writeSSE({ event: "demarrage", data: DEMARRAGE, retry: 300 });
      while (!flux.aborted) await flux.sleep(30_000);
    }),
  );
}

/** Le script de la page de dev. */
export const SCRIPT_RECHARGEMENT = `
const flux = new EventSource("/__dev/rechargement");
// Un rechargement pendant la relance du serveur tomberait sur une page d'erreur : on attend qu'il
// réponde.
const recharger = () =>
  fetch(location.href, { method: "HEAD" }).then(
    () => location.reload(),
    () => setTimeout(recharger, 300),
  );
let demarrage;
flux.addEventListener("demarrage", (e) => {
  if (demarrage && demarrage !== e.data) recharger();
  demarrage = e.data;
});
flux.addEventListener("page", recharger);
flux.addEventListener("css", () => {
  for (const lien of document.querySelectorAll('link[rel="stylesheet"][href^="/static/"]')) {
    const nouveau = lien.cloneNode();
    nouveau.href = lien.href.split("?")[0] + "?t=" + Date.now();
    nouveau.onload = () => lien.remove();
    lien.after(nouveau);
  }
});
`;
