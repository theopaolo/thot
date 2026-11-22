import { html } from "hono/html";
import { icone } from "../icones.ts";
import { type Catalogue, idsMatieres, type Scope } from "../domaines.ts";
import type { Libelles } from "../instance.ts";
import { champsScope, selectsPerimetre } from "./perimetre.ts";
import { nomPerimetre } from "./commun.ts";
import { attente, panneauSource, question, reponse } from "./echange.ts";
import { cleEnvoi, idee } from "./eleve-commun.ts";
import { type ConversationVue, listeConversations } from "./eleve-conversations.ts";

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
