let focaliserFeuille = false;

function ouvrirFeuille(declencheur: HTMLElement) {
  const conteneur = declencheur.closest("[data-feuille]");
  if (!conteneur) return;
  if (innerWidth >= 1180) {
    conteneur
      .querySelector(".colonne-source, .colonne-lecteur")
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
  ouverte
    .querySelector<HTMLElement>('[aria-pressed="true"], [aria-current="true"]')
    ?.focus({ preventScroll: true });
}

function verifierQuiz(bouton: HTMLButtonElement) {
  const champ = bouton.previousElementSibling;
  const sortie = document.getElementById("quiz-resultat");
  const reponse = bouton.dataset.answer;
  if (!(champ instanceof HTMLInputElement) || !sortie || reponse === undefined) return;
  const plier = (texte: string) =>
    texte
      .trim()
      .toLocaleLowerCase("fr")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\s+/g, " ");
  const r = plier(champ.value);
  // L'artiste ou le mouvement, séparés par `|`.
  const admises = reponse.split("|");
  const juste = admises.find((x) => {
    const a = plier(x);
    return r === a || (r.length >= 4 && ` ${a} `.includes(` ${r} `));
  });
  if (!r) sortie.textContent = "Écris une réponse avant de vérifier.";
  else if (juste) sortie.textContent = `Bravo, c'est bien ${juste}.`;
  else sortie.textContent = `Pas tout à fait. La réponse attendue : ${admises.join(" ou ")}.`;
}

// Une mise à jour ne fait défiler que le lecteur resté à moins de 80 px de la fin. La position se
// mesure juste avant l'ajout : après, la nouvelle réponse éloigne la fin.
const presDeLaFin = () => innerHeight + scrollY >= document.documentElement.scrollHeight - 80;
let auBout = true;

function suivreConversation() {
  if (document.querySelector(".feuille-ouverte")) return;
  if (auBout) scrollTo(0, document.documentElement.scrollHeight);
  const aller = document.querySelector<HTMLElement>("[data-aller-reponse]");
  if (aller) aller.hidden = auBout;
}

/** Tant qu'une réponse attend son flux, « Envoyer » reste désactivé. La saisie reste libre. */
function etatEnvoi() {
  const bouton = document.querySelector<HTMLButtonElement>(".question-form button.principal");
  if (!bouton || !document.getElementById("conversation")) return;
  const enCours = !!document.querySelector("#conversation [sse-connect]");
  bouton.disabled = enCours;
  bouton.lastElementChild!.textContent = enCours ? "Réponse en cours…" : "Envoyer";
}

// Un brouillon par compte et par conversation, le temps de l'onglet.
const brouillon = (form: HTMLFormElement) => `thot:brouillon:${form.dataset.brouillon}`;
// L'élément que le formulaire envoyé désigne pour le focus, une fois la page rechargée.
const FOCUS = "thot:focus";

function ouvrirConversation(racine: Element) {
  const titre = racine.querySelector<HTMLElement>("#titre-chat");
  if (!titre) return;
  const form = racine.querySelector<HTMLFormElement>("form[data-brouillon]");
  const champ = form?.querySelector("textarea");
  if (form && champ) champ.value = sessionStorage.getItem(brouillon(form)) ?? "";
  const cible = sessionStorage.getItem(FOCUS);
  sessionStorage.removeItem(FOCUS);
  // Une nouvelle conversation ne focalise la saisie qu'à partir de 1180 px : un téléphone
  // n'ouvre pas son clavier sans qu'on le demande.
  const nouvelle = form?.dataset.brouillon?.endsWith(":nouvelle") && innerWidth >= 1180;
  const focus = racine.querySelector<HTMLElement>(cible ?? (nouvelle ? "#texte" : "#titre-chat"));
  (focus ?? titre).focus({ preventScroll: true });
  // Le périmètre appliqué s'annonce : la zone polie change après le chargement.
  const perimetre = cible === ".perimetre summary" && racine.querySelector("#perimetre");
  if (perimetre) {
    const texte = perimetre.textContent;
    perimetre.textContent = "";
    setTimeout(() => (perimetre.textContent = texte), 100);
  }
  etatEnvoi();
}

function renommer(form: HTMLFormElement, ouvrir: boolean) {
  const tete = form.parentElement!;
  tete.querySelector<HTMLElement>("#titre-chat")!.hidden = ouvrir;
  tete.querySelector<HTMLElement>(".actions-conversation")!.hidden = ouvrir;
  form.hidden = !ouvrir;
  if (ouvrir) form.querySelector("input")?.select();
  else {
    form.reset();
    tete.querySelector<HTMLElement>("[data-renommer]")?.focus();
  }
}

export function installerEleve() {
  addEventListener("load", () => {
    if (!document.getElementById("conversation")) return;
    auBout = true;
    suivreConversation();
  });
  for (const nom of ["htmx:beforeSwap", "htmx:sseBeforeMessage"]) {
    document.addEventListener(nom, () => (auBout = presDeLaFin()));
  }
  addEventListener(
    "scroll",
    () => {
      const aller = document.querySelector<HTMLElement>("[data-aller-reponse]");
      if (aller && presDeLaFin()) aller.hidden = true;
    },
    { passive: true },
  );
  document.addEventListener("htmx:load", (event) => {
    if (event.target instanceof Element) ouvrirConversation(event.target);
  });

  document.addEventListener("input", (event) => {
    const champ = event.target;
    if (champ instanceof HTMLTextAreaElement && champ.form?.dataset.brouillon) {
      sessionStorage.setItem(brouillon(champ.form), champ.value);
    }
  });
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.dataset.focus) sessionStorage.setItem(FOCUS, form.dataset.focus);
    // Un poste partagé ne garde aucun brouillon après la déconnexion.
    if (form.action.endsWith("/deconnexion")) {
      for (const cle of Object.keys(sessionStorage)) {
        if (cle.startsWith("thot:")) sessionStorage.removeItem(cle);
      }
    }
  });
  // Le brouillon part avec l'envoi réussi. Un échec ou un refus le garde.
  document.addEventListener("htmx:beforeSwap", (event) => {
    const { requestConfig, isError } = (
      event as CustomEvent<{ requestConfig: { elt: Element }; isError: boolean }>
    ).detail;
    const elt = requestConfig.elt;
    if (!isError && elt instanceof HTMLFormElement && elt.dataset.brouillon) {
      sessionStorage.removeItem(brouillon(elt));
    }
  });
  document.addEventListener(
    "toggle",
    (event) => {
      const details = event.target;
      if (details instanceof HTMLDetailsElement && details.open && details.closest(".perimetre")) {
        details.querySelector("select")?.focus();
      }
    },
    true,
  );

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const ouverture = event.target.closest<HTMLElement>("[data-ouvrir-feuille]");
    if (ouverture) ouvrirFeuille(ouverture);
    if (event.target.closest(".fermer-feuille")) fermerFeuille();
    const quiz = event.target.closest<HTMLButtonElement>("[data-verifier-quiz]");
    if (quiz) verifierQuiz(quiz);
    const titre = event.target.closest(".tete-conversation [data-renommer]");
    if (titre) {
      renommer(titre.closest(".tete-conversation")!.querySelector("form.renommer")!, true);
    }
    const annuler = event.target.closest("[data-annuler-renommer]");
    if (annuler) renommer(annuler.closest("form")!, false);
    const aller = event.target.closest<HTMLElement>("[data-aller-reponse]");
    if (aller) {
      aller.hidden = true;
      const reponse = [...document.querySelectorAll<HTMLElement>("#conversation .reponse")].at(-1);
      if (reponse) {
        reponse.tabIndex = -1;
        reponse.scrollIntoView({ block: "start" });
        reponse.focus({ preventScroll: true });
      }
    }
    const navigation = event.target.closest<HTMLButtonElement>("[data-citation]");
    if (navigation) {
      document
        .getElementById(`reponse-${navigation.dataset.reponse}`)
        ?.querySelectorAll<HTMLButtonElement>(".citation")
        [Number(navigation.dataset.citation)]?.click();
    }
  });

  document.addEventListener("keydown", (event) => {
    const champ = event.target;
    if (
      champ instanceof HTMLTextAreaElement &&
      champ.matches(".question-form textarea") &&
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing
    ) {
      event.preventDefault();
      if (!champ.form?.querySelector<HTMLButtonElement>("button.principal")?.disabled) {
        champ.form?.requestSubmit();
      }
    }
    if (event.key === "Escape" && champ instanceof Element) {
      const form = champ.closest<HTMLFormElement>("form.renommer");
      if (form) renommer(form, false);
    }
  });

  document.addEventListener("htmx:beforeRequest", (event) => {
    if (event.target instanceof Element && event.target.matches(".question-form")) {
      fermerFeuille();
    }
  });

  document.addEventListener("htmx:afterRequest", (event) => {
    const { elt, successful } = (
      event as CustomEvent<{
        elt: HTMLElement;
        successful: boolean;
      }>
    ).detail;
    if (!successful) return;
    if (elt instanceof HTMLFormElement && elt.matches(".question-form")) {
      elt.reset();
      // Une nouvelle clé : la question suivante n'est pas un renvoi de celle-ci.
      const cle = elt.elements.namedItem("cle");
      if (cle instanceof HTMLInputElement) cle.value = crypto.randomUUID();
    }
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
      if (conversation && !event.target.closest(".avis")) suivreConversation();
    }
    etatEnvoi();
    if (!focaliserFeuille) return;
    const titre = document.querySelector<HTMLElement>('.feuille-ouverte .feuille [tabindex="-1"]');
    if (titre) {
      focaliserFeuille = false;
      titre.focus({ preventScroll: true });
    }
  });

  document.addEventListener("htmx:sseMessage", (event) => {
    if (event.target instanceof Element && event.target.closest("#conversation")) {
      suivreConversation();
    }
  });
}
