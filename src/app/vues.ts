import { html } from "hono/html";
import type { Bloc } from "../core/document.ts";
import type { Affirmation, Resultat } from "../core/reponse.ts";
import type { Compte } from "./comptes.ts";
import { CLASSES, MATIERES, PUBLICS, TYPES_DOCUMENT } from "./depot.ts";

type Option = { value: string; label: string };

export const page = (titre: string, compte: Compte | null, corps: unknown, classe = "") =>
  html`
    <!DOCTYPE html>
    <html lang="fr">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${titre} · Thot</title>
        <link rel="stylesheet" href="/static/style.css">
        <script src="/static/vendor/htmx.min.js" defer></script>
        <script src="/static/vendor/htmx-ext-sse.js" defer></script>
      </head>
      <body
        hx-on::before-request="document.getElementById('erreur-reseau').hidden = true"
        hx-on::response-error="document.getElementById('erreur-reseau').hidden = false"
        hx-on::send-error="document.getElementById('erreur-reseau').hidden = false"
      >
        <header class="site">
          <a class="marque" href="/">Thot</a>
          ${compte ? nav(compte) : ""}
        </header>
        <main class="${classe}">
          <p id="erreur-reseau" role="alert" hidden>
            L'action n'a pas abouti. Votre saisie est conservée, réessayez.
          </p>
          ${corps}
        </main>
      </body>
    </html>
  `;

const nav = (c: Compte) =>
  html`
    <nav aria-label="Navigation principale">
      ${c.role === "enseignant"
        ? html`
          <a href="/prof">Sources</a><a href="/prof/depot">Déposer</a><a href="/prof/legendes">Légendes</a><a
            href="/eleve"
          >Vue élève</a>
        `
        : html`
          <a href="/eleve">Chapitres</a><a href="/eleve/chat">Poser une question</a>
        `}
      <span class="discret">${c.nom}</span>
      <form method="post" action="/deconnexion"><button class="lien">Se déconnecter</button></form>
    </nav>
  `;

export const connexion = (erreur?: string, identifiant = "") =>
  html`
    <form method="post" action="/connexion" class="etroit" style="max-width: 24rem">
      <h1>Connexion</h1>
      ${erreur
        ? html`
          <p role="alert">${erreur}</p>
        `
        : ""}
      <div class="champ">
        <label for="identifiant">Identifiant</label>
        <input
          type="text"
          id="identifiant"
          name="identifiant"
          value="${identifiant}"
          autocomplete="username"
          required
          autofocus
        >
      </div>
      <div class="champ">
        <label for="mot_de_passe">Mot de passe</label>
        <input
          type="password"
          id="mot_de_passe"
          name="mot_de_passe"
          autocomplete="current-password"
          required
        >
      </div>
      <button class="principal">Se connecter</button>
    </form>
  `;

// ---------------------------------------------------------------- enseignant

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
            <td><span class="statut ${l.etat === "failed"
              ? "failed"
              : JOBS_ACTIFS.includes(l.etat)
              ? "en-cours"
              : ""}">${ETATS_JOB[l.etat] ?? l.etat}</span></td>
            <td><span class="statut ${l.statut}">${STATUTS[l.statut] ?? l.statut}</span></td>
            <td class="statut unreviewed">${l.images_a_relire
              ? `${l.images_a_relire} non relue${l.images_a_relire > 1 ? "s" : ""}`
              : ""}</td>
          </tr>
        `
      )}
    </tbody>
  `;
};

export const sources = (lignes: LigneSource[], filtre: string, compteurs: Record<string, number>) =>
  html`
    <h1>Sources</h1>
    <div class="barre">
      ${[["", "Toutes"], ["a_relire", "À relire"], ["certifiee", "Certifiées"], [
        "rejetee",
        "Rejetées",
      ]].map(
        ([v, l]) =>
          v === filtre
            ? html`
              <strong>${l} (${compteurs[v] ?? 0})</strong>
            `
            : html`
              <a href="/prof${v ? `?statut=${v}` : ""}">${l} (${compteurs[v] ?? 0})</a>
            `,
      )}
      <a class="bouton espace" href="/prof/depot">Déposer un document</a>
    </div>
    ${lignes.length
      ? html`
        <form method="post" action="/prof/sources/statut">
          <div class="barre">
            <label style="font-weight:400;display:flex;gap:.5rem;align-items:center;margin:0">
              <input
                type="checkbox"
                onclick="this.form.querySelectorAll('[name=ids]').forEach(c => c.checked = this.checked)"
              > Tout sélectionner</label>
            <button name="statut" value="certifiee">Certifier la sélection</button>
            <button name="statut" value="rejetee">Rejeter la sélection</button>
          </div>
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Document</th>
                <th>Traitement</th>
                <th>Statut</th>
                <th>Légendes</th>
              </tr>
            </thead>
            ${lignesSources(lignes, filtre ? `statut=${filtre}` : "")}
          </table>
        </form>
      `
      : html`
        <p>Aucun document. <a href="/prof/depot">Déposer le premier</a>.</p>
      `}
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
  const publics = s.publics ?? PUBLICS.map((p) => p.value);
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
        <input
          type="file"
          id="fichier"
          name="fichier"
          accept=".pdf,.html,.htm,.png,.jpg,.jpeg"
          required
        >
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
          label: "Séquence",
          valeur: c.sequence,
          aide: "Le chapitre sous lequel les élèves le trouveront.",
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
          <small>par ${s.statut_par}, ${s.statut_le}</small>
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
          <button hx-post="/prof/sources/${s
            .id}/rejetee" hx-target="#statut-source" hx-swap="outerHTML">
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
    <p class="discret">Déposé par ${d.source.enseignant} le ${d.source.cree_le.slice(0, 10)}</p>
    ${statutSource(d.source)}
    <p class="discret">
      Certifier la source l'ouvre aux élèves. Les légendes d'images se relisent à part: une légende non
      relue aide la recherche mais n'est jamais citée.
    </p>
    ${d.job?.etat === "failed"
      ? html`
        <p role="alert">Le traitement a échoué: ${d.job.erreur}</p>
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
          Traitement en cours: ${ETATS_JOB[d.job.etat]}.
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
              <img src="/media/${i.id}" alt="" loading="lazy">
              <figcaption>
                <span class="statut ${i.legende_statut}">${LEGENDES[i.legende_statut]}</span>
                ${i.legende ?? "Pas de légende."} ${i.modele
                  ? html`
                    <small>(${i.legende_origine}, ${i.modele})</small>
                  `
                  : ""} ${i.legende_statut === "unreviewed"
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

/** Blocs du document, avec intertitres et passage surligné entre `debut` et `fin`. */
export const texteDocument = (blocs: Bloc[], marque?: [number, number]) => {
  let section = "";
  return blocs.map((b) => {
    const titre = b.section !== section && b.texte !== b.section
      ? html`
        <h3>${b.section}</h3>
      `
      : "";
    section = b.section;
    const t = Array.from(b.texte);
    if (marque && marque[0] < b.fin && marque[1] > b.debut) {
      const a = Math.max(0, marque[0] - b.debut);
      const z = Math.min(t.length, marque[1] - b.debut);
      return html`
        ${titre}<p id="${b.id}">${t.slice(0, a).join("")}<mark id="passage">${t.slice(a, z).join(
          "",
        )}</mark>${t.slice(z).join("")}</p>
      `;
    }
    return b.texte === b.section
      ? html`
        <h3 id="${b.id}">${b.texte}</h3>
      `
      : html`
        ${titre}<p id="${b.id}">${b.texte}</p>
      `;
  });
};

export type ALegender = ImageVue & { source_id: string; titre: string; restantes: number };

const touche = (k: string) =>
  `click, keyup[key=='${k}' && !event.target.matches('input,textarea,select')] from:body`;

export const legende = (i: ALegender | undefined) =>
  i
    ? html`
      <form
        id="legende"
        class="legende"
        hx-target="#legende"
        hx-swap="outerHTML"
        hx-disabled-elt="find button"
      >
        <div><img src="/media/${i.id}" alt="Image à légender de ${i.titre}"></div>
        <div>
          <p><strong>${i.restantes}</strong> légende${i.restantes > 1 ? "s" : ""} à relire</p>
          <p><a href="/prof/sources/${i.source_id}">${i.titre}</a></p>
          <p class="discret">
            Proposée par ${i.modele ??
              "personne"}. Corrigez le texte si besoin, puis validez. Seule une légende validée
            peut être citée à un élève.
          </p>
          <label for="texte">Légende</label>
          <textarea id="texte" name="texte" rows="7">${i.legende ?? ""}</textarea>
          <input type="hidden" name="image" value="${i.id}">
          <div class="barre" style="margin-top:.75rem">
            <button class="principal" hx-post="/prof/legendes/certified" hx-trigger="${touche(
              "v",
            )}">
              Valider (V)
            </button>
            <button hx-post="/prof/legendes/rejected" hx-trigger="${touche(
              "r",
            )}">Rejeter (R)</button>
            <button type="button" onclick="document.getElementById('texte').focus()">Éditer (E)</button>
          </div>
        </div>
      </form>
    `
    : html`
      <p id="legende">Toutes les légendes sont relues.</p>
    `;

/** La touche E place le curseur dans la légende. V et R passent par `hx-trigger`. */
export const raccourciEdition = html`
  <script>
  document.addEventListener("keyup", (e) => {
    if (e.key === "e" && !e.target.matches("input,textarea,select")) document.getElementById("texte")?.focus();
  });
  </script>
`;

// ---------------------------------------------------------------- élève

export type ChapitreVue = {
  nom: string;
  sources: { id: string; titre: string; seance: string }[];
  questions: string[];
};

export type FaitVue = {
  phrase: string;
  titre: string;
  source_id: string;
  debut: number;
  fin: number;
};

/** Une question proposée: un bouton qui l'envoie telle quelle, sans passer par la saisie. */
const idee = (q: string, htmx: boolean, libelle = q) =>
  htmx
    ? html`
      <button
        type="button"
        class="idee"
        hx-post="/eleve/questions"
        hx-vals="${JSON.stringify({ texte: q })}"
        hx-target="#conversation"
        hx-swap="beforeend"
        hx-on::after-request="if (event.detail.successful) this.remove()"
      >${libelle}</button>
    `
    : html`
      <form method="post" action="/eleve/questions" class="idee-form">
        <input type="hidden" name="texte" value="${q}"><button class="idee">${libelle}</button>
      </form>
    `;

const nomChapitre = (nom: string) => nom.replace(/^ATC\s+/, "");

export const accueilEleve = (prenom: string, chapitres: ChapitreVue[], fait?: FaitVue) =>
  html`
    <h1>Bonjour ${prenom}</h1>
    <form method="post" action="/eleve/questions" class="question-rapide">
      <label for="texte">Une question sur le cours ?</label>
      <div class="barre">
        <input type="text" id="texte" name="texte" required maxlength="1000"
          placeholder="Par exemple : pourquoi Mondrian n'utilise que trois couleurs ?">
        <button class="principal">Demander</button>
      </div>
    </form>
    ${fait
      ? html`
        <section class="saviez-vous" aria-labelledby="saviez-vous">
          <h2 id="saviez-vous">Le saviez-vous ?</h2>
          <blockquote>${fait.phrase}</blockquote>
          <p class="discret">
            Tiré de « ${fait.titre} ».
            <a href="/eleve/sources/${fait.source_id}?debut=${fait.debut}&fin=${fait.fin}#passage"
            >Lire le passage</a>
          </p>
          ${idee(`Explique-moi : ${fait.phrase}`, false, "M'en dire plus")}
        </section>
      `
      : ""}
    ${chapitres.length
      ? html`
        <div class="chapitres">${chapitres.map((c) =>
          html`
            <section class="chapitre">
              <h2>Réviser ${nomChapitre(c.nom)}</h2>
              ${c.questions.length
                ? html`
                  <div class="idees">${c.questions.map((q) => idee(q, false))}</div>
                `
                : ""}
              <details>
                <summary>${c.sources.length} document${c.sources.length > 1
                  ? "s"
                  : ""} du chapitre</summary>
                <ul>${c.sources.map((s) =>
                  html`
                    <li><a href="/eleve/sources/${s.id}">${s.titre}</a></li>
                  `
                )}</ul>
              </details>
            </section>
          `
        )}</div>
      `
      : html`
        <p>Aucun document n'est encore publié par tes enseignants.</p>
      `}
  `;

export const lectureSource = (
  s: { titre: string; sequence: string },
  images: { id: string; legende: string | null }[],
  blocs: Bloc[],
  marque?: [number, number],
) =>
  html`
    <p><a href="/eleve">Chapitres</a> · ${s.sequence}</p>
    <article class="document">
      <h1>${s.titre}</h1>
      ${images.map((i) =>
        html`
          <figure><img src="/media/${i.id}" alt="${i.legende ?? ""}">${i.legende
            ? html`
              <figcaption>${i.legende}</figcaption>
            `
            : ""}</figure>
        `
      )} ${texteDocument(blocs.filter((b, n) => !(n === 0 && b.texte === s.titre)), marque)}
    </article>
  `;

export const question = (texte: string) =>
  html`
    <p class="question">${texte}</p>
  `;

/** Réponse en attente: l'extension SSE la remplace par l'événement « reponse ». */
export const attente = (id: string) =>
  html`
    <article
      class="reponse"
      hx-ext="sse"
      sse-connect="/eleve/messages/${id}/flux"
      sse-swap="reponse"
      hx-swap="outerHTML"
    >
      <p class="etape" sse-swap="etape" hx-swap="innerHTML" role="status">Envoi de la question</p>
    </article>
  `;

export const reponse = (id: string, r: Resultat) => {
  if (r.etat === "answered") {
    return html`
      <article class="reponse" id="reponse-${id}">${r.affirmations.map((
        a: Affirmation,
        n: number,
      ) =>
        html`
          <span>${a.texte}</span><button
            class="citation"
            aria-pressed="false"
            aria-label="Source ${n + 1}: ${a.titre}"
            hx-get="/eleve/messages/${id}/citations/${n}"
            hx-target="#source"
            hx-swap="outerHTML"
            hx-sync="#source:replace"
            hx-on::after-request="document.querySelectorAll('.citation').forEach(b => b.setAttribute('aria-pressed', b === this)); if (innerWidth < 900) document.getElementById('source').scrollIntoView({ behavior: 'smooth' })"
          >
            ${n + 1}
          </button>
        `
      )}</article>
    `;
  }
  if (r.etat === "out_of_corpus") {
    return html`
      <article class="reponse hors-corpus" id="reponse-${id}">
        <p><strong>Je ne trouve pas la réponse dans les documents du cours.</strong></p>
        <p>
          Aucun passage publié par tes enseignants ne répond à cette question. Reformule-la avec d'autres
          mots, ou pose-la à ton professeur.
        </p>
      </article>
    `;
  }
  return html`
    <article class="reponse panne" id="reponse-${id}">
      <p><strong>Thot n'a pas pu répondre, à cause d'une panne technique.</strong></p>
      <p>Ce n'est pas une limite du cours. Ta question est conservée.</p>
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
    avant?: string;
    milieu?: string;
    apres?: string;
  },
) =>
  a
    ? html`
      <aside id="source" aria-live="polite">
        <h2>${a.titre}</h2>
        ${a.milieu !== undefined
          ? html`
            <blockquote
              class="passage">${a.avant?.length ? "… " : ""}${a.avant}<mark>${a.milieu}</mark>${a
                .apres}${a.apres?.length ? " …" : ""}</blockquote>
          `
          : html`
            <p class="discret">Légende d'image relue par l'enseignant :</p>
            <blockquote>
              <mark>${a.citation}</mark>
            </blockquote>
          `}
        <a href="/eleve/sources/${a.source_id}${a.debut !== undefined
          ? `?debut=${a.debut}&fin=${a.fin}#passage`
          : ""}">Ouvrir le document</a>
      </aside>
    `
    : html`
      <aside id="source">
        <p class="discret">
          Les numéros dans une réponse ouvrent ici le passage du cours qui la justifie.
        </p>
      </aside>
    `;

export const chat = (
  messages: { id: string; question: string; etat: string; resultat: string | null }[],
  idees: string[] = [],
) =>
  html`
    <h1>Poser une question</h1>
    <div class="chat">
      <section aria-label="Conversation">
        <div
          id="conversation"
          hx-on::after-settle="this.scrollTop = this.scrollHeight"
          hx-on:htmx:sse-message="this.scrollTop = this.scrollHeight"
        >
          ${messages.map((m) =>
            html`
              ${question(m.question)}${m.resultat
                ? reponse(m.id, JSON.parse(m.resultat))
                : attente(m.id)}
            `
          )}
        </div>
        <form
          class="question-form"
          hx-post="/eleve/questions"
          hx-target="#conversation"
          hx-swap="beforeend"
          hx-disabled-elt="find button"
          hx-on::after-request="if (event.detail.successful) this.reset()"
        >
          <label for="texte">Ta question</label>
          <textarea
            id="texte"
            name="texte"
            required
            maxlength="1000"
            onkeydown="if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); this.form.requestSubmit(); }"
          ></textarea>
          <div class="barre" style="margin-top:.5rem">
            <button class="principal">Envoyer</button>
            <small>Thot répond seulement avec les documents publiés par tes enseignants.</small>
          </div>
        </form>
        ${idees.length
          ? html`
            <section class="idees" aria-label="Idées de questions">
              <h2>${messages.length ? "Autres idées" : "Tu ne sais pas par où commencer ?"}</h2>
              ${idees.map((q) => idee(q, true))}
            </section>
          `
          : ""}
      </section>
      ${panneauSource()}
    </div>
  `;
