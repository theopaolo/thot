import { html } from "hono/html";
import {
  type Champ,
  type Citation,
  champsQuestion,
  type Contenu,
  CRITERES,
  type Explication,
  MAX_TEXTE,
  OPTIONS,
  type Question,
  TYPES_QUESTION,
  type TypeQuestion,
} from "../../core/activite.ts";
import { SEUIL_SOUTIEN } from "../../core/reponse.ts";
import type {
  Activite,
  ActiviteListee,
  FiltreActivites,
  imagesCitables,
  suiviObjectifs,
} from "../activites.ts";
import { MAX_PASSAGES, type Saisie, un } from "../edition.ts";
import type { Catalogue } from "../domaines.ts";
import { icone } from "../icones.ts";
import { type Libelles, minuscule } from "../instance.ts";
import { filtre as filtreCours } from "./domaines.ts";
import { jour, ongletsBibliotheque } from "./prof.ts";
import { enrichi, enrichiLigne, imageQuestion, LANGAGES, lettre, NOMS_TYPE } from "./questions.ts";

export const ETATS: Record<Activite["etat"], [string, string]> = {
  brouillon: ["Brouillon", "a_relire"],
  relue: ["Relu", "en-cours"],
  publiee: ["Publié", "certifiee"],
  a_revoir: ["À revoir", "failed"],
};
const ACTIONS: Record<string, string> = {
  relue: "Relu",
  publiee: "Publié",
  modifiee: "Modifié",
  a_revoir: "Signalé à revoir",
};
export const etat = (a: Activite) =>
  html`<span class="statut ${ETATS[a.etat][1]}">${ETATS[a.etat][0]}</span>${
    a.archivee_le ? html` <span class="statut">Archivée</span>` : ""
  }`;

/** Un passage cité. Sans offsets, il vient d'une légende d'image relue. */
export type Cite = Pick<Citation, "source_id" | "revision" | "titre" | "citation"> &
  Partial<Pick<Citation, "debut" | "fin">>;

/** Le lecteur de source existant, ouvert sur le passage, dans la révision citée. */
export const lien = (c: Cite) =>
  c.debut === undefined
    ? `/eleve/sources/${c.source_id}`
    : `/eleve/sources/${c.source_id}?debut=${c.debut}&fin=${c.fin}&revision=${c.revision}#passage`;

/** Les passages d'un champ. Avec `servies`, une citation qui ne tient plus le dit. */
export const passages = (ch: { citations: Cite[] }, servies?: Map<string, number | undefined>) =>
  ch.citations.length
    ? html`<ul class="discret">${ch.citations.map((c) => {
        const servie = servies?.get(c.source_id);
        const ecart =
          servies && servie !== c.revision
            ? html` <span class="statut failed">${
                servie === undefined
                  ? "source plus citable dans ce cours"
                  : `version ${c.revision} citée, la source sert la version ${servie}`
              }</span>`
            : "";
        return html`<li>« ${c.citation} » <a href="${lien(c)}">${c.titre}</a>${ecart}</li>`;
      })}</ul>`
    : "";

/** L'avis du juge de soutien sur un champ. Il ne bloque rien : l'enseignant tranche. */
export const avis = (ch: Champ) =>
  ch.soutien === null
    ? html`<p><span class="statut a_relire">Juge indisponible</span> <span class="discret">Les passages sont retrouvés mot pour mot, mais le juge n'a pas vérifié qu'ils établissent ce champ.</span></p>`
    : ch.soutien !== undefined && ch.soutien < SEUIL_SOUTIEN
      ? html`<p><span class="statut failed">À vérifier</span> <span class="discret">Selon le juge de soutien, les passages cités n'établissent pas tout ce que dit ce champ.</span></p>`
      : "";

export const TYPES: Record<Activite["type"], string> = {
  exercice: "Exercice",
  explication: "Explication",
};

const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? "s" : ""}`;

/** « Exercice, 3 questions » ou « Explication ». */
const typeDe = (type: Activite["type"], questions: number | null) =>
  type === "exercice" && questions !== null
    ? `Exercice, ${pluriel(questions, "question")}`
    : TYPES[type];

const option = (valeur: string, libelle: string, choisie: string) =>
  html`<option value="${valeur}" ${valeur === choisie ? "selected" : ""}>${libelle}</option>`;

// Bibliothèque

const FILTRES_ETAT = [
  ["", "Toutes, sauf archivées"],
  ["brouillon", "Brouillons"],
  ["relue", "Relues"],
  ["publiee", "Publiées"],
  ["a_revoir", "À revoir"],
  ["archivee", "Archivées"],
];
export const ETATS_FILTRE = FILTRES_ETAT.map(([v]) => v).filter(Boolean);

export type Liste = {
  liste: ActiviteListee[];
  cat: Catalogue;
  filtre: FiltreActivites;
  libelles: Libelles;
};

/** Le cours se choisit dans la même grille que pour les ressources, l'état dans le formulaire. */
export const listeProf = ({ liste, cat, filtre, libelles: l }: Liste) => html`
  ${filtreCours(
    cat,
    { matiere_id: filtre.matiereId ?? "", cours_id: filtre.coursId ?? "", theme_id: "" },
    "/prof/activites",
    l,
    { etat: filtre.etat ?? "" },
    { tout: "Toutes les activités", themes: false },
  )}
  <h1>Bibliothèque</h1>
  ${ongletsBibliotheque("/prof/activites")}
  <div class="barre">
    <a class="bouton principal" href="/prof/activites/nouvelle">Préparer une activité</a>
    <a class="bouton" href="/prof/activites/importer">Importer un quiz</a>
    <a href="/prof/objectifs">Objectifs</a>
  </div>
  <form method="get" action="/prof/activites" class="barre reglage">
    ${filtre.coursId ? html`<input type="hidden" name="cours_id" value="${filtre.coursId}">` : ""}
    ${filtre.matiereId ? html`<input type="hidden" name="matiere_id" value="${filtre.matiereId}">` : ""}
    <label for="filtre-etat">État</label>
    <select id="filtre-etat" name="etat">${FILTRES_ETAT.map(([v, t]) =>
      option(v, t, filtre.etat ?? ""),
    )}</select>
    <button>Filtrer</button>
  </form>
  ${
    liste.length
      ? html`<table>
        <thead><tr><th>Activité</th><th>État</th><th>Remises</th><th>Modifiée le</th></tr></thead>
        <tbody>${liste.map(
          // Deux activités au même titre se distinguent par la ligne qui le suit : type, nombre de
          // questions, cours, puis l'objectif quand le titre ne le reprend pas.
          (a) => html`<tr>
            <td><a href="/prof/activites/${a.id}">${a.titre}</a><br><span class="discret">${[
              typeDe(a.type, a.questions) + (a.les_cours ? `, dans ${a.les_cours}` : ""),
              a.titre === a.intitule ? "" : `Objectif : ${a.intitule}`,
            ]
              .filter(Boolean)
              .join(". ")}</span></td>
            <td>${etat(a)}</td><td>${a.remises}</td><td>${jour(a.maj_le)}</td>
          </tr>`,
        )}</tbody>
      </table>`
      : filtre.coursId || filtre.matiereId || filtre.etat
        ? html`<p>Aucune activité ne correspond à ce filtre.</p>`
        : html`<p>Aucune activité. Un exercice ou une explication part d'un objectif et de sources certifiées d'un cours.</p>`
  }
`;

// Objectifs

export type LigneObjectif = ReturnType<typeof suiviObjectifs>[number];

/** Les objectifs des cours du compte, avec leurs comptes, à renommer ou fusionner. */
export const objectifs = (liste: LigneObjectif[], l: Libelles, erreur?: string) => html`
  <p><a href="/prof/activites">Bibliothèque</a></p>
  <h1>Objectifs</h1>
  <p class="discret">Les objectifs de vos ${minuscule(l.cours_pluriel)}. Les tentatives remises sont celles des élèves que vous suivez, toutes versions confondues. Fusionner rattache les activités d'un objectif à un autre du même ${minuscule(l.cours)}, puis supprime le premier.</p>
  ${erreur ? html`<p role="alert">${erreur}</p>` : ""}
  ${
    liste.length
      ? html`<table>
        <thead><tr><th>Objectif</th><th>${l.cours}</th><th>Activités</th><th>Publiées</th><th>Tentatives remises</th><th>Fusionner dans</th></tr></thead>
        <tbody>${liste.map((o) => {
          const autres = liste.filter((x) => x.cours_id === o.cours_id && x.id !== o.id);
          return html`<tr>
            <td><form method="post" action="/prof/objectifs/${o.id}/renommer" class="barre reglage">
              <input type="text" name="intitule" value="${o.intitule}" maxlength="300" required aria-label="Intitulé de l'objectif">
              <button>Renommer</button>
            </form>${o.reference ? html`<span class="discret">${o.reference}</span>` : ""}</td>
            <td>${o.cours}</td><td>${o.activites}</td><td>${o.publiees}</td><td>${o.tentatives}</td>
            <td>${
              autres.length
                ? html`<form method="post" action="/prof/objectifs/${o.id}/fusionner" class="barre reglage">
                  <select name="vers" aria-label="Objectif qui reprend les activités de « ${o.intitule} »">${autres.map(
                    (x) => option(x.id, x.intitule, ""),
                  )}</select>
                  <button data-confirmer="Fusionner « ${o.intitule} » dans l'objectif choisi ? Ses activités passent à cet objectif, puis il disparaît.">Fusionner</button>
                </form>`
                : html`<span class="discret">Seul objectif de ce ${minuscule(l.cours)}</span>`
            }</td>
          </tr>`;
        })}</tbody>
      </table>`
      : html`<p>Aucun objectif. Un objectif naît avec la première activité préparée pour lui.</p>`
  }
`;

// Page d'une activité

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

type Servies = DetailProf["servies"];

const VIDE_SOURCE = "Vide : sa source a été supprimée.";

/** Le texte d'un champ, puis ses preuves. Sans passage, il est rédigé par l'enseignant. */
const champ = (ch: Champ, servies: Servies, vide: string, signer: boolean) =>
  ch.texte
    ? html`${enrichi(ch.texte)}${
        ch.citations.length
          ? html`${avis(ch)}${passages(ch, servies)}`
          : signer
            ? html`<p class="discret">Rédigé par l'enseignant</p>`
            : ""
      }`
    : html`<p class="discret">${vide}</p>${passages(ch, servies)}`;

/** Le contenu propre au type : réponse attendue et critères, options, ou réponses acceptées. */
const corpsType = (q: Question, servies: Servies, signer: boolean) => {
  if (q.type === "redigee") {
    const code = q.langage && q.attendu.texte && !q.attendu.texte.includes("```");
    return html`
      <h4>Réponse attendue</h4>
      ${
        code
          ? html`<pre data-langage="${q.langage}"><code>${q.attendu.texte}</code></pre>${
              q.attendu.citations.length
                ? html`${avis(q.attendu)}${passages(q.attendu, servies)}`
                : signer
                  ? html`<p class="discret">Rédigé par l'enseignant</p>`
                  : ""
            }`
          : champ(q.attendu, servies, "Vide.", signer)
      }
      ${
        q.criteres.length
          ? html`<h4>Critères</h4><ol>${q.criteres.map(
              (ch) => html`<li>${champ(ch, servies, VIDE_SOURCE, signer)}</li>`,
            )}</ol>`
          : ""
      }`;
  }
  if (q.type === "terme") {
    return html`<h4>Réponses acceptées</h4><ul>${q.accepte.map((x) => html`<li>${x}</li>`)}</ul>`;
  }
  // Une option fausse n'affirme rien : elle ne dit pas qui l'a rédigée.
  return html`<ol type="A">${q.options.map(
    (o) =>
      html`<li>${o.texte.texte ? enrichiLigne(o.texte.texte) : html`<span class="discret">${VIDE_SOURCE}</span>`}${
        o.juste ? html` <span class="statut certifiee">Bonne réponse</span>` : ""
      }${o.texte.citations.length ? html`${avis(o.texte)}${passages(o.texte, servies)}` : ""}</li>`,
  )}</ol>`;
};

/** Une question en lecture, avec ses actions. */
const lecture = (d: DetailProf, n: number, q: Question, i: number) => {
  const { a, servies } = d;
  // Une question sans aucun passage le dit une fois, pas sous chaque champ.
  // Une consigne vide vient d'une source supprimée, pas de l'enseignant.
  const enseignant = !!q.consigne.texte && champsQuestion(q).every((ch) => !ch.citations.length);
  return html`<section class="question-prof" id="q-${q.id}">
    <h3>Question ${i + 1} <span class="discret">${NOMS_TYPE[q.type]}${
      q.type === "redigee" && q.langage ? `, ${q.langage}` : ""
    }${enseignant ? ", rédigée par l'enseignant" : ""}</span></h3>
    ${imageQuestion(a.id, q.image)}
    ${champ(q.consigne, servies, VIDE_SOURCE, !enseignant)}
    ${corpsType(q, servies, !enseignant)}
    ${q.indice ? html`<p><strong>Indice :</strong> ${enrichiLigne(q.indice)}</p>` : ""}
    ${q.ou ? html`<p><strong>Où chercher :</strong> ${d.titres.get(q.ou) ?? "source supprimée"}</p>` : ""}
    ${
      q.retour.texte || q.retour.citations.length
        ? html`<h4>Retour</h4>${champ(q.retour, servies, VIDE_SOURCE, !enseignant)}`
        : html`<p class="discret">Pas de retour.</p>`
    }
    ${actions(d, n, q, i)}
  </section>`;
};

/**
 * Modifier, puis les autres actions dans un menu ancré sous son bouton. Le menu reste dans le
 * formulaire : ses boutons envoient la version lue. Sans ancrage CSS, il s'ouvre au centre.
 */
const actions = (d: DetailProf, n: number, q: Question, i: number) => {
  const { a } = d;
  const id = encodeURIComponent(q.id);
  const base = `/prof/activites/${a.id}/questions/${id}`;
  return html`<form method="post" class="barre actions-question">
    <input type="hidden" name="revision" value="${a.revision}">
    <a class="bouton" href="/prof/activites/${a.id}?modifier=${id}#q-${id}">${icone("pencil-simple")}Modifier</a>
    <button type="button" popovertarget="menu-${q.id}" style="anchor-name: --menu-${i}">${icone("dots-three")}Autres actions</button>
    <div id="menu-${q.id}" popover class="menu-question" style="position-anchor: --menu-${i}">
      <button formaction="${base}/dupliquer">${icone("copy")}Dupliquer</button>
      <button formaction="${base}/regenerer">${icone("arrows-clockwise")}Proposer une autre question</button>
      <button formaction="${base}/monter" class="filet" ${i === 0 ? "disabled" : ""}>${icone("arrow-up")}Monter</button>
      <button formaction="${base}/descendre" ${i === n - 1 ? "disabled" : ""}>${icone("arrow-down")}Descendre</button>
      ${
        n > 2
          ? html`<div class="deplacer">
            <label for="rang-${q.id}">Déplacer en position</label>
            <select id="rang-${q.id}" name="rang">${Array.from(
              { length: n },
              (_, k) =>
                html`<option value="${k + 1}" ${k === i ? "selected" : ""}>${k + 1}${k === i ? ", actuelle" : ""}</option>`,
            )}</select>
            <button formaction="${base}/deplacer">${icone("arrows-down-up")}Déplacer</button>
          </div>`
          : ""
      }
      <button formaction="${base}/supprimer" class="danger filet" ${n === 1 ? "disabled" : ""}
        data-confirmer="Supprimer la question ${i + 1} ? La version suivante ne l'aura plus.">${icone("trash")}Supprimer</button>
    </div>
  </form>`;
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
const formulaire = (d: DetailProf, e: Edition, rang: number, avant?: Question) => {
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

/**
 * Ce qu'une question demande à l'enseignant : « À revoir » quand une citation ne vise plus la
 * version servie ou que sa consigne est vide, « À vérifier » quand le juge ne soutient pas un champ.
 */
const aFaire = (q: Question, servies: Servies) =>
  !q.consigne.texte ||
  champsQuestion(q).some((ch) => ch.citations.some((c) => servies.get(c.source_id) !== c.revision))
    ? "À revoir"
    : champsQuestion(q).some(
          (ch) =>
            ch.citations.length && typeof ch.soutien === "number" && ch.soutien < SEUIL_SOUTIEN,
        )
      ? "À vérifier"
      : "";

/** L'index de la série, collé à droite des questions sur un écran large, comme le sommaire du lecteur. */
const indexQuestions = (
  d: DetailProf,
  contenu: Contenu,
) => html`<nav class="sommaire" aria-labelledby="index-questions">
  <h2 id="index-questions">${pluriel(contenu.questions.length, "question")}</h2>
  <ol>${contenu.questions.map((q, i) => {
    const etat = aFaire(q, d.servies);
    return html`<li><a href="#q-${q.id}"><span class="chiffres">${i + 1}.</span> ${NOMS_TYPE[q.type]}${
      etat ? html` <span class="statut failed">${etat}</span>` : ""
    }</a></li>`;
  })}</ol>
</nav>`;

const choixType = (nom: string, id: string) =>
  html`<select id="${id}" name="${nom}">${TYPES_QUESTION.map((t) => option(t, NOMS_TYPE[t], ""))}</select>`;

/** Les questions dans l'ordre, l'une d'elles ouverte en formulaire, puis l'ajout d'une question. */
const questions = (d: DetailProf, contenu: Contenu) => {
  const { a, edition: e } = d;
  const rejets = JSON.parse(a.rejets) as string[];
  const n = contenu.questions.length;
  const nouvelle = e && !contenu.questions.some((q) => q.id === e.id);
  return html`
    <h2>Questions</h2>
    ${
      rejets.length
        ? html`<p class="discret">${pluriel(rejets.length, "champ")} rejeté${
            rejets.length > 1 ? "s" : ""
          } à la génération : ${rejets.join(" ")}</p>`
        : ""
    }
    <div class="questions-colonnes"><div>
    ${contenu.questions.map((q, i) =>
      e?.id === q.id ? formulaire(d, e, i, q) : lecture(d, n, q, i),
    )}
    ${
      nouvelle
        ? formulaire(d, e, n)
        : html`<div class="ajout-question">
          <form method="get" action="/prof/activites/${a.id}#q-nouvelle" class="barre reglage">
            <input type="hidden" name="modifier" value="nouvelle">
            <label for="ajout-type">Ajouter une question</label>
            ${choixType("type", "ajout-type")}
            <button>Ajouter</button>
          </form>
          <form method="post" action="/prof/activites/${a.id}/questions/proposer" class="barre reglage">
            <input type="hidden" name="revision" value="${a.revision}">
            <label for="proposer-type">Faire rédiger une question par Thot</label>
            ${choixType("type", "proposer-type")}
            <button>Faire rédiger</button>
          </form>
        </div>`
    }
    </div>${indexQuestions(d, contenu)}</div>
  `;
};

/** Les phrases d'une explication et leurs preuves. L'aperçu élève les montre rangées en blocs. */
const corpsExplication = (e: Explication, servies: Servies) => html`
  ${
    e.juge_indisponible
      ? html`<p><span class="statut a_relire">Juge indisponible</span> <span class="discret">Une phrase au moins est passée sans l'avis du juge de soutien.</span></p>`
      : ""
  }
  ${
    e.partielle
      ? html`<p class="discret">Explication partielle : Thot a retiré les phrases dont la citation ne tenait pas.</p>`
      : ""
  }
  <h2>Phrases</h2>
  ${
    e.affirmations.length
      ? html`<ol>${e.affirmations.map(
          (x) =>
            html`<li><p>${x.texte}</p>${passages({ citations: [{ ...x, revision: x.revision ?? 1 }] }, servies)}</li>`,
        )}</ol>`
      : html`<p class="discret">Vide : ses sources ont été supprimées.</p>`
  }
  <p class="discret">L'aperçu élève montre les titres et le rangement en blocs, qui viennent du modèle sans preuve.</p>
`;

/**
 * Titre, date à rendre, objectif, cours et corrigé, dans un seul formulaire replié. Son résumé dit
 * les cours, le corrigé et la date. Retirer un cours passe par un formulaire à part, hors de celui-ci :
 * un bouton imbriqué deviendrait le bouton par défaut de la touche Entrée.
 */
const reglages = (d: DetailProf) => {
  const { a, contenu, libelles: l } = d;
  const serie = "questions" in contenu;
  const prive = a.audience === "prive";
  const resume = [
    prive ? "" : d.cours.map((c) => c.nom).join(", "),
    serie
      ? contenu.correction === "question"
        ? "corrigé après chaque question"
        : "corrigé après la remise"
      : "",
    a.a_rendre_le ? `à rendre le ${jour(a.a_rendre_le)}` : "",
  ].filter(Boolean);
  return html`<details class="reglages-activite" ${d.cours.some((c) => c.bloquantes.length) ? "open" : ""}>
    <summary>Réglages <span class="discret">${resume.join(", ")}</span></summary>
    <form method="post" action="/prof/activites/${a.id}/reglages">
      <input type="hidden" name="revision" value="${a.revision}">
      <div class="champ">
        <label for="titre">Titre</label>
        <input type="text" id="titre" name="titre" value="${a.titre}" maxlength="300" required>
      </div>
      <div class="champ">
        <label for="a_rendre_le">À rendre le</label>
        <input type="date" id="a_rendre_le" name="a_rendre_le" value="${a.a_rendre_le ?? ""}">
      </div>
      <div class="champ">
        <label for="objectif">Objectif</label>
        <select id="objectif" name="objectif_id">${d.objectifs.map((o) =>
          option(o.id, o.intitule, a.objectif_id),
        )}</select>
        <p class="aide">${a.reference ? `Référence : ${a.reference}. ` : ""}<a href="/prof/objectifs">Renommer ou fusionner les objectifs</a></p>
      </div>
      ${
        serie
          ? html`<div class="champ">
            <label for="correction">Corrigé</label>
            <select id="correction" name="correction">${[
              option("question", "Après chaque question", contenu.correction),
              option("serie", "Après la remise de la série", contenu.correction),
            ]}</select>
            <p class="aide">Le changer crée la version ${a.revision + 1}, à relire.</p>
          </div>`
          : ""
      }
      ${
        prive
          ? ""
          : html`<fieldset class="cours-activite">
            <legend><strong>${l.cours_pluriel}</strong></legend>
            <ul>${d.cours.map(
              (c) =>
                html`<li>${c.nom}${
                  c.bloquantes.length
                    ? html` <span class="statut failed">Ne tient plus : ${c.bloquantes.join(", ")}</span>`
                    : ""
                } ${
                  c.id === a.cours_id
                    ? html`<span class="discret">origine, porte l'objectif</span>`
                    : html`<button class="lien" form="retirer-${c.id}" aria-label="Retirer ${c.nom}">Retirer</button>`
                }</li>`,
            )}</ul>
            ${
              d.autres.length
                ? html`<label for="ajout-cours">Ajouter à un ${minuscule(l.cours)}</label>
                  <select id="ajout-cours" name="cours_id">${[
                    option("", "Aucun", ""),
                    ...d.autres.map((c) => option(c.id, c.nom, "")),
                  ]}</select>`
                : ""
            }
          </fieldset>`
      }
      <div class="barre"><button>Enregistrer</button></div>
    </form>
    ${
      prive
        ? ""
        : d.cours
            .filter((c) => c.id !== a.cours_id)
            .map(
              (c) =>
                html`<form id="retirer-${c.id}" method="post" action="/prof/activites/${a.id}/cours/${c.id}/retirer"></form>`,
            )
    }
  </details>`;
};

/** La page d'une activité : ses réglages, ses questions à modifier, ses réponses, son historique. */
export const detailProf = (d: DetailProf) => {
  const { a, contenu } = d;
  const personnel = a.audience === "prive";
  const explication = "affirmations" in contenu;
  const fautifs = d.cours.filter((c) => c.bloquantes.length);
  return html`
    <p><a href="/prof/activites">Bibliothèque</a></p>
    <h1>${a.titre}</h1>
    <p class="discret">${typeDe(a.type, explication ? null : contenu.questions.length)}, version ${a.revision} ${etat(a)}</p>
    ${d.erreur && !d.edition ? html`<p role="alert">${d.erreur}</p>` : ""}
    ${
      personnel
        ? html`<p class="note">${
            explication ? "Explication privée, générée" : "Exercice privé, généré"
          } par Thot. Votre relecture ne vaut pas relecture indépendante.</p>`
        : ""
    }
    ${
      a.etat === "a_revoir"
        ? html`<div role="alert"><p>Une source citée a une nouvelle version, n'est plus citable ou a été supprimée${
            fautifs.length
              ? `. Ne tiennent plus : ${fautifs.map((c) => `${c.bloquantes.join(", ")} dans ${c.nom}`).join(", ")}`
              : ""
          }. ${
            explication
              ? "Les élèves ne reçoivent plus cette explication. Préparez-en une autre."
              : "Les élèves ne reçoivent plus cet exercice. Cherchez ses passages dans la version actuelle des sources, modifiez les questions qui ne tiennent plus ou retirez le cours fautif."
          }</p>${
            explication
              ? ""
              : html`<form method="post" action="/prof/activites/${a.id}/reancrer">
                <input type="hidden" name="revision" value="${a.revision}">
                <button>Chercher les passages dans la version actuelle</button>
              </form>`
          }</div>`
        : ""
    }
    <div class="barre">
      ${
        a.etat === "brouillon"
          ? html`<form method="post" action="/prof/activites/${a.id}/relire">
            <input type="hidden" name="revision" value="${a.revision}">
            <button class="principal">Marquer la version ${a.revision} relue</button>
          </form>`
          : ""
      }
      ${
        a.etat === "relue"
          ? html`<form method="post" action="/prof/activites/${a.id}/publier">
            <input type="hidden" name="revision" value="${a.revision}">
            <button class="principal">${personnel ? "Publier pour m'entraîner" : "Publier aux élèves du cours"}</button>
          </form>`
          : ""
      }
      <a class="bouton" href="/prof/activites/${a.id}/apercu">Aperçu élève</a>
      ${explication ? "" : html`<a class="bouton" href="/prof/activites/${a.id}/reponses">Réponses</a>`}
      <form method="post" action="/prof/activites/${a.id}/archiver">
        <input type="hidden" name="oui" value="${a.archivee_le ? "0" : "1"}">
        ${
          a.archivee_le
            ? html`<button>Désarchiver</button>`
            : html`<button data-confirmer="Archiver cette activité ? Les élèves ne la reçoivent plus. Leurs tentatives restent lisibles.">Archiver</button>`
        }
      </form>
      ${
        d.supprimable
          ? html`<form method="post" action="/prof/activites/${a.id}/supprimer">
            <button class="danger" data-confirmer="Supprimer ce brouillon ? Il n'a jamais été publié. Rien ne le rétablit.">Supprimer le brouillon</button>
          </form>`
          : ""
      }
    </div>
    ${reglages(d)}
    ${explication ? corpsExplication(contenu, d.servies) : questions(d, contenu)}
    ${
      d.suivi && !explication
        ? html`<h2>Réponses</h2>
          <p>${pluriel(d.suivi.remis, "élève")} sur ${d.suivi.eleves} ${
            d.suivi.remis > 1 ? "ont" : "a"
          } remis une tentative, toutes versions confondues. <a href="/prof/activites/${a.id}/reponses">Lire les réponses</a></p>`
        : ""
    }
    <details>
      <summary>Historique des versions</summary>
      ${
        d.relectures.length
          ? html`<table>
            <thead><tr><th>Action</th><th>Version</th><th>Par</th><th>Date</th></tr></thead>
            <tbody>${d.relectures.map(
              (r) =>
                html`<tr><td>${ACTIONS[r.action] ?? r.action}</td><td>${r.revision}</td><td>${
                  r.nom ?? "Thot"
                }</td><td>${jour(r.le)}</td></tr>`,
            )}</tbody>
          </table>`
          : html`<p class="discret">Pas encore relu.</p>`
      }
    </details>
  `;
};
