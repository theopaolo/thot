import { html } from "hono/html";
import {
  type Contenu,
  CRITERES,
  type Explication,
  MAX_TEXTE,
  OPTIONS,
  type Question,
  type TypeQuestion,
} from "../../core/activite.ts";
import type { Activite, imagesCitables } from "../activites.ts";
import { LANGAGES, MAX_PASSAGES, type Saisie, un } from "../edition.ts";
import type { Libelles } from "../instance.ts";
import { imageQuestion, lettre, NOMS_TYPE } from "./questions.ts";
import { option } from "./activites.ts";

/** La question ouverte en formulaire : `nouvelle` pour une question à ajouter. */
export type Edition = { id: string; type: TypeQuestion; saisie: Saisie };

export type DetailProf = {
  a: Activite;
  contenu: Contenu | Explication;
  relectures: { revision: number; action: string; le: string; nom: string | null }[];
  servies: Map<string, number | undefined>;
  libelles: Libelles;
  /** les cours de l'activité, chacun avec les titres des sources qui n'y tiennent pas */
  cours: { id: string; nom: string; bloquantes: string[] }[];
  /** les autres cours du compte, où l'ajouter */
  autres: { id: string; nom: string }[];
  objectifs: { id: string; intitule: string }[];
  /** les sources que la série peut citer */
  sources: { id: string; titre: string }[];
  images: ReturnType<typeof imagesCitables>;
  /** le titre de chaque source citée, montrée ou citable */
  titres: Map<string, string>;
  /** absent pour un compte qui ne lit pas les réponses */
  suivi?: { eleves: number; remis: number };
  /** jamais publiée et sans tentative */
  supprimable: boolean;
  edition?: Edition;
  erreur?: string;
};

/**
 * Les passages d'un champ dans le formulaire : un par zone de texte, sa source en champ caché, puis
 * une ligne pour en ajouter un. Une saisie refusée peut nommer une source inconnue : elle se
 * choisit de nouveau.
 */
const passagesSaisis = (d: DetailProf, s: Saisie, cle: string) => {
  const remplis = Array.from({ length: MAX_PASSAGES + 1 }, (_, j) => ({
    source: un(s, `${cle}_s${j}`),
    passage: un(s, `${cle}_p${j}`).trim(),
  })).filter((p) => p.passage);
  const choix = (j: number, choisie: string) =>
    html`<select id="f-${cle}-s${j}" name="${cle}_s${j}">${d.sources.map((x) =>
      option(x.id, x.titre, choisie),
    )}</select>`;
  const n = remplis.length;
  return html`${remplis.map((p, j) =>
    d.titres.has(p.source)
      ? html`<input type="hidden" name="${cle}_s${j}" value="${p.source}">
        <label for="f-${cle}-p${j}" class="aide">Passage de « ${d.titres.get(p.source)} »</label>
        <textarea id="f-${cle}-p${j}" name="${cle}_p${j}" rows="2" maxlength="${MAX_TEXTE}">${p.passage}</textarea>`
      : html`<label for="f-${cle}-s${j}" class="aide">Source du passage</label>${choix(j, p.source)}
        <textarea id="f-${cle}-p${j}" name="${cle}_p${j}" rows="2" maxlength="${MAX_TEXTE}" aria-label="Passage">${p.passage}</textarea>`,
  )}${
    n < MAX_PASSAGES && d.sources.length
      ? html`<details class="ajout-passage"><summary>Ajouter un passage</summary>
        <label for="f-${cle}-s${n}">Source</label>${choix(n, "")}
        <label for="f-${cle}-p${n}">Passage, copié mot pour mot de la source</label>
        <textarea id="f-${cle}-p${n}" name="${cle}_p${n}" rows="2" maxlength="${MAX_TEXTE}"></textarea>
      </details>`
      : ""
  }`;
};

/** Une zone de texte pour un champ, puis ses passages. */
const zone = (
  d: DetailProf,
  s: Saisie,
  cle: string,
  libelle: string,
  rows: number,
  requis = false,
) => html`<div class="champ">
  <label for="f-${cle}">${libelle}</label>
  <textarea id="f-${cle}" name="${cle}" rows="${rows}" maxlength="${MAX_TEXTE}" ${requis ? "required" : ""}>${un(s, cle)}</textarea>
  ${passagesSaisis(d, s, cle)}
</div>`;

/** Les champs propres au type de la question. */
const champsType = (d: DetailProf, s: Saisie, type: TypeQuestion, avant?: Question) => {
  if (type === "redigee") {
    const remplis = Array.from({ length: CRITERES.max }, (_, i) => un(s, `critere_${i}`).trim());
    const n = Math.min(CRITERES.max, remplis.findLastIndex(Boolean) + 2);
    const langages: string[] = [...LANGAGES];
    const actuel = avant?.type === "redigee" ? avant.langage : undefined;
    if (actuel && !langages.includes(actuel)) langages.push(actuel);
    return html`
      ${zone(d, s, "attendu", "Réponse attendue", 4)}
      <fieldset>
        <legend><strong>Critères</strong></legend>
        <p class="aide">${CRITERES.max} au plus. L'élève coche ceux qu'il pense remplir. Un critère vidé disparaît.</p>
        ${Array.from({ length: n }, (_, i) => zone(d, s, `critere_${i}`, `Critère ${i + 1}`, 2))}
      </fieldset>
      <div class="champ">
        <label for="f-langage">Langage</label>
        <p class="aide">Avec un langage, l'élève répond dans une zone à chasse fixe et le corrigé s'affiche coloré.</p>
        <select id="f-langage" name="langage">${[
          option("", "Texte", un(s, "langage")),
          ...langages.map((x) => option(x, x, un(s, "langage"))),
        ]}</select>
      </div>`;
  }
  if (type === "terme") {
    return html`<div class="champ">
      <label for="f-accepte">Réponses acceptées</label>
      <p class="aide">Une par ligne. Thot compare sans majuscules, sans accents ni mots de liaison, et tolère une faute de frappe dès 5 lettres, deux dès 10.</p>
      <textarea id="f-accepte" name="accepte" rows="4" required>${un(s, "accepte")}</textarea>
    </div>`;
  }
  const justes = new Set([s.juste ?? []].flat());
  const multiple = type === "choix_multiple";
  return html`<fieldset>
    <legend><strong>Options</strong></legend>
    <p class="aide">De ${OPTIONS.min} à ${OPTIONS.max} options. ${
      multiple ? "Cochez les bonnes réponses." : "Cochez la bonne réponse."
    } Une option vidée disparaît. L'élève les reçoit dans un ordre mélangé.</p>
    ${Array.from(
      { length: OPTIONS.max },
      (_, i) => html`<div class="option-edition">
        <input type="hidden" name="option_${i}_id" value="${un(s, `option_${i}_id`)}">
        <label><input type="${multiple ? "checkbox" : "radio"}" name="juste" value="${i}" ${
          justes.has(String(i)) ? "checked" : ""
        }> Option ${lettre(i)} juste</label>
        ${zone(d, s, `option_${i}`, `Option ${lettre(i)}`, 2)}
      </div>`,
    )}
  </fieldset>`;
};

/** Le formulaire d'une question, à sa place dans la série. */
export const formulaire = (d: DetailProf, e: Edition, rang: number, avant?: Question) => {
  const { a } = d;
  const s = e.saisie;
  const id = avant ? encodeURIComponent(avant.id) : "";
  const image = avant?.image;
  return html`<section class="question-prof" id="q-${avant?.id ?? "nouvelle"}">
    <h3>${avant ? `Question ${rang + 1}` : "Nouvelle question"} <span class="discret">${NOMS_TYPE[e.type]}</span></h3>
    ${d.erreur ? html`<p role="alert">${d.erreur}</p>` : ""}
    <form method="post" enctype="multipart/form-data" class="etroit"
      action="/prof/activites/${a.id}/questions${avant ? `/${id}/enregistrer` : ""}">
      <input type="hidden" name="revision" value="${a.revision}">
      ${avant ? "" : html`<input type="hidden" name="type" value="${e.type}">`}
      <p class="aide">Enregistrer crée la version ${a.revision + 1}, à relire avant publication. Chaque passage est cherché mot pour mot dans la version actuelle de sa source. Videz un passage pour le retirer. Un champ sans passage s'affiche « Rédigé par l'enseignant ».</p>
      ${zone(d, s, "consigne", "Consigne", 4, true)}
      ${champsType(d, s, e.type, avant)}
      ${zone(d, s, "retour", "Retour, lu après la correction", 3)}
      <div class="champ">
        <label for="f-indice">Indice</label>
        <p class="aide">Montré après une première erreur, quand le corrigé suit chaque question.</p>
        <input type="text" id="f-indice" name="indice" maxlength="500" value="${un(s, "indice")}">
      </div>
      <div class="champ">
        <label for="f-ou">Où chercher</label>
        <select id="f-ou" name="ou">${[
          option("", "Aucune source", un(s, "ou")),
          ...d.sources.map((x) => option(x.id, x.titre, un(s, "ou"))),
        ]}</select>
      </div>
      <fieldset>
        <legend><strong>Image</strong></legend>
        ${
          image
            ? html`${imageQuestion(a.id, image)}<label><input type="checkbox" name="image_retirer" value="1"> Retirer l'image</label>`
            : ""
        }
        <div class="champ">
          <label for="f-image">Déposer une image</label>
          <p class="aide">PNG, JPEG, WebP ou GIF, 5 Mo au plus.${image ? " Elle remplace l'image actuelle." : ""}</p>
          <input type="file" id="f-image" name="image_fichier" accept="image/png,image/jpeg,image/webp,image/gif">
        </div>
        ${
          d.images.length
            ? html`<div class="champ">
              <label for="f-media">Ou une image d'une source du cours</label>
              <select id="f-media" name="image_media">${[
                option(
                  "",
                  image?.fichier ? "Garder l'image déposée" : "Aucune",
                  un(s, "image_media"),
                ),
                ...d.images.map((x) =>
                  option(
                    x.id,
                    `${x.titre} : ${(x.legende ?? "sans légende").slice(0, 80)}`,
                    un(s, "image_media"),
                  ),
                ),
              ]}</select>
            </div>`
            : ""
        }
        <div class="champ">
          <label for="f-alt">Texte alternatif</label>
          <p class="aide">Obligatoire avec une image : ce qu'elle montre, pour qui ne la voit pas.</p>
          <input type="text" id="f-alt" name="image_alt" maxlength="300" value="${un(s, "image_alt")}">
        </div>
      </fieldset>
      <div class="barre">
        <button class="principal">Enregistrer</button>
        <a href="/prof/activites/${a.id}${avant ? `#q-${id}` : ""}">Annuler</a>
      </div>
    </form>
  </section>`;
};
