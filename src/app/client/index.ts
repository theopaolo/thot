import { fermerFeuille, installerEleve } from "./eleve.ts";
import { installerDepot } from "./depot.ts";
import { installerProf } from "./prof.ts";

installerEleve();
installerDepot();
installerProf();

/**
 * Un bouton « Copier » sur chaque bloc de code d'un document. Il vit hors du `<pre>`, qui défile
 * en largeur. Sans presse-papiers, le code reste sélectionnable à la main.
 */
function boutonsCopier(racine: Element) {
  if (!navigator.clipboard) return;
  for (const pre of racine.querySelectorAll<HTMLElement>(".document pre:not([data-mermaid])")) {
    if (pre.parentElement?.classList.contains("bloc-code")) continue;
    const cadre = document.createElement("div");
    cadre.className = "bloc-code";
    const bouton = document.createElement("button");
    bouton.type = "button";
    bouton.className = "copier";
    bouton.textContent = "Copier";
    bouton.addEventListener("click", () => {
      navigator.clipboard.writeText(pre.textContent ?? "").then(
        () => (bouton.textContent = "Copié"),
        () => (bouton.textContent = "Copie refusée"),
      );
      setTimeout(() => (bouton.textContent = "Copier"), 2000);
    });
    pre.before(cadre);
    cadre.append(bouton, pre);
  }
}

// Mermaid, KaTeX et Shiki ne se chargent que pour un contenu qui a un schéma, une formule ou du
// code dans un langage nommé : la page, ou une réponse que htmx vient de poser.
document.addEventListener("htmx:load", (event) => {
  const racine = event.target;
  if (!(racine instanceof Element)) return;
  boutonsCopier(racine);
  if (racine.querySelector("[data-mermaid]")) {
    void import("./schemas.ts").then((m) => m.dessiner(racine));
  }
  if (racine.querySelector("[data-langage]")) {
    void import("./coloration.ts").then((m) => m.colorer(racine));
  }
  if (racine.querySelector("[data-tex]")) {
    void import("./formules.ts").then((m) => m.ecrire(racine));
  }
});

document.addEventListener("keydown", (event) => {
  const saisie =
    event.target instanceof Element &&
    event.target.closest("input,textarea,select,[contenteditable]");
  if (event.key === "/" && !saisie && !event.metaKey && !event.ctrlKey && !event.altKey) {
    const champ = document.getElementById("texte");
    if (champ) {
      event.preventDefault();
      champ.focus();
    }
  }
  if (event.key === "Escape") {
    const menu = document.querySelector<HTMLDetailsElement>("details.compte[open]");
    if (menu) {
      menu.open = false;
      menu.querySelector("summary")?.focus();
    } else fermerFeuille();
  }
});

// Un conflit (409) dit pourquoi en clair : conversation archivée ailleurs, réponse déjà en cours.
// La limite de questions par heure (429) dit quand revenir.
for (const nom of ["htmx:beforeRequest", "htmx:responseError", "htmx:sendError"]) {
  document.addEventListener(nom, (event) => {
    const erreur = document.getElementById("erreur-reseau");
    // Un rafraîchissement périodique tourne en fond, sans geste de la personne : il ne touche
    // pas à l'alerte.
    const fond = event.target instanceof Element && event.target.matches('[hx-trigger^="every"]');
    if (!erreur || fond) return;
    erreur.dataset.defaut ??= erreur.textContent ?? "";
    const xhr = (event as CustomEvent<{ xhr?: XMLHttpRequest }>).detail.xhr;
    erreur.textContent = [409, 429].includes(xhr?.status ?? 0)
      ? xhr!.responseText
      : erreur.dataset.defaut;
    erreur.hidden = nom === "htmx:beforeRequest";
  });
}
