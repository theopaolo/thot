import { html } from "hono/html";
import { icone } from "../icones.ts";
import type { Profil } from "../../core/profils.ts";
import type { Scope } from "../domaines.ts";
import { champsScope } from "./perimetre.ts";

export type ChapitreVue = {
  nom: string;
  themeId?: string;
  coursId?: string;
  cours?: string;
  matiereId?: string;
  matiere?: string;
  sources: SourceChapitre[];
  questions: string[];
};

export type SourceChapitre = {
  id: string;
  titre: string;
  seance: string;
  date: string;
  quiz_reponse: string;
  profil?: Profil;
  image_id: string | null;
  format?: string;
  /** l'ordre de lecture que l'enseignant donne, `null` sans ordre */
  ordre?: number | null;
};

/**
 * Rejoué avec la même clé et le même texte, un envoi retrouve l'échange déjà créé au lieu d'en
 * ouvrir un autre.
 */
export const cleEnvoi = () => html`<input type="hidden" name="cle" value="${crypto.randomUUID()}">`;

/**
 * Une question proposée: un bouton qui l'envoie telle quelle, sans passer par la saisie. Dans le
 * chat, elle continue la conversation ouverte. Ailleurs, elle en commence une.
 */
export const idee = (
  q: string,
  htmx: boolean,
  libelle = q,
  themeId = "",
  scope: Partial<Scope> = {},
) =>
  htmx
    ? html`
      <button
        type="button"
        class="idee"
        hx-post="/eleve/questions"
        hx-vals="${JSON.stringify({ texte: q, cle: crypto.randomUUID() })}"
        hx-include="[name=conversation]"
        hx-target="#conversation"
        hx-swap="beforeend"
      >${icone("arrow-right")}${libelle}</button>
    `
    : html`
      <form method="post" action="/eleve/questions" class="idee-form">
        ${champsScope({ ...scope, theme_id: themeId || scope.theme_id || "", texte: q })}${cleEnvoi()}<button class="idee">${icone(
          "arrow-right",
        )}${libelle}</button>
      </form>
    `;

export const nomChapitre = (nom: string) => nom.replace(/^ATC\s+/, "");

/** La page d'un thème, ou celle des documents sans thème. */
export const lienTheme = (themeId?: string | null, doc?: string) =>
  `${themeId ? `/eleve/themes/${themeId}` : "/eleve/sans-sequence"}${doc ? `?doc=${doc}` : ""}`;

export const fermer = html`
  <button type="button" class="fermer-feuille">${icone("x")}Fermer</button>
`;
