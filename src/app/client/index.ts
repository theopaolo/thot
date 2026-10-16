import { fermerFeuille, installerEleve } from "./eleve.ts";
import { installerDepot } from "./depot.ts";
import { installerProf } from "./prof.ts";

installerEleve();
installerDepot();
installerProf();

// Mermaid et KaTeX ne se chargent que pour un contenu qui a un schéma ou une formule : la page,
// ou une réponse que htmx vient de poser.
document.addEventListener("htmx:load", (event) => {
  const racine = event.target;
  if (!(racine instanceof Element)) return;
  if (racine.querySelector("[data-mermaid]")) {
    void import("./schemas.ts").then((m) => m.dessiner(racine));
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
for (const nom of ["htmx:beforeRequest", "htmx:responseError", "htmx:sendError"]) {
  document.addEventListener(nom, (event) => {
    const erreur = document.getElementById("erreur-reseau");
    // Le suivi des statuts de la liste tourne en fond : il ne touche pas à l'alerte.
    if (!erreur || (event.target instanceof Element && event.target.matches(".statut"))) return;
    erreur.dataset.defaut ??= erreur.textContent ?? "";
    const xhr = (event as CustomEvent<{ xhr?: XMLHttpRequest }>).detail.xhr;
    erreur.textContent = xhr?.status === 409 ? xhr.responseText : erreur.dataset.defaut;
    erreur.hidden = nom === "htmx:beforeRequest";
  });
}
