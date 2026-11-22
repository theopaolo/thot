import { html } from "hono/html";
import type { Bloc } from "../../core/document.ts";
import type { BlocReponse, Resultat } from "../../core/reponse.ts";
import { type Formes, formes } from "../../core/accords.ts";
import { formules, LIENS, texteMermaid } from "../../core/notation.ts";
import { type Icone, icone } from "../icones.ts";
import { texteDocument } from "./document.ts";
import { fermer, idee } from "./eleve-commun.ts";

/** Le terme de cours du profil, pour un appel qui ne connaît pas l'instance. */
const COURS = formes("Cours", "Cours", "m");

export const question = (texte: string) =>
  html`
    <p class="question">${texte}</p>
  `;

/** Réponse en attente: l'extension SSE la remplace par l'événement « reponse ». */
export const attente = (id: string, etape: string | null = null) =>
  html`
    <article
      class="reponse"
      hx-ext="sse"
      sse-connect="/eleve/messages/${id}/flux"
      sse-swap="reponse"
      hx-swap="outerHTML"
    >
      <p class="etape" sse-swap="etape" hx-swap="innerHTML" role="status">${etape ?? "En attente"}</p>
      <button type="button" class="lien" hx-post="/eleve/messages/${id}/arreter"
        hx-target="closest .reponse" hx-swap="outerHTML" data-arreter="${id}">Arrêter</button>
    </article>
  `;

export const avis = (id: string, choix: string | null) =>
  html`
    <div id="avis-${id}" class="avis" aria-label="Avis sur la réponse">
      <span>Cette réponse est-elle utile ?</span>
      ${[
        ["utile", "Utile"],
        ["confus", "Peu claire"],
        ["faux", "Fausse"],
      ].map(
        ([valeur, libelle]) =>
          html`
          <button type="button" aria-pressed="${String(
            choix === valeur,
          )}" name="avis" value="${valeur}"
            hx-post="/eleve/messages/${id}/avis" hx-include="this" hx-target="#avis-${id}"
            hx-swap="outerHTML">${libelle}</button>
        `,
      )}
    </div>
  `;

export const reponse = (
  id: string,
  r: Resultat,
  choix: string | null = null,
  idees: string[] = [],
  auto = false,
  /**
   * hors d'une conversation, une explication publiée ou l'échange relu par l'enseignant :
   * l'adresse de ses passages, sans avis
   */
  citations = "",
  fc: Formes = COURS,
) => {
  if (r.etat === "answered") {
    // Une ligne par intertitre cité: deux sections d'un même document restent distinctes.
    const sources = [...new Map(r.affirmations.map((a) => [a.titre, a.source_id])).entries()];
    const notes = [
      r.partielle ? "Réponse partielle : seuls les passages vérifiés sont affichés" : "",
      r.juge_indisponible
        ? "Vérification partielle : une étape de contrôle n'a pas pu être faite."
        : "",
      r.source_supprimee
        ? "Une source citée a été supprimée : la partie de la réponse qui la citait est retirée."
        : "",
    ].filter(Boolean);
    // En comparaison, la matière de la source suit sa citation : le titre d'une colonne ne la
    // prouve pas. Une formule que la citation écrit aussi garde sa source dans `data-tex`, et
    // reste du texte jusqu'au rendu de KaTeX dans le navigateur.
    const phrase = (n: number) =>
      html`<span>${formules(r.affirmations[n].texte, r.affirmations[n].citation).map((m) =>
        typeof m === "string"
          ? m
          : html`<span class="${m.bloc ? "formule formule-bloc" : "formule"}" data-tex="${m.tex}">${m.source}</span>`,
      )}</span><span class="lien-citation">&nbsp;<button
        class="citation"
        aria-pressed="${String(auto && n === 0)}"
        aria-label="${n + 1}, voir le passage : ${r.affirmations[n].titre}"
        hx-get="${citations || `/eleve/messages/${id}/citations`}/${n}"
        hx-trigger="${auto && n === 0 ? "click, load, restaurer" : "click, restaurer"}"
        hx-target="#source"
        hx-swap="outerHTML"
        hx-sync="#source:replace"
        data-ouvrir-feuille
      >${icone("quotes")}${n + 1}</button></span>${
        r.affirmations[n].matiere
          ? html` <span class="discret">${r.affirmations[n].matiere}</span>`
          : ""
      }`;
    // Sans blocs, comme toute réponse antérieure, les affirmations forment un paragraphe. Un type
    // inconnu se lit aussi en paragraphe.
    const bloc = (b: BlocReponse, k: number) => {
      if (b.type === "tableau") {
        // La légende reste hors du cadre qui défile et nomme le tableau.
        return html`<figure class="tableau-reponse">
          ${b.titre ? html`<figcaption id="legende-${id}-${k}">${b.titre}</figcaption>` : ""}
          <div class="cadre-tableau"><table${b.titre ? html` aria-labelledby="legende-${id}-${k}"` : ""}>
          <thead><tr><td></td>${b.colonnes.map((c) => html`<th scope="col">${c}</th>`)}</tr></thead>
          <tbody>${b.lignes.map(
            (l) =>
              html`<tr><th scope="row">${l.titre}</th>${b.colonnes.map((_, k) => {
                const n = l.affirmations[k];
                return html`<td>${typeof n === "number" ? phrase(n) : ""}</td>`;
              })}</tr>`,
          )}</tbody>
        </table></div></figure>`;
      }
      if (b.type === "schema") {
        // La liste est l'équivalent texte du schéma, toujours affiché. Le navigateur dessine le
        // schéma au-dessus quand Mermaid y parvient.
        const nom = (i: number) => html`<strong>${b.noeuds[i].titre}</strong>`;
        return html`<figure class="schema-reponse">
          ${b.titre ? html`<figcaption>${b.titre}</figcaption>` : ""}
          <ul data-mermaid="${texteMermaid(b)}">${b.noeuds.map((noeud, i) =>
            noeud.affirmation === undefined
              ? ""
              : html`<li>${nom(i)} : ${phrase(noeud.affirmation)}</li>`,
          )}${b.relations.map(
            (l) =>
              html`<li>${nom(l.de)} ${LIENS[l.lien]} ${nom(l.vers)} : ${phrase(l.affirmation)}</li>`,
          )}</ul>
        </figure>`;
      }
      const titre = b.titre ? html`<h2>${b.titre}</h2>` : "";
      const items = b.affirmations.map((n) => html`<li>${phrase(n)}</li>`);
      if (b.type === "liste") return html`${titre}<ul>${items}</ul>`;
      if (b.type === "etapes") return html`${titre}<ol>${items}</ol>`;
      return html`${titre}<p>${b.affirmations.map((n, k) => html`${k ? " " : ""}${phrase(n)}`)}</p>`;
    };
    return html`
      <article class="reponse" id="reponse-${id}">
        ${(notes.length ? notes : [`Réponse vérifiée dans les ${fc.noms} validé${fc.e}s`]).map(
          (note) => html`<p class="reponse-note">${note}</p>`,
        )}
        <div class="texte-reponse">${(
          r.blocs ?? [{ type: "paragraphe", affirmations: r.affirmations.map((_, n) => n) }]
        ).map(bloc)}</div>
        ${(r.sans_passage ?? []).map(
          (m) => html`<p class="reponse-note">Aucun passage trouvé en ${m}.</p>`,
        )}
        ${[
          ...new Map(r.affirmations.filter((a) => a.image_id).map((a) => [a.image_id, a])).values(),
        ].map(
          (a) =>
            html`
              <a
                href="/eleve/sources/${a.source_id}"><img class="image-reponse" src="/media/${
                  a.image_id
                }" alt="${a.titre}" loading="lazy"></a>
            `,
        )}
        <p class="provenance">Sources : ${sources.map(
          ([titre, sourceId], n) =>
            html`${n ? ", " : ""}<a href="/eleve/sources/${sourceId}">${titre}</a>`,
        )}</p>
        ${citations ? "" : avis(id, choix)}
        ${
          idees.length
            ? html`<div class="idees-reponse"><strong>Pour continuer</strong>${idees.map((q) =>
                idee(q, true),
              )}</div>`
            : ""
        }
      </article>
    `;
  }
  if (r.etat === "out_of_corpus") {
    return html`
      <article class="reponse hors-corpus" id="reponse-${id}">
        <p><strong>Je ne trouve pas la réponse dans les documents ${fc.du}.</strong></p>
        <p>
          Aucun passage publié par tes enseignants ne répond à cette question. Reformule-la avec d'autres
          mots, ou pose-la à ton professeur.
        </p>
        ${
          idees.length
            ? html`<div class="idees-reponse"><strong>Ce que ${fc.ton} couvre</strong>${idees.map(
                (q) => idee(q, true),
              )}</div>`
            : ""
        }
      </article>
    `;
  }
  return html`
    <article class="reponse panne" id="reponse-${id}">
      <p><strong>${
        r.code === "EVIDENCE_WITHDRAWN"
          ? "Une source de cette réponse a été retirée ou modifiée."
          : r.code === "SOURCE_DELETED"
            ? "Une source citée a été supprimée."
            : r.code === "CITATION_UNVERIFIED"
              ? "Je n'ai pas pu vérifier les citations de cette réponse."
              : r.code === "CANCELLED"
                ? "Réponse arrêtée."
                : "Thot n'a pas pu répondre, à cause d'une panne technique."
      }</strong></p>
      <p>${
        r.code === "EVIDENCE_WITHDRAWN" || r.code === "SOURCE_DELETED"
          ? "Réessaie pour obtenir une réponse avec les sources disponibles."
          : r.code === "CITATION_UNVERIFIED"
            ? "Ta question est conservée. Réessaie ou demande à ton professeur."
            : r.code === "CANCELLED"
              ? "Ta question est conservée."
              : `Ce n'est pas une limite ${fc.du}. Ta question est conservée.`
      }</p>
      <button
        hx-post="/eleve/messages/${id}/relancer"
        hx-target="#reponse-${id}"
        hx-swap="outerHTML"
      >
        Réessayer
      </button>
    </article>
  `;
};

export const panneauSource = (
  a?: {
    titre: string;
    citation: string;
    source_id: string;
    debut?: number;
    fin?: number;
    revision?: number;
    /** les blocs du document qui portent le passage `debut`..`fin` */
    blocs?: Bloc[];
    enseignant?: string;
  },
  suite?: { id: string; n: number; total: number },
  /** l'enseignant qui relit un échange est vouvoyé. Sans titre : « Dans ton cours ». */
  tete?: string,
  fc: Formes = COURS,
) =>
  a
    ? html`
      <aside id="source" class="feuille" aria-labelledby="source-titre">
        <div class="feuille-tete">
          <h2>${tete ?? `Dans ${fc.ton}`}</h2>
          ${fermer}
        </div>
        <div>
          <h3 id="source-titre" tabindex="-1">${a.titre}</h3>
          ${a.enseignant ? html`<p class="discret">Document de ${a.enseignant}</p>` : ""}
        </div>
        ${
          suite && suite.total > 1
            ? html`
            <div class="source-nav">
              ${[
                [-1, "Précédent", "caret-left"],
                [1, "Suivant", "caret-right"],
              ].map(
                ([pas, libelle, nom]) =>
                  html`
                  <button
                    type="button"
                    ${
                      suite.n + Number(pas) < 0 || suite.n + Number(pas) >= suite.total
                        ? "disabled"
                        : ""
                    }
                    data-reponse="${suite.id}" data-citation="${suite.n + Number(pas)}"
                  >${icone(nom as Icone)}${libelle}</button>
                `,
              )}
              <span class="discret">${suite.n + 1} sur ${suite.total}</span>
            </div>
          `
            : ""
        }
        <div class="defile">
          ${
            a.blocs?.length && a.debut !== undefined && a.fin !== undefined
              ? html`<div class="document">${texteDocument(
                  a.blocs,
                  [a.debut, a.fin],
                  3,
                  a.blocs[0].section,
                  false,
                )}</div>`
              : a.debut !== undefined
                ? html`<blockquote class="passage"><mark>${a.citation}</mark></blockquote>`
                : html`
              <p class="discret">Légende d'image relue par l'enseignant :</p>
              <blockquote class="passage"><mark>${a.citation}</mark></blockquote>
            `
          }
        </div>
        <div class="feuille-pied">
          <a class="bouton" href="/eleve/sources/${a.source_id}${
            a.debut !== undefined
              ? `?debut=${a.debut}&fin=${a.fin}&revision=${a.revision ?? 1}#passage`
              : ""
          }">${icone("file-text")}Ouvrir le document complet</a>
        </div>
      </aside>
    `
    : html`
      <aside id="source" class="feuille" aria-labelledby="source-vide">
        <h2 id="source-vide">${tete ?? `Dans ${fc.ton}`}</h2>
        <p class="discret">
          Les numéros dans une réponse ouvrent ici le passage ${fc.du} sur lequel repose chaque phrase.
        </p>
      </aside>
    `;
