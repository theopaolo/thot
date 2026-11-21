import { html } from "hono/html";
import type { Champ, Citation } from "../../core/activite.ts";
import { SEUIL_SOUTIEN } from "../../core/reponse.ts";
import type { Activite, ActiviteListee, FiltreActivites, suiviObjectifs } from "../activites.ts";
import type { Catalogue } from "../domaines.ts";
import { type Libelles, minuscule } from "../instance.ts";
import { filtre as filtreCours } from "./domaines.ts";
import { jour } from "./commun.ts";
import { ongletsBibliotheque } from "./prof-bibliotheque.ts";

export const ETATS: Record<Activite["etat"], [string, string]> = {
  brouillon: ["Brouillon", "a_relire"],
  relue: ["Relu", "en-cours"],
  publiee: ["Publié", "certifiee"],
  a_revoir: ["À revoir", "failed"],
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

export const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? "s" : ""}`;

/** « Exercice, 3 questions » ou « Explication ». */
export const typeDe = (type: Activite["type"], questions: number | null) =>
  type === "exercice" && questions !== null
    ? `Exercice, ${pluriel(questions, "question")}`
    : TYPES[type];

export const option = (valeur: string, libelle: string, choisie: string) =>
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
    <p class="aide">Chaque activité part d'un objectif de cours. <a href="/prof/objectifs">Renommer ou fusionner les objectifs</a></p>
  </div>
  <div class="barre">
    <nav class="segments" aria-label="État">${FILTRES_ETAT.map(([v, t]) => {
      const p = { cours_id: filtre.coursId, matiere_id: filtre.matiereId, etat: v };
      const q = new URLSearchParams(Object.entries(p).filter(([, x]) => x) as [string, string][]);
      return html`<a href="/prof/activites${q.size ? `?${q}` : ""}"
        aria-current="${String(v === (filtre.etat ?? ""))}">${t}</a>`;
    })}</nav>
  </div>
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
