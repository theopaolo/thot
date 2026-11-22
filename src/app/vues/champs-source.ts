import { html } from "hono/html";
import type { Champ } from "../../core/profils.ts";
import type { Affiliation, Catalogue, Cours } from "../domaines.ts";
import { icone } from "../icones.ts";
import { type Libelles, minuscule } from "../instance.ts";
import { options, selectionProfil } from "./commun.ts";

/**
 * L'étape « Où les ranger ? » du dépôt : un cours du compte, avec son thème, ou un cours qu'un
 * administrateur crée avec le dépôt, dans une matière existante ou nouvelle. Le thème et les champs
 * du nouveau cours ne s'affichent que sous le choix coché (CSS `:has`). Un seul cours, ou `?cours=`,
 * est coché d'office.
 */
export const rangementDepot = (
  cat: Catalogue,
  l: Libelles,
  o: {
    saisie: Record<string, string>;
    creer: boolean;
    sansProfil: boolean;
    personnel?: boolean;
    erreur?: string;
  },
) => {
  const v = o.saisie;
  const choisi = v.cours ?? (cat.cours.length === 1 ? cat.cours[0].id : "");
  const nouveau = o.creer && (choisi === "nouveau" || !cat.cours.length);
  const cours = (c: Cours) => {
    const themes = cat.themes.filter((t) => t.cours_id === c.id);
    return html`
      <div class="lien-cours">
        <label><input type="radio" name="cours" value="${c.id}" required ${
          choisi === c.id ? "checked" : ""
        } data-chemin="${cat.matieres.find((m) => m.id === c.matiere_id)?.nom} / ${c.nom}"> ${c.nom}${c.public ? html` <span class="discret">${c.public}</span>` : ""}</label>
        ${
          themes.length
            ? html`<label class="theme-cours">${l.regroupement} <select name="theme_${
                c.id
              }" aria-label="${l.regroupement} dans ${c.nom}"><option value="">Sans ${minuscule(
                l.regroupement,
              )}</option>${options(themes, v[`theme_${c.id}`])}</select></label>`
            : ""
        }
      </div>
    `;
  };
  return html`
    ${o.erreur ? html`<p role="alert">${o.erreur}</p>` : ""}
    ${
      cat.cours.length
        ? html`<p class="aide">${
            o.personnel
              ? ""
              : "Les membres du cours lisent ses ressources, dans la limite des lecteurs de l'étape suivante. "
          }D'autres cours s'ajoutent ensuite sur la page de la ressource.</p>`
        : o.creer
          ? html`<p class="aide">Aucun cours pour l'instant. Créez le premier : il rangera ces
            ressources.</p>`
          : html`<p>Vous n'êtes membre d'aucun cours. Un administrateur crée les cours et vous y
            inscrit. En attendant, ces ressources restent non classées.</p>`
    }
    <fieldset class="rangement">
      <legend class="visuellement-cache">${l.cours}</legend>
      ${cat.matieres.map((m) => {
        const liste = cat.cours.filter((c) => c.matiere_id === m.id);
        return liste.length ? html`<p class="matiere-depot">${m.nom}</p>${liste.map(cours)}` : "";
      })}
      ${
        o.creer
          ? html`
          <div class="nouveau-cours">
            <label><input type="radio" name="cours" value="nouveau" required ${
              nouveau ? "checked" : ""
            }> ${icone("plus")}Créer un cours</label>
            <div class="nouveau-cours-champs">
              ${
                cat.matieres.length
                  ? html`<label>${l.matiere} <select name="nouveau_matiere">${options(
                      cat.matieres,
                      v.nouveau_matiere,
                    )}<option value="nouvelle" ${
                      v.nouveau_matiere === "nouvelle" ? "selected" : ""
                    }>Créer une matière</option></select></label>`
                  : html`<input type="hidden" name="nouveau_matiere" value="nouvelle">`
              }
              <div class="nouvelle-matiere ${cat.matieres.length ? "selon-choix" : ""}">
                <label>${l.matiere} à créer <input type="text" name="nouvelle_matiere"
                  maxlength="200" value="${v.nouvelle_matiere ?? ""}" data-requis></label>
                ${o.sansProfil ? selectionProfil(v.profil) : ""}
              </div>
              <label>${l.cours} à créer <input type="text" name="nouveau_cours" maxlength="200"
                value="${v.nouveau_cours ?? ""}" data-requis></label>
            </div>
          </div>
        `
          : ""
      }
    </fieldset>
  `;
};
/** Les cours rangés par matière. Le thème d'un cours ne s'affiche qu'une fois le cours coché. */
export const liens = (cat: Catalogue, l: Libelles, valeurs: Affiliation[] = []) =>
  html`<fieldset class="rattachement"><legend><strong>${l.cours_pluriel} de rattachement</strong></legend><input type="hidden" name="affiliations_presentes" value="1"><p class="aide">Les membres des cours cochés lisent la ressource, dans la limite de ses lecteurs. Une ressource rattachée garde au moins un cours.</p>${cat.matieres.map(
    (m) => {
      const cours = cat.cours.filter((c) => c.matiere_id === m.id);
      return cours.length
        ? html`<fieldset><legend>${m.nom}</legend>${cours.map((c) => {
            const lien = valeurs.find((v) => v.cours_id === c.id);
            const themes = cat.themes.filter((t) => t.cours_id === c.id);
            return html`
              <div class="lien-cours"><label><input type="checkbox" name="cours" value="${
                c.id
              }" ${lien ? "checked" : ""}> ${c.nom}</label>${
                themes.length
                  ? html`<label class="theme-cours">${l.regroupement} <select name="theme_${
                      c.id
                    }" aria-label="${l.regroupement} dans ${c.nom}"><option value="">Sans ${minuscule(
                      l.regroupement,
                    )}</option>${options(themes, lien?.theme_id ?? "")}</select></label>`
                  : ""
              }</div>
            `;
          })}</fieldset>`
        : "";
    },
  )}</fieldset>`;
export const informations = (
  liste: Champ[],
  meta: Record<string, unknown>,
  propositions: Record<string, string> = {},
) =>
  html`${liste.map((c) => {
    const propose = !meta[c.cle] && Boolean(propositions[c.cle]);
    return html`
      <div
        class="champ"><label for="${c.cle}">${c.label}</label>${
          propose ? html`<p class="aide" id="${c.cle}-aide">Proposé par Thot, à vérifier.</p>` : ""
        }<input id="${c.cle}" name="${c.cle}" type="${
          c.type === "date" ? "date" : "text"
        }" value="${String(meta[c.cle] || propositions[c.cle] || "")}" maxlength="120" ${
          propose ? html`aria-describedby="${c.cle}-aide"` : ""
        }></div>
    `;
  })}`;
export const langue = (valeur = "fr") =>
  html`
    <label>Langue de la source <input type="text" name="langue" value="${valeur}" maxlength="30"></label><p
      class="aide">Français (fr) et anglais (en) pris en charge : une question en français trouve aussi les passages en anglais. Autres langues : recherche non prise en charge.</p>
  `;
