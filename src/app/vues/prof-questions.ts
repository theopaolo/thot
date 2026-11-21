import { html } from "hono/html";
import type { Resultat } from "../../core/reponse.ts";
import { icone } from "../icones.ts";
import type { Catalogue, Scope } from "../domaines.ts";
import type { Libelles } from "../instance.ts";
import { jour, nomPerimetre } from "./commun.ts";
import { panneauSource, question, reponse } from "./echange.ts";

export type QuestionProf = {
  id: string;
  question: string;
  etat: string;
  code: string | null;
  avis: string | null;
  cree_le: string;
  nom: string;
  chapitre: string;
};

/** L'avis que l'élève donne sous une réponse publiée, avec « Cette réponse est-elle utile ? ». */
const AVIS: Record<string, string> = { faux: "Fausse", confus: "Peu claire", utile: "Utile" };

/** Le mot d'une réponse en échec, puis sa cause et sa suite pour la page de l'échange. */
const ECHECS: Record<string, [string, string, string]> = {
  CITATION_UNVERIFIED: [
    "Citation non vérifiée",
    "Thot n'a pas pu vérifier les citations de cette réponse.",
    "L'élève n'a pas reçu la réponse. Sa question est conservée.",
  ],
  SOURCE_DELETED: [
    "Source supprimée",
    "Une source citée a été supprimée.",
    "L'élève peut relancer sa question avec les sources disponibles.",
  ],
  EVIDENCE_WITHDRAWN: [
    "Source retirée",
    "Une source de cette réponse a été retirée ou modifiée, ou vous ne la lisez pas.",
    "Thot ne vous montre que les passages que vous pouvez lire.",
  ],
  CANCELLED: ["Arrêtée", "L'élève a arrêté la réponse.", "Sa question est conservée."],
};
const PANNE: [string, string, string] = [
  "Panne",
  "Thot n'a pas pu répondre, à cause d'une panne technique.",
  "Ce n'est pas une limite du cours. L'élève garde sa question et peut la relancer.",
];
const echec = (code: string | null | undefined) => ECHECS[code ?? ""] ?? PANNE;

/** L'état d'une question en mots, le même dans la liste et sur la page de l'échange. */
const etatQuestion = (etat: string, code: string | null | undefined) =>
  etat === "answered"
    ? "Répondue"
    : etat === "out_of_corpus"
      ? "Sans passage dans le cours"
      : etat === "failed"
        ? echec(code)[0]
        : etat === "annule"
          ? "Arrêtée"
          : "En cours";

const tableQuestions = (lignes: QuestionProf[], avecEtat: boolean) =>
  html`
    <table>
      <thead>
        <tr>
          <th>Question</th>
          ${
            avecEtat
              ? html`
              <th>État</th>
              <th>Avis</th>
            `
              : ""
          }
          <th>Élève</th>
          <th>Date</th>
        </tr>
      </thead>
      <tbody>
        ${lignes.map(
          (m) =>
            html`
            <tr>
              <td><a href="/prof/questions/${m.id}">${m.question}</a></td>
              ${
                avecEtat
                  ? html`
                  <td>${etatQuestion(m.etat, m.code)}</td>
                  <td>${
                    AVIS[m.avis ?? ""] ??
                    html`<span aria-hidden="true">–</span><span class="visuellement-cache">Pas d'avis</span>`
                  }</td>
                `
                  : ""
              }
              <td>${m.nom}</td>
              <td>${jour(m.cree_le)}</td>
            </tr>
          `,
        )}
      </tbody>
    </table>
  `;

export const questionsProf = (messages: QuestionProf[]) => {
  const refus = messages.filter((m) => m.etat === "out_of_corpus");
  const groupes = Map.groupBy(
    messages.filter((m) => m.etat !== "out_of_corpus"),
    (m) => m.chapitre || "Autres questions",
  );
  return html`
    <h1>Questions des élèves</h1>
    ${
      messages.length
        ? ""
        : html`<p>Les questions que les élèves de vos cours posent à Thot s'affichent ici, et aucun n'en a encore posé.</p>`
    }
    ${
      refus.length
        ? html`
        <section class="questions-prof">
          <h2>Hors cours</h2>
          <p class="discret">Thot n'a pas trouvé de réponse dans vos cours. Ces questions signalent peut-être un point à couvrir.</p>
          ${tableQuestions(refus, false)}
        </section>
      `
        : ""
    }
    ${[...groupes].map(
      ([chapitre, lignes]) =>
        html`
        <section class="questions-prof">
          <h2>${chapitre}</h2>
          ${tableQuestions(lignes, true)}
        </section>
      `,
    )}
  `;
};

export type EchangeProf = Omit<QuestionProf, "code" | "chapitre"> &
  Scope & { resultat: Resultat | null };

/**
 * Un échange lu par l'enseignant, avec les gabarits du chat : la question, la réponse et ses
 * passages. La conversation reste privée : la page ne la nomme pas et n'y mène pas.
 */
export const echangeProf = (e: EchangeProf, cat: Catalogue, l: Libelles) => {
  const r = e.resultat;
  // La relecture peut retirer une preuve : la réponse publiée est alors en échec.
  const etat = e.etat === "answered" && r ? r.etat : e.etat;
  const code = r?.etat === "failed" ? r.code : null;
  // Le dépôt coche le cours de l'échange, ou celui de son thème.
  const coursId = e.cours_id || cat.themes.find((t) => t.id === e.theme_id)?.cours_id || "";
  const [, cause, suite] = echec(code);
  const enCours = etat === "en_attente" || etat === "en_cours";
  return html`
    <p><a href="/prof/questions">Questions des élèves</a></p>
    <div class="mur-lecteur" data-feuille>
      <div class="echange-prof">
        <h1>Question de ${e.nom}</h1>
        <dl class="cartel">
          <dt>État</dt>
          <dd><span class="statut ${etat === "failed" ? "failed" : enCours ? "en-cours" : ""}">${etatQuestion(
            etat,
            code,
          )}</span></dd>
          <dt>Dans</dt>
          <dd>${nomPerimetre(cat, e, l) || "toutes ses ressources"}</dd>
          <dt>Posée le</dt>
          <dd>${jour(e.cree_le)}</dd>
          ${
            etat === "answered"
              ? html`<dt>Avis de l'élève</dt><dd>${AVIS[e.avis ?? ""] ?? "Pas d'avis"}</dd>`
              : ""
          }
        </dl>
        ${question(e.question)}
        ${
          r?.etat === "answered"
            ? reponse(e.id, r, null, [], false, `/prof/questions/${e.id}/citations`)
            : etat === "out_of_corpus"
              ? html`<article class="reponse hors-corpus" id="reponse-${e.id}">
                <p><strong>Aucun passage certifié ne répond à cette question.</strong></p>
                <p>Thot n'a rien trouvé d'assez proche dans les ressources que l'élève peut lire, et
                  lui a répondu que le cours ne la couvre pas. Si ce point fait partie du cours,
                  déposez le document qui le traite.</p>
                <a class="bouton principal" href="/prof/depot${coursId ? `?cours=${coursId}` : ""}"
                  >${icone("upload-simple")}Déposer un document</a>
              </article>`
              : enCours
                ? html`<p class="discret">Thot prépare encore la réponse. Rechargez la page pour la lire.</p>`
                : html`<article class="reponse panne" id="reponse-${e.id}">
                  <p><strong>${cause}</strong></p>
                  <p>${suite}</p>
                </article>`
        }
      </div>
      ${
        r?.etat === "answered"
          ? html`<div class="colonne-source">${panneauSource(undefined, undefined, "Dans le cours")}</div>`
          : ""
      }
    </div>
  `;
};
