import { html } from "hono/html";
import { AUDIENCES } from "../depot.ts";
import {
  GENRES,
  type Instance,
  type Libelles,
  minuscule,
  type Reglages,
  traitements,
} from "../instance.ts";
import { type Profil, PROFILS } from "../../core/profils.ts";

export const domainesDe = (l: Pick<Libelles, "matieres" | "cours_pluriel">) =>
  `${l.matieres} et ${minuscule(l.cours_pluriel)}`;
export const ongletsAdministration = (chemin: string, l: Libelles) =>
  html`<nav class="onglets" aria-label="Administration">${[
    ["/administration", "Réglages"],
    ["/administration/domaines", domainesDe(l)],
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
  l: Libelles,
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
  const genre = (nom: (typeof GENRES)[number], terme: string) =>
    html`
      <fieldset class="genre">
        <legend>${terme}, son genre</legend>
        ${(
          [
            ["m", "Masculin"],
            ["f", "Féminin"],
          ] as const
        ).map(
          ([valeur, label]) =>
            html`<label><input type="radio" name="${nom}" value="${valeur}" ${
              v[nom] === valeur ? "checked" : ""
            }> ${label}</label>`,
        )}
      </fieldset>
    `;
  const texte = (
    nom: Exclude<keyof Reglages, "lecteurs" | (typeof GENRES)[number]>,
    label: string,
    max: number,
    aide = "",
  ) => {
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
    ${ongletsAdministration("/administration", l)}
    ${e.enregistre ? html`<p role="status" tabindex="-1" autofocus>Réglages enregistrés.</p>` : ""}
    ${
      e.conflit
        ? html`<p role="alert" tabindex="-1" autofocus>Quelqu'un a modifié ces réglages pendant votre saisie. Vos valeurs sont conservées : enregistrez pour remplacer les siennes.</p>`
        : premiere
          ? html`<p role="alert">Rien n'a été enregistré. Corrigez les champs signalés.</p>`
          : ""
    }
    <form method="post" action="/administration" class="etroit reglages">
      <input type="hidden" name="version" value="${instance.version}">
      <fieldset>
        <legend>Identité</legend>
        ${texte("nom", "Nom affiché", 100, "En haut du menu et dans l'onglet du navigateur.")}
        <p>Usage : ${
          instance.mode === "personal"
            ? "personnel, pour étudier vos propres documents"
            : "partagé entre enseignants et élèves"
        }<br><span class="aide">Fixé à l'installation de Thot.</span></p>
        <p>Profil : ${profil ? PROFILS[profil].nom : "pas encore choisi"}<br><span class="aide">Il propose le vocabulaire et les champs du dépôt. ${
          !profil || !fige
            ? html`${
                profil
                  ? "Il se change jusqu'au premier dépôt"
                  : `Vous le choisirez avec ${l.formes.matiere.selon("le premier", "la première")} ${l.formes.matiere.nom}`
              }, dans <a href="/administration/domaines">${domainesDe(l)}</a>.`
            : "Il ne change plus depuis le premier dépôt."
        }</span></p>
      </fieldset>
      <section class="traitements" aria-labelledby="titre-traitements">
        <h2 id="titre-traitements">Services d'IA</h2>
        <p class="aide">Thot envoie les documents et les questions à ces services, qui les lisent et rédigent les réponses. Thot ne vérifie pas la localisation déclarée à l'installation.</p>
        <table>
          <thead><tr><th>Service</th><th>État</th><th>Localisation</th></tr></thead>
          <tbody>${traitements().map(
            (f) =>
              html`<tr><td>${f.nom}</td><td>${
                !f.autorise ? "Désactivé" : f.disponible ? "Actif" : "Clé d'accès manquante"
              }</td><td>${f.localisation}</td></tr>`,
          )}</tbody>
        </table>
      </section>
      <fieldset aria-describedby="vocabulaire-aide">
        <legend>Vocabulaire</legend>
        <p class="aide" id="vocabulaire-aide">Thot emploie ces mots dans toutes ses pages. Un champ vide garde le mot du profil ${preset.nom}, écrit en gris. Le genre accorde un mot que vous réglez dans les phrases : « un cours », « une unité ».</p>
        <div class="deux">
          ${texte("matiere", "Matière, au singulier", 40)}
          ${texte("matieres", "Matière, au pluriel", 40)}
        </div>
        ${genre("matiere_genre", "Matière")}
        <div class="deux">
          ${texte("cours", "Cours, au singulier", 40)}
          ${texte("cours_pluriel", "Cours, au pluriel", 40)}
        </div>
        ${genre("cours_genre", "Cours")}
        ${texte("niveau", "Niveau", 40)}
        <div class="deux">
          ${texte("regroupement", "Partie d'un cours, au singulier", 40)}
          ${texte("regroupements", "Partie d'un cours, au pluriel", 40)}
        </div>
      </fieldset>
      ${
        instance.mode === "personal"
          ? ""
          : html`
          <fieldset aria-describedby="lecteurs-aide">
            <legend>Lecteurs d'une nouvelle ressource</legend>
            <p class="aide" id="lecteurs-aide">Le dépôt propose ce choix, et l'enseignant peut le changer. Les ressources déjà déposées gardent leurs lecteurs.</p>
            ${AUDIENCES.map(
              (a) =>
                html`<label><input type="radio" name="lecteurs" value="${a.value}" ${
                  v.lecteurs === a.value ? "checked" : ""
                }> ${a.label}</label>`,
            )}
          </fieldset>
        `
      }
      <div class="barre">
        <button class="principal">Enregistrer</button>
        <button type="reset">Annuler les modifications</button>
      </div>
    </form>
    <div class="pied-reglages">
      <p><a class="bouton" href="/prof">Gérer les documents</a></p>
      <p class="discret">Identifiant technique : <code>${instance.id}</code></p>
    </div>
  `;
};
