import { html } from "hono/html";
import type { Compte } from "../comptes.ts";
import { config } from "../config.ts";
import { AUDIENCES } from "../depot.ts";
import { type Instance, type Reglages, traitements } from "../instance.ts";
import { type Icone, icone } from "../icones.ts";
import { type Profil, PROFILS } from "../../core/profils.ts";

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
        ${
          compte && prof
            ? rail(compte, chemin, railReplie, instance)
            : html`
          <header class="site">
            <a class="marque" href="/">${instance.nom}</a>
            ${
              compte && !compte.renouveler_mdp && chemin !== "/eleve/recherche"
                ? rechercheEntete
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
        <button class="lien">${icone("sign-out")}Se déconnecter</button>
      </form>
    </details>
  `;

const rechercheEntete = html`
  <form method="get" action="/eleve/recherche" role="search" class="recherche-entete">
    <input type="search" name="q" required maxlength="300" aria-label="Chercher dans le cours"
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
          chemin.startsWith("/eleve/sources"),
      )}
      ${lienNav(
        "/eleve/chat",
        html`<span class="libelle-long">Poser une question</span><span class="libelle-court">Question</span>`,
        "chat-circle",
        chemin.startsWith("/eleve/chat"),
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
        ${
          instance.mode === "shared"
            ? html`
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
            ? lienNav("/administration", "Administration", "sidebar-simple", false, false)
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
        <form method="post" action="/deconnexion">
          <button class="lien">${icone("sign-out")}<span>Se déconnecter</span></button>
        </form>
      </div>
    </header>
  `;

export const connexion = (erreur?: string, identifiant = "", retour = "") =>
  html`
    <form method="post" action="/connexion" class="etroit" style="max-width: 24rem">
      <h1>Connexion</h1>
      ${retour ? html`<input type="hidden" name="retour" value="${retour}">` : ""}
      ${
        erreur
          ? html`
          <p role="alert">${erreur}</p>
        `
          : ""
      }
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

/**
 * La page d'un lien d'inscription : ses cours et son créateur, puis le bouton pour un élève
 * connecté, une explication pour un enseignant, ou la création de compte pour un visiteur.
 */
export const inscription = (
  jeton: string,
  cours: { nom: string; matiere: string; createur: string }[],
  compte: Compte | undefined,
  erreur?: string,
  saisie: { nom?: unknown; identifiant?: unknown } = {},
) =>
  !cours.length
    ? html`
      <section class="etroit">
        <h1>Lien d'inscription</h1>
        <p>Ce lien n'inscrit plus personne : il a expiré, il a été révoqué ou il n'a plus de place. Demande un nouveau lien à ton enseignant.</p>
      </section>
    `
    : html`
      <form method="post" action="/inscription/${jeton}" class="etroit">
        <h1>Rejoindre ${cours.length > 1 ? "des cours" : "un cours"}</h1>
        <p>${cours[0].createur} t'invite à rejoindre :</p>
        <ul>${cours.map((c) => html`<li>${c.matiere} / ${c.nom}</li>`)}</ul>
        ${erreur ? html`<p role="alert">${erreur}</p>` : ""}
        ${
          compte?.role === "enseignant"
            ? html`<p>Ce lien inscrit des élèves. Un administrateur inscrit les enseignants à un cours.</p>`
            : compte
              ? html`
                <p>Tu es connecté avec le compte ${compte.nom}.</p>
                <button class="principal">Rejoindre</button>
              `
              : html`
                <p>Tu as déjà un compte ? <a href="/connexion?retour=/inscription/${jeton}">Connecte-toi d'abord</a>. Sinon, crée ton compte ici.</p>
                <div class="champ">
                  <label for="nom">Nom</label>
                  <p id="aide-nom" class="aide">Ton prénom et ton nom, pour que ton enseignant te reconnaisse.</p>
                  <input id="nom" type="text" name="nom" value="${String(saisie.nom ?? "")}" required maxlength="100" autocomplete="name" aria-describedby="aide-nom">
                </div>
                <div class="champ">
                  <label for="identifiant">Identifiant</label>
                  <p id="aide-identifiant" class="aide">3 à 40 caractères : minuscules, chiffres, point, tiret ou tiret bas. Il te sert à te connecter.</p>
                  <input id="identifiant" type="text" name="identifiant" value="${String(saisie.identifiant ?? "")}" required minlength="3" maxlength="40" pattern="[a-z0-9._\\-]+" autocomplete="username" spellcheck="false" aria-describedby="aide-identifiant">
                </div>
                <div class="champ">
                  <label for="mot_de_passe">Mot de passe (12 caractères minimum)</label>
                  <input id="mot_de_passe" type="password" name="mot_de_passe" required minlength="12" maxlength="200" autocomplete="new-password">
                </div>
                <button class="principal">Créer mon compte et rejoindre</button>
              `
        }
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

export const ongletsAdministration = (chemin: string) =>
  html`<nav class="onglets" aria-label="Administration">${[
    ["/administration", "Instance"],
    ["/administration/domaines", "Matières et cours"],
  ].map(
    ([href, libelle]) =>
      html`<a href="${href}" ${chemin === href ? html`aria-current="page"` : ""}>${libelle}</a>`,
  )}</nav>`;

/**
 * Les réglages de l'instance en un formulaire. Après une réponse du serveur, le focus va au
 * message d'état, à l'alerte d'un conflit ou au premier champ invalide.
 */
export const administration = (
  instance: Instance,
  profil: Profil | undefined,
  fige: boolean,
  e: {
    saisie?: Reglages;
    erreurs?: Record<string, string>;
    conflit?: boolean;
    enregistre?: boolean;
  } = {},
) => {
  const v = e.saisie ?? instance;
  const erreurs = e.erreurs ?? {};
  const premiere = Object.keys(erreurs)[0];
  const preset = PROFILS[profil ?? "general"];
  const texte = (
    nom: "nom" | "niveau" | "regroupement" | "regroupements",
    label: string,
    max: number,
  ) => {
    const aide = nom === "nom" ? "" : `Vide : ${preset[nom]}, le terme du profil ${preset.nom}.`;
    const decrit = [aide && `${nom}-aide`, erreurs[nom] && `${nom}-erreur`].filter(Boolean);
    return html`
      <div class="champ">
        <label for="${nom}">${label}</label>
        ${aide ? html`<p class="aide" id="${nom}-aide">${aide}</p>` : ""}
        <input type="text" id="${nom}" name="${nom}" value="${v[nom]}" maxlength="${max}" ${
          nom === "nom" ? "required" : html`placeholder="${preset[nom]}"`
        } ${decrit.length ? html`aria-describedby="${decrit.join(" ")}"` : ""} ${
          erreurs[nom] ? html`aria-invalid="true"` : ""
        } ${premiere === nom ? "autofocus" : ""}>
        ${erreurs[nom] ? html`<p class="erreur" id="${nom}-erreur">${erreurs[nom]}</p>` : ""}
      </div>
    `;
  };
  return html`
    <h1>Administration</h1>
    ${ongletsAdministration("/administration")}
    ${e.enregistre ? html`<p role="status" tabindex="-1" autofocus>Réglages enregistrés.</p>` : ""}
    ${
      e.conflit
        ? html`<p role="alert" tabindex="-1" autofocus>Ces réglages ont changé pendant votre saisie. Vos valeurs sont conservées.</p>`
        : premiere
          ? html`<p role="alert">Rien n'a été enregistré. Corrigez les champs signalés.</p>`
          : ""
    }
    <form method="post" action="/administration" class="etroit reglages">
      <input type="hidden" name="version" value="${instance.version}">
      <fieldset>
        <legend>Identité</legend>
        ${texte("nom", "Nom de l'instance", 100)}
        <p>Mode d'usage : ${instance.mode === "personal" ? "personnel" : "partagé"}<br><span
            class="aide">Choisi par l'opérateur avant la création des comptes.</span></p>
        <p>Identité de l'instance : <code>${instance.id}</code></p>
      </fieldset>
      <fieldset>
        <legend>Vocabulaire</legend>
        ${texte("niveau", "Niveau", 40)}
        <div class="deux">
          ${texte("regroupement", "Regroupement, au singulier", 40)}
          ${texte("regroupements", "Regroupement, au pluriel", 40)}
        </div>
      </fieldset>
      ${
        instance.mode === "personal"
          ? ""
          : html`
          <fieldset>
            <legend>Nouveaux dépôts</legend>
            <fieldset aria-describedby="lecteurs-aide">
              <legend>Lecteurs proposés par défaut</legend>
              <p class="aide" id="lecteurs-aide">S'applique aux prochains dépôts. Les ressources déposées gardent leurs lecteurs.</p>
              ${AUDIENCES.map(
                (a) =>
                  html`<label><input type="radio" name="lecteurs" value="${a.value}" ${
                    v.lecteurs === a.value ? "checked" : ""
                  }> ${a.label}</label>`,
              )}
            </fieldset>
          </fieldset>
        `
      }
      <div class="barre">
        <button class="principal">Enregistrer</button>
        <button type="reset">Annuler les modifications</button>
      </div>
    </form>
    <section class="etroit">
      <h2>Profil d'import</h2>
      <p>${profil ? PROFILS[profil].nom : "Aucun"}. ${
        !profil
          ? "La première matière le choisit."
          : fige
            ? "Des ressources sont déposées, il ne change plus."
            : "Il se change tant qu'aucune ressource n'est déposée."
      } <a href="/administration/domaines">Matières et cours</a></p>
      <h2>Traitement des documents et des questions</h2>
      <p>Services autorisés et localisations déclarés par l'opérateur. Les localisations ne sont pas vérifiées par l'application.</p>
      <dl>${traitements().map(
        (f) =>
          html`
          <dt>${f.nom}</dt>
          <dd>${
            !f.autorise ? "Désactivé" : f.disponible ? "Configuré" : "Clé absente"
          }. Localisation : ${f.localisation}.</dd>
        `,
      )}</dl>
      <p>Aucun traitement par un modèle local n'est proposé.</p>
      <a class="bouton" href="/prof">Gérer les documents</a>
    </section>
  `;
};
