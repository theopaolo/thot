import { html } from "hono/html";
import type { Bloc } from "../../core/document.ts";
import type { BlocReponse, Resultat } from "../../core/reponse.ts";
import { formules, LIENS, texteMermaid } from "../../core/notation.ts";
import { estAnglais } from "../../core/recherche.ts";
import { type Icone, icone } from "../icones.ts";
import type { Champ, Profil } from "../../core/profils.ts";
import { type Catalogue, idsMatieres, type Scope } from "../domaines.ts";
import type { Libelles } from "../instance.ts";
import { champsScope, selectsPerimetre } from "./domaines.ts";
import { texteDocument } from "./document.ts";

export type ChapitreVue = {
  nom: string;
  themeId?: string;
  coursId?: string;
  cours?: string;
  sources: SourceChapitre[];
  questions: string[];
};

export type SourceChapitre = {
  id: string;
  titre: string;
  seance: string;
  date: string;
  quiz_reponse: string;
  profil?: Profil;
  image_id: string | null;
};

export type FaitVue = {
  phrase: string;
  titre: string;
  source_id: string;
  debut: number;
  fin: number;
};

/** Rejoué avec la même clé, un envoi retrouve l'échange déjà créé au lieu d'en ouvrir un autre. */
export const cleEnvoi = () => html`<input type="hidden" name="cle" value="${crypto.randomUUID()}">`;

/**
 * Une question proposée: un bouton qui l'envoie telle quelle, sans passer par la saisie. Dans le
 * chat, elle continue la conversation ouverte. Ailleurs, elle en commence une.
 */
const idee = (q: string, htmx: boolean, libelle = q, themeId = "", scope: Partial<Scope> = {}) =>
  htmx
    ? html`
      <button
        type="button"
        class="idee"
        hx-post="/eleve/questions"
        hx-vals="${JSON.stringify({ texte: q, cle: crypto.randomUUID() })}"
        hx-include="[name=conversation]"
        hx-target="#conversation"
        hx-swap="beforeend"
      >${icone("arrow-right")}${libelle}</button>
    `
    : html`
      <form method="post" action="/eleve/questions" class="idee-form">
        ${champsScope({ ...scope, theme_id: themeId || scope.theme_id || "", texte: q })}${cleEnvoi()}<button class="idee">${icone(
          "arrow-right",
        )}${libelle}</button>
      </form>
    `;

const nomChapitre = (nom: string) => nom.replace(/^ATC\s+/, "");

export const accueilEleve = (
  prenom: string,
  chapitres: ChapitreVue[],
  fait: FaitVue | undefined,
  oeuvre: SourceChapitre | undefined,
  personnel: boolean,
  mention: string,
  l: Libelles,
) =>
  html`
    <h1>Bonjour ${prenom}</h1>
    <form method="post" action="/eleve/questions" class="question-rapide">
      ${cleEnvoi()}
      <label for="texte">Qu'aimerais-tu comprendre aujourd'hui ?</label>
      <div class="saisie">
        <input type="text" id="texte" name="texte" required maxlength="1000"
          placeholder="Pose ta question sur les ressources">
        <button class="principal">${icone("arrow-up")}Demander</button>
      </div>
      ${mention ? html`<small>${mention}</small>` : ""}
    </form>
    <div class="accueil-grille">
      <section aria-labelledby="tes-chapitres">
        <h2 id="tes-chapitres">${personnel ? "Mes documents" : l.regroupements}</h2>
        ${
          chapitres.length
            ? html`
            <ul class="chapitres">${chapitres.map(
              (c) =>
                html`
                <li class="chapitre">
                  <div class="chapitre-tete">
                    <h3><a href="${lienTheme(c.themeId)}">${nomChapitre(
                      c.nom || "Autres documents",
                    )}</a></h3>
                    <span class="discret">${c.sources.length} documents${
                      chapitres.some((autre) => autre.nom === c.nom && autre.coursId !== c.coursId)
                        ? ` / ${c.cours}`
                        : ""
                    }</span>
                  </div>
                  <div class="apercu-oeuvres">${c.sources
                    .filter((s) => s.image_id)
                    .slice(0, 4)
                    .map(
                      (s) =>
                        html`
                        <a class="passe-partout"
                          href="${lienTheme(c.themeId, s.id)}"><img src="/media/${
                            s.image_id
                          }" alt="${s.titre}" loading="lazy"></a>
                      `,
                    )}</div>
                  ${
                    c.questions.length
                      ? html`
                      <div class="idees">${c.questions
                        .slice(0, 2)
                        .map((q) => idee(q, false, q, c.themeId))}</div>
                    `
                      : ""
                  }
                  <a class="bouton" href="${lienTheme(c.themeId)}" aria-label="Ouvrir ${nomChapitre(c.nom || "Autres documents")}">${icone(
                    "arrow-right",
                  )}Ouvrir</a>
                </li>
              `,
            )}</ul>
          `
            : html`
            <p>${
              personnel
                ? html`
                Aucun document n'est encore prêt pour l'étude. <a
                  href="/prof/depot">Déposer un document</a>, puis le relire dans la bibliothèque.
              `
                : "Aucun document n'est encore publié par tes enseignants."
            }</p>
          `
        }
      </section>
      ${
        oeuvre
          ? html`<aside class="saviez-vous" aria-labelledby="saviez-vous">
          <h2 id="saviez-vous">Le saviez-vous ?</h2>
          <a class="passe-partout" href="/eleve/sources/${oeuvre.id}"><img src="/media/${oeuvre.image_id}" alt="${oeuvre.titre}" loading="lazy"></a>
          <p><strong>${oeuvre.titre}</strong>${oeuvre.date ? ` · ${oeuvre.date}` : ""}</p>
          ${idee(
            `Qu'est-ce que tu sais de cette œuvre : ${oeuvre.titre} ?`,
            false,
            "Qu'est-ce que tu sais de cette œuvre ?",
          )}
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
            : ""
      }
    </div>
  `;

/**
 * La liste des ressources, rangée par cours puis par thème. Les ressources d'un cours sans thème
 * viennent sous le nom du cours, celles sans cours sous « Autres documents ». Les activités
 * publiées suivent les ressources de leur cours.
 */
export const ressourcesParCours = (
  chapitres: ChapitreVue[],
  grille: boolean,
  activites: ActiviteListee[] = [],
) =>
  [...Map.groupBy(chapitres, (ch) => ch.coursId ?? "").values()].map(
    (groupe) => html`
      <h2>${groupe[0].cours ?? "Autres documents"}</h2>
      ${groupe.map(
        (ch) => html`
          ${
            // Un thème qui porte le nom de son cours, souvent celui d'un dossier importé, ne
            // répète pas le titre.
            ch.themeId && ch.nom !== ch.cours
              ? html`<h3><a href="/eleve/themes/${ch.themeId}">${ch.nom}</a></h3>`
              : ""
          }
          <ul class="${grille ? "tuiles" : ""}">${ch.sources.map(
            (r) =>
              html`<li><a class="${grille ? "tuile" : ""}" href="/eleve/sources/${r.id}">${
                grille && r.image_id
                  ? html`<span class="passe-partout"><img src="/media/${r.image_id}" alt="" loading="lazy"></span>`
                  : ""
              }${r.titre}</a></li>`,
          )}</ul>
        `,
      )}
      ${activitesDuCours(activites.filter((a) => a.cours_id === groupe[0].coursId))}
    `,
  );

type ActiviteListee = { id: string; intitule: string; type: string; cours_id: string };
const activitesDuCours = (liste: ActiviteListee[]) =>
  liste.length
    ? html`<h3>Exercices et explications</h3>
      <ul>${liste.map(
        (a) =>
          html`<li><a href="/eleve/activites/${a.id}">${a.intitule}</a> <span class="discret">${
            a.type === "explication" ? "Explication" : "Exercice"
          }</span></li>`,
      )}</ul>`
    : "";

const formRecherche = (q: string, p?: Scope) =>
  html`
    <form method="get" action="/eleve/recherche" class="question-rapide" role="search">
      ${p ? champsScope(p) : ""}
      <label for="q">Chercher une ressource</label>
      <div class="saisie">
        <input type="search" id="q" name="q" value="${q}" required maxlength="300"
          placeholder="Un sujet ou une description">
        <button>${icone("magnifying-glass")}Chercher</button>
      </div>
    </form>
  `;

export type Trouve = {
  id: string;
  titre: string;
  /** le nom du thème */
  theme: string;
  date: string;
  image_id: string | null;
  profil?: Profil;
  theme_id: string;
  /** début du passage trouvé, sans le titre */
  extrait: string;
};

/** Les documents les plus proches de la recherche, du plus proche au moins proche. */
export const recherche = (q: string, trouves: Trouve[] = [], p?: Scope) =>
  html`
    <a class="bouton retour" href="/eleve">${icone("arrow-left")}Ressources</a>
    <h1>Chercher une ressource</h1>
    ${formRecherche(q, p)}
    ${
      !q
        ? ""
        : trouves.length
          ? html`
        <p class="sous-titre">${
          trouves.length === 1 ? "Un document proche" : `${trouves.length} documents proches`
        } de ta recherche, du plus proche au moins proche.</p>
        <div class="tuiles resultats">${trouves.map(
          (s) =>
            html`
            <a class="tuile" href="${
              s.profil === "general" ? `/eleve/sources/${s.id}` : lienTheme(s.theme_id, s.id)
            }">
              <span class="passe-partout">${
                s.image_id
                  ? html`<img src="/media/${s.image_id}" alt="" loading="lazy">`
                  : html`<span class="sans-image">${icone("file-text")}</span>`
              }</span>
              <span class="tuile-titre">${s.titre}</span>
              <span class="discret">${[
                s.profil === "general" ? s.theme : nomChapitre(s.theme),
                s.date,
              ]
                .filter(Boolean)
                .join(", ")}</span>
              ${s.extrait ? html`<span class="tuile-extrait">${s.extrait}</span>` : ""}
            </a>
          `,
        )}</div>
      `
          : html`
        <p>Rien dans le cours ne ressemble à « ${q} ». Essaie d'autres mots.</p>
        ${idee(q, false, "Poser la question à Thot")}
      `
    }
  `;

/** La page d'un thème, ou celle des documents sans thème. */
const lienTheme = (themeId?: string | null, doc?: string) =>
  `${themeId ? `/eleve/themes/${themeId}` : "/eleve/sans-sequence"}${doc ? `?doc=${doc}` : ""}`;

/** Ce que le lecteur montre d'un document choisi dans le mur. */
/** « 2 sur $ »: compteur de diapositive resté dans deux exports HTML, sans valeur pour un élève. */
export const COMPTEUR_DIAPO = /^\d+ sur \$\d*$/;

export type SourceLue = {
  id: string;
  titre: string;
  enseignant: string;
  profil?: Profil;
  matiere_id: string | null;
  langue?: string;
  metadonnees?: string;
  /** le thème dans un cours du lecteur, vide sans thème */
  theme_id: string;
  theme: string;
  seance: string;
  date: string;
  /** la révision servie */
  revision: number;
};

/** Cartel de musée: seulement les champs connus, rien d'inventé. */
const cartel = (
  d: {
    seance: string;
    theme: string;
    date: string;
    enseignant: string;
    profil?: Profil;
  },
  l: Libelles,
) =>
  html`
    <dl class="cartel">
      ${
        d.date
          ? html`
          <dt>Date</dt>
          <dd>${d.date}</dd>
        `
          : ""
      }
      ${
        d.seance
          ? html`
          <dt>Séance</dt>
          <dd>${d.seance}</dd>
        `
          : ""
      }
      ${
        d.theme
          ? html`
          <dt>${l.regroupement}</dt>
          <dd>${d.profil === "general" ? d.theme : nomChapitre(d.theme)}</dd>
        `
          : ""
      }
      <dt>Publié par</dt><dd>${d.enseignant}</dd>
    </dl>
  `;

export type Apercu = {
  id: string;
  titre: string;
  enseignant: string;
  profil?: Profil;
  theme_id: string;
  theme: string;
  seance: string;
  date: string;
  image_id: string | null;
  legende: string | null;
  credit: string | null;
  images: number;
  extrait: string;
};

export const lecteur = (d: Apercu | undefined, l: Libelles) =>
  d
    ? html`
      <aside id="lecteur" class="feuille" aria-labelledby="lecteur-titre">
        <div class="feuille-tete">
          <h2 id="lecteur-titre" tabindex="-1">${d.titre}</h2>
          ${fermer}
        </div>
        <div class="defile">
          ${
            d.image_id
              ? html`
              <figure class="oeuvre-grande">
                <img src="/media/${d.image_id}" alt="${d.legende ?? d.titre}">
                ${
                  d.legende || d.credit
                    ? html`<figcaption>${d.legende}${
                        d.credit ? html`<span class="credit">${d.credit}</span>` : ""
                      }</figcaption>`
                    : ""
                }
              </figure>
            `
              : ""
          }
          ${cartel(d, l)}
          ${d.images > 1 ? html`<p class="discret">${d.images} images dans le document.</p>` : ""}
          ${d.extrait ? html`<p class="extrait">${d.extrait}</p>` : ""}
        </div>
        <div class="feuille-pied">
          <a class="bouton principal" href="/eleve/sources/${d.id}">${icone(
            "file-text",
          )}Lire le document</a>
          <form method="post" action="/eleve/questions">
            ${cleEnvoi()}
            <input type="hidden" name="texte" value="Que dit le cours sur « ${d.titre} » ?">
            <input type="hidden" name="theme_id" value="${d.theme_id}">
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

const tuile = (s: SourceChapitre, choisi: boolean, themeId?: string) =>
  html`
    <a
      class="tuile"
      href="${lienTheme(themeId, s.id)}"
      aria-current="${String(choisi)}"
      hx-get="/eleve/documents/${s.id}/apercu"
      hx-target="#lecteur"
      hx-swap="outerHTML"
      hx-sync="closest .mur-lecteur:replace"
      hx-push-url="${lienTheme(themeId, s.id)}"
      data-ouvrir-feuille
    >
      <span class="passe-partout">${
        s.image_id
          ? html`<img src="/media/${s.image_id}" alt="" loading="lazy">`
          : html`<span class="sans-image">${icone("file-text")}</span>`
      }</span>
      <span class="tuile-titre">${s.titre}</span>
      ${s.date ? html`<span class="discret">${s.date}</span>` : ""}
    </a>
  `;

export const pageChapitre = (
  nom: string,
  sources: SourceChapitre[],
  questions: string[],
  choisi: Apercu | undefined,
  themeId: string | undefined,
  perimetre: string,
  mention: string,
  l: Libelles,
) => {
  const quiLit = mention ? html`<small>${mention}</small>` : "";
  const surQuoi = (titre: string) =>
    titre ? `Une question sur ${titre} ?` : "Une question sur ces documents ?";
  if (sources.every((s) => s.profil === "general")) {
    return html`
      <p><a href="/eleve">Ressources</a></p><h1>${
        nom || "Ressources non classées"
      }</h1><p class="discret">${perimetre}</p>
          <form method="post" action="/eleve/questions"
        class="question-rapide">${cleEnvoi()}<label for="texte">${surQuoi(nom)}</label><div class="saisie"><input type="text" id="texte" name="texte" required maxlength="1000"><input type="hidden" name="theme_id" value="${
          themeId ?? ""
        }"><button>Demander</button></div>${quiLit}</form>
          <ul>${sources.map(
            (s) => html`<li><a href="/eleve/sources/${s.id}">${s.titre}</a></li>`,
          )}</ul>${
            questions.length
              ? html`<div class="idees">${questions.map((q) => idee(q, false, q, themeId))}</div>`
              : ""
          }
    `;
  }
  const oeuvre = sources.find((s) => s.image_id && s.quiz_reponse);
  const seances = Map.groupBy(sources, (s) => s.seance || "Autres documents");
  return html`
    <div class="mur-lecteur" data-feuille>
      <div class="mur">
    <a class="bouton retour" href="/eleve">${icone("arrow-left")}${l.regroupements}</a>
    <h1>${themeId ? nom : nomChapitre(nom || "Autres documents")}</h1>
    <p class="sous-titre">${
      sources.length
    } documents publiés par tes enseignants, rangés par séance.</p>
    <form method="post" action="/eleve/questions" class="question-rapide">
      ${cleEnvoi()}
      <label for="texte">${surQuoi(themeId ? nom : nomChapitre(nom))}</label>
      <div class="saisie">
        <input type="text" id="texte" name="texte" required maxlength="1000"
          placeholder="Pose ta question">
        <input type="hidden" name="theme_id" value="${themeId ?? ""}">
        <button class="principal">${icone("arrow-up")}Demander</button>
      </div>
      ${quiLit}
    </form>
    ${
      questions.length
        ? html`<div class="idees">${questions
            .slice(0, 3)
            .map((q) => idee(q, false, q, themeId))}</div>`
        : ""
    }
        ${[...seances].map(
          ([seance, docs]) =>
            html`
            <section class="seance" aria-labelledby="seance-${docs[0].id}">
              <h2 id="seance-${docs[0].id}">${seance} <span class="discret">${
                docs.length
              }</span></h2>
              <div class="tuiles">${docs.map((s) => tuile(s, s.id === choisi?.id, themeId))}</div>
            </section>
          `,
        )}
      </div>
      <div class="colonne-lecteur">${lecteur(choisi, l)}</div>
    </div>
    ${
      oeuvre
        ? html`
        <section class="quiz">
          <h2>Quelle œuvre est-ce ?</h2>
          <img src="/media/${oeuvre.image_id}" alt="Œuvre à identifier" loading="lazy">
          <label for="quiz-reponse">Quel artiste ou mouvement ?</label>
          <div class="saisie">
            <input id="quiz-reponse" type="text" autocomplete="off">
            <button type="button" data-answer="${oeuvre.quiz_reponse}"
              data-verifier-quiz>${icone("check")}Vérifier</button>
          </div>
          <p id="quiz-resultat" role="status"></p>
        </section>
      `
        : ""
    }
  `;
};

export const lectureSource = (
  s: SourceLue,
  images: { id: string; legende: string | null; credit: string | null }[],
  blocs: Bloc[],
  informations: Champ[],
  l: Libelles,
  marque?: [number, number],
  /** les blocs viennent d'une révision qui ne sert plus */
  ancienne = false,
) =>
  html`
    <a class="bouton retour" href="${
      s.profil === "general" ? "/eleve" : lienTheme(s.theme_id, s.id)
    }">${icone(
      "arrow-left",
    )}${s.profil === "general" ? "Ressources" : nomChapitre(s.theme || "Autres documents")}</a>
    <article class="document">
      <h1>${s.titre}</h1>
      ${
        s.langue && s.langue !== "fr" && !estAnglais(s.langue)
          ? html`<p class="note">Langue non prise en charge pour la recherche : ${s.langue}</p>`
          : ""
      }
      ${
        ancienne
          ? html`<p class="note">
              Version citée par une réponse précédente. Le texte du document a changé depuis.
              <a href="/eleve/sources/${s.id}">Lire la version actuelle</a>
            </p>`
          : ""
      }
      ${
        s.metadonnees
          ? html`<dl class="cartel">${informations.map((c) => {
              const valeur = JSON.parse(s.metadonnees!)[c.cle];
              return valeur
                ? html`
                <dt>${c.label}</dt>
                <dd>${String(valeur)}</dd>
              `
                : "";
            })}</dl>`
          : ""
      }
      <div class="document-tete">
        ${cartel(s, l)}
        <form method="post" action="/eleve/questions">
          ${cleEnvoi()}
          <input type="hidden" name="texte" value="Que dit le cours sur « ${s.titre} » ?">
          <input type="hidden" name="theme_id" value="${s.theme_id}">
          <button>${icone("chat-circle")}Poser une question dessus</button>
        </form>
      </div>
      ${images.map(
        (i) =>
          html`
          <figure class="oeuvre-grande"><img src="/media/${i.id}" alt="${i.legende ?? s.titre}">${
            i.legende || i.credit
              ? html`
              <figcaption>${i.legende}${
                i.credit ? html`<span class="credit">${i.credit}</span>` : ""
              }</figcaption>
            `
              : ""
          }</figure>
        `,
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
export const attente = (id: string, etape: string | null = null) =>
  html`
    <article
      class="reponse"
      hx-ext="sse"
      sse-connect="/eleve/messages/${id}/flux"
      sse-swap="reponse"
      hx-swap="outerHTML"
    >
      <p class="etape" sse-swap="etape" hx-swap="innerHTML" role="status">${etape ?? "En attente"}</p>
      <button type="button" class="lien" hx-post="/eleve/messages/${id}/arreter"
        hx-target="closest .reponse" hx-swap="outerHTML" data-arreter="${id}">Arrêter</button>
    </article>
  `;

export const avis = (id: string, choix: string | null) =>
  html`
    <div id="avis-${id}" class="avis" aria-label="Avis sur la réponse">
      <span>Cette réponse est-elle utile ?</span>
      ${[
        ["utile", "Utile"],
        ["confus", "Peu claire"],
        ["faux", "Fausse"],
      ].map(
        ([valeur, libelle]) =>
          html`
          <button type="button" aria-pressed="${String(
            choix === valeur,
          )}" name="avis" value="${valeur}"
            hx-post="/eleve/messages/${id}/avis" hx-include="this" hx-target="#avis-${id}"
            hx-swap="outerHTML">${libelle}</button>
        `,
      )}
    </div>
  `;

export const reponse = (
  id: string,
  r: Resultat,
  choix: string | null = null,
  idees: string[] = [],
  auto = false,
  /** hors d'une conversation, une explication publiée : l'adresse de ses passages, sans avis */
  citations = "",
) => {
  if (r.etat === "answered") {
    // Une ligne par intertitre cité: deux sections d'un même document restent distinctes.
    const sources = [...new Map(r.affirmations.map((a) => [a.titre, a.source_id])).entries()];
    const notes = [
      r.partielle ? "Réponse partielle : seuls les passages vérifiés sont affichés" : "",
      r.juge_indisponible
        ? "Vérification partielle : une étape de contrôle n'a pas pu être faite."
        : "",
      r.source_supprimee
        ? "Une source citée a été supprimée : la partie de la réponse qui la citait est retirée."
        : "",
    ].filter(Boolean);
    // En comparaison, la matière de la source suit sa citation : le titre d'une colonne ne la
    // prouve pas. Une formule que la citation écrit aussi garde sa source dans `data-tex`, et
    // reste du texte jusqu'au rendu de KaTeX dans le navigateur.
    const phrase = (n: number) =>
      html`<span>${formules(r.affirmations[n].texte, r.affirmations[n].citation).map((m) =>
        typeof m === "string"
          ? m
          : html`<span class="${m.bloc ? "formule formule-bloc" : "formule"}" data-tex="${m.tex}">${m.source}</span>`,
      )}</span><span class="marque">&nbsp;<button
        class="citation"
        aria-pressed="${String(auto && n === 0)}"
        aria-label="${n + 1}, voir le passage : ${r.affirmations[n].titre}"
        hx-get="${citations || `/eleve/messages/${id}/citations`}/${n}"
        hx-trigger="${auto && n === 0 ? "click, load, restaurer" : "click, restaurer"}"
        hx-target="#source"
        hx-swap="outerHTML"
        hx-sync="#source:replace"
        data-ouvrir-feuille
      >${icone("quotes")}${n + 1}</button></span>${
        r.affirmations[n].matiere
          ? html` <span class="discret">${r.affirmations[n].matiere}</span>`
          : ""
      }`;
    // Sans blocs, comme toute réponse antérieure, les affirmations forment un paragraphe. Un type
    // inconnu se lit aussi en paragraphe.
    const bloc = (b: BlocReponse, k: number) => {
      if (b.type === "tableau") {
        // La légende reste hors du cadre qui défile et nomme le tableau.
        return html`<figure class="tableau-reponse">
          ${b.titre ? html`<figcaption id="legende-${id}-${k}">${b.titre}</figcaption>` : ""}
          <div class="cadre-tableau"><table${b.titre ? html` aria-labelledby="legende-${id}-${k}"` : ""}>
          <thead><tr><td></td>${b.colonnes.map((c) => html`<th scope="col">${c}</th>`)}</tr></thead>
          <tbody>${b.lignes.map(
            (l) =>
              html`<tr><th scope="row">${l.titre}</th>${b.colonnes.map((_, k) => {
                const n = l.affirmations[k];
                return html`<td>${typeof n === "number" ? phrase(n) : ""}</td>`;
              })}</tr>`,
          )}</tbody>
        </table></div></figure>`;
      }
      if (b.type === "schema") {
        // La liste est l'équivalent texte du schéma, toujours affiché. Le navigateur dessine le
        // schéma au-dessus quand Mermaid y parvient.
        const nom = (i: number) => html`<strong>${b.noeuds[i].titre}</strong>`;
        return html`<figure class="schema-reponse">
          ${b.titre ? html`<figcaption>${b.titre}</figcaption>` : ""}
          <ul data-mermaid="${texteMermaid(b)}">${b.noeuds.map((noeud, i) =>
            noeud.affirmation === undefined
              ? ""
              : html`<li>${nom(i)} : ${phrase(noeud.affirmation)}</li>`,
          )}${b.relations.map(
            (l) =>
              html`<li>${nom(l.de)} ${LIENS[l.lien]} ${nom(l.vers)} : ${phrase(l.affirmation)}</li>`,
          )}</ul>
        </figure>`;
      }
      const titre = b.titre ? html`<h2>${b.titre}</h2>` : "";
      const items = b.affirmations.map((n) => html`<li>${phrase(n)}</li>`);
      if (b.type === "liste") return html`${titre}<ul>${items}</ul>`;
      if (b.type === "etapes") return html`${titre}<ol>${items}</ol>`;
      return html`${titre}<p>${b.affirmations.map((n, k) => html`${k ? " " : ""}${phrase(n)}`)}</p>`;
    };
    return html`
      <article class="reponse" id="reponse-${id}">
        ${(notes.length ? notes : ["Réponse vérifiée dans les cours validés"]).map(
          (note) => html`<p class="reponse-note">${note}</p>`,
        )}
        <div class="texte-reponse">${(
          r.blocs ?? [{ type: "paragraphe", affirmations: r.affirmations.map((_, n) => n) }]
        ).map(bloc)}</div>
        ${(r.sans_passage ?? []).map(
          (m) => html`<p class="reponse-note">Aucun passage trouvé en ${m}.</p>`,
        )}
        ${[
          ...new Map(r.affirmations.filter((a) => a.image_id).map((a) => [a.image_id, a])).values(),
        ].map(
          (a) =>
            html`
              <a
                href="/eleve/sources/${a.source_id}"><img class="image-reponse" src="/media/${
                  a.image_id
                }" alt="${a.titre}" loading="lazy"></a>
            `,
        )}
        <p class="provenance">Sources : ${sources.map(
          ([titre, sourceId], n) =>
            html`${n ? ", " : ""}<a href="/eleve/sources/${sourceId}">${titre}</a>`,
        )}</p>
        ${citations ? "" : avis(id, choix)}
        ${
          idees.length
            ? html`<div class="idees-reponse"><strong>Pour continuer</strong>${idees.map((q) =>
                idee(q, true),
              )}</div>`
            : ""
        }
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
        ${
          idees.length
            ? html`<div class="idees-reponse"><strong>Ce que ton cours couvre</strong>${idees.map(
                (q) => idee(q, true),
              )}</div>`
            : ""
        }
      </article>
    `;
  }
  return html`
    <article class="reponse panne" id="reponse-${id}">
      <p><strong>${
        r.code === "EVIDENCE_WITHDRAWN"
          ? "Une source de cette réponse a été retirée ou modifiée."
          : r.code === "SOURCE_DELETED"
            ? "Une source citée a été supprimée."
            : r.code === "CITATION_UNVERIFIED"
              ? "Je n'ai pas pu vérifier les citations de cette réponse."
              : r.code === "CANCELLED"
                ? "Réponse arrêtée."
                : "Thot n'a pas pu répondre, à cause d'une panne technique."
      }</strong></p>
      <p>${
        r.code === "EVIDENCE_WITHDRAWN" || r.code === "SOURCE_DELETED"
          ? "Réessaie pour obtenir une réponse avec les sources disponibles."
          : r.code === "CITATION_UNVERIFIED"
            ? "Ta question est conservée. Réessaie ou demande à ton professeur."
            : r.code === "CANCELLED"
              ? "Ta question est conservée."
              : "Ce n'est pas une limite du cours. Ta question est conservée."
      }</p>
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
  <button type="button" class="fermer-feuille">${icone("x")}Fermer</button>
`;

export const panneauSource = (
  a?: {
    titre: string;
    citation: string;
    source_id: string;
    debut?: number;
    fin?: number;
    revision?: number;
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
        ${
          suite && suite.total > 1
            ? html`
            <div class="source-nav">
              ${[
                [-1, "Précédent", "caret-left"],
                [1, "Suivant", "caret-right"],
              ].map(
                ([pas, libelle, nom]) =>
                  html`
                  <button
                    type="button"
                    ${
                      suite.n + Number(pas) < 0 || suite.n + Number(pas) >= suite.total
                        ? "disabled"
                        : ""
                    }
                    data-reponse="${suite.id}" data-citation="${suite.n + Number(pas)}"
                  >${icone(nom as Icone)}${libelle}</button>
                `,
              )}
              <span class="discret">${suite.n + 1} sur ${suite.total}</span>
            </div>
          `
            : ""
        }
        <div class="defile">
          ${
            a.milieu !== undefined
              ? html`
              <blockquote
                class="passage">${a.coupeAvant ? "… " : ""}${a.avant}<mark>${a.milieu}</mark>${
                  a.apres
                }${a.coupeApres ? " …" : ""}</blockquote>
            `
              : html`
              <p class="discret">Légende d'image relue par l'enseignant :</p>
              <blockquote class="passage"><mark>${a.citation}</mark></blockquote>
            `
          }
        </div>
        <div class="feuille-pied">
          <a class="bouton" href="/eleve/sources/${a.source_id}${
            a.debut !== undefined
              ? `?debut=${a.debut}&fin=${a.fin}&revision=${a.revision ?? 1}#passage`
              : ""
          }">${icone("file-text")}Ouvrir le document complet</a>
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
  /** la dernière étape annoncée d'une réponse en cours */
  etape?: string | null;
  resultat: string | null;
  avis: string | null;
  /** le périmètre de cet échange, quand il diffère de celui de l'échange précédent */
  perimetre?: string;
};

const LISTE = new Intl.ListFormat("fr");
/**
 * « Arts appliqués / STD2A / Bauhaus », en nommant le niveau qui a disparu. Vide : tout. Une
 * comparaison nomme ses matières : « Histoire de l'art et Physique ».
 */
export const nomPerimetre = (cat: Catalogue, p: Scope, theme = "Thème") => {
  if (p.matieres) {
    return LISTE.format(
      idsMatieres(p.matieres)
        .map((id) => cat.matieres.find((m) => m.id === id)?.nom ?? "Matière indisponible")
        .sort((a, b) => a.localeCompare(b, "fr")),
    );
  }
  const t = cat.themes.find((x) => x.id === p.theme_id);
  const c = cat.cours.find((x) => x.id === (p.cours_id || t?.cours_id));
  const m = cat.matieres.find((x) => x.id === (p.matiere_id || c?.matiere_id));
  return [
    m?.nom ?? (p.matiere_id ? "Matière indisponible" : ""),
    c?.nom ?? (p.cours_id ? "Cours indisponible" : ""),
    t?.nom ?? (p.theme_id ? `${theme} indisponible` : ""),
  ]
    .filter(Boolean)
    .join(" / ");
};

export type ConversationVue = {
  id: string;
  titre: string;
  perimetre: string;
  active_le: string;
  /** état du dernier échange */
  etat: string | null;
  /** une réponse terminée que l'élève n'a pas encore ouverte */
  nouvelle?: number;
};

const JOUR_ISO = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" });
const HEURE = new Intl.DateTimeFormat("fr-FR", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Europe/Paris",
});
const DATE_COURTE = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  timeZone: "Europe/Paris",
});
/** « 14 h 02 » le jour même, « hier » la veille, « 12 oct. » avant. */
export const quand = (iso: string, maintenant = Date.now()) => {
  const date = new Date(iso);
  const jour = JOUR_ISO.format(date);
  if (jour === JOUR_ISO.format(maintenant)) return HEURE.format(date).replace(":", " h ");
  if (jour === JOUR_ISO.format(maintenant - 86_400_000)) return "hier";
  return DATE_COURTE.format(date);
};

const ETATS: Record<string, [string, string]> = {
  en_attente: ["En attente", "en-cours"],
  en_cours: ["Réponse en cours", "en-cours"],
  failed: ["Échec", "failed"],
};

/**
 * Le statut d'une conversation dans la liste. Une réponse en file ou en cours se relit toutes les
 * 3 s. La conversation ouverte affiche sa réponse elle-même : elle n'a pas de « Nouvelle réponse ».
 */
export const statutConversation = (
  c: Pick<ConversationVue, "id" | "etat" | "nouvelle">,
  ouverte: boolean,
) => {
  const [mot, classe] =
    ETATS[c.etat ?? ""] ?? (c.nouvelle && !ouverte ? ["Nouvelle réponse", "nouvelle"] : []);
  if (!mot) return "";
  return classe === "en-cours"
    ? html`<span class="statut en-cours" hx-get="/eleve/conversations/${c.id}/etat${
        ouverte ? "?ouverte=1" : ""
      }" hx-trigger="every 3s" hx-swap="outerHTML transition:false">${mot}</span>`
    : html`<span class="statut ${classe}">${mot}</span>`;
};

/** Les résultats seuls : la recherche HTMX remplace ce bloc, pas le champ. */
export const resultatsConversations = (
  liste: ConversationVue[],
  courante = "",
  archivees = 0,
  suite = "",
  q = "",
) =>
  html`
    <div id="resultats-conversations" aria-live="polite">
      ${
        liste.length
          ? html`<ul class="conversations">${liste.map(
              (c) =>
                html`<li><a href="/eleve/chat/${c.id}" aria-current="${
                  c.id === courante ? "page" : "false"
                }"><span class="conversation-titre">${c.titre}</span><span class="discret">${
                  c.perimetre || "Toutes tes ressources"
                }</span><span class="discret">${quand(c.active_le)} ${statutConversation(
                  c,
                  c.id === courante,
                )}</span></a></li>`,
            )}</ul>`
          : html`<p class="discret">${
              q
                ? html`Aucune conversation ne correspond à « ${q} ».`
                : html`Aucune conversation pour l'instant.`
            }</p>`
      }
      ${suite ? html`<p><a href="${suite}">Afficher les conversations précédentes</a></p>` : ""}
      ${
        archivees
          ? html`<p><a href="/eleve/conversations/archivees">Conversations archivées (${archivees})</a></p>`
          : ""
      }
    </div>
  `;

const listeConversations = (
  liste: ConversationVue[],
  courante = "",
  archivees = 0,
  suite = "",
  q = "",
  archive = false,
) => {
  const action = archive ? "/eleve/conversations/archivees" : "/eleve/conversations";
  return html`
    <a class="bouton" href="/eleve/chat/nouvelle">Nouvelle conversation</a>
    ${
      liste.length || q
        ? html`<form class="recherche-conversations" role="search" method="get" action="${action}"
            hx-get="${action}" hx-trigger="input changed delay:300ms, submit"
            hx-target="#resultats-conversations" hx-swap="outerHTML transition:false">
            ${courante ? html`<input type="hidden" name="courante" value="${courante}">` : ""}
            <input type="search" name="q" value="${q}" maxlength="100"
              aria-label="Chercher dans tes conversations" placeholder="Chercher une conversation">
          </form>`
        : ""
    }
    ${resultatsConversations(liste, courante, archivees, suite, q)}
  `;
};

/** La liste seule, sous 1400 px, et celle des conversations archivées. */
export const pageConversations = (
  archive: boolean,
  liste: ConversationVue[],
  archivees: number,
  suite: string,
  q = "",
) =>
  html`
    <section class="page-conversations">
      ${archive ? html`<p><a href="/eleve/conversations">Conversations</a></p>` : ""}
      <h1>${archive ? "Conversations archivées" : "Conversations"}</h1>
      ${listeConversations(liste, "", archivees, suite, q, archive)}
    </section>
  `;

export type Fil = {
  /** compte qui écrit : ses brouillons ne se mêlent pas à ceux d'un autre compte du navigateur */
  compte: string;
  /** absente : nouvelle conversation, rien n'est enregistré avant la première question */
  conversation?: { id: string; titre: string; archivee: boolean };
  messages: MessageVue[];
  idees: string[];
  liste: ConversationVue[];
  archivees: number;
  suite: string;
  perimetre: Scope;
  catalogue: Catalogue;
  theme: string;
  indisponible: boolean;
  statut?: string;
  personnel?: boolean;
  mention?: string;
};

export const chat = (f: Fil) => {
  const conv = f.conversation;
  const derniere = f.messages.findLastIndex((m) => m.etat === "answered");
  const enCours = f.messages.some((m) => !m.resultat);
  const nom = nomPerimetre(f.catalogue, f.perimetre, f.theme) || "toutes tes ressources";
  const changer = conv
    ? html`method="post" action="/eleve/chat/${conv.id}/perimetre"`
    : html`method="get" action="/eleve/chat/nouvelle"`;
  const comparees = idsMatieres(f.perimetre.matieres);
  const composer = html`
    <form
      id="envoi"
      class="question-form"
      method="post"
      action="/eleve/questions"
      ${
        conv
          ? html`hx-post="/eleve/questions" hx-target="#conversation" hx-swap="beforeend"
            hx-disabled-elt="find button.principal"`
          : html`hx-boost="true" hx-replace-url="true" data-focus="#texte"`
      }
      data-brouillon="${f.compte}:${conv?.id ?? "nouvelle"}"
    >
      ${conv ? "" : champsScope(f.perimetre)}${cleEnvoi()}
      <label for="texte">Ta question</label>
      <div class="saisie">
        <textarea
          id="texte"
          name="texte"
          required
          maxlength="1000"
          rows="2"
          placeholder="${conv ? "Pose une autre question…" : "Pose ta question…"}"
        ></textarea>
        <button class="principal" ${enCours ? "disabled" : ""}>${icone("arrow-up")}<span>${
          enCours ? "Réponse en cours…" : "Envoyer"
        }</span></button>
      </div>
    </form>
  `;
  const notice = html`<small>${
    f.personnel
      ? "Thot répond seulement avec les documents que tu as relus et rendus disponibles pour l'étude."
      : "Thot répond seulement avec les documents publiés par tes enseignants."
  } ${f.mention ?? ""}</small>`;
  return html`
    <div class="chat" data-feuille>
      <nav class="liste-conversations" aria-label="Conversations"><div>${listeConversations(
        f.liste,
        conv?.id,
        f.archivees,
        f.suite,
      )}</div></nav>
      <section class="chat-principal" aria-labelledby="titre-chat">
        <div class="tete-conversation">
          <p class="liens-conversations">
            <a href="/eleve/conversations">Conversations</a>
            <a href="/eleve/chat/nouvelle">Nouvelle</a>
          </p>
          ${f.statut ? html`<p role="status">${f.statut}</p>` : ""}
          <h1 id="titre-chat" tabindex="-1">${conv?.titre ?? "Nouvelle conversation"}</h1>
          ${
            conv && !conv.archivee
              ? html`
              <form class="renommer" method="post" action="/eleve/chat/${conv.id}/renommer" hidden
                data-focus="[data-renommer]">
                <label for="titre-conversation">Titre de la conversation</label>
                <div class="saisie">
                  <input type="text" id="titre-conversation" name="titre" value="${conv.titre}"
                    required maxlength="120">
                  <button class="principal">Enregistrer</button>
                  <button type="button" data-annuler-renommer>Annuler</button>
                </div>
              </form>
              <div class="actions-conversation">
                <button type="button" class="lien" data-renommer>Renommer</button>
                <form method="post" action="/eleve/chat/${conv.id}/archiver">
                  <button class="lien">Archiver</button>
                </form>
              </div>
            `
              : ""
          }
          ${conv ? html`<input type="hidden" name="conversation" value="${conv.id}" form="envoi">` : ""}
        </div>
        <div
          id="conversation"
          ${conv ? html`data-memoire="${f.compte}:${conv.id}"` : ""}
          aria-live="polite"
          aria-relevant="additions"
        >
          ${f.messages.map(
            (m, i) =>
              html`
              ${
                m.perimetre === undefined
                  ? ""
                  : html`<p class="changement-perimetre">Périmètre changé : ${
                      m.perimetre || "toutes tes ressources"
                    }</p>`
              }
              ${question(m.question)}${
                m.resultat
                  ? reponse(
                      m.id,
                      JSON.parse(m.resultat),
                      m.avis,
                      i === f.messages.length - 1 ? f.idees : [],
                      i === derniere,
                    )
                  : attente(m.id, m.etape)
              }
            `,
          )}
        </div>
        <div class="pied-chat">
          ${
            conv?.archivee
              ? html`
              <p>Cette conversation est archivée.</p>
              <form method="post" action="/eleve/chat/${conv.id}/desarchiver">
                <button>Désarchiver</button>
              </form>
            `
              : html`
              <div class="perimetre">
                <p id="perimetre" aria-live="polite">Dans : ${nom}</p>
                <details ${f.indisponible ? "open" : ""}>
                  <summary>Changer</summary>
                  <form ${changer} data-focus=".perimetre summary">
                    ${selectsPerimetre(f.catalogue, f.perimetre, f.theme)}
                    <button>Appliquer aux prochaines questions</button>
                  </form>
                  ${
                    f.catalogue.matieres.length > 1
                      ? html`
                      <form ${changer} data-focus=".perimetre summary">
                        <fieldset>
                          <legend>Comparer des matières</legend>
                          ${f.catalogue.matieres.map(
                            (m) =>
                              html`<label><input type="checkbox" name="matieres" value="${m.id}" ${
                                comparees.includes(m.id) ? "checked" : ""
                              }> ${m.nom}</label>`,
                          )}
                        </fieldset>
                        <button>Comparer dans les prochaines questions</button>
                      </form>
                    `
                      : ""
                  }
                </details>
              </div>
              <div class="composeur">
                <button type="button" class="lien" data-aller-reponse hidden>Aller à la nouvelle réponse</button>
                ${f.indisponible ? "" : composer}
              </div>
              ${
                f.indisponible
                  ? html`<p>Ce périmètre n'est plus disponible. Choisis-en un autre pour continuer.</p>`
                  : notice
              }
              ${
                !conv && f.idees.length
                  ? html`<div class="idees">${f.idees.map((q) =>
                      idee(q, false, q, "", f.perimetre),
                    )}</div>`
                  : ""
              }
            `
          }
        </div>
      </section>
      <div class="colonne-source">${panneauSource()}</div>
    </div>
  `;
};
