import { fermerFeuille, installerEleve } from "./eleve.ts";
import { installerDepot } from "./depot.ts";
import { installerProf } from "./prof.ts";

installerEleve();
installerDepot();
installerProf();

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
    if (!erreur) return;
    erreur.dataset.defaut ??= erreur.textContent ?? "";
    const xhr = (event as CustomEvent<{ xhr?: XMLHttpRequest }>).detail.xhr;
    erreur.textContent = xhr?.status === 409 ? xhr.responseText : erreur.dataset.defaut;
    erreur.hidden = nom === "htmx:beforeRequest";
  });
}
