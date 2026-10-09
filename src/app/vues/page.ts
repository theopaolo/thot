import { html } from "hono/html";
import type { Compte } from "../comptes.ts";
import { config } from "../config.ts";
import { type Instance, traitements } from "../instance.ts";
import { type Icone, icone } from "../icones.ts";

export const page = (
  titre: string,
  compte: Compte | null,
  corps: unknown,
  classe = "",
  chemin = "",
  railReplie = false,
  instance: Pick<Instance, "nom" | "mode"> = { nom: "Thot", mode: "shared" },
) => {
  const prof = chemin.startsWith("/prof");
  return html`
    <!DOCTYPE html>
    <html lang="fr">
      <head>
        <meta charset="utf-8">
        <meta name="htmx-config" content='{"globalViewTransitions":true}'>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${titre} · ${instance.nom}</title>
        <link rel="stylesheet" href="/static/style.css">
        <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
        <script src="/static/vendor/htmx.min.js" defer></script>
        <script src="/static/vendor/htmx-ext-sse.js" defer></script>
        <script type="module" src="/static/dist/app.js"></script>
      </head>
      <body
        class="${prof ? `prof${railReplie ? " rail-replie" : ""}` : "eleve"}"
      >
        <a class="evitement" href="#contenu">Aller au contenu</a>
        ${compte && prof ? rail(compte, chemin, railReplie, instance) : html`
          <header class="site">
            <a class="marque" href="/">${instance.nom}</a>
            ${compte && !compte.renouveler_mdp && chemin !== "/eleve/recherche"
              ? rechercheEntete
              : ""}
            ${compte
              ? compte.renouveler_mdp
                ? compteMenu(compte)
                : navEleve(compte, chemin, instance.mode === "personal")
              : ""}
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

const rechercheEntete = html`
  <form method="get" action="/eleve/recherche" role="search" class="recherche-entete">
    <input type="search" name="q" required maxlength="300" aria-label="Chercher dans le cours"
      placeholder="Chercher une œuvre, un document">
    <button aria-label="Chercher">${icone("magnifying-glass")}</button>
  </form>
`;

const navEleve = (c: Compte, chemin: string, personnel: boolean) =>
  html`
    <nav aria-label="Navigation principale" hx-boost="true">
      ${lienNav(
        "/eleve",
        personnel ? "Mes documents" : "Séquences",
        "books",
        chemin === "/eleve" || chemin === "/eleve/sans-sequence" ||
          chemin.startsWith("/eleve/sequences") ||
          chemin.startsWith("/eleve/sources"),
      )}
      ${lienNav(
        "/eleve/chat",
        html`<span class="libelle-long">Poser une question</span><span class="libelle-court">Question</span>`,
        "chat-circle",
        chemin.startsWith("/eleve/chat"),
      )}
      ${c.role === "enseignant"
        ? lienNav(
          "/prof",
          personnel ? "Gérer mes documents" : "Espace enseignant",
          "arrow-left",
          false,
          false,
        )
        : ""}
      ${c.administrateur
        ? lienNav(
          "/administration",
          "Administration",
          "sidebar-simple",
          chemin === "/administration",
          false,
        )
        : ""}
      ${compteMenu(c)}
    </nav>
  `;

/** Le rail se replie en icônes; le cookie `rail` garde ce choix d'une page à l'autre. */
const rail = (
  c: Compte,
  chemin: string,
  replie: boolean,
  instance: Pick<Instance, "nom" | "mode">,
) =>
  html`
    <header class="rail">
      <div class="rail-tete">
        <a class="marque" href="/" title="${instance.nom}">${instance.nom}</a>
        <button type="button" class="rail-bascule" data-replier-rail aria-expanded="${String(
          !replie,
        )}"
          aria-label="Menu" title="Replier ou déplier le menu">${icone("sidebar-simple")}</button>
      </div>
      <p class="discret">${instance.mode === "personal" ? "Mes documents" : "Espace enseignant"}</p>
      <nav aria-label="Navigation enseignant" hx-boost="true">
        ${lienNav(
          "/prof",
          "Bibliothèque",
          "file-text",
          chemin === "/prof" || chemin.startsWith("/prof/sources"),
        )}
        ${lienNav("/prof/depot", "Déposer", "upload-simple", chemin.startsWith("/prof/depot"))}
        ${lienNav("/prof/legendes", "Légendes", "image", chemin.startsWith("/prof/legendes"))}
        ${instance.mode === "shared"
          ? html`
            ${lienNav("/prof/eleves", "Élèves", "users", chemin.startsWith("/prof/eleves"))}
            ${lienNav(
              "/prof/questions",
              "Questions",
              "question",
              chemin.startsWith("/prof/questions"),
            )}
          `
          : ""}
        ${c.administrateur
          ? lienNav("/administration", "Administration", "sidebar-simple", false, false)
          : ""}
      </nav>
      <div class="rail-pied">
        ${lienNav(
          "/eleve",
          instance.mode === "personal" ? "Étudier" : "Vue élève",
          "books",
          false,
          false,
        )}
        <strong>${c.nom}</strong>
        <form method="post" action="/deconnexion">
          <button class="lien">${icone("sign-out")}<span>Se déconnecter</span></button>
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
          ${config.dev ? html`placeholder="Facultatif sauf administrateur"` : html`required`}
        >
      </div>
      <button class="principal">Se connecter</button>
    </form>
  `;

export const motDePasse = (erreur?: string) =>
  html`
    <form method="post" action="/mot-de-passe" class="etroit">
      <h1>Choisir un mot de passe</h1>
      <p>Le code provisoire a été utilisé. Choisissez votre mot de passe, puis reconnectez-vous.</p>
      ${erreur ? html`<p role="alert">${erreur}</p>` : ""}
      <div class="champ">
        <label for="mot_de_passe">Nouveau mot de passe (12 caractères minimum)</label>
        <input id="mot_de_passe" name="mot_de_passe" type="password" autocomplete="new-password" minlength="12" maxlength="200" required>
      </div>
      <div class="champ">
        <label for="confirmation">Confirmer le mot de passe</label>
        <input id="confirmation" name="confirmation" type="password" autocomplete="new-password" minlength="12" maxlength="200" required>
      </div>
      <button class="principal">Enregistrer et se reconnecter</button>
    </form>
  `;

export const administration = (instance: Instance) =>
  html`
    <section class="etroit">
      <h1>Administration</h1>
      <p><strong>${instance.nom}</strong> · ${instance.mode === "personal"
        ? "Usage personnel"
        : "Usage partagé"}</p>
      <p>Identité de l'instance : <code>${instance.id}</code></p>
      <p>Le nom et les services autorisés sont configurés par l'opérateur. Renommer l'instance conserve ses documents et ses comptes.</p>
      <h2>Traitement des documents et des questions</h2>
      <p>Localisations déclarées par l'opérateur. Elles ne sont pas vérifiées par l'application.</p>
      <dl>${traitements().map((f) =>
        html`
          <dt>${f.nom}</dt>
          <dd>${!f.autorise
            ? "Désactivé"
            : f.disponible
            ? "Configuré"
            : "Clé absente"}. Localisation : ${f.localisation}.</dd>
        `
      )}</dl>
      <p>Aucun traitement par un modèle local n'est proposé.</p>
      <a class="bouton" href="/prof">Gérer les documents</a>
    </section>
  `;
