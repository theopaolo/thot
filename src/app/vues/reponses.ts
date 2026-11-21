import { html } from "hono/html";
import type { Contenu, Question } from "../../core/activite.ts";
import { approchee, points } from "../../core/questions.ts";
import { type Activite, NOTES, type TentativeLue } from "../activites.ts";
import { jour } from "./commun.ts";
import { enrichi, enrichiLigne, lettre, NOMS_TYPE } from "./questions.ts";

const NOMBRE = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
/** 0,5 s'écrit « 0,5 » en français. */
export const nombre = (n: number) => NOMBRE.format(n);

/** Ce qu'un élève a répondu à une question qu'il a finie. */
export type Case = {
  /** `null` : une réponse rédigée en attente de note */
  points: number | null;
  essais: string[];
  criteres: number[];
  note?: number;
  commentaire?: string;
};
export type Ligne = {
  eleve: { id: string; nom: string };
  /** la dernière tentative de l'élève, de n'importe quelle version */
  t?: TentativeLue;
  /** une case par question de la version actuelle, vide si elle n'est pas finie */
  cases: (Case | undefined)[];
  /** les points des questions qui en ont */
  total: number;
};

/** Une ligne par élève suivi, d'après sa dernière tentative. Les réponses se rattachent par identifiant de question. */
export function lignes(
  contenu: Contenu,
  eleves: { id: string; nom: string }[],
  tentatives: TentativeLue[],
): Ligne[] {
  return eleves.map((eleve) => {
    const t = tentatives.find((x) => x.compte_id === eleve.id);
    const cases = contenu.questions.map((q): Case | undefined => {
      const r = t?.reponses[q.id];
      if (!t || !r?.finie) return undefined;
      const retour = t.retours[q.id];
      return {
        points: points(q, r.essais, contenu.correction, retour?.note ?? null),
        essais: r.essais,
        criteres: r.criteres ?? [],
        note: retour?.note,
        commentaire: retour?.commentaire,
      };
    });
    return { eleve, t, cases, total: cases.reduce((s, c) => s + (c?.points ?? 0), 0) };
  });
}

/** La moyenne des points de ceux qui ont fini la question, de 0 à 1. */
export function taux(liste: Ligne[], i: number) {
  const p = liste.flatMap((l) => l.cases[i]?.points ?? []);
  return p.length ? p.reduce((a, b) => a + b, 0) / p.length : null;
}
const pourcent = (x: number | null) => (x === null ? "" : `${Math.round(100 * x)} %`);

const etatTexte = (l: Ligne) =>
  !l.t ? "Rien remis" : l.t.rendue_le ? `Remise le ${jour(l.t.rendue_le)}` : "En cours";

/** Le texte d'une valeur enregistrée : l'option pour un choix, la saisie pour le reste. */
function affiche(q: Question, v: string) {
  if (q.type !== "choix" && q.type !== "choix_multiple") return v;
  return v
    .split(",")
    .map((id) => {
      const i = q.options.findIndex((o) => o.id === id);
      return i < 0 ? id : `${lettre(i)}. ${q.options[i].texte.texte}`;
    })
    .join(", ");
}

const ancre = (t: { id: string }, q: Question) => `r-${t.id}-${q.id}`;

/** Une réponse à taper que Thot a acceptée alors qu'elle diffère de chaque réponse attendue. */
const differente = (q: Question, c: Case) =>
  q.type === "terme" && c.essais.some((v) => approchee(v, q.accepte));

/**
 * Une réponse rédigée se note. Une réponse fermée aussi quand Thot l'a refusée, que l'enseignant
 * l'a notée, ou que Thot l'a acceptée avec une différence.
 */
const anoter = (q: Question, c: Case | undefined): c is Case =>
  !!c &&
  (q.type === "redigee"
    ? !!c.essais[0]
    : c.essais.length > 0 && (c.note !== undefined || (c.points ?? 1) < 1 || differente(q, c)));

const classe = (p: number) => (p >= 1 ? "s-ok" : p > 0 ? "s-half" : "s-ko");

const caseGrille = (a: Activite, l: Ligne, q: Question, c: Case | undefined) => {
  if (!c) return html`<td class="case"></td>`;
  const lien = anoter(q, c) ? `#${ancre(l.t!, q)}` : "";
  const p =
    c.points === null
      ? html`<a href="${lien}" title="À noter">?</a>`
      : lien
        ? html`<a href="${lien}">${nombre(c.points)}</a>`
        : nombre(c.points);
  return html`<td class="case ${c.points === null ? "s-attente" : classe(c.points)}">${p}</td>`;
};

const boutonsNote = (c: Case | undefined) =>
  NOTES.map(
    (n) =>
      html`<button name="note" value="${c?.note === n ? "" : String(n)}" aria-pressed="${String(c?.note === n)}">${nombre(n)}</button>`,
  );

/** La note (0, 0,5, 1) et le commentaire de l'enseignant sur une réponse. */
const formNote = (a: Activite, l: Ligne, q: Question, c: Case) => html`
  <form class="note-reponse" method="post" action="/prof/activites/${a.id}/reponses/${l.t!.id}/${encodeURIComponent(q.id)}">
    <div class="barre">
      <span class="aide">Note</span>
      ${boutonsNote(c)}
      <span class="aide">${
        c.note !== undefined
          ? "Recliquez sur la note pour l'enlever."
          : c.points !== null
            ? `Note automatique : ${nombre(c.points)}`
            : ""
      }</span>
    </div>
    <label class="aide" for="c-${ancre(l.t!, q)}">Commentaire pour l'élève</label>
    <textarea id="c-${ancre(l.t!, q)}" name="commentaire" rows="2" maxlength="2000">${c.commentaire ?? ""}</textarea>
    <button name="note" value="${c.note ?? ""}">Enregistrer le commentaire</button>
  </form>`;

const reponseRedigee = (q: Question & { type: "redigee" }, texte: string) =>
  q.langage
    ? html`<pre data-langage="${q.langage}"><code>${texte}</code></pre>`
    : html`<p class="reponse-texte">${texte}</p>`;

const sectionRedigees = (a: Activite, contenu: Contenu, liste: Ligne[]) => {
  const blocs = contenu.questions.flatMap((q, i) => {
    if (q.type !== "redigee") return [];
    const items = liste.flatMap((l) => (anoter(q, l.cases[i]) ? [{ l, c: l.cases[i]! }] : []));
    if (!items.length) return [];
    const aNoter = items.filter(({ c }) => c.points === null).length;
    return [
      html`<article class="reponses-bloc">
        <h3>Question ${i + 1}</h3>
        ${enrichi(q.consigne.texte)}
        <p><strong>Réponse attendue.</strong></p>
        ${enrichi(q.attendu.texte)}
        ${
          q.criteres.length
            ? html`<p class="aide">Critères</p><ol>${q.criteres.map((x) => html`<li>${enrichiLigne(x.texte)}</li>`)}</ol>`
            : ""
        }
        <p class="aide">${aNoter ? `${aNoter} à noter.` : "Tout est noté."}</p>
        <ul class="reponses-liste">${items.map(({ l, c }) => {
          const memeVersion = l.t!.revision === a.revision;
          return html`<li id="${ancre(l.t!, q)}" class="${c.points === null ? "a-noter" : ""}">
            <p><strong>${l.eleve.nom}</strong>${
              memeVersion ? "" : html` <span class="discret">version ${l.t!.revision}</span>`
            }${c.points === null ? html` <span class="statut a_relire">À noter</span>` : ""}</p>
            ${reponseRedigee(q, c.essais[0])}
            <p class="aide">${
              c.criteres.length
                ? html`Critères cochés par l'élève : ${c.criteres
                    .map((j) =>
                      memeVersion && q.criteres[j] ? q.criteres[j].texte : `n° ${j + 1}`,
                    )
                    .join(" ; ")}`
                : "L'élève n'a coché aucun critère."
            }</p>
            ${formNote(a, l, q, c)}
          </li>`;
        })}</ul>
      </article>`,
    ];
  });
  return blocs.length
    ? html`<h2 id="a-noter">Réponses rédigées</h2>
        <p class="discret">Thot ne note pas ces réponses. La note de l'enseignant remplace la note automatique.</p>${blocs}`
    : "";
};

const sectionFermees = (a: Activite, contenu: Contenu, liste: Ligne[]) => {
  const blocs = contenu.questions.flatMap((q, i) => {
    if (q.type === "redigee") return [];
    const items = liste.flatMap((l) => (anoter(q, l.cases[i]) ? [{ l, c: l.cases[i]! }] : []));
    if (!items.length) return [];
    const attendu =
      q.type === "terme"
        ? q.accepte.join(", ")
        : q.options.flatMap((o, j) => (o.juste ? `${lettre(j)}. ${o.texte.texte}` : [])).join(", ");
    return [
      html`<article class="reponses-bloc">
        <h3>Question ${i + 1}</h3>
        ${enrichi(q.consigne.texte)}
        <p class="aide">${q.type === "terme" ? "Réponses acceptées" : "Bonnes réponses"} : ${attendu}</p>
        <ul class="reponses-liste">${items.map(
          ({ l, c }) => html`<li id="${ancre(l.t!, q)}">
            <p><strong>${l.eleve.nom}</strong>${
              l.t!.revision === a.revision
                ? ""
                : html` <span class="discret">version ${l.t!.revision}</span>`
            }${
              differente(q, c)
                ? html` <span class="statut a_relire">Acceptée avec une différence</span>`
                : ""
            }</p>
            <p class="reponse-texte">${c.essais.map((v) => affiche(q, v)).join(" puis ")}</p>
            ${formNote(a, l, q, c)}
          </li>`,
        )}</ul>
      </article>`,
    ];
  });
  return blocs.length
    ? html`<h2>Réponses fermées à vérifier</h2>
        <p class="discret">Une réponse juste que Thot a refusée, une faute de frappe trop grande par exemple, peut recevoir des points. Une réponse à taper que Thot a acceptée avec un accent, un mot ou une lettre de différence peut les perdre : notez-la 0.</p>${blocs}`
    : "";
};

/** Le premier choix de chaque élève qui a fini une question à choix, vide pour un autre type. */
const premiersChoix = (q: Question, liste: Ligne[], i: number) =>
  q.type === "choix" || q.type === "choix_multiple"
    ? liste.flatMap((l) => l.cases[i]?.essais[0] ?? [])
    : [];

const sectionQuestions = (contenu: Contenu, liste: Ligne[]) => html`
  <h2>Question par question</h2>
  <ol class="reponses-questions">${contenu.questions.map((q, i) => {
    const premiers = premiersChoix(q, liste, i);
    const t = taux(liste, i);
    const compter = (id: string) => premiers.filter((v) => v.split(",").includes(id)).length;
    return html`<li id="q-${i + 1}">
      <p><strong>Question ${i + 1}</strong> <span class="discret">${NOMS_TYPE[q.type]}. ${
        t === null ? "Pas encore de réponse." : `${pourcent(t)} de réussite.`
      }</span></p>
      ${enrichi(q.consigne.texte)}
      ${
        (q.type === "choix" || q.type === "choix_multiple") && premiers.length
          ? html`<ul class="distribution" aria-label="Premier choix des élèves">${q.options.map(
              (o, j) => html`<li class="${o.juste ? "juste" : ""}">
                <span>${lettre(j)}. ${enrichiLigne(o.texte.texte)}${
                  o.juste ? html` <span class="visuellement-cache">(bonne réponse)</span>` : ""
                }</span>
                <span class="distribution-barre"><span style="width: ${Math.round((100 * compter(o.id)) / premiers.length)}%"></span></span>
                <span class="distribution-n">${compter(o.id)}</span>
              </li>`,
            )}</ul>`
          : ""
      }
    </li>`;
  })}</ol>
  ${
    // La légende suit les barres : sans question à choix déjà répondue, il n'y en a pas.
    contenu.questions.some((q, i) => premiersChoix(q, liste, i).length)
      ? html`<p class="aide">Les barres comptent le premier choix de chaque élève. La bonne réponse est en vert.</p>`
      : ""
  }`;

export function pageReponses(a: Activite, contenu: Contenu, liste: Ligne[]) {
  const remises = liste.filter((l) => l.t?.rendue_le).length;
  const aNoter = liste.reduce((n, l) => n + l.cases.filter((c) => c?.points === null).length, 0);
  return html`
    <div class="reponses">
      <p><a href="/prof/activites/${a.id}">${a.titre}</a></p>
      <h1>Réponses</h1>
      <p class="discret">${liste.length} élève${liste.length > 1 ? "s" : ""} suivi${liste.length > 1 ? "s" : ""}. ${remises} remise${remises > 1 ? "s" : ""}. ${
        aNoter
          ? html`<a href="#a-noter">${aNoter} réponse${aNoter > 1 ? "s" : ""} rédigée${aNoter > 1 ? "s" : ""} à noter</a>.`
          : "Aucune réponse rédigée à noter."
      }</p>
      <p class="discret">Les points mesurent ce qui a été pratiqué, pas un niveau.</p>
      <div class="barre">${
        liste.some((l) => l.t)
          ? html`<a class="bouton" href="/prof/activites/${a.id}/reponses.csv">Exporter en CSV</a>`
          : html`<button type="button" disabled aria-describedby="sans-export">Exporter en CSV</button>
            <span class="aide" id="sans-export">Aucun élève n'a encore répondu.</span>`
      }</div>
      ${
        liste.length
          ? html`<div class="defilable"><table class="grille">
              <thead><tr>
                <th>Élève</th><th>État</th><th>Points</th>
                ${contenu.questions.map(
                  (q, i) =>
                    html`<th class="case"><a href="#q-${i + 1}" title="${q.consigne.texte.split("\n")[0]}">${i + 1}</a></th>`,
                )}
              </tr></thead>
              <tbody>${liste.map(
                (l) => html`<tr>
                  <th scope="row">${l.eleve.nom}</th>
                  <td>${etatTexte(l)}${
                    l.t && l.t.revision < a.revision
                      ? html` <span class="discret">version ${l.t.revision}</span>`
                      : ""
                  }${l.t?.a_reprendre ? html` <span class="statut en-cours">À reprendre</span>` : ""}
                    ${
                      l.t?.rendue_le
                        ? html`<form method="post" action="/prof/activites/${a.id}/reponses/${l.t.id}/reprendre">
                            <button class="lien" name="oui" value="${l.t.a_reprendre ? "" : "1"}" aria-pressed="${String(l.t.a_reprendre)}">${
                              l.t.a_reprendre ? "Annuler la reprise" : "Faire reprendre"
                            }</button>
                          </form>`
                        : ""
                    }</td>
                  <td>${l.t ? `${nombre(l.total)} / ${contenu.questions.length}` : ""}</td>
                  ${contenu.questions.map((q, i) => caseGrille(a, l, q, l.cases[i]))}
                </tr>`,
              )}</tbody>
              <tfoot><tr>
                <th scope="row">Réussite</th><td></td><td></td>
                ${contenu.questions.map((_, i) => html`<td class="case">${pourcent(taux(liste, i))}</td>`)}
              </tr></tfoot>
            </table></div>
            <ul class="legende">
              <li><span class="case s-ok">1</span> juste au premier essai</li>
              <li><span class="case s-half">0,5</span> juste au deuxième essai</li>
              <li><span class="case s-ko">0</span> faux</li>
              <li><span class="case s-attente">?</span> réponse rédigée à noter</li>
              <li><span class="case"></span> pas finie</li>
            </ul>`
          : html`<p>Aucun élève suivi pour cette activité.</p>`
      }
      ${sectionRedigees(a, contenu, liste)}
      ${sectionFermees(a, contenu, liste)}
      ${sectionQuestions(contenu, liste)}
    </div>`;
}

// CSV : points en virgule décimale et séparateur point-virgule, pour les tableurs français.

/** Un champ entre guillemets. Un début en = + - @ fait lire une formule au tableur : une apostrophe le désarme. */
const champCsv = (v: string | number) => {
  const s = String(v);
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

export function csv(a: Activite, contenu: Contenu, liste: Ligne[]) {
  const commentees = contenu.questions.flatMap((q, i) =>
    liste.some((l) => l.cases[i]?.commentaire) ? [i] : [],
  );
  const lignesCsv = [
    [
      "Élève",
      "État",
      "Total",
      "Sur",
      ...contenu.questions.map((_, i) => `Q${i + 1}`),
      ...commentees.map((i) => `Commentaire Q${i + 1}`),
    ],
    ...liste.map((l) => [
      l.eleve.nom,
      [
        etatTexte(l),
        l.t && l.t.revision < a.revision ? `version ${l.t.revision}` : "",
        l.t?.a_reprendre ? "à reprendre" : "",
      ]
        .filter(Boolean)
        .join(", "),
      l.t ? nombre(l.total) : "",
      contenu.questions.length,
      ...l.cases.map((c) => (!c ? "" : c.points === null ? "à noter" : nombre(c.points))),
      ...commentees.map((i) => l.cases[i]?.commentaire ?? ""),
    ]),
  ];
  return `﻿${lignesCsv.map((l) => l.map(champCsv).join(";")).join("\r\n")}\r\n`;
}
