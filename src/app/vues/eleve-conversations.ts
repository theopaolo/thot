import { html } from "hono/html";

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

export const listeConversations = (
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
