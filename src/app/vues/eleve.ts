import { html } from "hono/html";
import type { Bloc } from "../../core/document.ts";
import { estAnglais } from "../../core/recherche.ts";
import { icone } from "../icones.ts";
import type { Champ, Profil } from "../../core/profils.ts";
import { type Catalogue, idsMatieres, type Scope } from "../domaines.ts";
import type { Libelles } from "../instance.ts";
import { champsScope, selectsPerimetre } from "./domaines.ts";
import { sections, texteDocument } from "./document.ts";
import { nomPerimetre } from "./commun.ts";
import { attente, panneauSource, question, reponse } from "./echange.ts";
import {
  cleEnvoi,
  fermer,
  idee,
  lienTheme,
  nomChapitre,
  type SourceChapitre,
} from "./eleve-commun.ts";
import { type ActiviteListee, ligneActivite } from "./eleve-ressources.ts";

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

/** Ce que le lecteur montre d'un document choisi dans le mur. */
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
  /** les ressources du thème dans l'ordre de lecture, `s` comprise */
  voisins: { id: string; titre: string }[] = [],
  /** les activités publiées qui citent la ressource ou y renvoient */
  activites: ActiviteListee[] = [],
  /** le cours d'une ressource sans thème : il titre la liste des voisines */
  cours?: { id: string; nom: string },
) => {
  const texte = blocs.filter((b, n) => !(n === 0 && b.texte === s.titre));
  const plan = sections(texte, s.titre);
  const rang = voisins.findIndex((v) => v.id === s.id);
  const precedente = rang > 0 ? voisins[rang - 1] : undefined;
  const suivante = rang >= 0 ? voisins[rang + 1] : undefined;
  return html`
    <a class="bouton retour" href="${
      s.profil === "general" ? "/eleve" : lienTheme(s.theme_id, s.id)
    }">${icone(
      "arrow-left",
    )}${s.profil === "general" ? "Ressources" : nomChapitre(s.theme || "Autres documents")}</a>
    <div class="lecture-colonnes">
    ${
      voisins.length > 1
        ? html`
          <nav class="ressources-theme" aria-labelledby="ressources-theme-titre">
            <h2 id="ressources-theme-titre">${
              cours
                ? html`<a href="/eleve?cours_id=${cours.id}">${cours.nom}</a>`
                : html`<a href="${lienTheme(s.theme_id)}">${s.theme || "Ressources non classées"}</a>`
            }</h2>
            <ol>${voisins.map(
              (v) =>
                html`<li><a href="/eleve/sources/${v.id}" aria-current="${
                  v.id === s.id ? "page" : "false"
                }">${v.titre}</a></li>`,
            )}</ol>
          </nav>
        `
        : ""
    }
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
      )} ${texteDocument(texte, marque, 2, s.titre)}
      <div data-fin-lecture="/eleve/sources/${s.id}/lu"></div>
      ${
        activites.length
          ? html`<section aria-labelledby="s-entrainer">
            <h2 id="s-entrainer">S'entraîner</h2>
            <ul>${activites.map((a) => ligneActivite(a))}</ul>
          </section>`
          : ""
      }
      ${
        precedente || suivante
          ? html`
            <nav class="suite-lecture" aria-label="Ressource précédente et suivante">
              ${
                precedente
                  ? html`<a href="/eleve/sources/${precedente.id}" rel="prev"><span>Précédente</span>${precedente.titre}</a>`
                  : ""
              }
              ${
                suivante
                  ? html`<a href="/eleve/sources/${suivante.id}" rel="next"><span>Suivante</span>${suivante.titre}</a>`
                  : ""
              }
            </nav>
          `
          : ""
      }
    </article>
    ${
      plan.length > 1
        ? html`
          <nav class="sommaire" aria-labelledby="sommaire-titre">
            <h2 id="sommaire-titre">Sommaire</h2>
            <ol>${plan.map((p) => html`<li><a href="#${p.ancre}">${p.titre}</a></li>`)}</ol>
          </nav>
        `
        : ""
    }
    </div>
  `;
};

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
  libelles: Libelles;
  indisponible: boolean;
  statut?: string;
  personnel?: boolean;
  mention?: string;
};

export const chat = (f: Fil) => {
  const conv = f.conversation;
  // Le titre donné d'office reprend la première question, affichée juste dessous : il reste
  // pour les lecteurs d'écran, et reparaît une fois la conversation renommée.
  const titreRepete =
    !!conv && !!f.messages[0]?.question.replace(/\s+/g, " ").startsWith(conv.titre);
  const derniere = f.messages.findLastIndex((m) => m.etat === "answered");
  const enCours = f.messages.some((m) => !m.resultat);
  const nom = nomPerimetre(f.catalogue, f.perimetre, f.libelles) || "toutes tes ressources";
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
          <h1 id="titre-chat" tabindex="-1" ${
            titreRepete ? html`class="visuellement-cache"` : ""
          }>${conv?.titre ?? "Nouvelle conversation"}</h1>
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
              <div class="composeur">
                <button type="button" class="lien" data-aller-reponse hidden>Aller à la nouvelle réponse</button>
                <div class="perimetre">
                  <p id="perimetre" aria-live="polite">Dans : ${nom}</p>
                  <details ${f.indisponible ? "open" : ""}>
                    <summary>Changer</summary>
                    <form ${changer} data-focus=".perimetre summary">
                      ${selectsPerimetre(f.catalogue, f.perimetre, f.libelles)}
                      <button>Appliquer aux prochaines questions</button>
                    </form>
                    ${
                      f.catalogue.matieres.length > 1
                        ? html`
                        <form ${changer} data-focus=".perimetre summary">
                          <fieldset>
                            <legend>${f.libelles.matieres} à comparer</legend>
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
