import { fromFileUrl, join, resolve } from "@std/path";

const env = (cle: string, defaut: string) => Deno.env.get(cle) || defaut;

export const RACINE = fromFileUrl(new URL("../../", import.meta.url));

const autorise = (cle: string) => {
  const valeur = env(cle, "1");
  if (!["0", "1"].includes(valeur)) throw new Error(`${cle}: utiliser 0 ou 1.`);
  return valeur === "1";
};

const origine = Deno.env.get("THOT_ORIGIN") || "";
if (origine) {
  const url = new URL(origine);
  if (
    url.origin !== origine ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  ) throw new Error("THOT_ORIGIN: origine HTTPS requise (HTTP permis sur localhost).");
}

export const fournisseurs = {
  openrouter: {
    autorise: autorise("THOT_OPENROUTER_ENABLED"),
    localisation: env("THOT_OPENROUTER_LOCATION", "Non renseignée"),
  },
  mistral: {
    autorise: autorise("THOT_MISTRAL_ENABLED"),
    localisation: env("THOT_MISTRAL_LOCATION", "Non renseignée"),
  },
};

export const config = {
  // Posé par `deno task dev` (src/main.ts). Les mots de passe ordinaires ne sont plus vérifiés.
  dev: Deno.env.get("THOT_DEV") === "1",
  donnees: resolve(env("THOT_DATA_DIR", join(RACINE, "data"))),
  origine,
  port: Number(env("THOT_PORT", "8000")),
  schoolId: env("THOT_SCHOOL_ID", "pilote"),
  retentionJours: Number(env("THOT_RETENTION_JOURS", "90")),
  // Seuil calibré sur le corpus pilote: mesures/thot-real/resultats_abstention.json,
  // qwen3-reranker-8b, AUC 0,952. Tout changement de modèle ou de corpus le rend obsolète.
  seuil: Number(env("THOT_SEUIL_ABSTENTION", "0.023")),
  modeles: {
    cle: fournisseurs.openrouter.autorise ? Deno.env.get("OPENROUTER_API_KEY") : undefined,
    url: env("THOT_OPENROUTER_URL", "https://openrouter.ai/api/v1"),
    legende: env("THOT_MODELE_LEGENDE", "google/gemma-4-26b-a4b-it"),
    reclasseur: env("THOT_MODELE_RECLASSEUR", "qwen/qwen3-reranker-8b"),
    generation: env("THOT_MODELE_GENERATION", "deepseek/deepseek-v4.1-flash"),
    soutien: env("THOT_MODELE_SOUTIEN", "z-ai/glm-5.3"),
    cleMistral: fournisseurs.mistral.autorise ? Deno.env.get("MISTRAL_API_KEY") : undefined,
    soutienMistral: env("THOT_MODELE_SOUTIEN_MISTRAL", "zai-glm-5-3"),
    // DeepSeek V4.1 Flash sans raisonnement: 1,7 s de médiane et des citations plus fidèles
    // que gpt-oss-120b (tasks/ensuite/mod-101.md).
    effort: env("THOT_EFFORT_GENERATION", "none"),
  },
};

export const contenu = (...chemin: string[]) => join(config.donnees, "content", ...chemin);

export function preparerDonnees() {
  Deno.mkdirSync(config.donnees, { recursive: true, mode: 0o700 });
  const temporaire = join(config.donnees, "tmp");
  Deno.mkdirSync(temporaire, { recursive: true, mode: 0o700 });
  Deno.env.set("TMPDIR", temporaire);
  Deno.env.set("SQLITE_TMPDIR", temporaire);
}
