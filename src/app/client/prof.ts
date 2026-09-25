export function installerProf() {
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("[data-imprimer]")) globalThis.print();
    const bouton = event.target.closest<HTMLButtonElement>("[data-rejeter-selection]");
    if (bouton?.form) {
      const n = bouton.form.querySelectorAll("[name=ids]:checked").length;
      if (
        !n || !confirm(`Rejeter ${n} source${n > 1 ? "s" : ""} ? Les élèves ne les verront plus.`)
      ) {
        event.preventDefault();
      }
    }
  });

  document.addEventListener("change", (event) => {
    const champ = event.target;
    if (!(champ instanceof HTMLInputElement)) return;
    if (champ.matches("[data-tout-selectionner]")) {
      champ.form?.querySelectorAll<HTMLInputElement>("[name=ids]").forEach((caseSource) => {
        caseSource.checked = champ.checked;
      });
    }
    if (champ.matches('.fichier input[type="file"]')) {
      const sortie = champ.parentElement?.querySelector("output");
      if (sortie) sortie.textContent = champ.files?.[0]?.name ?? "Aucun fichier choisi";
    }
  });

  document.addEventListener("keydown", (event) => {
    const revue = document.querySelector("#legende.relecture");
    if (
      !revue || event.metaKey || event.ctrlKey || event.altKey || event.repeat ||
      event.isComposing || (event.target instanceof Element &&
        event.target.closest("input,textarea,select,[contenteditable]"))
    ) return;
    if (event.key === "e") {
      event.preventDefault();
      revue.querySelector<HTMLTextAreaElement>("#texte")?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const liens = [...revue.querySelectorAll<HTMLAnchorElement>(".file a")];
      const i = liens.findIndex((a) => a.getAttribute("aria-current") === "true");
      const cible = liens[event.key === "ArrowDown" ? i + 1 : i - 1];
      if (cible) {
        event.preventDefault();
        cible.click();
      }
    }
  });

  document.addEventListener("keyup", (event) => {
    if (
      event.metaKey || event.ctrlKey || event.altKey || event.isComposing ||
      (event.target instanceof Element &&
        event.target.closest("input,textarea,select,[contenteditable]"))
    ) return;
    if (event.key === "v" || event.key === "r") {
      document.querySelector<HTMLButtonElement>(
        `#legende [data-raccourci="${event.key}"]`,
      )?.click();
    }
  });
}
