import { html } from "hono/html";
import type { Catalogue, Scope } from "../domaines.ts";
import { icone } from "../icones.ts";
import type { Libelles } from "../instance.ts";
import { options } from "./commun.ts";

/**
 * Les listes du périmètre, communes au filtre de la bibliothèque et à celui du chat. Sans thème
 * dans les cours du compte, la liste des thèmes disparaît.
 */
export const selectsPerimetre = (cat: Catalogue, p: Scope, l: Libelles) =>
  html`
      <label>${l.matiere} <select name="matiere_id"><option value="">Tout</option>${options(
        cat.matieres,
        p.matiere_id,
      )}</select></label>
      <label>${l.cours} <select name="cours_id"><option value="">Tout</option>${options(
        cat.cours.map((c) => ({
          id: c.id,
          nom: `${cat.matieres.find((m) => m.id === c.matiere_id)?.nom} / ${c.nom}`,
        })),
        p.cours_id,
      )}</select></label>
      ${
        cat.themes.length
          ? html`<label>${l.regroupement} <select name="theme_id"><option value="">Tout</option>${options(
              cat.themes.map((t) => ({
                id: t.id,
                nom: `${
                  cat.matieres.find(
                    (m) => m.id === cat.cours.find((c) => c.id === t.cours_id)?.matiere_id,
                  )?.nom
                } / ${cat.cours.find((c) => c.id === t.cours_id)?.nom} / ${t.nom}`,
              })),
              p.theme_id,
            )}</select></label>`
          : ""
      }
  `;

/** Un terme réglé n'a pas de genre : « tous les cours » ne s'accorderait pas avec « matière ». */
const TOUT = "Toutes les ressources";
/**
 * Le choix du cours : un bouton ouvre la grille des cours, rangés par matière, chaque thème sous
 * son cours. Un lien applique le choix. `garder` : les paramètres de la page que le choix garde.
 * `tout` nomme le choix sans cours, `themes: false` ne propose que les cours.
 */
export const filtre = (
  cat: Catalogue,
  p: Scope,
  action: string,
  l: Libelles,
  garder: Record<string, string> = {},
  { tout = TOUT, themes = true } = {},
) => {
  const lien = (champs: Record<string, string>) => {
    const q = new URLSearchParams(Object.entries(garder).filter(([, v]) => v));
    for (const [k, v] of Object.entries(champs)) q.set(k, v);
    return `${action}?${q}`;
  };
  const actuel = (vrai: boolean) => html`aria-current="${String(vrai)}"`;
  const c = cat.cours.find((x) => x.id === p.cours_id);
  const t = cat.themes.find((x) => x.id === p.theme_id);
  const choisi = p.theme_id
    ? t
      ? `${cat.cours.find((x) => x.id === t.cours_id)?.nom}, ${t.nom}`
      : `${l.regroupement} indisponible`
    : p.cours_id
      ? (c?.nom ?? `${l.cours} indisponible`)
      : p.matiere_id
        ? (cat.matieres.find((m) => m.id === p.matiere_id)?.nom ?? `${l.matiere} indisponible`)
        : tout;
  const plusieurs = cat.matieres.length > 1;
  const vue = garder.vue ?? "";
  const portee = Object.fromEntries(Object.entries(p).filter(([, v]) => v));
  return html`
    <div class="biblio-outils">
      ${
        cat.cours.length || choisi !== tout
          ? html`
        <div class="champ-cours">
          <span class="etiquette" id="etiquette-cours">${l.cours}</span>
          <button type="button" class="choix-cours" id="bouton-cours" popovertarget="grille-cours" aria-labelledby="etiquette-cours bouton-cours">
            ${choisi} ${icone("caret-down")}
          </button>
        </div>
        <nav id="grille-cours" popover aria-label="${l.cours_pluriel}">
          <a href="${lien({ cours_id: "" })}" ${actuel(
            !p.matiere_id && !p.cours_id && !p.theme_id && !p.matieres,
          )}>${tout}</a>
          ${cat.matieres.map((m) => {
            const cours = cat.cours.filter((x) => x.matiere_id === m.id);
            return cours.length
              ? html`
              ${
                plusieurs
                  ? html`<a class="matiere" href="${lien({ matiere_id: m.id })}" ${actuel(
                      p.matiere_id === m.id && !p.cours_id && !p.theme_id,
                    )}>${m.nom}</a>`
                  : ""
              }
              <ul>${cours.map(
                (x) => html`
                <li>
                  <a href="${lien({ cours_id: x.id })}" ${actuel(
                    p.cours_id === x.id && !p.theme_id,
                  )}>${x.nom}${x.public ? html`<small>${x.public}</small>` : ""}</a>
                  ${(themes ? cat.themes : [])
                    .filter((y) => y.cours_id === x.id)
                    .map(
                      (y) =>
                        html`<a class="theme" href="${lien({ cours_id: x.id, theme_id: y.id })}" ${actuel(
                          p.theme_id === y.id,
                        )}>${y.nom}</a>`,
                    )}
                </li>
              `,
              )}</ul>
            `
              : "";
          })}
        </nav>
      `
          : ""
      }
      ${
        action === "/eleve"
          ? html`<nav class="segments" aria-label="Affichage">${(
              [
                ["", "Liste", "list"],
                ["grille", "Dossiers", "squares-four"],
              ] as const
            ).map(
              ([v, nom, i]) =>
                html`<a href="${lien({ ...portee, vue: v })}" title="${nom}" ${actuel(
                  v === vue,
                )}>${icone(i)}<span class="visuellement-cache">${nom}</span></a>`,
            )}</nav>`
          : ""
      }
    </div>
  `;
};
export const champsScope = (p: Record<string, string>) =>
  html`${Object.entries(p).map(([n, v]) => html`<input type="hidden" name="${n}" value="${v}">`)}`;
