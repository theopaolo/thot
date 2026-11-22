import { readFileSync } from "node:fs";
import { join } from "node:path";
import { html, raw } from "hono/html";
import type { Compte } from "../comptes.ts";
import { config, RACINE } from "../config.ts";
import { SCRIPT_RECHARGEMENT } from "../rechargement.ts";
import type { Instance } from "../instance.ts";
import { type Formes, formes } from "../../core/accords.ts";
import { type Icone, icone } from "../icones.ts";

/**
 * Les feuilles de `static/css/`, dans l'ordre de la cascade : à sélecteur égal, la règle d'une
 * feuille l'emporte sur celle d'une feuille placée avant elle. Hors `pnpm dev`, Vite les réunit
 * en une seule feuille hachée (`src/app/client/styles.css`).
 */
const FEUILLES = [
  "base",
  "navigation",
  "page",
  "documents",
  "lecture",
  "chat",
  "enseignant",
  "impression",
  "bibliotheque",
  "reponses",
  "activites",
  "administration",
  "dossiers",
  "eleves",
  "relecture",
  "sommaire",
];

/** La feuille réunie par Vite (`static/dist/assets/styles-*.css`), ou rien avant construction. */
const feuilleReunie = (() => {
  try {
    const manifeste = JSON.parse(
      readFileSync(join(RACINE, "static/dist/.vite/manifest.json"), "utf8"),
    ) as Record<string, { file?: string }>;
    const fichier = manifeste["src/app/client/styles.css"]?.file;
    return fichier ? `/static/dist/${fichier}` : undefined;
  } catch {
    return undefined;
  }
})();

const liensStyles = () =>
  !config.dev && feuilleReunie
    ? html`<link rel="stylesheet" href="${feuilleReunie}">`
    : FEUILLES.map((f) => html`<link rel="stylesheet" href="/static/css/${f}.css">`);

export const page = (
  titre: string,
  compte: Compte | null,
  corps: unknown,
  classe = "",
  chemin = "",
  railReplie = false,
  instance: Pick<Instance, "nom" | "mode"> = { nom: "Thot", mode: "shared" },
  legendes = 0,
  /** le terme de cours de l'instance, celui du profil par défaut */
  fc: Formes = formes("Cours", "Cours", "m"),
) => {
  // L'administration garde le menu de l'enseignant : on y passe sans changer d'espace.
  const prof =
    chemin.startsWith("/prof") ||
    (chemin.startsWith("/administration") && compte?.role === "enseignant");
  return html`
    <!DOCTYPE html>
    <html lang="fr">
      <head>
        <meta charset="utf-8">
        <meta name="htmx-config" content='{"globalViewTransitions":true}'>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${titre} · ${instance.nom}</title>
        ${liensStyles()}
        <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
        <script src="/static/vendor/htmx.min.js" defer></script>
        <script src="/static/vendor/htmx-ext-sse.js" defer></script>
        <script type="module" src="/static/dist/app.js"></script>
        ${config.dev ? html`<script>${raw(SCRIPT_RECHARGEMENT)}</script>` : ""}
      </head>
      <body
        class="${prof ? `prof${railReplie ? " rail-replie" : ""}` : "eleve"}"
      >
        <a class="evitement" href="#contenu">Aller au contenu</a>
        ${
          compte && prof
            ? rail(compte, chemin, railReplie, instance, legendes, fc)
            : html`
          <header class="site">
            <a class="marque" href="/">${instance.nom}</a>
            ${
              compte && !compte.renouveler_mdp && chemin !== "/eleve/recherche"
                ? rechercheEntete(fc)
                : ""
            }
            ${
              compte
                ? compte.renouveler_mdp
                  ? compteMenu(compte)
                  : navEleve(compte, chemin, instance.mode === "personal")
                : ""
            }
          </header>
        `
        }
        <main id="contenu" tabindex="-1" class="${classe}">
          <p id="erreur-reseau" role="alert" hidden>
            ${
              prof
                ? "L'action n'a pas abouti. Votre saisie est conservée, réessayez."
                : "L'action n'a pas abouti. Ta saisie est conservée, réessaie."
            }
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
        ${c.renouveler_mdp ? "" : html`<p><a href="/mot-de-passe">Mot de passe</a></p>`}
        <button class="lien">${icone("sign-out")}Se déconnecter</button>
      </form>
    </details>
  `;

const rechercheEntete = (fc: Formes) => html`
  <form method="get" action="/eleve/recherche" role="search" class="recherche-entete">
    <input type="search" name="q" required maxlength="300" aria-label="Chercher dans ${fc.le}"
      placeholder="Chercher une ressource">
    <button aria-label="Chercher">${icone("magnifying-glass")}</button>
  </form>
`;

const navEleve = (c: Compte, chemin: string, personnel: boolean) =>
  html`
    <nav aria-label="Navigation principale" hx-boost="true">
      ${lienNav(
        "/eleve",
        personnel ? "Mes documents" : "Ressources",
        "books",
        chemin === "/eleve" ||
          chemin === "/eleve/sans-sequence" ||
          chemin.startsWith("/eleve/sequences") ||
          chemin.startsWith("/eleve/themes") ||
          chemin.startsWith("/eleve/sources") ||
          chemin.startsWith("/eleve/activites"),
      )}
      ${lienNav(
        "/eleve/chat",
        html`<span class="libelle-long">Poser une question</span><span class="libelle-court">Question</span>`,
        "chat-circle",
        chemin.startsWith("/eleve/chat") || chemin.startsWith("/eleve/conversations"),
      )}
      ${
        c.role === "enseignant"
          ? lienNav(
              "/prof",
              personnel ? "Gérer mes documents" : "Espace enseignant",
              "arrow-left",
              false,
              false,
            )
          : ""
      }
      ${
        c.administrateur
          ? lienNav(
              "/administration",
              "Administration",
              "sidebar-simple",
              chemin === "/administration",
              false,
            )
          : ""
      }
      ${compteMenu(c)}
    </nav>
  `;

/** Le rail se replie en icônes; le cookie `rail` garde ce choix d'une page à l'autre. */
const rail = (
  c: Compte,
  chemin: string,
  replie: boolean,
  instance: Pick<Instance, "nom" | "mode">,
  legendes: number,
  fc: Formes,
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
          chemin === "/prof" ||
            chemin.startsWith("/prof/sources") ||
            chemin.startsWith("/prof/relecture") ||
            chemin.startsWith("/prof/activites"),
        )}
        ${lienNav("/prof/depot", "Déposer", "upload-simple", chemin.startsWith("/prof/depot"))}
        ${lienNav(
          "/prof/legendes",
          legendes
            ? html`Légendes <span class="nombre"
                >${legendes}<span class="visuellement-cache"> à relire</span></span>`
            : "Légendes",
          "image",
          chemin.startsWith("/prof/legendes"),
        )}
        ${
          instance.mode === "shared"
            ? html`
            ${lienNav("/prof/cours", `Mes ${fc.noms}`, "squares-four", chemin.startsWith("/prof/cours"))}
            ${lienNav("/prof/eleves", "Élèves", "users", chemin.startsWith("/prof/eleves"))}
            ${lienNav(
              "/prof/questions",
              "Questions",
              "question",
              chemin.startsWith("/prof/questions"),
            )}
          `
            : ""
        }
        ${
          c.administrateur
            ? lienNav(
                "/administration",
                "Administration",
                "sidebar-simple",
                chemin.startsWith("/administration"),
              )
            : ""
        }
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
        <a href="/mot-de-passe" hx-boost="false">${icone("pencil-simple")}<span>Mot de passe</span></a>
        <form method="post" action="/deconnexion">
          <button class="lien">${icone("sign-out")}<span>Se déconnecter</span></button>
        </form>
      </div>
    </header>
  `;
