import { html } from "hono/html";
import type { Compte } from "../comptes.ts";
import { type Icone, icone } from "../icones.ts";

export const page = (
  titre: string,
  compte: Compte | null,
  corps: unknown,
  classe = "",
  chemin = "",
) => {
  const prof = chemin.startsWith("/prof");
  return html`
    <!DOCTYPE html>
    <html lang="fr">
      <head>
        <meta charset="utf-8">
        <meta name="htmx-config" content='{"globalViewTransitions":true}'>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${titre} · Thot</title>
        <link rel="stylesheet" href="/static/style.css">
        <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
        <script src="/static/vendor/htmx.min.js" defer></script>
        <script src="/static/vendor/htmx-ext-sse.js" defer></script>
        <script type="module" src="/static/dist/app.js"></script>
      </head>
      <body
        class="${prof ? "prof" : "eleve"}"
      >
        <a class="evitement" href="#contenu">Aller au contenu</a>
        ${compte && prof ? rail(compte, chemin) : html`
          <header class="site">
            <a class="marque" href="/">Thot</a>
            ${compte ? navEleve(compte, chemin) : ""}
          </header>
        `}
        <main id="contenu" tabindex="-1" class="${classe}">
          <p id="erreur-reseau" role="alert" hidden>
            ${prof
              ? "L'action n'a pas abouti. Votre saisie est conservée, réessayez."
              : "L'action n'a pas abouti. Ta saisie est conservée, réessaie."}
          </p>
          ${corps}
        </main>
      </body>
    </html>
  `;
};

/** Lien de navigation: icône et libellé, jaune quand c'est la page en cours.
 * Entre espaces prof et élève, `boost` vaut false: hx-boost garde la classe du body. */
const lienNav = (href: string, libelle: unknown, nom: Icone, actuel: boolean, boost = true) =>
  html`
    <a href="${href}" aria-current="${actuel ? "page" : "false"}"
      hx-boost="${boost ? "true" : "false"}">${icone(nom)}<span>${libelle}</span></a>
  `;

const compteMenu = (c: Compte) =>
  html`
    <details class="compte">
      <summary>${c.nom}</summary>
      <form method="post" action="/deconnexion">
        <button class="lien">${icone("sign-out")}Se déconnecter</button>
      </form>
    </details>
  `;

const navEleve = (c: Compte, chemin: string) =>
  html`
    <nav aria-label="Navigation principale" hx-boost="true">
      ${lienNav(
        "/eleve",
        "Chapitres",
        "books",
        chemin === "/eleve" || chemin === "/eleve/sans-chapitre" ||
          chemin.startsWith("/eleve/chapitres") ||
          chemin.startsWith("/eleve/sources"),
      )}
      ${lienNav(
        "/eleve/chat",
        html`<span class="libelle-long">Poser une question</span><span class="libelle-court">Question</span>`,
        "chat-circle",
        chemin.startsWith("/eleve/chat"),
      )}
      ${c.role === "enseignant"
        ? lienNav("/prof", "Espace enseignant", "arrow-left", false, false)
        : ""}
      ${compteMenu(c)}
    </nav>
  `;

const rail = (c: Compte, chemin: string) =>
  html`
    <header class="rail">
      <a class="marque" href="/prof">Thot</a>
      <p class="discret">Espace enseignant</p>
      <nav aria-label="Navigation enseignant" hx-boost="true">
        ${lienNav(
          "/prof",
          "Sources",
          "file-text",
          chemin === "/prof" || chemin.startsWith("/prof/sources"),
        )}
        ${lienNav("/prof/depot", "Déposer", "upload-simple", chemin.startsWith("/prof/depot"))}
        ${lienNav("/prof/legendes", "Légendes", "image", chemin.startsWith("/prof/legendes"))}
        ${lienNav("/prof/eleves", "Élèves", "users", chemin.startsWith("/prof/eleves"))}
        ${lienNav("/prof/questions", "Questions", "question", chemin.startsWith("/prof/questions"))}
        ${lienNav("/eleve", "Vue élève", "books", false, false)}
      </nav>
      <div class="rail-pied">
        <strong>${c.nom}</strong>
        <form method="post" action="/deconnexion">
          <button class="lien">${icone("sign-out")}Se déconnecter</button>
        </form>
      </div>
    </header>
  `;

export const connexion = (erreur?: string, identifiant = "") =>
  html`
    <form method="post" action="/connexion" class="etroit" style="max-width: 24rem">
      <h1>Connexion</h1>
      ${erreur
        ? html`
          <p role="alert">${erreur}</p>
        `
        : ""}
      <div class="champ">
        <label for="identifiant">Identifiant</label>
        <input
          type="text"
          id="identifiant"
          name="identifiant"
          value="${identifiant}"
          autocomplete="username"
          required
          autofocus
        >
      </div>
      <div class="champ">
        <label for="mot_de_passe">Mot de passe</label>
        <input
          type="password"
          id="mot_de_passe"
          name="mot_de_passe"
          autocomplete="current-password"
          required
        >
      </div>
      <button class="principal">Se connecter</button>
    </form>
  `;
