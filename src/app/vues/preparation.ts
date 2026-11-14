import { html } from "hono/html";
import { TYPES_QUESTION } from "../../core/activite.ts";
import { MAX_SERIE, MAX_SOURCES } from "../activites.ts";
import type { Catalogue } from "../domaines.ts";
import type { Libelles } from "../instance.ts";
import { NOMS_TYPE } from "./questions.ts";

export type Preparation = {
  catalogue: Catalogue;
  libelles: Libelles;
  coursId: string;
  objectifs: { id: string; intitule: string; reference: string }[];
  sources: { id: string; titre: string }[];
  personnel: boolean;
  saisie: Record<string, unknown>;
  erreur?: string;
  rejets?: string[];
};

/** Choisir le type, le cours, l'objectif et les sources, puis faire rédiger le brouillon. */
export const preparation = (p: Preparation) => {
  const s = (nom: string) => String(p.saisie[nom] ?? "");
  const choisies = new Set([p.saisie.sources ?? []].flat().map(String));
  const explication = s("type") === "explication";
  const types = new Set(
    Object.keys(p.saisie).length ? [p.saisie.types ?? []].flat().map(String) : ["redigee"],
  );
  const nomCours = (c: Catalogue["cours"][number]) =>
    `${p.catalogue.matieres.find((m) => m.id === c.matiere_id)?.nom ?? ""} / ${c.nom}`;
  return html`
    <p><a href="/prof/activites">Activités</a></p>
    <h1>Préparer une activité</h1>
    <p class="discret">Un quiz de carnet-quiz s'importe depuis <a href="/prof/activites/importer">cette page</a>.</p>
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
        <label for="cours_id">${p.libelles.cours}</label>
        <select id="cours_id" name="cours_id">${p.catalogue.cours.map(
          (c) =>
            html`<option value="${c.id}" ${c.id === p.coursId ? "selected" : ""}>${nomCours(c)}</option>`,
        )}</select>
        <button>Changer</button>
      </form>
      <form method="post" action="/prof/activites" class="etroit">
        <input type="hidden" name="cours_id" value="${p.coursId}">
        <fieldset>
          <legend><strong>Activité</strong></legend>
          <label><input type="radio" name="type" value="exercice" ${explication ? "" : "checked"}> Exercice, une série de questions</label>
          <p class="aide">Chaque champ que Thot rédige cite des passages retrouvés mot pour mot. Un champ sans passage retrouvé est rejeté. Une réponse rédigée a une consigne, une réponse attendue, 2 à 5 critères et un retour. Un choix a une consigne, des options et un retour : la bonne option et le retour citent leurs passages, les options fausses non. Le juge de soutien signale ce que les passages d'un champ n'établissent pas.</p>
          <label><input type="radio" name="type" value="explication" ${explication ? "checked" : ""}> Explication d'étude</label>
          <p class="aide">Thot répond à l'objectif comme à une question, dans les sources choisies seulement. Chaque phrase cite son passage et passe le juge de soutien. L'élève la lit, sans réponse à envoyer.</p>
        </fieldset>
        <fieldset>
          <legend><strong>Série de questions</strong></legend>
          <p class="aide">Pour un exercice. Thot rédige une question par appel, chacune citée mot pour mot. Une question mal ancrée est rejetée et comptée, les autres restent.</p>
          <div class="champ">
            <label for="nombre">Nombre de questions, de 1 à ${MAX_SERIE}</label>
            <input type="number" id="nombre" name="nombre" min="1" max="${MAX_SERIE}" value="${s("nombre") || "1"}">
          </div>
          <p class="aide">Types, tirés dans l'ordre et en boucle.</p>
          ${TYPES_QUESTION.map(
            (t) =>
              html`<label><input type="checkbox" name="types" value="${t}" ${
                types.has(t) ? "checked" : ""
              }> ${NOMS_TYPE[t]}</label>`,
          )}
          <p class="aide">Corrigé de l'élève.</p>
          <label><input type="radio" name="correction" value="serie" ${s("correction") === "question" ? "" : "checked"}> Après la remise de la série</label>
          <label><input type="radio" name="correction" value="question" ${s("correction") === "question" ? "checked" : ""}> Après chaque question</label>
        </fieldset>
        <fieldset>
          <legend><strong>Objectif</strong></legend>
          ${
            p.objectifs.length
              ? html`<div class="champ">
                <label for="objectif_id">Objectif enregistré</label>
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
            <input type="text" id="intitule" name="intitule" maxlength="300" value="${s("intitule")}">
          </div>
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
        <button class="principal" ${p.sources.length ? "" : "disabled"}>Rédiger le brouillon</button>
      </form>
    `
    }
  `;
};

export type Importation = {
  catalogue: Catalogue;
  libelles: Libelles;
  coursId: string;
  objectifs: { id: string; intitule: string }[];
  saisie: Record<string, unknown>;
  /** Une erreur par ligne : la lecture du fichier, ou une question qui ne convient pas. */
  erreurs?: string[];
};

/** Importer un quiz carnet-quiz en brouillon d'exercice. */
export const importation = (p: Importation) => {
  const s = (nom: string) => String(p.saisie[nom] ?? "");
  const nomCours = (c: Catalogue["cours"][number]) =>
    `${p.catalogue.matieres.find((m) => m.id === c.matiere_id)?.nom ?? ""} / ${c.nom}`;
  return html`
    <p><a href="/prof/activites">Activités</a></p>
    <h1>Importer un quiz de carnet-quiz</h1>
    <p>Un fichier JSON de 1 Mo au plus. Les champs sont repris tels que vous les avez écrits, sans citation. Thot ne reprend pas les pièges anti-IA, le chrono ni les liens de recherche. Les images se déposent ensuite dans Thot.</p>
    ${
      p.erreurs?.length
        ? html`<div role="alert"><strong>Import refusé</strong><ul>${p.erreurs.map(
            (e) => html`<li>${e}</li>`,
          )}</ul></div>`
        : ""
    }
    ${
      !p.catalogue.cours.length
        ? html`<p>Aucun cours. Un objectif appartient à un cours.</p>`
        : html`
      <form method="get" action="/prof/activites/importer" class="barre">
        <label for="cours_id_choix">${p.libelles.cours}</label>
        <select id="cours_id_choix" name="cours_id">${p.catalogue.cours.map(
          (c) =>
            html`<option value="${c.id}" ${c.id === p.coursId ? "selected" : ""}>${nomCours(c)}</option>`,
        )}</select>
        <button>Changer</button>
      </form>
      <form method="post" action="/prof/activites/importer" enctype="multipart/form-data" class="etroit">
        <input type="hidden" name="cours_id" value="${p.coursId}">
        <fieldset>
          <legend><strong>Objectif</strong></legend>
          ${
            p.objectifs.length
              ? html`<div class="champ">
                <label for="objectif_id">Objectif enregistré</label>
                <select id="objectif_id" name="objectif_id">
                  <option value="">Nouvel objectif</option>
                  ${p.objectifs.map(
                    (o) =>
                      html`<option value="${o.id}" ${o.id === s("objectif_id") ? "selected" : ""}>${o.intitule}</option>`,
                  )}
                </select>
              </div>`
              : ""
          }
          <div class="champ">
            <label for="intitule">Nouvel objectif</label>
            <input type="text" id="intitule" name="intitule" maxlength="300" value="${s("intitule")}">
          </div>
        </fieldset>
        <div class="champ">
          <label for="fichier">Fichier du quiz (.json)</label>
          <input type="file" id="fichier" name="fichier" accept=".json,application/json" required>
        </div>
        <button class="principal">Importer en brouillon</button>
      </form>
    `
    }
  `;
};

/** Ce que l'import a repris et ce qu'il a laissé. */
export const importee = (p: {
  id: string;
  titre: string;
  questions: number;
  ignores: string[];
}) => html`
  <p><a href="/prof/activites">Activités</a></p>
  <h1>Quiz importé</h1>
  <div role="status">
    <p><strong>${p.titre}</strong> : ${p.questions} question${p.questions > 1 ? "s" : ""}, en brouillon. Chaque champ est rédigé par l'enseignant. Le corrigé suit chaque question, avec l'indice après une première erreur.</p>
  </div>
  ${
    p.ignores.length
      ? html`<p>Thot n'a pas repris :</p><ul>${p.ignores.map((i) => html`<li>${i}</li>`)}</ul>`
      : html`<p>Rien n'a été laissé de côté.</p>`
  }
  <p><a class="bouton principal" href="/prof/activites/${p.id}">Relire l'activité</a></p>
`;
