import { html } from "hono/html";
import type { Bloc } from "../../core/document.ts";
import type { Affirmation, Resultat } from "../../core/reponse.ts";
import { type Icone, icone } from "../icones.ts";
import { texteDocument } from "./document.ts";

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
                    <h3><a href="${lienChapitre(c.nom)}">${nomChapitre(
                      c.nom || "Sans chapitre",
                    )}</a></h3>
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
                        idee(q, false, q, c.nom)
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
  `${nom ? `/eleve/chapitres/${encodeURIComponent(nom)}` : "/eleve/sans-chapitre"}${
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
      data-ouvrir-feuille
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
              data-verifier-quiz>${icone(
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
    <a class="bouton retour" href="${lienChapitre(s.sequence, s.id)}">${icone(
      "arrow-left",
    )}${nomChapitre(s.sequence || "Sans chapitre")}</a>
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
              data-ouvrir-feuille
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
  <button type="button" class="fermer-feuille">${icone(
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
                    data-reponse="${suite.id}" data-citation="${suite.n + Number(pas)}"
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
