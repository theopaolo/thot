import { html } from "hono/html";
import type { Bloc } from "../../core/document.ts";
import { CLASSES, MATIERES, PUBLICS, PUBLICS_PAR_DEFAUT, TYPES_DOCUMENT } from "../depot.ts";
import { icone } from "../icones.ts";
import { texteDocument } from "./document.ts";

type Option = { value: string; label: string };

const JOUR = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeZone: "Europe/Paris" });
/** « 22 septembre 2026 » à partir d'un horodatage ISO. */
const jour = (iso: string) => JOUR.format(new Date(iso));

const ETATS_JOB: Record<string, string> = {
  received: "en file",
  extracting: "extraction",
  enriching: "légendes",
  awaiting_review: "extrait",
  failed: "échec",
};
const STATUTS: Record<string, string> = {
  a_relire: "à relire",
  certifiee: "certifiée",
  rejetee: "rejetée",
};

export type LigneSource = {
  id: string;
  titre: string;
  sequence: string;
  format: string;
  statut: string;
  etat: string;
  erreur: string | null;
  images_a_relire: number;
};

export const JOBS_ACTIFS = ["received", "extracting", "enriching"];

export const lignesSources = (lignes: LigneSource[], requete: string) => {
  const actifs = lignes.some((l) => JOBS_ACTIFS.includes(l.etat));
  return html`
    <tbody id="lignes" ${actifs
      ? html`
        hx-get="/prof/lignes?${requete}" hx-trigger="every 3s" hx-swap="outerHTML"
      `
      : ""}>
      ${lignes.map((l) =>
        html`
          <tr>
            <td>
              <input type="checkbox" name="ids" value="${l.id}" aria-label="Sélectionner ${l
                .titre}">
            </td>
            <td>
              <a href="/prof/sources/${l.id}">${l.titre}</a><br><small>${l.sequence} · ${l
                .format}</small>
            </td>
            <td>${l.etat === "failed"
              ? html`<span class="statut failed">échec du traitement</span>`
              : JOBS_ACTIFS.includes(l.etat)
              ? html`<span class="statut en-cours">${ETATS_JOB[l.etat]}…</span>`
              : html`<span class="statut ${l.statut}">${STATUTS[l.statut] ?? l.statut}</span>`}</td>
            <td class="statut unreviewed">${l.images_a_relire
              ? `${l.images_a_relire} non relue${l.images_a_relire > 1 ? "s" : ""}`
              : ""}</td>
          </tr>
        `
      )}
    </tbody>
  `;
};

type Filtres = { statut: string; chapitre: string };

/** Une ligne de liens-filtres. Le compte de chaque lien tient compte de l'autre filtre. */
const filtre = (
  nom: string,
  cle: keyof Filtres,
  choix: [string, string][],
  f: Filtres,
  compte: (v: string) => number,
) =>
  html`
    <nav class="filtre" aria-label="${nom}">
      <span class="discret">${nom}</span>
      ${choix.map(([v, l]) => {
        const lien = `/prof?${new URLSearchParams({ ...f, [cle]: v })}`;
        return html`
          <a href="${lien}"
            aria-current="${String(v === f[cle])}">${l} <span class="discret">${compte(
              v,
            )}</span></a>
        `;
      })}
    </nav>
  `;

export const sources = (
  lignes: LigneSource[],
  f: Filtres,
  repartition: { chapitre: string; statut: string; n: number }[],
) => {
  const somme = (garde: (r: (typeof repartition)[number]) => boolean) =>
    repartition.filter(garde).reduce((t, r) => t + r.n, 0);
  const chapitres = [...new Set(repartition.map((r) => r.chapitre))].filter(Boolean).sort();
  const requete = new URLSearchParams(f).toString();
  return html`
    <h1>Sources</h1>
    ${filtre(
      "Statut",
      "statut",
      [["", "Toutes"], ["a_relire", "À relire"], ["certifiee", "Certifiées"], [
        "rejetee",
        "Rejetées",
      ]],
      f,
      (v) => somme((r) => (!v || r.statut === v) && (!f.chapitre || r.chapitre === f.chapitre)),
    )} ${filtre(
      "Chapitre",
      "chapitre",
      [["", "Tous"], ...chapitres.map((c): [string, string] => [c, c])],
      f,
      (v) => somme((r) => (!v || r.chapitre === v) && (!f.statut || r.statut === f.statut)),
    )}
    ${lignes.length
      ? html`
        <form method="post" action="/prof/sources/statut?${requete}">
          <div class="barre actions-selection">
            <button name="statut" value="certifiee">Certifier la sélection</button>
            <button
              class="espace"
              name="statut"
              value="rejetee"
              data-rejeter-selection
            >
              Rejeter la sélection
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Tout sélectionner"
                    data-tout-selectionner
                  >
                </th>
                <th>Document</th>
                <th>Statut</th>
                <th>Légendes</th>
              </tr>
            </thead>
            ${lignesSources(lignes, requete)}
          </table>
        </form>
      `
      : repartition.length
      ? html`
        <p>Aucun document pour ce filtre.</p>
      `
      : html`
        <p>Aucun document. <a href="/prof/depot">Déposer le premier</a>.</p>
      `}
  `;
};

export const eleves = (
  liste: { id: string; identifiant: string; nom: string }[],
  erreur?: string,
) =>
  html`
    <h1>Élèves</h1>
    <p>Importer une classe avec un CSV UTF-8 contenant les colonnes <code>identifiant,nom</code>. Les identifiants doivent être uniques.</p>
    ${erreur ? html`<p role="alert">${erreur}</p>` : ""}
    <form method="post" action="/prof/eleves/importer" enctype="multipart/form-data" class="barre">
      <label for="fichier">Liste CSV</label>
      ${champFichier(".csv,text/csv")}
      <button class="principal">Importer et afficher les mots de passe</button>
    </form>
    ${liste.length
      ? html`
        <table>
          <thead>
            <tr>
              <th>Nom</th>
              <th>Identifiant</th>
              <th><span class="visuellement-cache">Action</span></th>
            </tr>
          </thead>
          <tbody>
          ${liste.map((c) =>
            html`
              <tr>
                <td>${c.nom}</td>
                <td>${c.identifiant}</td>
                <td>
                  <form method="post" action="/prof/eleves/${c.id}/reinitialiser">
                    <button>Réinitialiser le mot de passe</button>
                  </form>
                </td>
              </tr>
            `
          )}
          </tbody>
        </table>
      `
      : html`<p>Aucun élève importé.</p>`}
  `;

export const feuilleIdentifiants = (
  liste: { identifiant: string; nom: string; motDePasse: string }[],
  adresse: string,
) =>
  html`
    <div
      class="barre sans-impression"><h1>Identifiants à remettre</h1><span class="espace"></span><button type="button" data-imprimer>Imprimer</button></div>
    <p
      class="sans-impression">Les mots de passe ne seront plus affichés après cette page. Imprimez la feuille, puis fermez-la.</p>
    <div class="feuilles">${liste.map((c) =>
      html`
        <section class="identifiants"><strong>Thot · ${c.nom}</strong>
          <p>Adresse : <span>${adresse}</span></p><p>Identifiant : <strong>${c
            .identifiant}</strong></p>
          <p>Mot de passe : <strong>${c.motDePasse}</strong></p>
        </section>
      `
    )}</div>
    <p class="sans-impression"><a href="/prof/eleves">Retour aux élèves</a></p>
  `;

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

const AVIS: Record<string, string> = { faux: "Fausse", confus: "Peu claire", utile: "Utile" };

const tableQuestions = (lignes: QuestionProf[], avecEtat: boolean) =>
  html`
    <table>
      <thead>
        <tr>
          <th>Question</th>
          ${avecEtat
            ? html`
              <th>État</th>
              <th>Avis</th>
            `
            : ""}
          <th>Élève</th>
          <th>Date</th>
        </tr>
      </thead>
      <tbody>
        ${lignes.map((m) =>
          html`
            <tr>
              <td>${m.question}</td>
              ${avecEtat
                ? html`
                  <td>${m.etat === "answered"
                    ? "Répondue"
                    : m.etat === "failed"
                    ? m.code === "CITATION_UNVERIFIED" ? "Citation non vérifiée" : "Panne"
                    : "En cours"}</td>
                  <td>${AVIS[m.avis ?? ""] ?? ""}</td>
                `
                : ""}
              <td>${m.nom}</td>
              <td>${jour(m.cree_le)}</td>
            </tr>
          `
        )}
      </tbody>
    </table>
  `;

export const questionsProf = (messages: QuestionProf[]) => {
  const refus = messages.filter((m) => m.etat === "out_of_corpus");
  const groupes = Map.groupBy(
    messages.filter((m) => m.etat !== "out_of_corpus"),
    (m) => m.chapitre || "Sans chapitre",
  );
  return html`
    <h1>Questions des élèves</h1>
    ${messages.length ? "" : html`<p>Aucune question posée pour le moment.</p>`}
    ${refus.length
      ? html`
        <section class="questions-prof">
          <h2>Hors cours</h2>
          <p class="discret">Thot n'a pas trouvé de réponse dans vos cours. Ces questions signalent peut-être un point à couvrir.</p>
          ${tableQuestions(refus, false)}
        </section>
      `
      : ""}
    ${[...groupes].map(([chapitre, lignes]) =>
      html`
        <section class="questions-prof">
          <h2>${chapitre}</h2>
          ${tableQuestions(lignes, true)}
        </section>
      `
    )}
  `;
};

/** Sélecteur de fichier au libellé français, quelle que soit la langue du navigateur. */
const champFichier = (accept: string) =>
  html`
    <span class="fichier">
      <input
        type="file"
        id="fichier"
        name="fichier"
        accept="${accept}"
        required
        class="visuellement-cache"
      >
      <label for="fichier" class="bouton">${icone("upload-simple")}Choisir un fichier</label>
      <output for="fichier" class="discret">Aucun fichier choisi</output>
    </span>
  `;

const champ = (
  o: {
    nom: string;
    label: string;
    valeur?: string;
    erreur?: string;
    aide?: string;
    requis?: boolean;
    options?: Option[];
    zone?: boolean;
  },
) =>
  html`
    <div class="champ">
      <label for="${o.nom}">${o.label}${o.requis ? " *" : ""}</label>
      ${o.aide
        ? html`
          <p class="aide" id="${o.nom}-aide">${o.aide}</p>
        `
        : ""} ${o.options
        ? html`
          <select id="${o.nom}" name="${o.nom}" ${o.requis ? "required" : ""}>
            <option value="">Choisir</option>
            ${o.options.map((x) =>
              html`
                <option value="${x.value}" ${x.value === o.valeur ? "selected" : ""}>${x
                  .label}</option>
              `
            )}
          </select>
        `
        : o.zone
        ? html`
          <textarea id="${o.nom}" name="${o.nom}">${o.valeur ?? ""}</textarea>
        `
        : html`
          <input type="text" id="${o.nom}" name="${o.nom}" value="${o.valeur ?? ""}" ${o.requis
            ? "required"
            : ""}>
        `} ${o.erreur
        ? html`
          <p class="erreur" id="${o.nom}-erreur">${o.erreur}</p>
        `
        : ""}
    </div>
  `;

export const depot = (
  s: {
    champs?: Record<string, string>;
    publics?: string[];
    erreurs?: Record<string, string>;
    ok?: string;
  },
) => {
  const c = s.champs ?? {};
  const e = s.erreurs ?? {};
  const publics = s.publics ?? PUBLICS_PAR_DEFAUT;
  return html`
    <h1>Déposer un document</h1>
    ${s.ok
      ? html`
        <p role="status">${s.ok}</p>
      `
      : ""}
    <form method="post" action="/prof/depot" enctype="multipart/form-data" class="etroit">
      ${champ({
        nom: "titre",
        label: "Nom du document",
        requis: true,
        valeur: c.titre,
        erreur: e.titre,
        aide: "Le nom que vous lui donnez, pas celui du fichier.",
      })}
      <div class="champ">
        <label for="fichier">Fichier *</label>
        <p class="aide">PDF, HTML, PNG ou JPEG, 25 Mo au maximum. Le type est lu dans le contenu.</p>
        ${champFichier(".pdf,.html,.htm,.png,.jpg,.jpeg")}
        ${e.fichier
          ? html`
            <p class="erreur">${e.fichier}</p>
          `
          : ""}
      </div>
      <div class="deux">
        ${champ({
          nom: "type_document",
          label: "Type de document",
          requis: true,
          options: TYPES_DOCUMENT,
          valeur: c.type_document,
          erreur: e.type_document,
        })} ${champ({
          nom: "classe",
          label: "Classe",
          requis: true,
          options: CLASSES,
          valeur: c.classe,
          erreur: e.classe,
        })} ${champ({
          nom: "matiere",
          label: "Matière",
          requis: true,
          options: MATIERES,
          valeur: c.matiere,
          erreur: e.matiere,
        })} ${champ({
          nom: "sous_matiere",
          label: "Sous-matière",
          valeur: c.sous_matiere,
        })} ${champ({
          nom: "sequence",
          label: "Chapitre",
          valeur: c.sequence,
          aide: "Les élèves trouvent le document sous ce chapitre.",
        })} ${champ({ nom: "seance", label: "Séance", valeur: c.seance })}
      </div>
      ${champ({ nom: "resume", label: "Résumé", zone: true, valeur: c.resume })} ${champ({
        nom: "objectifs",
        label: "Objectifs pédagogiques",
        zone: true,
        valeur: c.objectifs,
      })} ${champ({ nom: "evaluation", label: "Évaluation", valeur: c.evaluation })}
      <fieldset>
        <legend><strong>Confidentialité</strong></legend>
        ${PUBLICS.map((p) =>
          html`
            <label><input type="checkbox" name="publics" value="${p
              .value}" ${publics.includes(p.value) ? "checked" : ""}> ${p.label}</label>
          `
        )}
      </fieldset>
      <button class="principal">Déposer</button>
    </form>
  `;
};

export type Detail = {
  source: {
    id: string;
    titre: string;
    statut: string;
    format: string;
    fichier: string;
    statut_par: string | null;
    statut_le: string | null;
    enseignant: string;
    cree_le: string;
  };
  meta: Record<string, unknown>;
  job: { etat: string; erreur: string | null; avertissements: string[] } | undefined;
  images: ImageVue[];
  blocs: Bloc[];
};

export type ImageVue = {
  id: string;
  legende: string | null;
  legende_statut: string;
  legende_origine: string | null;
  modele: string | null;
};

export const statutSource = (s: Detail["source"]) =>
  html`
    <div id="statut-source" class="barre">
      <span class="statut ${s.statut}">${STATUTS[s.statut]}</span>
      ${s.statut_par
        ? html`
          <small>par ${s.statut_par}, le ${s.statut_le ? jour(s.statut_le) : ""}</small>
        `
        : ""}
      <span class="espace"></span>
      ${s.statut !== "certifiee"
        ? html`
          <button
            class="principal"
            hx-post="/prof/sources/${s.id}/certifiee"
            hx-target="#statut-source"
            hx-swap="outerHTML"
          >
            Certifier la source
          </button>
        `
        : ""} ${s.statut !== "rejetee"
        ? html`
          <button
            hx-post="/prof/sources/${s.id}/rejetee"
            hx-target="#statut-source"
            hx-swap="outerHTML"
            hx-confirm="Rejeter cette source ? Les élèves ne la verront plus."
          >
            Rejeter
          </button>
        `
        : ""}
    </div>
  `;

export const detailSource = (d: Detail) =>
  html`
    <p><a href="/prof">Sources</a></p>
    <h1>${d.source.titre}</h1>
    <p class="discret">${d.meta.sequence ?? ""} ${d.meta.seance ? `· ${d.meta.seance}` : ""} · ${d
      .source.format} · ${d.source.fichier}</p>
    <p class="discret">Déposé par ${d.source.enseignant} le ${jour(d.source.cree_le)}</p>
    <form method="post" action="/prof/sources/${d.source
      .id}/modifier" class="etroit edition-source">
      <h2>Modifier les informations</h2>
      <div class="deux">
        ${champ({ nom: "titre", label: "Titre", valeur: d.source.titre, requis: true })}
        ${champ({ nom: "sequence", label: "Chapitre", valeur: String(d.meta.sequence ?? "") })}
        ${champ({ nom: "date", label: "Date de l'œuvre", valeur: String(d.meta.date ?? "") })}
        ${champ({
          nom: "quiz_reponse",
          label: "Artiste ou mouvement pour le quiz",
          valeur: String(d.meta.quiz_reponse ?? ""),
        })}
      </div>
      <button>Enregistrer</button>
    </form>
    ${statutSource(d.source)}
    <p class="discret">
      Certifier la source la rend disponible selon les publics choisis au dépôt. Les légendes d'images
      se relisent à part : une légende non relue n'est jamais citée.
    </p>
    ${d.job?.etat === "failed"
      ? html`
        <p role="alert">Le traitement a échoué : ${d.job.erreur}</p>
      `
      : d.job && JOBS_ACTIFS.includes(d.job.etat)
      ? html`
        <p
          class="note"
          hx-get="/prof/sources/${d.source.id}"
          hx-trigger="every 3s"
          hx-select="main"
          hx-target="main"
          hx-swap="outerHTML"
        >
          Traitement en cours : ${ETATS_JOB[d.job.etat]}.
        </p>
      `
      : ""} ${d.job?.avertissements.length
      ? html`
        <div class="alerte"><strong>Avertissements</strong><ul>${d.job.avertissements.map((a) =>
          html`
            <li>${a}</li>
          `
        )}</ul></div>
      `
      : ""} ${d.images.length
      ? html`
        <h2>Images</h2>${d.images.map((i) =>
          html`
            <figure>
              <img src="/media/${i.id}" alt="Image de ${d.source.titre}" loading="lazy">
              <figcaption>
                <span class="statut ${i.legende_statut}">${LEGENDES[i.legende_statut]}</span>
                ${i.legende ?? "Pas de légende."} ${i.legende_statut === "unreviewed"
                  ? html`
                    <a href="/prof/legendes?image=${i.id}">Relire</a>
                  `
                  : ""}
              </figcaption>
            </figure>
          `
        )}
      `
      : ""}
    <h2>Texte extrait</h2>
    <div class="document">${texteDocument(d.blocs)}</div>
  `;

const LEGENDES: Record<string, string> = {
  unreviewed: "non relue",
  certified: "certifiée",
  rejected: "rejetée",
};

export type ALegender = ImageVue & { source_id: string; titre: string; restantes: number };

export const legende = (i: ALegender | undefined, file: { id: string; titre: string }[] = []) =>
  i
    ? html`
      <div id="legende" class="relecture">
        <nav class="file" aria-label="Légendes à relire">
          <p><strong>${i.restantes}</strong> légende${i.restantes > 1 ? "s" : ""} à relire</p>
          <ol>${file.map((f) =>
            html`
              <li><a href="/prof/legendes?image=${f.id}" aria-current="${String(
                f.id === i.id,
              )}">${f.titre}</a></li>
            `
          )}</ol>
        </nav>
        <figure class="relecture-image">
          <img src="/media/${i.id}" alt="Image à légender de ${i.titre}">
        </figure>
        <form
          class="relecture-proposition"
          hx-target="#legende"
          hx-swap="outerHTML"
          hx-disabled-elt="find button"
        >
          <p><a href="/prof/sources/${i.source_id}">${i.titre}</a></p>
          <p class="discret">
            Légende proposée automatiquement. Seule une légende validée peut être citée à un élève.
          </p>
          <label for="texte">Légende</label>
          <textarea id="texte" name="texte" rows="7">${i.legende ?? ""}</textarea>
          <input type="hidden" name="image" value="${i.id}">
          <div class="barre">
            <button class="principal" hx-post="/prof/legendes/certified"
              data-raccourci="v">${icone("check")}Valider (V)</button>
            <button class="espace" hx-post="/prof/legendes/rejected"
              data-raccourci="r">${icone(
                "x",
              )}Rejeter (R)</button>
          </div>
        </form>
      </div>
    `
    : html`
      <p id="legende">Toutes les légendes sont relues.</p>
    `;

export const pageLegendes = (i: ALegender | undefined, file: { id: string; titre: string }[]) =>
  html`
    <h1>Relire les légendes</h1>
    <p class="raccourcis discret">
      <kbd>V</kbd> valider, <kbd>E</kbd> éditer, <kbd>R</kbd> rejeter,
      <kbd>↑</kbd> <kbd>↓</kbd> image précédente ou suivante
    </p>
    ${legende(i, file)}
  `;
