import { html } from "hono/html";
import { AUDIENCES } from "../depot.ts";
import { icone } from "../icones.ts";
import { type Catalogue, type Scope, idsMatieres } from "../domaines.ts";
import type { Libelles } from "../instance.ts";

type Option = { value: string; label: string };

const JOUR = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeZone: "Europe/Paris" });
/** « 22 septembre 2026 » à partir d'un horodatage ISO. */
export const jour = (iso: string) => JOUR.format(new Date(iso));

/** Sélecteur de fichier au libellé français, quelle que soit la langue du navigateur. */
export const champFichier = (accept: string, plusieurs = false) =>
  html`
    <span class="fichier ${plusieurs ? "zone-depot" : ""}">
      <input
        type="file"
        id="fichier"
        name="fichier"
        accept="${accept}"
        ${plusieurs ? "multiple" : ""}
        required
        class="visuellement-cache"
      >
      <label for="fichier" class="bouton">${icone("upload-simple")}Choisir ${
        plusieurs ? "des fichiers" : "un fichier"
      }</label>
      <output for="fichier" class="discret">${
        plusieurs ? "ou glissez-les sur la page" : "Aucun fichier choisi"
      }</output>
    </span>
  `;

export const champ = (o: {
  nom: string;
  label: string;
  valeur?: string;
  erreur?: string;
  aide?: string;
  requis?: boolean;
  options?: Option[];
  zone?: boolean;
}) =>
  html`
    <div class="champ">
      <label for="${o.nom}">${o.label}${o.requis ? " *" : ""}</label>
      ${
        o.aide
          ? html`
          <p class="aide" id="${o.nom}-aide">${o.aide}</p>
        `
          : ""
      } ${
        o.options
          ? html`
          <select id="${o.nom}" name="${o.nom}" ${o.requis ? "required" : ""}>
            <option value="">Choisir</option>
            ${o.options.map(
              (x) =>
                html`
                <option value="${x.value}" ${x.value === o.valeur ? "selected" : ""}>${
                  x.label
                }</option>
              `,
            )}
          </select>
        `
          : o.zone
            ? html`
          <textarea id="${o.nom}" name="${o.nom}">${o.valeur ?? ""}</textarea>
        `
            : html`
          <input type="text" id="${o.nom}" name="${o.nom}" value="${o.valeur ?? ""}" ${
            o.requis ? "required" : ""
          }>
        `
      } ${
        o.erreur
          ? html`
          <p class="erreur" id="${o.nom}-erreur">${o.erreur}</p>
        `
          : ""
      }
    </div>
  `;

/** `titre` : faux quand le titre de l'étape du dépôt pose déjà la question. */
export const lecteurs = (audience = "eleves", reponses = true, titre = true) =>
  html`
    <fieldset>
      <legend class="${titre ? "" : "visuellement-cache"}"><strong>Qui peut la lire ?</strong></legend>
      ${AUDIENCES.map(
        (a) =>
          html`
          <label><input type="radio" name="audience" value="${a.value}" ${
            audience === a.value ? "checked" : ""
          }> ${a.label}</label>
        `,
      )}
      <label><input type="checkbox" name="reponses" value="1" ${reponses ? "checked" : ""}> Thot
        s'en sert pour répondre</label>
      <p class="aide">Une réponse ne cite que les ressources certifiées que son lecteur peut lire.</p>
    </fieldset>
  `;

export const nombre = (n: number, mot: string) => `${n} ${mot}${n > 1 ? "s" : ""}`;

const LISTE = new Intl.ListFormat("fr");
/**
 * « Arts appliqués / STD2A / Bauhaus », en nommant le niveau qui a disparu. Vide : tout. Une
 * comparaison nomme ses matières : « Histoire de l'art et Physique ».
 */
export const nomPerimetre = (
  cat: Catalogue,
  p: Scope,
  l: Pick<Libelles, "matiere" | "cours" | "regroupement">,
) => {
  if (p.matieres) {
    return LISTE.format(
      idsMatieres(p.matieres)
        .map((id) => cat.matieres.find((m) => m.id === id)?.nom ?? `${l.matiere} indisponible`)
        .sort((a, b) => a.localeCompare(b, "fr")),
    );
  }
  const t = cat.themes.find((x) => x.id === p.theme_id);
  const c = cat.cours.find((x) => x.id === (p.cours_id || t?.cours_id));
  const m = cat.matieres.find((x) => x.id === (p.matiere_id || c?.matiere_id));
  return [
    m?.nom ?? (p.matiere_id ? `${l.matiere} indisponible` : ""),
    c?.nom ?? (p.cours_id ? `${l.cours} indisponible` : ""),
    t?.nom ?? (p.theme_id ? `${l.regroupement} indisponible` : ""),
  ]
    .filter(Boolean)
    .join(" / ");
};
