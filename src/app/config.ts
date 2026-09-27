import { fromFileUrl, join } from "@std/path";

const env = (cle: string, defaut: string) => Deno.env.get(cle) || defaut;

export const RACINE = fromFileUrl(new URL("../../", import.meta.url));

export const config = {
  donnees: env("THOT_DATA_DIR", join(RACINE, "data")),
  port: Number(env("THOT_PORT", "8000")),
  schoolId: env("THOT_SCHOOL_ID", "pilote"),
  retentionJours: Number(env("THOT_RETENTION_JOURS", "90")),
  // Seuil calibré sur le corpus pilote: mesures/thot-real/resultats_abstention.json,
  // qwen3-reranker-8b, AUC 0,952. Tout changement de modèle ou de corpus le rend obsolète.
  seuil: Number(env("THOT_SEUIL_ABSTENTION", "0.023")),
  modeles: {
    cle: Deno.env.get("OPENROUTER_API_KEY"),
    url: env("THOT_OPENROUTER_URL", "https://openrouter.ai/api/v1"),
    legende: env("THOT_MODELE_LEGENDE", "google/gemma-4-26b-a4b-it"),
    reclasseur: env("THOT_MODELE_RECLASSEUR", "qwen/qwen3-reranker-8b"),
    generation: env("THOT_MODELE_GENERATION", "deepseek/deepseek-v4.1-flash"),
    soutien: env("THOT_MODELE_SOUTIEN", "z-ai/glm-5.3"),
    cleMistral: Deno.env.get("MISTRAL_API_KEY"),
    soutienMistral: env("THOT_MODELE_SOUTIEN_MISTRAL", "zai-glm-5-3"),
    // DeepSeek V4.1 Flash sans raisonnement: 1,7 s de médiane et des citations plus fidèles
    // que gpt-oss-120b (tasks/ensuite/mod-101.md).
    effort: env("THOT_EFFORT_GENERATION", "none"),
  },
};

export const contenu = (...chemin: string[]) => join(config.donnees, "content", ...chemin);
