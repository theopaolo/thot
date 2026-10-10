import { html } from "hono/html";
import { CHAMPS, type Profil, PROFILS } from "../../core/profils.ts";
import type { Affiliation, Catalogue, Scope } from "../domaines.ts";

const options = (liste: { id: string; nom: string }[], valeur = "") =>
  liste.map((m) =>
    html`<option value="${m.id}" ${m.id === valeur ? "selected" : ""}>${m.nom}</option>`
  );
export const selectionProfil = (valeur = "general") =>
  html`<label>Profil <select name="profil">${
    Object.entries(PROFILS).map(([id, p]) =>
      html`<option value="${id}" ${id === valeur ? "selected" : ""}>${p.nom}</option>`
    )
  }</select></label>`;
export const gestion = (cat: Catalogue, erreur = "") =>
  html`
    <h1>Matières et cours</h1>${erreur ? html`<p role="alert">${erreur}</p>` : ""}
    <p>Un profil modifié s'applique aux futurs dépôts. Les ressources gardent leur profil d'import,
    leurs informations relues et leur index. Une nouvelle extraction nécessite une action explicite.
    La réextraction refuse un texte qui changerait les citations. La recherche est prise en charge en français uniquement.</p>
    <h2>Matières</h2>
    ${cat.matieres.map((m) =>
      html`
        <form method="post" action="/administration/domaines/profil"
          class="barre"><strong>${m.nom}</strong><input type="hidden" name="matiere_id" value="${m
            .id}">${selectionProfil(m.profil)}<button>Enregistrer le profil</button></form>
      `
    )}
    <form method="post" action="/administration/domaines/matiere"
      class="etroit"><label>Nouvelle matière <input type="text" name="nom" required maxlength="200"></label>${selectionProfil()}<button>Créer la matière</button></form>
    <h2>Cours</h2><ul>${cat.cours.map((c) =>
      html`<li>${c.nom} (${cat.matieres.find((m) => m.id === c.matiere_id)?.nom})${
        c.public ? `, ${c.public}` : ""
      }${c.objectif ? ` : ${c.objectif}` : ""}</li>`
    )}</ul>
    <form method="post" action="/administration/domaines/cours"
      class="etroit"><label>Matière <select name="matiere_id" required>${options(
        cat.matieres,
      )}</select></label><label>Nom du cours <input type="text" name="nom" required maxlength="200"></label><label>Public ou niveau (facultatif) <input type="text" name="public" maxlength="200"></label><label>Objectif (facultatif) <textarea name="objectif" maxlength="4000"></textarea></label><button>Créer le cours</button></form>
    <h2>Thèmes</h2><ul>${cat.themes.map((t) =>
      html`<li>${
        cat.matieres.find((m) => m.id === cat.cours.find((c) => c.id === t.cours_id)?.matiere_id)
          ?.nom
      } / ${cat.cours.find((c) => c.id === t.cours_id)?.nom} : ${t.nom}</li>`
    )}</ul>
    <form method="post" action="/administration/domaines/theme"
      class="etroit"><label>Cours <select name="cours_id" required>${options(
        cat.cours.map((c) => ({
          id: c.id,
          nom: `${cat.matieres.find((m) => m.id === c.matiere_id)?.nom} / ${c.nom}`,
        })),
      )}</select></label><label>Nouveau thème <input type="text" name="nom" required maxlength="200"></label><button>Créer le thème</button></form>
  `;

export const filtre = (cat: Catalogue, p: Scope, action: string, q = "", vue = "") =>
  html`
    <form method="get" action="${action}" class="biblio-outils" aria-label="Périmètre des ressources">
      <label>Matière <select name="matiere_id"><option value="">Toutes les matières</option>${options(
        cat.matieres,
        p.matiere_id,
      )}</select></label>
      <label>Cours <select name="cours_id"><option value="">Tous les cours</option>${options(
        cat.cours.map((c) => ({
          id: c.id,
          nom: `${cat.matieres.find((m) => m.id === c.matiere_id)?.nom} / ${c.nom}`,
        })),
        p.cours_id,
      )}</select></label>
      <label>Thème <select name="theme_id"><option value="">Tous les thèmes</option>${options(
        cat.themes.map((t) => ({
          id: t.id,
          nom: `${
            cat.matieres.find((m) =>
              m.id === cat.cours.find((c) => c.id === t.cours_id)?.matiere_id
            )?.nom
          } / ${cat.cours.find((c) => c.id === t.cours_id)?.nom} / ${t.nom}`,
        })),
        p.theme_id,
      )}</select></label>
      ${action === "/eleve/recherche"
        ? html`<input type="text" name="q" value="${q}" aria-label="Recherche" maxlength="300">`
        : ""}
      ${action === "/eleve"
        ? html`<label>Affichage <select name="vue"><option value="">Liste</option><option value="grille" ${
          vue === "grille" ? "selected" : ""
        }>Images</option></select></label>`
        : ""}
      <button>Appliquer</button>
    </form>
    <p class="discret">Périmètre : ${cat.matieres.find((m) => m.id === p.matiere_id)?.nom ??
      (p.matiere_id ? "Matière indisponible" : "toutes les matières")} / ${cat.cours.find((c) =>
        c.id === p.cours_id
      )?.nom ??
      (p.cours_id ? "Cours indisponible" : "tous les cours")} / ${cat.themes.find((t) =>
        t.id === p.theme_id
      )?.nom ?? (p.theme_id ? "Thème indisponible" : "tous les thèmes")}.</p>
  `;

export const choixMatiere = (cat: Catalogue, id = "") =>
  html`
    <form method="get" action="/prof/depot"
      class="barre"><label>Matière <select name="matiere_id"><option value="">Non classée</option>${options(
        cat.matieres,
        id,
      )}</select></label><button>Choisir les champs</button></form>
  `;
export const liens = (cat: Catalogue, valeurs: Affiliation[] = []) =>
  html`<fieldset><legend>Cours de rattachement</legend><input type="hidden" name="affiliations_presentes" value="1"><p class="aide">Le rattachement ne change pas les publics de la ressource.</p>${
    cat.cours.map((c) =>
      html`
        <div
          class="champ"><label><input type="checkbox" name="cours" value="${c
            .id}" ${valeurs.some((v) => v.cours_id === c.id) ? "checked" : ""}> ${cat.matieres.find(
              (m) => m.id === c.matiere_id,
            )?.nom} / ${c.nom}</label><label>Thème <select name="theme_${c
            .id}"><option value="">Sans thème</option>${options(
              cat.themes.filter((t) => t.cours_id === c.id),
              valeurs.find((v) => v.cours_id === c.id)?.theme_id ?? "",
            )}</select></label></div>
      `
    )
  }</fieldset>`;
export const informations = (profil: Profil, meta: Record<string, unknown>) =>
  html`${
    PROFILS[profil].informations.map((n) =>
      html`
        <div
          class="champ"><label for="${n}">${CHAMPS[n]
            .label}</label><input id="${n}" name="${n}" type="${CHAMPS[n].type === "date"
            ? "date"
            : "text"}" value="${String(meta[n] ?? "")}" maxlength="120"></div>
      `
    )
  }`;
export const langue = (valeur = "fr") =>
  html`
    <label>Langue de la source <input type="text" name="langue" value="${valeur}" maxlength="30"></label><p
      class="aide">Français (fr) pris en charge. Anglais (en) et autres langues : recherche non prise en charge.</p>
  `;
export const champsScope = (p: Scope) =>
  html`${Object.entries(p).map(([n, v]) => html`<input type="hidden" name="${n}" value="${v}">`)}`;
