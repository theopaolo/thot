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
}

export type Cache = { lire(cle: string): string | undefined; ecrire(cle: string, v: string): void };

export type ConfigModeles = {
  cle?: string;
  url?: string;
  legende: string;
  reclasseur: string;
  generation: string;
  /** effort de réflexion du générateur (`low`, `medium`, `high`). Absent: celui du fournisseur. */
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
    return (json.choices?.[0]?.message?.content ?? "") as string;
  }

  return {
    async legender(image, mime) {
      const url = `data:${mime};base64,${base64(image)}`;
      const texte = await chat(
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
      // gpt-oss raisonne sur le même budget de sortie. Une réponse vide à 2 400 tokens est
      // retentée à 6 000 avant d'être déclarée vide, comme dans le banc d'essai.
      for (const budget of [2400, 6000]) {
        const texte = await chat(config.generation, messages, budget, config.effort ?? true);
        if (texte.trim()) return { texte, modele: config.generation };
      }
      throw new PanneModele("Le générateur a rendu une sortie vide.", "MODEL_EMPTY_RESPONSE");
    },

    async reformuler(questionPrecedente, question) {
      const texte = await chat(
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
        120,
        false,
      );
      return texte.trim();
    },
  };
}
