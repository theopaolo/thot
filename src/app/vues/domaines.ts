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
const LIBELLES = { matiere: "matière", cours: "cours", theme: "thème" };
const ligne = (genre: keyof typeof LIBELLES, id: string, nom: string, contexte = "") => {
  const libelle = `Nom (${LIBELLES[genre]})`;
  return html`
    <form method="post" action="/administration/domaines/renommer" class="barre">
      <input type="hidden" name="genre" value="${genre}"><input type="hidden" name="id" value="${id}">
      <input type="text" name="nom" value="${nom}" required maxlength="200" aria-label="${libelle}">
      <button>Renommer</button>
      <button formaction="/administration/domaines/supprimer" formnovalidate>Supprimer</button>
      ${contexte ? html`<span class="discret">${contexte}</span>` : ""}
    </form>
  `;
};
export const gestion = (cat: Catalogue, erreur = "", figee = false) => {
  const profil = cat.matieres[0]?.profil;
  const controleProfil = !profil
    ? ""
    : figee
    ? html`<p>Profil de l'instance : <strong>${
      PROFILS[profil].nom
    }</strong>. Des ressources sont déposées, il ne change plus.</p>`
    : html`
      <form method="post" action="/administration/domaines/profil"
        class="barre">${selectionProfil(
          profil,
        )}<button>Changer le profil de l'instance</button></form>
    `;
  return html`
    <h1>Matières et cours</h1>${erreur ? html`<p role="alert">${erreur}</p>` : ""}
    <p>L'instance garde un seul profil d'import, partagé par toutes ses matières. Il se change tant
    qu'aucune ressource n'est déposée. La recherche est prise en charge en français uniquement.</p>
    ${controleProfil}
    <p>Renommer garde les rattachements. Supprimer est refusé tant qu'une ressource ou une question
    d'élève utilise l'entrée. Une matière ou un cours emporte ses cours et ses thèmes.</p>
    <h2>Matières</h2>
    ${cat.matieres.map((m) => ligne("matiere", m.id, m.nom))}
    <form method="post" action="/administration/domaines/matiere"
      class="etroit"><label>Nouvelle matière <input type="text" name="nom" required maxlength="200"></label>${profil
        ? ""
        : selectionProfil()}<button>Créer la matière</button></form>
    <h2>Cours</h2>${cat.cours.map((c) =>
      ligne(
        "cours",
        c.id,
        c.nom,
        `${cat.matieres.find((m) => m.id === c.matiere_id)?.nom}${c.public ? `, ${c.public}` : ""}${
          c.objectif ? ` : ${c.objectif}` : ""
        }`,
      )
    )}
    <form method="post" action="/administration/domaines/cours"
      class="etroit"><label>Matière <select name="matiere_id" required>${options(
        cat.matieres,
      )}</select></label><label>Nom du cours <input type="text" name="nom" required maxlength="200"></label><label>Public ou niveau (facultatif) <input type="text" name="public" maxlength="200"></label><label>Objectif (facultatif) <textarea name="objectif" maxlength="4000"></textarea></label><button>Créer le cours</button></form>
    <h2>Thèmes</h2>${cat.themes.map((t) =>
      ligne(
        "theme",
        t.id,
        t.nom,
        `${
          cat.matieres.find((m) => m.id === cat.cours.find((c) => c.id === t.cours_id)?.matiere_id)
            ?.nom
        } / ${cat.cours.find((c) => c.id === t.cours_id)?.nom}`,
      )
    )}
    <form method="post" action="/administration/domaines/theme"
      class="etroit"><label>Cours <select name="cours_id" required>${options(
        cat.cours.map((c) => ({
          id: c.id,
          nom: `${cat.matieres.find((m) => m.id === c.matiere_id)?.nom} / ${c.nom}`,
        })),
      )}</select></label><label>Nouveau thème <input type="text" name="nom" required maxlength="200"></label><button>Créer le thème</button></form>
  `;
};

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
