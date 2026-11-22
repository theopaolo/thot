import { html } from "hono/html";
import type { Compte } from "../comptes.ts";
import { config } from "../config.ts";

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
          ${config.dev ? html`placeholder="Facultatif en développement"` : html`required`}
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
            ? html`<p>Ce lien inscrit des élèves. Un enseignant de ces cours vous y ajoute depuis « Mes cours ».</p>`
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

/**
 * Le choix d'un mot de passe. Après un code provisoire, la connexion l'a déjà vérifié. Sinon le
 * compte donne son mot de passe actuel. Dans les deux cas, il se reconnecte ensuite.
 */
export const motDePasse = (compte: Compte, erreur?: string) => {
  const tu = compte.role === "eleve";
  return html`
    <form method="post" action="/mot-de-passe" class="etroit">
      <h1>${compte.renouveler_mdp ? "Choisir un mot de passe" : "Changer de mot de passe"}</h1>
      <p>${
        compte.renouveler_mdp
          ? tu
            ? "Le code que ton enseignant t'a remis ne sert qu'une fois. Choisis ton mot de passe, puis reconnecte-toi."
            : "Le code provisoire a été utilisé. Choisissez votre mot de passe, puis reconnectez-vous."
          : tu
            ? "Le changement ferme tes sessions sur tous tes appareils. Tu te reconnectes ensuite."
            : "Le changement ferme vos sessions sur tous vos appareils. Vous vous reconnectez ensuite."
      }</p>
      ${erreur ? html`<p role="alert">${erreur}</p>` : ""}
      ${
        compte.renouveler_mdp
          ? ""
          : html`<div class="champ">
              <label for="ancien">Mot de passe actuel</label>
              <input id="ancien" name="ancien" type="password" autocomplete="current-password" required>
            </div>`
      }
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
};
