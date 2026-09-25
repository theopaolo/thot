import { fermerFeuille, installerEleve } from "./eleve.ts";
import { installerProf } from "./prof.ts";

installerEleve();
installerProf();

document.addEventListener("keydown", (event) => {
  const saisie = event.target instanceof Element &&
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

for (const nom of ["htmx:beforeRequest", "htmx:responseError", "htmx:sendError"]) {
  document.addEventListener(nom, () => {
    const erreur = document.getElementById("erreur-reseau");
    if (erreur) erreur.hidden = nom === "htmx:beforeRequest";
  });
}
