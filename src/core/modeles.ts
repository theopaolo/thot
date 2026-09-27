/** Une panne de fournisseur. Elle ne doit jamais se lire comme un refus hors corpus. */
export class PanneModele extends Error {
  constructor(message: string, readonly code = "MODEL_UNAVAILABLE") {
    super(message);
  }
}

export type Message = { role: "system" | "user" | "assistant"; content: string };

/** Accès aux modèles. Deux implémentations: OpenRouter, et un faux pour les tests. */
export interface Modeles {
  legender(image: Uint8Array, mime: string): Promise<{ texte: string; modele: string }>;
  reclasser(question: string, documents: string[]): Promise<{ index: number; score: number }[]>;
  generer(messages: Message[]): Promise<{ texte: string; modele: string }>;
  reformuler(questionPrecedente: string, question: string): Promise<string>;
  /** probabilité que `citation`, lue sous le titre de son extrait, suffise à établir `texte` */
  soutenir(
    texte: string,
    citation: string,
    titre: string,
  ): Promise<{ probabilite: number; modele: string }>;
}

export type Cache = { lire(cle: string): string | undefined; ecrire(cle: string, v: string): void };

export type ConfigModeles = {
  cle?: string;
  url?: string;
  legende: string;
  reclasseur: string;
  generation: string;
  soutien: string;
  /** clé de l'API Mistral: le juge y passe d'abord quand elle est là */
  cleMistral?: string;
  soutienMistral: string;
  /** effort de réflexion du générateur (`none`, `low`, `medium`, `high`). Absent: celui du fournisseur. */
  effort?: string;
};

export const CONSIGNE_LEGENDE = `Tu decris une image d'un corpus pedagogique d'arts appliques
(lycee, Terminale) pour qu'un eleve puisse la RETROUVER en la cherchant avec
ses propres mots.

Ecris en francais, 40 a 70 mots, un seul paragraphe, sans titre ni puces.

Decris ce qui se VOIT, et rien d'autre : le type d'objet represente, sa forme
generale, ses couleurs, sa matiere, ce que font les personnages s'il y en a,
et les deux ou trois details qui frappent en premier. A cote de chaque terme
technique, donne l'equivalent en mots de tous les jours, celui qu'emploierait
quelqu'un qui ne connait pas le vocabulaire de la discipline.

N'invente jamais de nom d'auteur, de date ni de lieu que tu ne lis pas dans
l'image. Si un texte est ecrit dans l'image, recopie-le entre guillemets.
Ne reprends aucune formulation de cette consigne.`;

// Le juge ne voit pas le paragraphe autour de la citation: avec lui, il acceptait des faits
// présents seulement dans le paragraphe (ADR 0006).
const CONSIGNE_SOUTIEN = `Tu controles une reponse faite a un eleve. On te donne une phrase
de la reponse, le titre de l'extrait du cours et le passage cite pour la prouver.

Le titre peut donner le sujet de la phrase : le mouvement, l'artiste ou l'oeuvre dont
parle l'extrait. Tout le reste doit venir du passage.

Reponds "oui" si le titre et le passage suffisent a etablir tout ce que dit la phrase.
Reponds "non" si la phrase ajoute, generalise, inverse ou attribue a quelqu'un d'autre
ce que dit le passage.

Reponds par un seul mot : oui ou non.`;

/** P(oui) parmi les jetons les plus probables du premier token de sortie. */
export function probabiliteOui(tops: { token: string; logprob: number }[]) {
  const masse = (mot: string) =>
    tops.filter((t) => t.token.trim().toLowerCase() === mot)
      .reduce((s, t) => s + Math.exp(t.logprob), 0);
  const oui = masse("oui");
  const non = masse("non");
  return oui + non ? oui / (oui + non) : undefined;
}

type Jeton = {
  token: string;
  logprob: number;
  top_logprobs?: { token: string; logprob: number }[];
};
type Choix = {
  message?: { content?: string | { type: string; text?: string }[] | null };
  logprobs?: { content?: Jeton[] | null } | null;
};

/**
 * Verdict du juge dans une réponse de chat: P(oui) sur le premier jeton de la réponse, sinon le
 * verdict écrit, qui vaut 1 ou 0. Certains hébergeurs annoncent les logprobs et n'en rendent pas.
 * Chez Mistral, le contenu mêle raisonnement et texte, et les logprobs couvrent le raisonnement:
 * la réponse commence après `</think>`.
 */
export function lireVerdict(choix: Choix | undefined) {
  const contenu = choix?.message?.content;
  const ecrit =
    (Array.isArray(contenu)
      ? contenu.filter((p) => p.type === "text").map((p) => p.text ?? "").join("")
      : String(contenu ?? "")).trim().toLowerCase();
  const jetons = choix?.logprobs?.content ?? [];
  let i = jetons.findLastIndex((j) => j.token.includes("</think>")) + 1;
  while (i < jetons.length && !jetons[i].token.trim()) i++;
  const tops = jetons[i]?.top_logprobs;
  return (tops && probabiliteOui(tops)) ??
    (/^\W*oui/.test(ecrit) ? 1 : /^\W*non/.test(ecrit) ? 0 : undefined);
}

async function empreinte(s: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0")).join("");
}

const base64 = (octets: Uint8Array) => {
  let s = "";
  for (let i = 0; i < octets.length; i += 0x8000) {
    s += String.fromCharCode(...octets.subarray(i, i + 0x8000));
  }
  return btoa(s);
};

export function openrouter(config: ConfigModeles, cache?: Cache): Modeles {
  async function post(chemin: string, corps: unknown, cacheable = false) {
    if (!config.cle) {
      throw new PanneModele("OPENROUTER_API_KEY absente: aucun modèle n'est joignable.", "NO_KEY");
    }
    const cle = await empreinte(chemin + JSON.stringify(corps));
    const connu = cacheable ? cache?.lire(cle) : undefined;
    if (connu) return JSON.parse(connu);
    // Une seconde tentative après une panne passagère: réseau, 429, 5xx, erreur dans le corps.
    let derniere = "";
    for (const attente of [0, 1500]) {
      if (attente) await new Promise((r) => setTimeout(r, attente));
      let reponse: Response;
      try {
        reponse = await fetch((config.url ?? "https://openrouter.ai/api/v1") + chemin, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.cle}`,
            "content-type": "application/json",
            "X-OpenRouter-Cache": "false",
          },
          body: JSON.stringify(corps),
          signal: AbortSignal.timeout(90_000),
        });
      } catch (e) {
        derniere = `OpenRouter injoignable: ${(e as Error).message}`;
        continue;
      }
      if (!reponse.ok) {
        derniere = `OpenRouter ${reponse.status}: ${(await reponse.text()).slice(0, 300)}`;
        if (reponse.status === 429 || reponse.status >= 500) continue;
        throw new PanneModele(derniere);
      }
      const json = await reponse.json();
      if (json.error) {
        derniere = `OpenRouter: ${JSON.stringify(json.error).slice(0, 300)}`;
        continue;
      }
      if (cacheable) cache?.ecrire(cle, JSON.stringify(json));
      return json;
    }
    throw new PanneModele(derniere);
  }

  async function chat(
    modele: string,
    messages: unknown[],
    maxTokens: number,
    raisonnement: boolean | string = true,
    cacheable = false,
  ) {
    const corps: Record<string, unknown> = {
      model: modele,
      messages,
      temperature: 0,
      max_tokens: maxTokens,
    };
    // Même modèle, hébergeur le plus rapide: la latence d'une réponse élève en dépend.
    corps.provider = { sort: "throughput", zdr: true, data_collection: "deny" };
    if (raisonnement === false) corps.reasoning = { enabled: false };
    else if (typeof raisonnement === "string") corps.reasoning = { effort: raisonnement };
    const json = await post("/chat/completions", corps, cacheable);
    const choix = json.choices?.[0];
    return {
      texte: (choix?.message?.content ?? "") as string,
      coupe: choix?.finish_reason === "length",
    };
  }

  return {
    async legender(image, mime) {
      const url = `data:${mime};base64,${base64(image)}`;
      const { texte } = await chat(
        config.legende,
        [{
          role: "user",
          content: [{ type: "text", text: CONSIGNE_LEGENDE }, {
            type: "image_url",
            image_url: { url },
          }],
        }],
        400,
        false,
        true,
      );
      if (!texte.trim()) throw new PanneModele("Légende vide.", "MODEL_EMPTY_RESPONSE");
      return { texte: texte.trim(), modele: config.legende };
    },

    async reclasser(question, documents) {
      if (!documents.length) return [];
      const json = await post("/rerank", {
        model: config.reclasseur,
        query: question,
        documents: documents.map((d) => d.slice(0, 8000)),
        provider: { zdr: true, data_collection: "deny" },
      });
      return (json.results as { index: number; relevance_score: number }[])
        .map((r) => ({ index: r.index, score: r.relevance_score }))
        .sort((a, b) => b.score - a.score);
    },

    async generer(messages) {
      // Un générateur qui raisonne le fait sur le même budget de sortie. Une réponse vide à 2 400 tokens est
      // retentée à 6 000 avant d'être déclarée vide, comme dans le banc d'essai.
      for (const budget of [2400, 6000]) {
        const { texte, coupe } = await chat(
          config.generation,
          messages,
          budget,
          config.effort ?? true,
        );
        // Une sortie coupée au budget n'est pas un JSON complet: on la retente plus large.
        if (texte.trim() && (!coupe || budget === 6000)) {
          return { texte, modele: config.generation };
        }
      }
      throw new PanneModele("Le générateur a rendu une sortie vide.", "MODEL_EMPTY_RESPONSE");
    },

    async reformuler(questionPrecedente, question) {
      const { texte } = await chat(
        config.generation,
        [
          {
            role: "system",
            content:
              "Reformule la deuxième question pour qu'elle se comprenne seule, en ajoutant seulement le contexte nécessaire de la première. Si elle est déjà autonome, recopie-la. Une seule question, sans commentaire ni réponse.",
          },
          {
            role: "user",
            content: `Question précédente : ${questionPrecedente}\nNouvelle question : ${question}`,
          },
        ],
        // Le raisonnement compte dans le budget. Sans effort réglé, `low` borne la latence.
        600,
        config.effort ?? "low",
      );
      return texte.trim();
    },

    async soutenir(texte, citation, titre) {
      const messages = [
        { role: "system", content: CONSIGNE_SOUTIEN },
        {
          role: "user",
          content: `Titre : ${titre}\nPassage : « ${citation} »\nPhrase : « ${texte} »`,
        },
      ];
      // Voie directe: GLM 5.3 chez Mistral, en UE. Une erreur, un 429 ou plus de 2,5 s passent
      // la main à OpenRouter.
      if (config.cleMistral) {
        try {
          const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.cleMistral}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: config.soutienMistral,
              messages,
              temperature: 0,
              top_p: 1,
              max_tokens: 3000,
              reasoning_effort: "low",
              logprobs: true,
              top_logprobs: 10,
            }),
            signal: AbortSignal.timeout(2500),
          });
          if (r.ok) {
            const probabilite = lireVerdict((await r.json()).choices?.[0]);
            if (probabilite !== undefined) {
              return { probabilite, modele: `mistral/${config.soutienMistral}` };
            }
          } else await r.body?.cancel();
        } catch { /* relève par OpenRouter */ }
      }
      const json = await post("/chat/completions", {
        model: config.soutien,
        messages,
        temperature: 0,
        // Le juge raisonne brièvement, puis ses logprobs portent sur le premier jeton de la
        // réponse. Le budget couvre le raisonnement.
        max_tokens: 3000,
        reasoning: { effort: "low" },
        logprobs: true,
        top_logprobs: 10,
        // Sans `require_parameters`, un hébergeur sans logprobs répond quand même, sans elles.
        // Mistral sert GLM 5.3 en UE: 316 ms de médiane contre 1 s chez Modal, que `throughput`
        // choisissait. `order` garde la relève des autres hébergeurs.
        provider: {
          require_parameters: true,
          zdr: true,
          data_collection: "deny",
          order: ["Mistral"],
        },
      }, true);
      const probabilite = lireVerdict(json.choices?.[0]);
      if (probabilite === undefined) {
        throw new PanneModele(
          `Ni « oui » ni « non » en tête de sortie: ${
            JSON.stringify(json.choices?.[0]?.message?.content ?? null).slice(0, 200)
          }`,
          "MODEL_EMPTY_RESPONSE",
        );
      }
      return { probabilite, modele: config.soutien };
    },
  };
}
