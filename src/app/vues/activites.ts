import { html } from "hono/html";
import {
  type Champ,
  type Citation,
  champs,
  citationsDe,
  type Contenu,
  type Explication,
} from "../../core/activite.ts";
import { SEUIL_SOUTIEN } from "../../core/reponse.ts";
import {
  type Activite,
  MAX_SOURCES,
  nomChamp,
  type Tentative,
  type TentativeLue,
} from "../activites.ts";
import type { Catalogue } from "../domaines.ts";
import { icone } from "../icones.ts";
import { panneauSource, reponse } from "./eleve.ts";
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

/** Un passage cité. Sans offsets, il vient d'une légende d'image relue. */
type Cite = Pick<Citation, "source_id" | "revision" | "titre" | "citation"> &
  Partial<Pick<Citation, "debut" | "fin">>;

/** Le lecteur de source existant, ouvert sur le passage, dans la révision citée. */
const lien = (c: Cite) =>
  c.debut === undefined
    ? `/eleve/sources/${c.source_id}`
    : `/eleve/sources/${c.source_id}?debut=${c.debut}&fin=${c.fin}&revision=${c.revision}#passage`;

/** Les passages d'un champ. Avec `servies`, une citation qui ne tient plus le dit. */
const passages = (ch: { citations: Cite[] }, servies?: Map<string, number | undefined>) =>
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
const avis = (ch: Champ) =>
  ch.soutien === null
    ? html`<p><span class="statut a_relire">Juge indisponible</span> <span class="discret">Les passages sont retrouvés mot pour mot, mais le juge n'a pas vérifié qu'ils établissent ce champ.</span></p>`
    : ch.soutien !== undefined && ch.soutien < SEUIL_SOUTIEN
      ? html`<p><span class="statut failed">À vérifier</span> <span class="discret">Selon le juge de soutien, les passages cités n'établissent pas tout ce que dit ce champ.</span></p>`
      : "";

const TYPES: Record<Activite["type"], string> = {
  exercice: "Exercice",
  explication: "Explication",
};

export type SuiviObjectif = {
  intitule: string;
  cours: string;
  publiees: number;
  tentatives: number;
};

export const listeProf = (liste: Activite[], suivi: SuiviObjectif[]) => html`
  <h1>Bibliothèque</h1>
  ${ongletsBibliotheque("/prof/activites")}
  <p><a class="bouton principal" href="/prof/activites/nouvelle">Préparer une activité</a></p>
  ${
    liste.length
      ? html`<table>
        <thead><tr><th>Objectif</th><th>Type</th><th>Cours</th><th>État</th><th>Version</th></tr></thead>
        <tbody>${liste.map(
          (a) => html`<tr>
            <td><a href="/prof/activites/${a.id}">${a.intitule}</a></td>
            <td>${TYPES[a.type]}</td><td>${a.cours}</td><td>${etat(a)}</td><td>${a.revision}</td>
          </tr>`,
        )}</tbody>
      </table>`
      : html`<p>Aucune activité. Un exercice ou une explication part d'un objectif et de sources certifiées d'un cours.</p>`
  }
  ${
    suivi.length
      ? html`<h2>Par objectif</h2>
        <p class="discret">Dans vos cours. Une tentative est une réponse envoyée à un exercice, toutes versions confondues. Thot ne la note pas.</p>
        <table>
          <thead><tr><th>Objectif</th><th>Cours</th><th>Activités publiées</th><th>Tentatives</th></tr></thead>
          <tbody>${suivi.map(
            (o) =>
              html`<tr><td>${o.intitule}</td><td>${o.cours}</td><td>${o.publiees}</td><td>${o.tentatives}</td></tr>`,
          )}</tbody>
        </table>`
      : ""
  }
`;

/** Les réponses des élèves, lues par les enseignants du cours. */
const tentativesProf = (liste: TentativeLue[]) => html`
  <h2>Tentatives</h2>
  ${
    liste.length
      ? html`<p class="discret">Toutes versions confondues. Les critères cochés sont ceux que l'élève pense remplir, numérotés dans la version à laquelle il répondait.</p>
        <table>
          <thead><tr><th>Élève</th><th>Date</th><th>Version</th><th>Réponse</th><th>Critères cochés</th></tr></thead>
          <tbody>${liste.map((t) => {
            const coches = JSON.parse(t.criteres) as number[];
            return html`<tr><td>${t.nom}</td><td>${jour(t.cree_le)}</td><td>${t.revision}</td><td>${
              t.reponse
            }</td><td>${coches.length ? coches.map((i) => i + 1).join(", ") : "aucun"}</td></tr>`;
          })}</tbody>
        </table>`
      : html`<p class="discret">Aucune tentative.</p>`
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

/** Choisir le type, le cours, l'objectif et les sources, puis faire rédiger le brouillon. */
export const preparation = (p: Preparation) => {
  const s = (nom: string) => String(p.saisie[nom] ?? "");
  const choisies = new Set([p.saisie.sources ?? []].flat().map(String));
  const explication = s("type") === "explication";
  const nomCours = (c: Catalogue["cours"][number]) =>
    `${p.catalogue.matieres.find((m) => m.id === c.matiere_id)?.nom ?? ""} / ${c.nom}`;
  return html`
    <p><a href="/prof/activites">Activités</a></p>
    <h1>Préparer une activité</h1>
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
          <legend><strong>Activité</strong></legend>
          <label><input type="radio" name="type" value="exercice" ${explication ? "" : "checked"}> Exercice à réponse courte</label>
          <p class="aide">Thot rédige une consigne, une réponse attendue, 2 à 5 critères et un retour. Chaque champ cite des passages retrouvés mot pour mot. Un champ sans passage retrouvé est rejeté. Le juge de soutien signale ce que les passages d'un champ n'établissent pas.</p>
          <label><input type="radio" name="type" value="explication" ${explication ? "checked" : ""}> Explication d'étude</label>
          <p class="aide">Thot répond à l'objectif comme à une question, dans les sources choisies seulement. Chaque phrase cite son passage et passe le juge de soutien. L'élève la lit, sans réponse à envoyer.</p>
        </fieldset>
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
        <button class="principal" ${p.sources.length ? "" : "disabled"}>Rédiger le brouillon</button>
      </form>
    `
    }
  `;
};

export type DetailProf = {
  a: Activite;
  contenu: Contenu | Explication;
  relectures: { revision: number; action: string; le: string; nom: string | null }[];
  servies: Map<string, number | undefined>;
  /** le titre de chaque source citée */
  titres: Map<string, string>;
  /** absentes pour un compte qui ne les lit pas */
  tentatives?: TentativeLue[];
  erreur?: string;
};

type Servies = DetailProf["servies"];

/** Les champs d'un exercice, leurs preuves et l'avis du juge. */
const champsExercice = (contenu: Contenu, servies: Servies) => {
  const champ = (ch: Champ) =>
    html`<p>${ch.texte || html`<span class="discret">Vide : sa source a été supprimée.</span>`}</p>${avis(ch)}${passages(ch, servies)}`;
  return html`
    <h2>Consigne</h2>
    ${champ(contenu.consigne)}
    <h2>Réponse attendue</h2>
    ${champ(contenu.attendu)}
    <h2>Critères</h2>
    <ol>${contenu.criteres.map((ch) => html`<li>${champ(ch)}</li>`)}</ol>
    <h2>Retour</h2>
    ${champ(contenu.retour)}
  `;
};

const modification = (a: Activite, contenu: Contenu, erreur?: string) => {
  const liste = champs(contenu);
  return html`
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

/** Inspecter les preuves, modifier, relire, publier, avec l'historique de relecture. */
export const detailProf = ({
  a,
  contenu,
  relectures,
  servies,
  titres,
  tentatives,
  erreur,
}: DetailProf) => {
  const rejets = JSON.parse(a.rejets) as string[];
  const sources = [
    ...new Map(citationsDe(contenu).map((c) => [`${c.source_id}/${c.revision}`, c])).values(),
  ];
  const personnel = a.audience === "prive";
  const explication = a.type === "explication";
  return html`
    <p><a href="/prof/activites">Activités</a></p>
    <h1>${a.intitule}</h1>
    <p class="discret">${TYPES[a.type]} · ${a.cours}${a.reference ? ` · ${a.reference}` : ""} · version ${a.revision} · ${etat(a)}</p>
    ${erreur ? html`<p role="alert">${erreur}</p>` : ""}
    ${
      personnel
        ? html`<p class="note">${
            explication ? "Explication privée, générée" : "Exercice privé, généré"
          } par Thot. Votre relecture ne vaut pas relecture indépendante.</p>`
        : ""
    }
    ${
      a.etat === "a_revoir"
        ? html`<p role="alert">Une source citée a une nouvelle version, n'est plus citable dans ce cours ou a été supprimée. ${
            explication
              ? "Les élèves ne reçoivent plus cette explication. Préparez-en une autre."
              : "Les élèves ne reçoivent plus cet exercice. Enregistrez-le de nouveau pour rechercher ses passages dans la version actuelle, ou préparez-en un autre."
          }</p>`
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
    ${"affirmations" in contenu ? corpsExplication(contenu, servies) : champsExercice(contenu, servies)}
    <h2>Sources citées</h2>
    <ul>${sources.map(
      (c) => html`<li>${titres.get(c.source_id) ?? c.titre}, version ${c.revision}</li>`,
    )}</ul>
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
    ${tentatives && a.type === "exercice" ? tentativesProf(tentatives) : ""}
    ${"affirmations" in contenu ? "" : modification(a, contenu, erreur)}
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

/** Le haut de la page élève : retour, objectif, cours, et qui a préparé et relu l'activité. */
const entete = (a: Activite, relecteur?: string, apercu?: boolean) => {
  const e = a.type === "explication" ? "e" : "";
  return html`
    ${
      apercu
        ? html`<p><a href="/prof/activites/${a.id}">Retour à l'activité</a></p>
          <p class="note">Aperçu de la page élève.${
            e
              ? ""
              : " La réponse attendue, les critères et le retour n'apparaissent qu'après la réponse de l'élève."
          }</p>`
        : html`<a class="bouton retour" href="/eleve">${icone("arrow-left")}Ressources</a>`
    }
    <h1>${a.intitule}</h1>
    <p class="discret"><a href="/eleve?cours_id=${a.cours_id}">${a.cours}</a>. ${
      a.audience === "prive"
        ? `${TYPES[a.type]} généré${e} par Thot à partir de tes documents. Personne d'autre que toi ne l'a relu${e}.`
        : `${TYPES[a.type]} préparé${e} par ${a.auteur}${relecteur ? `, relu${e} par ${relecteur}` : ""}.`
    }</p>
  `;
};

/**
 * La page de l'élève. Avant une tentative sur la version actuelle, elle ne contient que l'objectif
 * et la consigne : ni réponse attendue, ni critère, ni retour, ni passage cité.
 */
export const pratique = ({ a, contenu, tentative, relecteur, apercu }: Pratique) => {
  const coches = tentative ? (JSON.parse(tentative.criteres) as number[]) : [];
  return html`
    ${entete(a, relecteur, apercu)}
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

/**
 * Une explication se lit comme une réponse : ses blocs, ses numéros de citation, et la feuille du
 * passage cité. Ni tentative ni corrigé.
 */
export const explication = ({
  a,
  contenu,
  relecteur,
  apercu,
}: Omit<Pratique, "contenu" | "tentative"> & { contenu: Explication }) => html`
  <div class="mur-lecteur" data-feuille>
    <div>
      ${entete(a, relecteur, apercu)}
      ${reponse(
        a.id,
        { etat: "answered", affirmations: contenu.affirmations, blocs: contenu.blocs },
        null,
        [],
        false,
        `/${apercu ? "prof" : "eleve"}/activites/${a.id}/citations`,
      )}
    </div>
    <div class="colonne-source">${panneauSource()}</div>
  </div>
`;

/** Les activités publiées de l'élève, dans la page de ses ressources. */
export const exercices = (liste: Activite[]) =>
  liste.length
    ? html`<section aria-labelledby="exercices">
      <h2 id="exercices">Exercices et explications</h2>
      <ul>${liste.map(
        (a) =>
          html`<li><a href="/eleve/activites/${a.id}">${a.intitule}</a> <span class="discret">${TYPES[a.type]}, ${a.cours}</span></li>`,
      )}</ul>
    </section>`
    : "";
