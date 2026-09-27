/** Compte la sélection et règle la case « Tout sélectionner » (cochée, partielle ou vide). */
function majSelection(form: HTMLFormElement | null) {
  if (!form) return;
  const cases = [...form.querySelectorAll<HTMLInputElement>("[name=ids]")];
  const n = cases.filter((c) => c.checked).length;
  const tout = form.querySelector<HTMLInputElement>("[data-tout-selectionner]");
  if (tout) {
    tout.checked = n > 0 && n === cases.length;
    tout.indeterminate = n > 0 && n < cases.length;
  }
  const compte = form.querySelector("[data-compte-selection]");
  if (compte) compte.textContent = `${n} sélectionné${n > 1 ? "s" : ""} sur ${cases.length}`;
}

function cocherTout(form: HTMLFormElement | null, coche: boolean) {
  form?.querySelectorAll<HTMLInputElement>("[name=ids]").forEach((c) => c.checked = coche);
  majSelection(form);
}

export function installerProf() {
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("[data-imprimer]")) globalThis.print();
    const bascule = event.target.closest<HTMLButtonElement>("[data-replier-rail]");
    if (bascule) {
      const replie = document.body.classList.toggle("rail-replie");
      bascule.setAttribute("aria-expanded", String(!replie));
      document.cookie = replie
        ? "rail=replie; path=/; max-age=31536000; samesite=lax"
        : "rail=; path=/; max-age=0; samesite=lax";
    }
    const choix = event.target.closest<HTMLButtonElement>("[data-selection]");
    if (choix) cocherTout(choix.form, choix.dataset.selection === "tout");
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
    if (champ.matches("[data-tout-selectionner]")) cocherTout(champ.form, champ.checked);
    if (champ.name === "ids") majSelection(champ.form);
    if (champ.matches('.fichier input[type="file"]')) {
      const sortie = champ.parentElement?.querySelector("output");
      if (sortie) sortie.textContent = champ.files?.[0]?.name ?? "Aucun fichier choisi";
    }
  });

  document.addEventListener("keydown", (event) => {
    const coche = document.querySelector<HTMLInputElement>("[name=ids]:checked");
    if (event.key === "Escape" && coche) cocherTout(coche.form, false);
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
    } else if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      const liens = [...revue.querySelectorAll<HTMLAnchorElement>(".file a")];
      const i = liens.findIndex((a) => a.getAttribute("aria-current") === "true");
      const suivant = event.key === "ArrowDown" || event.key === "ArrowRight";
      const cible = liens[suivant ? i + 1 : i - 1];
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
