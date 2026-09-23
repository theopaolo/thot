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
        <script>
          document.addEventListener('DOMContentLoaded', () => { htmx.config.globalViewTransitions = true; });
          document.addEventListener('keydown', (e) => {
            if (e.key === '/' && !e.target.matches('input,textarea,select,[contenteditable]')) {
              const box = document.getElementById('texte');
              if (box) { e.preventDefault(); box.focus(); }
            }
          });
        </script>
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
    <nav aria-label="Navigation principale" hx-boost="true">
      ${c.role === "enseignant"
        ? html`
          <a href="/prof">Sources</a><a href="/prof/depot">Déposer</a><a href="/prof/legendes">Légendes</a><a
            href="/prof/eleves">Élèves</a><a href="/prof/questions">Questions</a><a
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
      <input id="fichier" name="fichier" type="file" accept=".csv,text/csv" required>
      <button class="principal">Importer et afficher les mots de passe</button>
    </form>
    ${liste.length
      ? html`
        <table>
          <thead>
            <tr>
              <th>Nom</th>
              <th>Identifiant</th>
              <th></th>
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
      class="barre sans-impression"><h1>Identifiants à remettre</h1><span class="espace"></span><button onclick="window.print()">Imprimer</button></div>
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
  avis: string | null;
  cree_le: string;
  nom: string;
  chapitre: string;
};

export const questionsProf = (messages: QuestionProf[]) => {
  const groupes = Map.groupBy(messages, (m) => m.chapitre || "Sans chapitre");
  return html`
    <h1>Questions des élèves</h1>
    <p
      class="discret">Les refus peuvent signaler un point à couvrir ou à mieux relier au cours. Les réponses marquées « fausse » sont à vérifier.</p>
    ${messages.length
      ? [...groupes].map(([chapitre, lignes]) =>
        html`
          <section class="questions-prof">
            <h2>${chapitre}</h2>
            <table>
              <thead>
                <tr>
                  <th>Question</th>
                  <th>État</th>
                  <th>Avis</th>
                  <th>Élève</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
              ${lignes.map((m) =>
                html`
                  <tr>
                    <td>${m.question}</td>
                    <td>${m.etat === "out_of_corpus"
                      ? "Hors cours"
                      : m.etat === "answered"
                      ? "Répondue"
                      : m.etat === "failed"
                      ? "Panne"
                      : "En cours"}</td>
                    <td>${m.avis === "faux"
                      ? "Fausse"
                      : m.avis === "confus"
                      ? "Peu claire"
                      : m.avis === "utile"
                      ? "Utile"
                      : ""}</td>
                    <td>${m.nom}</td>
                    <td>${m.cree_le.slice(0, 10)}</td>
                  </tr>
                `
              )}
            </tbody>
            </table>
          </section>
        `
      )
      : html`<p>Aucune question posée pour le moment.</p>`}
  `;
};

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
  sources: SourceChapitre[];
  questions: string[];
};

export type SourceChapitre = {
  id: string;
  titre: string;
  sequence?: string;
  seance: string;
  date: string;
  quiz_reponse: string;
  image_id: string | null;
};

export type FaitVue = {
  phrase: string;
  titre: string;
  source_id: string;
  debut: number;
  fin: number;
};

/** Une question proposée: un bouton qui l'envoie telle quelle, sans passer par la saisie. */
const idee = (q: string, htmx: boolean, libelle = q, chapitre = "") =>
  htmx
    ? html`
      <button
        type="button"
        class="idee"
        hx-post="/eleve/questions"
        hx-vals="${JSON.stringify({ texte: q, chapitre })}"
        hx-target="#conversation"
        hx-swap="beforeend"
        hx-on::after-request="if (event.detail.successful) this.remove()"
      >${libelle}</button>
    `
    : html`
      <form method="post" action="/eleve/questions" class="idee-form">
        <input type="hidden" name="texte" value="${q}"><input type="hidden" name="chapitre" value="${chapitre}"><button class="idee">${libelle}</button>
      </form>
    `;

const nomChapitre = (nom: string) => nom.replace(/^ATC\s+/, "");

export const accueilEleve = (
  prenom: string,
  chapitres: ChapitreVue[],
  fait?: FaitVue,
  oeuvre?: SourceChapitre,
) =>
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
    ${oeuvre
      ? html`<section class="saviez-vous oeuvre-du-jour" aria-labelledby="saviez-vous">
        <h2 id="saviez-vous">Le saviez-vous ?</h2>
        <a href="/eleve/sources/${oeuvre.id}"><img src="/media/${oeuvre.image_id}" alt="${oeuvre.titre}" loading="lazy"></a>
        <p><strong>${oeuvre.titre}</strong>${oeuvre.date ? ` · ${oeuvre.date}` : ""}</p>
        ${
        idee(
          `Qu'est-ce que tu sais de cette œuvre : ${oeuvre.titre} ?`,
          false,
          "Qu'est-ce que tu sais de cette œuvre ?",
        )
      }
      </section>`
      : fait
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
              <h2><a href="/eleve/chapitres/${encodeURIComponent(
                c.nom === "Sans chapitre" ? "" : c.nom,
              )}">Réviser ${nomChapitre(c.nom)}</a></h2>
              ${c.questions.length
                ? html`
                  <div class="idees">${c.questions.map((q) =>
                    idee(q, false, q, c.nom === "Sans chapitre" ? "" : c.nom)
                  )}</div>
                `
                : ""}
              <div class="apercu-oeuvres">${c.sources.filter((s) => s.image_id).slice(0, 4).map((
                s,
              ) =>
                html`
                  <a
                    href="/eleve/sources/${s.id}"><img src="/media/${s.image_id}" alt="${s
                      .titre}" loading="lazy"></a>
                `
              )}</div>
              <a href="/eleve/chapitres/${encodeURIComponent(
                c.nom === "Sans chapitre" ? "" : c.nom,
              )}">Voir les ${c.sources.length} documents</a>
            </section>
          `
        )}</div>
      `
      : html`
        <p>Aucun document n'est encore publié par tes enseignants.</p>
      `}
  `;

export const pageChapitre = (nom: string, sources: SourceChapitre[], questions: string[]) => {
  const oeuvre = sources.find((s) => s.image_id && s.quiz_reponse);
  return html`
    <p><a href="/eleve">Chapitres</a></p>
    <h1>${nomChapitre(nom || "Sans chapitre")}</h1>
    <form method="post" action="/eleve/questions" class="question-rapide">
      <label for="texte">Une question sur ce chapitre ?</label>
      <div
        class="barre"><input type="text" id="texte" name="texte" required maxlength="1000" placeholder="Pose ta question">
        <input type="hidden" name="chapitre" value="${nom}"><button class="principal">Demander</button></div>
    </form>
    ${questions.length
      ? html`<div class="idees">${questions.map((q) => idee(q, false, q, nom))}</div>`
      : ""}
    <h2>Œuvres et documents</h2>
    <div class="galerie">${sources.map((s) =>
      html`
        <a class="oeuvre" href="/eleve/sources/${s.id}">
          ${s.image_id
            ? html`<img src="/media/${s.image_id}" alt="" loading="lazy">`
            : html`<span class="sans-image">Document</span>`}
          <strong>${s.titre}</strong>${s.date ? html`<small>${s.date}</small>` : ""}
        </a>
      `
    )}</div>
    ${oeuvre
      ? html`
        <section class="quiz">
          <h2>Quelle œuvre est-ce ?</h2>
          <img src="/media/${oeuvre.image_id}" alt="Œuvre à identifier" loading="lazy">
          <label for="quiz-reponse">Quel artiste ou mouvement ?</label>
          <div
            class="barre"><input id="quiz-reponse" type="text" autocomplete="off"><button type="button" data-answer="${oeuvre
              .quiz_reponse}" onclick="const r=this.previousElementSibling.value.trim().toLocaleLowerCase('fr').normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');const a=this.dataset.answer.toLocaleLowerCase('fr').normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');document.getElementById('quiz-resultat').textContent=r && r===a ? 'Bravo !' : 'Réponse : '+this.dataset.answer">Vérifier</button></div>
          <p id="quiz-resultat" role="status"></p>
        </section>
      `
      : ""}
  `;
};

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

export const avis = (id: string, choix: string | null) =>
  html`
    <div id="avis-${id}" class="avis" aria-label="Avis sur la réponse">
      <span>Cette réponse est-elle utile ?</span>
      ${[["utile", "Utile"], ["confus", "Peu claire"], ["faux", "Fausse"]].map((
        [valeur, libelle],
      ) =>
        html`
          <button type="button" aria-pressed="${String(
            choix === valeur,
          )}" name="avis" value="${valeur}"
            hx-post="/eleve/messages/${id}/avis" hx-include="this" hx-target="#avis-${id}"
            hx-swap="outerHTML">${libelle}</button>
        `
      )}
    </div>
  `;

export const reponse = (
  id: string,
  r: Resultat,
  choix: string | null = null,
  idees: string[] = [],
  auto = false,
) => {
  if (r.etat === "answered") {
    const sources = [...new Map(r.affirmations.map((a) => [a.source_id, a.titre])).entries()];
    return html`
      <article class="reponse" id="reponse-${id}"><div class="texte-reponse">${r.affirmations.map((
        a: Affirmation,
        n: number,
      ) =>
        html`
          <span>${a.texte}</span><button
            class="citation"
            aria-pressed="${String(auto && n === 0)}"
            aria-label="Source ${n + 1}: ${a.titre}"
            hx-get="/eleve/messages/${id}/citations/${n}"
            hx-trigger="${auto && n === 0 ? "click, load" : "click"}"
            hx-target="#source"
            hx-swap="outerHTML"
            hx-sync="#source:replace"
            hx-on::after-request="document.querySelectorAll('.citation').forEach(b => b.setAttribute('aria-pressed', b === this))"
            onclick="if (innerWidth < 900) setTimeout(() => document.getElementById('source').scrollIntoView({ behavior: 'smooth' }), 100)"
          >
            ${n + 1}
          </button>
        `
      )}</div>
      ${[...new Map(r.affirmations.filter((a) => a.image_id).map((a) => [a.image_id, a])).values()]
        .map((a) =>
          html`
            <a
              href="/eleve/sources/${a.source_id}"><img class="image-reponse" src="/media/${a
                .image_id}" alt="${a.titre}" loading="lazy"></a>
          `
        )}
      <p class="provenance">Sources : ${sources.map(([sourceId, titre], n) =>
        html`${n ? ", " : ""}<a href="/eleve/sources/${sourceId}">${titre}</a>`
      )}</p>
      ${avis(id, choix)}
      ${idees.length
        ? html`<div class="idees-reponse"><strong>Pour continuer</strong>${
          idees.map((q) => idee(q, true))
        }</div>`
        : ""}
      </article>
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

export type MessageVue = {
  id: string;
  question: string;
  etat: string;
  resultat: string | null;
  avis: string | null;
};

export const chat = (
  messages: MessageVue[],
  idees: string[] = [],
) =>
  html`
    <h1>Poser une question</h1>
    <div class="chat">
      <section class="chat-principal" aria-label="Conversation">
        <div
          id="conversation"
          hx-on::after-settle="this.scrollTop = this.scrollHeight"
          hx-on:htmx:sse-message="this.scrollTop = this.scrollHeight"
        >
          ${messages.map((m, i) =>
            html`
              ${question(m.question)}${m.resultat
                ? reponse(
                  m.id,
                  JSON.parse(m.resultat),
                  m.avis,
                  i === messages.length - 1 ? idees : [],
                  i === messages.length - 1,
                )
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
            onkeydown="if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.form.requestSubmit(); }"
          ></textarea>
          <div class="barre" style="margin-top:.5rem">
            <button class="principal">Envoyer</button>
            <small>Thot répond seulement avec les documents publiés par tes enseignants.</small>
          </div>
        </form>
      </section>
      ${panneauSource()}
    </div>
  `;
