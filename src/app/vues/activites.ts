import { html } from "hono/html";
import { type Champ, type Citation, champs, type Contenu } from "../../core/activite.ts";
import { type Activite, MAX_SOURCES, nomChamp, type Tentative } from "../activites.ts";
import type { Catalogue } from "../domaines.ts";
import { icone } from "../icones.ts";
import { jour, ongletsBibliotheque } from "./prof.ts";

const ETATS: Record<Activite["etat"], [string, string]> = {
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
const etat = (a: Activite) =>
  html`<span class="statut ${ETATS[a.etat][1]}">${ETATS[a.etat][0]}</span>`;

/** Le lecteur de source existant, ouvert sur le passage, dans la révision citée. */
const lien = (c: Citation) =>
  `/eleve/sources/${c.source_id}?debut=${c.debut}&fin=${c.fin}&revision=${c.revision}#passage`;

/** Les passages d'un champ. Avec `servies`, une citation qui ne tient plus le dit. */
const passages = (ch: Champ, servies?: Map<string, number | undefined>) =>
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

export const listeProf = (liste: Activite[]) => html`
  <h1>Bibliothèque</h1>
  ${ongletsBibliotheque("/prof/activites")}
  <p><a class="bouton principal" href="/prof/activites/nouvelle">Préparer un exercice</a></p>
  ${
    liste.length
      ? html`<table>
        <thead><tr><th>Objectif</th><th>Cours</th><th>État</th><th>Version</th></tr></thead>
        <tbody>${liste.map(
          (a) => html`<tr>
            <td><a href="/prof/activites/${a.id}">${a.intitule}</a></td>
            <td>${a.cours}</td><td>${etat(a)}</td><td>${a.revision}</td>
          </tr>`,
        )}</tbody>
      </table>`
      : html`<p>Aucun exercice. Un exercice part d'un objectif et de sources certifiées d'un cours.</p>`
  }
`;

export type Preparation = {
  catalogue: Catalogue;
  coursId: string;
  objectifs: { id: string; intitule: string; reference: string }[];
  sources: { id: string; titre: string }[];
  personnel: boolean;
  saisie: Record<string, unknown>;
  erreur?: string;
  rejets?: string[];
};

/** Choisir le cours, l'objectif et les sources, puis faire rédiger le brouillon. */
export const preparation = (p: Preparation) => {
  const s = (nom: string) => String(p.saisie[nom] ?? "");
  const choisies = new Set([p.saisie.sources ?? []].flat().map(String));
  const nomCours = (c: Catalogue["cours"][number]) =>
    `${p.catalogue.matieres.find((m) => m.id === c.matiere_id)?.nom ?? ""} / ${c.nom}`;
  return html`
    <p><a href="/prof/activites">Exercices</a></p>
    <h1>Préparer un exercice</h1>
    ${p.erreur ? html`<p role="alert">${p.erreur}</p>` : ""}
    ${
      p.rejets?.length
        ? html`<div class="alerte"><strong>Champs rejetés : ${p.rejets.length}</strong><ul>${p.rejets.map(
            (r) => html`<li>${r}</li>`,
          )}</ul></div>`
        : ""
    }
    ${
      !p.catalogue.cours.length
        ? html`<p>Aucun cours. Un objectif appartient à un cours : ${
            p.personnel
              ? html`créez-en un dans <a href="/administration/domaines">Matières et cours</a>.`
              : "un administrateur vous inscrit à un cours."
          }</p>`
        : html`
      <form method="get" action="/prof/activites/nouvelle" class="barre">
        <label for="cours_id">Cours</label>
        <select id="cours_id" name="cours_id">${p.catalogue.cours.map(
          (c) =>
            html`<option value="${c.id}" ${c.id === p.coursId ? "selected" : ""}>${nomCours(c)}</option>`,
        )}</select>
        <button>Changer de cours</button>
      </form>
      <form method="post" action="/prof/activites" class="etroit">
        <input type="hidden" name="cours_id" value="${p.coursId}">
        <fieldset>
          <legend><strong>Objectif</strong></legend>
          ${
            p.objectifs.length
              ? html`<div class="champ">
                <label for="objectif_id">Objectif du cours</label>
                <select id="objectif_id" name="objectif_id">
                  <option value="">Nouvel objectif</option>
                  ${p.objectifs.map(
                    (o) =>
                      html`<option value="${o.id}" ${o.id === s("objectif_id") ? "selected" : ""}>${o.intitule}${
                        o.reference ? ` (${o.reference})` : ""
                      }</option>`,
                  )}
                </select>
              </div>`
              : ""
          }
          <div class="champ">
            <label for="intitule">Nouvel objectif</label>
            <p class="aide">Ce que la personne doit savoir ou savoir faire. Ignoré si un objectif du cours est choisi.</p>
            <input type="text" id="intitule" name="intitule" maxlength="300" value="${s("intitule")}">
          </div>
          ${
            p.personnel
              ? ""
              : html`<div class="champ">
                <label for="reference">Référence (facultatif)</label>
                <p class="aide">Référentiel ou programme, compétence et version, par exemple « BTS MCO, référentiel 2024, C2 ». Thot ne déduit pas qu'un document couvre l'objectif.</p>
                <input type="text" id="reference" name="reference" maxlength="300" value="${s("reference")}">
              </div>`
          }
        </fieldset>
        <fieldset>
          <legend><strong>Sources, de 1 à ${MAX_SOURCES}</strong></legend>
          ${
            p.sources.length
              ? p.sources.map(
                  (x) =>
                    html`<label><input type="checkbox" name="sources" value="${x.id}" ${
                      choisies.has(x.id) ? "checked" : ""
                    }> ${x.titre}</label>`,
                )
              : html`<p class="discret">Aucune source certifiée de ce cours ne sert à Thot pour répondre${
                  p.personnel ? "" : " et n'est publiée aux élèves"
                }.</p>`
          }
        </fieldset>
        <p class="aide">Thot rédige une consigne, une réponse attendue, 2 à 5 critères et un retour. Chaque champ cite des passages retrouvés mot pour mot. Un champ sans passage retrouvé est rejeté.</p>
        <button class="principal" ${p.sources.length ? "" : "disabled"}>Rédiger le brouillon</button>
      </form>
    `
    }
  `;
};

export type DetailProf = {
  a: Activite;
  contenu: Contenu;
  relectures: { revision: number; action: string; le: string; nom: string | null }[];
  servies: Map<string, number | undefined>;
  erreur?: string;
};

/** Inspecter les preuves, modifier, relire, publier, avec l'historique de relecture. */
export const detailProf = ({ a, contenu, relectures, servies, erreur }: DetailProf) => {
  const liste = champs(contenu);
  const rejets = JSON.parse(a.rejets) as string[];
  const sources = [
    ...new Map(
      liste.flatMap((ch) => ch.citations).map((c) => [`${c.source_id}/${c.revision}`, c]),
    ).values(),
  ];
  const personnel = a.audience === "prive";
  const champ = (ch: Champ) =>
    html`<p>${ch.texte || html`<span class="discret">Vide : sa source a été supprimée.</span>`}</p>${passages(ch, servies)}`;
  return html`
    <p><a href="/prof/activites">Exercices</a></p>
    <h1>${a.intitule}</h1>
    <p class="discret">${a.cours}${a.reference ? ` · ${a.reference}` : ""} · version ${a.revision} · ${etat(a)}</p>
    ${erreur ? html`<p role="alert">${erreur}</p>` : ""}
    ${
      personnel
        ? html`<p class="note">Exercice privé, généré par Thot. Votre relecture ne vaut pas relecture indépendante.</p>`
        : ""
    }
    ${
      a.etat === "a_revoir"
        ? html`<p role="alert">Une source citée a une nouvelle version, n'est plus citable dans ce cours ou a été supprimée. Les élèves ne reçoivent plus cet exercice. Enregistrez-le de nouveau pour rechercher ses passages dans la version actuelle, ou préparez-en un autre.</p>`
        : ""
    }
    ${
      rejets.length
        ? html`<p class="discret">${rejets.length} champ${rejets.length > 1 ? "s" : ""} rejeté${
            rejets.length > 1 ? "s" : ""
          } à la génération : ${rejets.join(" ")}</p>`
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
    </div>
    <h2>Consigne</h2>
    ${champ(contenu.consigne)}
    <h2>Réponse attendue</h2>
    ${champ(contenu.attendu)}
    <h2>Critères</h2>
    <ol>${contenu.criteres.map((ch) => html`<li>${champ(ch)}</li>`)}</ol>
    <h2>Retour</h2>
    ${champ(contenu.retour)}
    <h2>Sources citées</h2>
    <ul>${sources.map((c) => html`<li>${c.titre}, version ${c.revision}</li>`)}</ul>
    <h2>Relectures</h2>
    ${
      relectures.length
        ? html`<table>
          <thead><tr><th>Action</th><th>Version</th><th>Par</th><th>Date</th></tr></thead>
          <tbody>${relectures.map(
            (r) =>
              html`<tr><td>${ACTIONS[r.action] ?? r.action}</td><td>${r.revision}</td><td>${
                r.nom ?? "Thot"
              }</td><td>${jour(r.le)}</td></tr>`,
          )}</tbody>
        </table>`
        : html`<p class="discret">Pas encore relu.</p>`
    }
    <details ${erreur ? "open" : ""}>
      <summary>Modifier</summary>
      <form method="post" action="/prof/activites/${a.id}/modifier" class="etroit">
        <input type="hidden" name="revision" value="${a.revision}">
        <p class="aide">Enregistrer une modification crée la version ${a.revision + 1}, à relire avant publication. Chaque passage est recherché mot pour mot dans la version actuelle de sa source. Un critère ou un passage vidé disparaît.</p>
        ${liste.map(
          (ch, i) => html`
            <div class="champ">
              <label for="texte-${i}">${nomChamp(i, liste.length)}</label>
              <textarea id="texte-${i}" name="texte_${i}" rows="3">${ch.texte}</textarea>
            </div>
            ${ch.citations.map(
              (c, j) => html`<div class="champ">
                <label for="citation-${i}-${j}">Passage cité de « ${c.titre} »</label>
                <textarea id="citation-${i}-${j}" name="citation_${i}_${j}" rows="2">${c.citation}</textarea>
              </div>`,
            )}
          `,
        )}
        <button class="principal">Enregistrer une nouvelle version</button>
      </form>
    </details>
  `;
};

export type Pratique = {
  a: Activite;
  contenu: Contenu;
  tentative?: Tentative;
  relecteur?: string;
  /** l'aperçu de l'enseignant : la page de l'élève avant sa réponse, formulaire inactif */
  apercu?: boolean;
};

/**
 * La page de l'élève. Avant une tentative sur la version actuelle, elle ne contient que l'objectif
 * et la consigne : ni réponse attendue, ni critère, ni retour, ni passage cité.
 */
export const pratique = ({ a, contenu, tentative, relecteur, apercu }: Pratique) => {
  const coches = tentative ? (JSON.parse(tentative.criteres) as number[]) : [];
  return html`
    ${
      apercu
        ? html`<p><a href="/prof/activites/${a.id}">Retour à l'exercice</a></p>
          <p class="note">Aperçu de la page élève. La réponse attendue, les critères et le retour n'apparaissent qu'après la réponse de l'élève.</p>`
        : html`<a class="bouton retour" href="/eleve">${icone("arrow-left")}Ressources</a>`
    }
    <h1>${a.intitule}</h1>
    <p class="discret">${a.cours}. ${
      a.audience === "prive"
        ? "Exercice généré par Thot à partir de tes documents. Personne d'autre que toi ne l'a relu."
        : `Exercice préparé par ${a.auteur}${relecteur ? `, relu par ${relecteur}` : ""}.`
    }</p>
    <h2>Consigne</h2>
    <p>${contenu.consigne.texte}</p>
    ${
      !tentative
        ? html`<form method="post" action="/eleve/activites/${a.id}/tentatives" class="etroit">
          <div class="champ">
            <label for="reponse">Ta réponse</label>
            <p class="aide">Après l'envoi, la réponse attendue et les critères s'affichent pour que tu te corriges.</p>
            <textarea id="reponse" name="reponse" required maxlength="4000" rows="5" ${apercu ? "disabled" : ""}></textarea>
          </div>
          <button class="principal" ${apercu ? "disabled" : ""}>Envoyer ma réponse</button>
        </form>`
        : html`<section id="corrige" aria-labelledby="ta-reponse">
          ${passages(contenu.consigne)}
          <div class="deux">
            <div>
              <h2 id="ta-reponse">Ta réponse</h2>
              <blockquote class="passage">${tentative.reponse}</blockquote>
            </div>
            <div>
              <h2>Réponse attendue</h2>
              <p>${contenu.attendu.texte}</p>
              ${passages(contenu.attendu)}
            </div>
          </div>
          <h2>Critères</h2>
          <form method="post" action="/eleve/activites/${a.id}/tentatives/${tentative.id}/criteres">
            <fieldset>
              <legend>Coche les critères que ta réponse remplit.</legend>
              ${contenu.criteres.map(
                (ch, i) =>
                  html`<label><input type="checkbox" name="criteres" value="${i}" ${
                    coches.includes(i) ? "checked" : ""
                  }> ${ch.texte}</label>${passages(ch)}`,
              )}
            </fieldset>
            ${
              coches.length
                ? html`<p class="discret">Tu as coché ${coches.length} critère${
                    coches.length > 1 ? "s" : ""
                  } sur ${contenu.criteres.length}.</p>`
                : ""
            }
            <button>Enregistrer mon auto-évaluation</button>
          </form>
          <h2>Retour</h2>
          <p>${contenu.retour.texte}</p>
          ${passages(contenu.retour)}
        </section>`
    }
  `;
};

/** Les exercices publiés de l'élève, dans la page de ses ressources. */
export const exercices = (liste: Activite[]) =>
  liste.length
    ? html`<section aria-labelledby="exercices">
      <h2 id="exercices">Exercices</h2>
      <ul>${liste.map(
        (a) =>
          html`<li><a href="/eleve/activites/${a.id}">${a.intitule}</a> <span class="discret">${a.cours}</span></li>`,
      )}</ul>
    </section>`
    : "";
