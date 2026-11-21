import { html } from "hono/html";
import { AUDIENCES } from "../depot.ts";
import { icone } from "../icones.ts";
import type { Libelles } from "../instance.ts";
import { type Dossier, type Etape, dossier, fil } from "./bureau.ts";
import { nombre } from "./commun.ts";
import { type LigneSource, lignesSources } from "./prof-lignes.ts";
import type { QuestionProf } from "./prof-questions.ts";

type Filtres = {
  q: string;
  statut: string;
  theme: string;
  lot: string;
  vue: string;
  matiere_id?: string;
  cours_id?: string;
  theme_id?: string;
};

const lienFiltres = (f: Filtres, change: Partial<Filtres>) =>
  `/prof?${new URLSearchParams({ ...f, ...change })}`;

/**
 * Le niveau ouvert dans la vue « Dossiers », que la route calcule : le chemin depuis la racine, et
 * les dossiers de ce niveau, un par cours à la racine, un par thème dans un cours.
 */
export type Rangement = {
  fil: { nom: string; portee: Partial<Filtres> }[];
  dossiers: { nom: string; portee: Partial<Filtres>; n: number; aRelire: number }[];
  /** le cours ouvert, où « Déposer ici » range les fichiers déposés */
  coursId?: string;
};

const bureauBibliotheque = (f: Filtres, r: Rangement) => html`
  ${fil(r.fil.map((e): Etape => ({ nom: e.nom, href: lienFiltres(f, e.portee) })))}
  ${
    r.dossiers.length
      ? html`<ul class="bureau">${r.dossiers.map((d) =>
          dossier({
            href: lienFiltres(f, d.portee),
            nom: d.nom,
            detail: nombre(d.n, "ressource"),
            signal: d.aRelire ? `${d.aRelire} à relire` : "",
          } satisfies Dossier),
        )}</ul>`
      : ""
  }
`;

/** La bibliothèque range les ressources et les activités préparées d'après elles. */
export const ongletsBibliotheque = (chemin: string) =>
  html`<nav class="onglets" aria-label="Bibliothèque">${[
    ["/prof", "Ressources"],
    ["/prof/activites", "Activités"],
  ].map(
    ([href, libelle]) =>
      html`<a href="${href}" ${chemin === href ? html`aria-current="page"` : ""}>${libelle}</a>`,
  )}</nav>`;

/** Où en est le compte dans la prise en main de Thot. */
export type Debut = {
  cours: boolean;
  ressource: boolean;
  certifiee: boolean;
  administrateur: boolean;
  personnel: boolean;
  /** les questions des élèves des cours du compte, vides en mode personnel */
  questions?: QuestionProf[];
};
/** Les étapes de prise en main sont faites : Thot peut répondre. */
const pret = (d: Debut) => d.cours && d.ressource && d.certifiee;
/**
 * Sans question encore, le chapeau de la bibliothèque invite à en poser une, plutôt qu'une section
 * vide qui répéterait que les réponses citent les ressources certifiées.
 */
const invitation = (d: Debut) =>
  pret(d) && !d.questions?.length
    ? html` ${d.personnel ? "" : "Aucune question d'élève pour l'instant. "}<a href="/eleve/chat">${
        d.personnel ? "Poser une question" : "Essayer avec une question"
      }</a>`
    : "";
/**
 * Ce que Thot fait des ressources, une fois l'une d'elles certifiée : les questions des élèves de
 * la semaine, dont celles qu'aucun passage du cours n'a pu prouver.
 */
const activiteEleves = (d: Debut) => {
  if (!d.questions?.length) return "";
  const semaine = Date.now() - 7 * 24 * 3600 * 1000;
  const recentes = d.questions.filter((q) => Date.parse(q.cree_le) >= semaine);
  const sansReponse = recentes.filter((q) => q.etat === "out_of_corpus").length;
  const dernieres = [...d.questions].sort((a, b) => b.cree_le.localeCompare(a.cree_le)).slice(0, 3);
  return html`
    <section class="activite-eleves" aria-labelledby="activite-eleves">
      <h2 id="activite-eleves">${d.personnel ? "Vos questions" : "Questions des élèves"}</h2>
      <p>${recentes.length} cette semaine${
        sansReponse
          ? html`, dont ${sansReponse} sans passage dans le cours : un document manque peut-être`
          : ""
      }. <a href="/prof/questions">Voir les questions</a></p>
      <ul>${dernieres.map(
        (q) =>
          html`<li>« <a href="/prof/questions/${q.id}">${q.question}</a> » <span class="discret">${q.nom}${
            q.etat === "out_of_corpus" ? ", sans passage dans le cours" : ""
          }</span></li>`,
      )}</ul>
    </section>
  `;
};
/**
 * Les étapes qui mènent à une première réponse, tant qu'il manque un cours, une ressource ou une
 * ressource certifiée. Une étape faite reste listée, cochée.
 */
const premiersPas = (d: Debut) => {
  if (pret(d)) return "";
  const etape = (fait: boolean, titre: unknown, aide: string) =>
    html`<li class="${fait ? "fait" : ""}">${fait ? html`${icone("check")}<span class="visuellement-cache">Fait : </span>` : ""}<strong>${titre}</strong>
      <span class="discret">${aide}</span></li>`;
  return html`
    <section class="premiers-pas" aria-labelledby="premiers-pas">
      <h2 id="premiers-pas">Pour commencer</h2>
      <ol>
        ${etape(
          d.cours,
          d.administrateur
            ? html`<a href="/administration/domaines">Créer une matière et un cours</a>`
            : "Rejoindre un cours",
          d.administrateur
            ? "Ils rangent les ressources."
            : "Un administrateur crée les cours et vous y inscrit.",
        )}
        ${etape(
          d.ressource,
          html`<a href="/prof/depot">Déposer des ressources</a>`,
          "PDF, Word, PowerPoint, HTML, Markdown ou images. Thot en extrait le texte.",
        )}
        ${etape(
          d.certifiee,
          html`<a href="/prof?statut=a_relire">Relire et certifier</a>`,
          "Ouvrez chaque ressource, vérifiez son texte, puis certifiez-la. Seules les ressources certifiées servent aux réponses.",
        )}
        ${etape(
          false,
          html`<a href="/eleve">${d.personnel ? "Étudier" : "Ouvrir la vue élève"}</a>`,
          d.personnel
            ? "Posez vos questions. Chaque réponse cite les passages de vos ressources."
            : "Les élèves membres du cours y posent leurs questions. Chaque réponse cite les passages des ressources certifiées.",
        )}
      </ol>
    </section>
  `;
};

export const sources = (
  lignes: LigneSource[],
  f: Filtres,
  repartition: { theme: string; statut: string; n: number }[],
  l: Libelles,
  general = false,
  supprimee = false,
  debut?: Debut,
  rangement?: Rangement,
  /** les sources que l'action groupée n'a pas certifiées, chacune avec sa raison */
  refus: { id: string; titre: string; raison: string }[] = [],
) => {
  // Le compte de chaque filtre tient compte de l'autre.
  const somme = (garde: (r: (typeof repartition)[number]) => boolean) =>
    repartition.filter(garde).reduce((t, r) => t + r.n, 0);
  const parTheme = (v: string) =>
    somme((r) => (!v || r.theme === v) && (!f.statut || r.statut === f.statut));
  const parStatut = (v: string) =>
    somme((r) => (!v || r.statut === v) && (!f.theme || r.theme === f.theme));
  const themes = [...new Set(repartition.map((r) => r.theme))].filter(Boolean).sort();
  const requete = new URLSearchParams(f).toString();
  const grille = f.vue === "grille";
  return html`
    <h1>Bibliothèque</h1>
    ${
      debut
        ? html`<p class="sous-titre">${
            debut.personnel
              ? "Thot répond à vos questions en citant uniquement les ressources certifiées ici."
              : "Thot répond aux questions des élèves en citant uniquement les ressources certifiées ici."
          }${invitation(debut)}</p>`
        : ""
    }
    ${!debut ? "" : pret(debut) ? activiteEleves(debut) : premiersPas(debut)}
    ${ongletsBibliotheque("/prof")}
    ${
      supprimee
        ? html`<p role="status" tabindex="-1" autofocus>Source supprimée définitivement.</p>`
        : ""
    }
    ${
      refus.length
        ? html`<div role="alert" tabindex="-1" autofocus>
            ${refus.length > 1 ? `${refus.length} sources n'ont pas été certifiées` : "Une source n'a pas été certifiée"} :
            <ul>
              ${refus.map((r) => html`<li><a href="/prof/sources/${r.id}">${r.titre}</a> : ${r.raison}.</li>`)}
            </ul>
          </div>`
        : ""
    }
    ${
      f.lot
        ? html`<p>Lot déposé : ${nombre(
            somme(() => true),
            "fichier",
          )}. <a href="${lienFiltres(f, { lot: "" })}">Toute la bibliothèque</a></p>`
        : ""
    }
    ${
      general
        ? ""
        : html`<nav class="onglets" aria-label="${l.regroupements}">
      ${[["", "Tout"], ...themes.map((t) => [t, t])].map(
        ([v, l]) =>
          html`
          <a href="${lienFiltres(f, { theme: v })}"
            aria-current="${String(
              v === f.theme,
            )}">${l} <span class="nombre">${parTheme(v)}</span></a>
        `,
      )}
    </nav>`
    }
    <div class="biblio-outils">
      <form method="get" action="/prof" role="search" class="recherche-entete">
        ${Object.entries(f)
          .filter(([k, v]) => v && k !== "q")
          .map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
        <input type="search" name="q" value="${f.q}" maxlength="200"
          aria-label="Chercher une ressource par son titre" placeholder="Chercher par titre">
        <button aria-label="Chercher">${icone("magnifying-glass")}</button>
      </form>
      <nav class="segments statuts" aria-label="Statut">
        ${[
          ["", "Toutes"],
          ["a_relire", "À relire"],
          ["certifiee", "Certifiées"],
          ["rejetee", "Rejetées"],
        ].map(([v, l]) => {
          const n = parStatut(v);
          return html`
            <a href="${lienFiltres(f, { statut: v })}" class="${n ? "" : "vide"}"
              aria-current="${String(v === f.statut)}">${l} <span class="nombre">${n}</span></a>
          `;
        })}
      </nav>
      ${parStatut("a_relire") > 0 ? html`<a href="/prof/relecture">Relire une par une</a>` : ""}
      <nav class="segments" aria-label="Affichage">
        ${(
          [
            ["", "Liste", "list"],
            ["grille", "Dossiers", "squares-four"],
          ] as const
        ).map(
          ([v, l, i]) =>
            html`
            <a href="${lienFiltres(f, { vue: v })}" title="${l}"
              aria-current="${String(
                v === f.vue,
              )}">${icone(i)}<span class="visuellement-cache">${l}</span></a>
          `,
        )}
      </nav>
    </div>
    ${grille && rangement ? bureauBibliotheque(f, rangement) : ""}
    ${
      lignes.length || (grille && rangement?.coursId)
        ? html`
        <form method="post" action="/prof/sources/statut?${requete}">
          ${lignesSources(lignes, requete, grille, rangement?.coursId, l)}
          <div class="selection" role="region" aria-label="Sélection">
            <output data-compte-selection aria-live="polite"></output>
            <button type="button" class="lien" data-selection="tout">Tout sélectionner</button>
            <button type="button" class="lien" data-selection="aucun">Annuler</button>
            <button class="principal certifier espace" name="statut" value="certifiee" formnovalidate
              data-certifier-selection>
              ${icone("check")} Certifier
            </button>
            <button name="statut" value="rejetee" formnovalidate data-rejeter-selection>
              ${icone("x")} Rejeter
            </button>
            <select name="audience" aria-label="Lecteurs de la sélection" required>
              <option value="">Choisir les lecteurs</option>
              ${AUDIENCES.map(
                (a) =>
                  html`
                  <option value="${a.value}">${a.label}</option>
                `,
              )}
            </select>
            <button name="statut" value="lecteurs">Changer les lecteurs</button>
          </div>
        </form>
      `
        : grille && rangement?.dossiers.length
          ? ""
          : // Les comptes suivent la recherche : à zéro, c'est la recherche qui ne trouve rien.
            f.q
            ? html`
        <p>Aucun titre de ressource ne contient « ${f.q} »${repartition.length ? " pour ce filtre" : ""}.
          <a href="${lienFiltres(f, { q: "" })}">Effacer la recherche</a></p>
      `
            : repartition.length
              ? html`
        <p>Aucun document pour ce filtre.</p>
      `
              : html`
        <p>Aucun document. <a href="/prof/depot">Déposer le premier</a>.</p>
      `
    }
  `;
};
