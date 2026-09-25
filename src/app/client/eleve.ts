let focaliserFeuille = false;

function ouvrirFeuille(declencheur: HTMLElement) {
  const conteneur = declencheur.closest("[data-feuille]");
  if (!conteneur) return;
  if (innerWidth >= 1180) {
    conteneur.querySelector(".colonne-source, .colonne-lecteur")
      ?.setAttribute("aria-live", "polite");
    return;
  }
  conteneur.classList.add("feuille-ouverte");
  focaliserFeuille = true;
  scrollBy({
    top: declencheur.getBoundingClientRect().top - innerHeight * 0.2,
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
}

export function fermerFeuille() {
  const ouverte = document.querySelector(".feuille-ouverte");
  if (!ouverte) return;
  ouverte.classList.remove("feuille-ouverte");
  focaliserFeuille = false;
  ouverte.querySelector<HTMLElement>('[aria-pressed="true"], [aria-current="true"]')
    ?.focus({ preventScroll: true });
}

function verifierQuiz(bouton: HTMLButtonElement) {
  const champ = bouton.previousElementSibling;
  const sortie = document.getElementById("quiz-resultat");
  const reponse = bouton.dataset.answer;
  if (!(champ instanceof HTMLInputElement) || !sortie || reponse === undefined) return;
  const plier = (texte: string) =>
    texte.trim().toLocaleLowerCase("fr").normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");
  const r = plier(champ.value);
  const a = plier(reponse);
  if (!r) sortie.textContent = "Écris une réponse avant de vérifier.";
  else if (r === a || (r.length >= 4 && (` ${a} `).includes(` ${r} `))) {
    sortie.textContent = `Bravo, c'est bien ${reponse}.`;
  } else sortie.textContent = `Pas tout à fait. La réponse attendue : ${reponse}.`;
}

function suivreConversation(conversation: HTMLElement) {
  conversation.scrollTop = conversation.scrollHeight;
  if (!document.querySelector(".feuille-ouverte")) scrollTo(0, document.body.scrollHeight);
}

export function installerEleve() {
  addEventListener("load", () => {
    const conversation = document.getElementById("conversation");
    if (conversation) suivreConversation(conversation);
  });

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const ouverture = event.target.closest<HTMLElement>("[data-ouvrir-feuille]");
    if (ouverture) ouvrirFeuille(ouverture);
    if (event.target.closest(".fermer-feuille")) fermerFeuille();
    const quiz = event.target.closest<HTMLButtonElement>("[data-verifier-quiz]");
    if (quiz) verifierQuiz(quiz);
    const navigation = event.target.closest<HTMLButtonElement>("[data-citation]");
    if (navigation) {
      document.getElementById(`reponse-${navigation.dataset.reponse}`)
        ?.querySelectorAll<HTMLButtonElement>(".citation")[Number(navigation.dataset.citation)]
        ?.click();
    }
  });

  document.addEventListener("keydown", (event) => {
    const champ = event.target;
    if (
      champ instanceof HTMLTextAreaElement && champ.matches(".question-form textarea") &&
      event.key === "Enter" && !event.shiftKey && !event.isComposing
    ) {
      event.preventDefault();
      champ.form?.requestSubmit();
    }
  });

  document.addEventListener("htmx:beforeRequest", (event) => {
    if (event.target instanceof Element && event.target.matches(".question-form")) {
      fermerFeuille();
    }
  });

  document.addEventListener("htmx:afterRequest", (event) => {
    const { elt, successful } = (event as CustomEvent<{
      elt: HTMLElement;
      successful: boolean;
    }>).detail;
    if (!successful) return;
    if (elt instanceof HTMLFormElement && elt.matches(".question-form")) elt.reset();
    if (elt.matches("button.idee")) elt.remove();
    if (elt.matches(".tuile")) {
      document.querySelectorAll(".tuile").forEach((tuile) => {
        tuile.setAttribute("aria-current", String(tuile === elt));
      });
    }
    if (elt.matches(".citation")) {
      document.querySelectorAll(".citation").forEach((citation) => {
        citation.setAttribute("aria-pressed", String(citation === elt));
      });
    }
  });

  document.addEventListener("htmx:afterSettle", (event) => {
    if (event.target instanceof Element) {
      const conversation = event.target.closest<HTMLElement>("#conversation");
      if (conversation && !event.target.closest(".avis")) suivreConversation(conversation);
    }
    if (!focaliserFeuille) return;
    const titre = document.querySelector<HTMLElement>('.feuille-ouverte .feuille [tabindex="-1"]');
    if (titre) {
      focaliserFeuille = false;
      titre.focus({ preventScroll: true });
    }
  });

  document.addEventListener("htmx:sseMessage", (event) => {
    const conversation = event.target instanceof Element &&
      event.target.closest<HTMLElement>("#conversation");
    if (conversation) suivreConversation(conversation);
  });
}
