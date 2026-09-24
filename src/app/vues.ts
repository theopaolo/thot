import { html, raw } from "hono/html";
import type { Bloc } from "../core/document.ts";
import type { Affirmation, Resultat } from "../core/reponse.ts";
import type { Compte } from "./comptes.ts";
import { CLASSES, MATIERES, PUBLICS, PUBLICS_PAR_DEFAUT, TYPES_DOCUMENT } from "./depot.ts";
import { type Icone, icone } from "./icones.ts";

type Option = { value: string; label: string };

export const page = (
  titre: string,
  compte: Compte | null,
  corps: unknown,
  classe = "",
  chemin = "",
) => {
  const prof = chemin.startsWith("/prof");
  return html`
    <!DOCTYPE html>
    <html lang="fr">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${titre} · Thot</title>
        <link rel="stylesheet" href="/static/style.css">
        <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
        <script src="/static/vendor/htmx.min.js" defer></script>
        <script src="/static/vendor/htmx-ext-sse.js" defer></script>
        <script>
          document.addEventListener('DOMContentLoaded', () => { htmx.config.globalViewTransitions = true; });
          addEventListener('load', () => {
            const conversation = document.getElementById('conversation');
            if (conversation) suivreConversation(conversation);
          });
          document.addEventListener('keydown', (e) => {
            if (e.key === '/' && !e.target.matches('input,textarea,select,[contenteditable]')) {
              const box = document.getElementById('texte');
              if (box) { e.preventDefault(); box.focus(); }
            }
            if (e.key === 'Escape') {
              const menu = document.querySelector('details.compte[open]');
              if (menu) { menu.open = false; menu.querySelector('summary').focus(); }
              else fermerFeuille();
            }
          });
          // Sous 1180 px, le passage cité et l'œuvre choisie s'ouvrent en feuille basse:
          // la citation ou la vignette reste visible au-dessus.
          let focaliserFeuille = false;
          function ouvrirFeuille(declencheur) {
            // Sur écran large, la colonne ne s'annonce qu'après un clic: le chargement reste muet.
            if (innerWidth >= 1180) {
              declencheur.closest('[data-feuille]').querySelector('.colonne-source, .colonne-lecteur')
                ?.setAttribute('aria-live', 'polite');
              return;
            }
            declencheur.closest('[data-feuille]').classList.add('feuille-ouverte');
            focaliserFeuille = true;
            const calme = matchMedia('(prefers-reduced-motion: reduce)').matches;
            scrollBy({ top: declencheur.getBoundingClientRect().top - innerHeight * 0.2, behavior: calme ? 'auto' : 'smooth' });
          }
          function fermerFeuille() {
            const ouverte = document.querySelector('.feuille-ouverte');
            if (!ouverte) return;
            ouverte.classList.remove('feuille-ouverte');
            ouverte.querySelector('[aria-pressed="true"], [aria-current="true"]')?.focus({ preventScroll: true });
          }
          // Quiz d'œuvre: un mot entier de la réponse suffit (« Morris » pour « William Morris »).
          function verifierQuiz(bouton) {
            const plier = (t) => t.trim().toLocaleLowerCase('fr').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/\\s+/g, ' ');
            const r = plier(bouton.previousElementSibling.value);
            const a = plier(bouton.dataset.answer);
            const sortie = document.getElementById('quiz-resultat');
            if (!r) sortie.textContent = "Écris une réponse avant de vérifier.";
            else if (r === a || (r.length >= 4 && (' ' + a + ' ').includes(' ' + r + ' '))) sortie.textContent = "Bravo, c'est bien " + bouton.dataset.answer + ".";
            else sortie.textContent = "Pas tout à fait. La réponse attendue : " + bouton.dataset.answer + ".";
          }
          // Montre le dernier message: la conversation défile seule sur écran large, la page sur mobile.
          function suivreConversation(el) {
            el.scrollTop = el.scrollHeight;
            if (!document.querySelector('.feuille-ouverte')) scrollTo(0, document.body.scrollHeight);
          }
          document.addEventListener('htmx:afterSettle', () => {
            if (!focaliserFeuille) return;
            focaliserFeuille = false;
            document.querySelector('.feuille-ouverte .feuille [tabindex="-1"]')?.focus({ preventScroll: true });
          });
        </script>
      </head>
      <body
        class="${prof ? "prof" : "eleve"}"
        hx-on::before-request="document.getElementById('erreur-reseau').hidden = true"
        hx-on::response-error="document.getElementById('erreur-reseau').hidden = false"
        hx-on::send-error="document.getElementById('erreur-reseau').hidden = false"
      >
        <a class="evitement" href="#contenu">Aller au contenu</a>
        ${compte && prof ? rail(compte, chemin) : html`
          <header class="site">
            <a class="marque" href="/">Thot</a>
            ${compte ? navEleve(compte, chemin) : ""}
          </header>
        `}
        <main id="contenu" tabindex="-1" class="${classe}">
          <p id="erreur-reseau" role="alert" hidden>
            ${prof
              ? "L'action n'a pas abouti. Votre saisie est conservée, réessayez."
              : "L'action n'a pas abouti. Ta saisie est conservée, réessaie."}
          </p>
          ${corps}
        </main>
      </body>
    </html>
  `;
};

/** Lien de navigation: icône et libellé, jaune quand c'est la page en cours.
 * Entre espaces prof et élève, `boost` vaut false: hx-boost garde la classe du body. */
const lienNav = (href: string, libelle: unknown, nom: Icone, actuel: boolean, boost = true) =>
  html`<a href="${href}" aria-current="${actuel ? "page" : "false"}" hx-boost="${boost ? "true" : "false"}">${
    icone(nom)
  }<span>${libelle}</span></a>`;

const compteMenu = (c: Compte) =>
  html`
    <details class="compte">
      <summary>${c.nom}</summary>
      <form method="post" action="/deconnexion">
        <button class="lien">${icone("sign-out")}Se déconnecter</button>
      </form>
    </details>
  `;

const navEleve = (c: Compte, chemin: string) =>
  html`
    <nav aria-label="Navigation principale" hx-boost="true">
      ${lienNav(
        "/eleve",
        "Chapitres",
        "books",
        chemin === "/eleve" || chemin.startsWith("/eleve/chapitres") ||
          chemin.startsWith("/eleve/sources"),
      )}
      ${lienNav(
        "/eleve/chat",
        html`<span class="libelle-long">Poser une question</span><span class="libelle-court">Question</span>`,
        "chat-circle",
        chemin.startsWith("/eleve/chat"),
      )}
      ${c.role === "enseignant" ? lienNav("/prof", "Espace enseignant", "arrow-left", false, false) : ""}
      ${compteMenu(c)}
    </nav>
  `;

const rail = (c: Compte, chemin: string) =>
  html`
    <header class="rail">
      <a class="marque" href="/prof">Thot</a>
      <p class="discret">Espace enseignant</p>
      <nav aria-label="Navigation enseignant" hx-boost="true">
        ${lienNav(
          "/prof",
          "Sources",
          "file-text",
          chemin === "/prof" || chemin.startsWith("/prof/sources"),
        )}
        ${lienNav("/prof/depot", "Déposer", "upload-simple", chemin.startsWith("/prof/depot"))}
        ${lienNav("/prof/legendes", "Légendes", "image", chemin.startsWith("/prof/legendes"))}
        ${lienNav("/prof/eleves", "Élèves", "users", chemin.startsWith("/prof/eleves"))}
        ${lienNav("/prof/questions", "Questions", "question", chemin.startsWith("/prof/questions"))}
        ${lienNav("/eleve", "Vue élève", "books", false, false)}
      </nav>
      <div class="rail-pied">
        <strong>${c.nom}</strong>
        <form method="post" action="/deconnexion">
          <button class="lien">${icone("sign-out")}Se déconnecter</button>
        </form>
      </div>
    </header>
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
              onclick="const n = this.form.querySelectorAll('[name=ids]:checked').length; return n > 0 && confirm('Rejeter ' + n + ' source' + (n > 1 ? 's' : '') + ' ? Les élèves ne les verront plus.')"
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
                    onclick="this.form.querySelectorAll('[name=ids]').forEach(c => c.checked = this.checked)"
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
        onchange="this.parentElement.querySelector('output').textContent = this.files[0]?.name ?? 'Aucun fichier choisi'"
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

/** Blocs du document, avec intertitres et passage surligné entre `debut` et `fin`. */
/** Intertitre de section: h2 sous le titre de la page élève, h3 sous « Texte extrait » côté enseignant. */
const intertitre = (texte: string, niveau: 2 | 3, id?: string) => {
  // Les identifiants de bloc sont générés à l'ingestion (« blk_9 »): pas de texte d'élève ici.
  const ancre = raw(id ? ` id="${id}"` : "");
  return niveau === 2
    ? html`
      <h2 class="intertitre" ${ancre}>${texte}</h2>
    `
    : html`<h3${ancre}>${texte}</h3>`;
};

export const texteDocument = (blocs: Bloc[], marque?: [number, number], niveau: 2 | 3 = 3) => {
  let section = "";
  return blocs.map((b) => {
    const titre = b.section !== section && b.texte !== b.section
      ? intertitre(b.section, niveau)
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
    return b.texte === b.section ? intertitre(b.texte, niveau, b.id) : html`
      ${titre}<p id="${b.id}">${b.texte}</p>
    `;
  });
};

export type ALegender = ImageVue & { source_id: string; titre: string; restantes: number };

// Une touche seule: Cmd+R ou Ctrl+V ne valident ni ne rejettent rien.
const touche = (k: string) =>
  `click, keyup[key=='${k}' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.target.matches('input,textarea,select')] from:body`;

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
              hx-trigger="${touche(
                "v",
              )}">${icone("check")}Valider (V)</button>
            <button class="espace" hx-post="/prof/legendes/rejected"
              hx-trigger="${touche("r")}">${icone(
                "x",
              )}Rejeter (R)</button>
          </div>
        </form>
      </div>
    `
    : html`
      <p id="legende">Toutes les légendes sont relues.</p>
    `;

/** E place le curseur dans la légende, ↑ et ↓ changent d'image. V et R passent par `hx-trigger`. */
export const raccourciEdition = html`
  <script>
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.matches("input,textarea,select")) return;
    if (e.key === "e") {
      e.preventDefault();
      document.getElementById("texte")?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const liens = [...document.querySelectorAll(".file a")];
      const i = liens.findIndex((a) => a.getAttribute("aria-current") === "true");
      const cible = liens[e.key === "ArrowDown" ? i + 1 : i - 1];
      if (cible) {
        e.preventDefault();
        cible.click();
      }
    }
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
      >${icone("arrow-right")}${libelle}</button>
    `
    : html`
      <form method="post" action="/eleve/questions" class="idee-form">
        <input type="hidden" name="texte" value="${q}"><input type="hidden" name="chapitre" value="${chapitre}"><button class="idee">${icone(
          "arrow-right",
        )}${libelle}</button>
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
      <label for="texte">Qu'aimerais-tu comprendre aujourd'hui ?</label>
      <div class="saisie">
        <input type="text" id="texte" name="texte" required maxlength="1000"
          placeholder="Pourquoi trois couleurs chez Mondrian ?">
        <button class="principal">${icone("arrow-up")}Demander</button>
      </div>
    </form>
    <div class="accueil-grille">
      <section aria-labelledby="tes-chapitres">
        <h2 id="tes-chapitres">Tes chapitres</h2>
        ${chapitres.length
          ? html`
            <ul class="chapitres">${chapitres.map((c) =>
              html`
                <li class="chapitre">
                  <div class="chapitre-tete">
                    <h3><a href="${lienChapitre(c.nom)}">${nomChapitre(c.nom)}</a></h3>
                    <span class="discret">${c.sources.length} documents</span>
                  </div>
                  <div class="apercu-oeuvres">${c.sources.filter((s) => s.image_id).slice(0, 4).map(
                    (
                      s,
                    ) =>
                      html`
                        <a class="passe-partout"
                          href="${lienChapitre(c.nom, s.id)}"><img src="/media/${s
                            .image_id}" alt="${s.titre}" loading="lazy"></a>
                      `,
                  )}</div>
                  ${c.questions.length
                    ? html`
                      <div class="idees">${c.questions.slice(0, 2).map((q) =>
                        idee(q, false, q, c.nom === "Sans chapitre" ? "" : c.nom)
                      )}</div>
                    `
                    : ""}
                  <a class="bouton" href="${lienChapitre(c.nom)}">${icone(
                    "arrow-right",
                  )}Ouvrir le chapitre</a>
                </li>
              `
            )}</ul>
          `
          : html`
            <p>Aucun document n'est encore publié par tes enseignants.</p>
          `}
      </section>
      ${oeuvre
        ? html`<aside class="saviez-vous" aria-labelledby="saviez-vous">
          <h2 id="saviez-vous">Le saviez-vous ?</h2>
          <a class="passe-partout" href="/eleve/sources/${oeuvre.id}"><img src="/media/${oeuvre.image_id}" alt="${oeuvre.titre}" loading="lazy"></a>
          <p><strong>${oeuvre.titre}</strong>${oeuvre.date ? ` · ${oeuvre.date}` : ""}</p>
          ${
          idee(
            `Qu'est-ce que tu sais de cette œuvre : ${oeuvre.titre} ?`,
            false,
            "Qu'est-ce que tu sais de cette œuvre ?",
          )
        }
        </aside>`
        : fait
        ? html`
          <aside class="saviez-vous" aria-labelledby="saviez-vous">
            <h2 id="saviez-vous">Le saviez-vous ?</h2>
            <blockquote>${fait.phrase}</blockquote>
            <p class="discret">
              Tiré de « ${fait.titre} ».
              <a href="/eleve/sources/${fait.source_id}?debut=${fait.debut}&fin=${fait.fin}#passage"
              >Lire le passage</a>
            </p>
            ${idee(`Explique-moi : ${fait.phrase}`, false, "M'en dire plus")}
          </aside>
        `
        : ""}
    </div>
  `;

const lienChapitre = (nom: string, doc?: string) =>
  `/eleve/chapitres/${encodeURIComponent(nom === "Sans chapitre" ? "" : nom)}${
    doc ? `?doc=${doc}` : ""
  }`;

/** Ce que le lecteur montre d'un document choisi dans le mur. */
/** « 2 sur $ »: compteur de diapositive resté dans deux exports HTML, sans valeur pour un élève. */
export const COMPTEUR_DIAPO = /^\d+ sur \$\d*$/;

export type SourceLue = {
  id: string;
  titre: string;
  enseignant: string;
  sequence: string;
  seance: string;
  date: string;
};

/** Cartel de musée: seulement les champs connus, rien d'inventé. */
const cartel = (d: { seance: string; chapitre: string; date: string; enseignant: string }) =>
  html`
    <dl class="cartel">
      ${d.date
        ? html`
          <dt>Date</dt>
          <dd>${d.date}</dd>
        `
        : ""}
      ${d.seance
        ? html`
          <dt>Séance</dt>
          <dd>${d.seance}</dd>
        `
        : ""}
      ${d.chapitre
        ? html`
          <dt>Chapitre</dt>
          <dd>${nomChapitre(d.chapitre)}</dd>
        `
        : ""}
      <dt>Publié par</dt><dd>${d.enseignant}</dd>
    </dl>
  `;

export type Apercu = {
  id: string;
  titre: string;
  enseignant: string;
  chapitre: string;
  seance: string;
  date: string;
  image_id: string | null;
  legende: string | null;
  images: number;
  extrait: string;
};

export const lecteur = (d?: Apercu) =>
  d
    ? html`
      <aside id="lecteur" class="feuille" aria-labelledby="lecteur-titre">
        <div class="feuille-tete">
          <h2 id="lecteur-titre" tabindex="-1">${d.titre}</h2>
          ${fermer}
        </div>
        <div class="defile">
          ${d.image_id
            ? html`
              <figure class="oeuvre-grande">
                <img src="/media/${d.image_id}" alt="${d.legende ?? d.titre}">
                ${d.legende ? html`<figcaption>${d.legende}</figcaption>` : ""}
              </figure>
            `
            : ""}
          ${cartel(d)}
          ${d.images > 1 ? html`<p class="discret">${d.images} images dans le document.</p>` : ""}
          ${d.extrait ? html`<p class="extrait">${d.extrait}</p>` : ""}
        </div>
        <div class="feuille-pied">
          <a class="bouton principal" href="/eleve/sources/${d.id}">${icone(
            "file-text",
          )}Lire le document</a>
          <form method="post" action="/eleve/questions">
            <input type="hidden" name="texte" value="Que dit le cours sur « ${d.titre} » ?">
            <input type="hidden" name="chapitre" value="${d.chapitre}">
            <button>${icone("chat-circle")}Poser une question dessus</button>
          </form>
        </div>
      </aside>
    `
    : html`
      <aside id="lecteur" class="feuille" aria-label="Document">
        <p class="discret">Choisis une œuvre dans le mur pour l'ouvrir ici.</p>
      </aside>
    `;

const tuile = (s: SourceChapitre, nom: string, choisi: boolean) =>
  html`
    <a
      class="tuile"
      href="${lienChapitre(nom, s.id)}"
      aria-current="${String(choisi)}"
      hx-get="/eleve/documents/${s.id}/apercu"
      hx-target="#lecteur"
      hx-swap="outerHTML"
      hx-sync="closest .mur-lecteur:replace"
      hx-push-url="${lienChapitre(nom, s.id)}"
      hx-on::after-request="if (event.detail.successful) document.querySelectorAll('.tuile').forEach(t => t.setAttribute('aria-current', t === this))"
      onclick="ouvrirFeuille(this)"
    >
      <span class="passe-partout">${s.image_id
        ? html`<img src="/media/${s.image_id}" alt="" loading="lazy">`
        : html`<span class="sans-image">${icone("file-text")}</span>`}</span>
      <span class="tuile-titre">${s.titre}</span>
      ${s.date ? html`<span class="discret">${s.date}</span>` : ""}
    </a>
  `;

export const pageChapitre = (
  nom: string,
  sources: SourceChapitre[],
  questions: string[],
  choisi?: Apercu,
) => {
  const oeuvre = sources.find((s) => s.image_id && s.quiz_reponse);
  const seances = Map.groupBy(sources, (s) => s.seance || "Autres documents");
  return html`
    <div class="mur-lecteur" data-feuille>
      <div class="mur">
    <a class="bouton retour" href="/eleve">${icone("arrow-left")}Tous les chapitres</a>
    <h1>${nomChapitre(nom || "Sans chapitre")}</h1>
    <p class="sous-titre">${sources
      .length} documents publiés par tes enseignants, rangés par séance.</p>
    <form method="post" action="/eleve/questions" class="question-rapide">
      <label for="texte">Une question sur ce chapitre ?</label>
      <div class="saisie">
        <input type="text" id="texte" name="texte" required maxlength="1000"
          placeholder="Pose ta question">
        <input type="hidden" name="chapitre" value="${nom}">
        <button class="principal">${icone("arrow-up")}Demander</button>
      </div>
    </form>
    ${questions.length
      ? html`<div class="idees">${questions.slice(0, 3).map((q) => idee(q, false, q, nom))}</div>`
      : ""}
        ${[...seances].map(([seance, docs]) =>
          html`
            <section class="seance" aria-labelledby="seance-${docs[0].id}">
              <h2 id="seance-${docs[0].id}">${seance} <span class="discret">${docs
                .length}</span></h2>
              <div class="tuiles">${docs.map((s) => tuile(s, nom, s.id === choisi?.id))}</div>
            </section>
          `
        )}
      </div>
      <div class="colonne-lecteur">${lecteur(choisi)}</div>
    </div>
    ${oeuvre
      ? html`
        <section class="quiz">
          <h2>Quelle œuvre est-ce ?</h2>
          <img src="/media/${oeuvre.image_id}" alt="Œuvre à identifier" loading="lazy">
          <label for="quiz-reponse">Quel artiste ou mouvement ?</label>
          <div class="saisie">
            <input id="quiz-reponse" type="text" autocomplete="off">
            <button type="button" data-answer="${oeuvre.quiz_reponse}"
              onclick="verifierQuiz(this)">${icone(
                "check",
              )}Vérifier</button>
          </div>
          <p id="quiz-resultat" role="status"></p>
        </section>
      `
      : ""}
  `;
};

export const lectureSource = (
  s: SourceLue,
  images: { id: string; legende: string | null }[],
  blocs: Bloc[],
  marque?: [number, number],
) =>
  html`
    <a class="bouton retour" href="${lienChapitre(s.sequence || "Sans chapitre", s.id)}">${icone(
      "arrow-left",
    )}${nomChapitre(s.sequence || "Tous les chapitres")}</a>
    <article class="document">
      <h1>${s.titre}</h1>
      <div class="document-tete">
        ${cartel({ ...s, chapitre: s.sequence })}
        <form method="post" action="/eleve/questions">
          <input type="hidden" name="texte" value="Que dit le cours sur « ${s.titre} » ?">
          <input type="hidden" name="chapitre" value="${s.sequence}">
          <button>${icone("chat-circle")}Poser une question dessus</button>
        </form>
      </div>
      ${images.map((i) =>
        html`
          <figure class="oeuvre-grande"><img src="/media/${i.id}" alt="${i.legende ?? s.titre}">${i
              .legende
            ? html`
              <figcaption>${i.legende}</figcaption>
            `
            : ""}</figure>
        `
      )} ${texteDocument(
        blocs.filter((b, n) => !(n === 0 && b.texte === s.titre)),
        marque,
        2,
      )}
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
    // Une ligne par intertitre cité: deux sections d'un même document restent distinctes.
    const sources = [...new Map(r.affirmations.map((a) => [a.titre, a.source_id])).entries()];
    return html`
      <article class="reponse" id="reponse-${id}">
        <p class="reponse-note">${r.partielle
          ? "Réponse partielle : seuls les passages vérifiés sont affichés"
          : "Réponse vérifiée dans les cours validés"}</p>
        <p class="texte-reponse">${r.affirmations.map((a: Affirmation, n: number) =>
          html`
            ${n ? " " : ""}<span>${a.texte}</span>&nbsp;<button
              class="citation"
              aria-pressed="${String(auto && n === 0)}"
              aria-label="${n + 1}, voir le passage : ${a.titre}"
              hx-get="/eleve/messages/${id}/citations/${n}"
              hx-trigger="${auto && n === 0 ? "click, load" : "click"}"
              hx-target="#source"
              hx-swap="outerHTML"
              hx-sync="#source:replace"
              hx-on::after-request="document.querySelectorAll('.citation').forEach(b => b.setAttribute('aria-pressed', b === this))"
              onclick="ouvrirFeuille(this)"
            >${icone("quotes")}${n + 1}</button>
          `
        )}</p>
        ${[...new Map(r.affirmations.filter((a) => a.image_id).map((a) => [a.image_id, a]))
          .values()]
          .map((a) =>
            html`
              <a
                href="/eleve/sources/${a.source_id}"><img class="image-reponse" src="/media/${a
                  .image_id}" alt="${a.titre}" loading="lazy"></a>
            `
          )}
        <p class="provenance">Sources : ${sources.map(([titre, sourceId], n) =>
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
        ${idees.length
          ? html`<div class="idees-reponse"><strong>Ce que ton cours couvre</strong>${
            idees.map((q) => idee(q, true))
          }</div>`
          : ""}
      </article>
    `;
  }
  return html`
    <article class="reponse panne" id="reponse-${id}">
      <p><strong>${r.code === "CITATION_UNVERIFIED"
        ? "Je n'ai pas pu vérifier les citations de cette réponse."
        : "Thot n'a pas pu répondre, à cause d'une panne technique."}</strong></p>
      <p>${r.code === "CITATION_UNVERIFIED"
        ? "Ta question est conservée. Réessaie ou demande à ton professeur."
        : "Ce n'est pas une limite du cours. Ta question est conservée."}</p>
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

const fermer = html`
  <button type="button" class="fermer-feuille" onclick="fermerFeuille()">${icone(
    "x",
  )}Fermer</button>
`;

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
    coupeAvant?: boolean;
    coupeApres?: boolean;
    enseignant?: string;
  },
  suite?: { id: string; n: number; total: number },
) =>
  a
    ? html`
      <aside id="source" class="feuille" aria-labelledby="source-titre">
        <div class="feuille-tete">
          <h2>Dans ton cours</h2>
          ${fermer}
        </div>
        <div>
          <h3 id="source-titre" tabindex="-1">${a.titre}</h3>
          ${a.enseignant ? html`<p class="discret">Document de ${a.enseignant}</p>` : ""}
        </div>
        ${suite && suite.total > 1
          ? html`
            <div class="source-nav">
              ${[[-1, "Précédent", "caret-left"], [1, "Suivant", "caret-right"]].map((
                [pas, libelle, nom],
              ) =>
                html`
                  <button
                    type="button"
                    ${suite.n + Number(pas) < 0 || suite.n + Number(pas) >= suite.total
                      ? "disabled"
                      : ""}
                    onclick="document.querySelectorAll('#reponse-${suite.id} .citation')[${suite.n +
                      Number(pas)}]?.click()"
                  >${icone(nom as Icone)}${libelle}</button>
                `
              )}
              <span class="discret">${suite.n + 1} sur ${suite.total}</span>
            </div>
          `
          : ""}
        <div class="defile">
          ${a.milieu !== undefined
            ? html`
              <blockquote
                class="passage">${a.coupeAvant ? "… " : ""}${a.avant}<mark>${a.milieu}</mark>${a
                  .apres}${a.coupeApres ? " …" : ""}</blockquote>
            `
            : html`
              <p class="discret">Légende d'image relue par l'enseignant :</p>
              <blockquote class="passage"><mark>${a.citation}</mark></blockquote>
            `}
        </div>
        <div class="feuille-pied">
          <a class="bouton" href="/eleve/sources/${a.source_id}${a.debut !== undefined
            ? `?debut=${a.debut}&fin=${a.fin}#passage`
            : ""}">${icone("file-text")}Ouvrir le document complet</a>
        </div>
      </aside>
    `
    : html`
      <aside id="source" class="feuille" aria-labelledby="source-vide">
        <h2 id="source-vide">Dans ton cours</h2>
        <p class="discret">
          Les numéros dans une réponse ouvrent ici le passage du cours sur lequel repose chaque phrase.
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
) => {
  const derniere = messages.findLastIndex((m) => m.etat === "answered");
  return html`
    <div class="chat" data-feuille>
      <section class="chat-principal" aria-labelledby="titre-chat">
        <h1 id="titre-chat">Poser une question</h1>
        <div
          id="conversation"
          aria-live="polite"
          aria-relevant="additions"
          hx-on::after-settle="if (!event.target.closest('.avis')) suivreConversation(this)"
          hx-on:htmx:sse-message="suivreConversation(this)"
        >
          ${messages.map((m, i) =>
            html`
              ${question(m.question)}${m.resultat
                ? reponse(
                  m.id,
                  JSON.parse(m.resultat),
                  m.avis,
                  i === messages.length - 1 ? idees : [],
                  i === derniere,
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
          hx-on::before-request="fermerFeuille()"
          hx-on::after-request="if (event.detail.successful) this.reset()"
        >
          <label for="texte">Ta question</label>
          <div class="saisie">
            <textarea
              id="texte"
              name="texte"
              required
              maxlength="1000"
              rows="2"
              placeholder="Pose une autre question…"
              onkeydown="if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.form.requestSubmit(); }"
            ></textarea>
            <button class="principal">${icone("arrow-up")}Envoyer</button>
          </div>
          <small>Thot répond seulement avec les documents publiés par tes enseignants.</small>
        </form>
      </section>
      <div class="colonne-source">${panneauSource()}</div>
    </div>
  `;
};
