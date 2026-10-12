// Banc privé : deno run -RWNE --env-file=.env evaluation/bench_vision.ts probe|run|eval
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "@std/path";
import { config, RACINE } from "../src/app/config.ts";
import { nomSur } from "../src/app/depot.ts";
import { indexer } from "../src/app/ingestion.ts";
import { CONSIGNE_LEGENDE, openrouter } from "../src/core/modeles.ts";
import { chercher } from "../src/core/recherche.ts";

const modeleIds = ["google/gemma-4-26b-a4b-it", "mistralai/mistral-large-4-0"];
const dossier = join(RACINE, "data/benchmark-ml4");
const imgOrder = JSON.parse(
  await Deno.readTextFile(join(RACINE, "../mesures/thot-real/img_order.json")),
) as string[];
const docs = JSON.parse(
  await Deno.readTextFile(join(RACINE, "../mesures/thot-real/docs.json")),
) as { id: string; titre: string }[];
const requetes = JSON.parse(await Deno.readTextFile(join(RACINE, "evaluation/queries_real.json"))) as
  { qid: string; type: string; q: string; gold: (number | string)[] }[];
type Ligne = { id: string; sourceId: string; fichier: string; mime: string; rel: string };
type Mesure = {
  texte?: string;
  ms: number;
  erreur?: string;
  completionTokens?: number;
  resolvedModel?: string;
  provider?: string;
};

const dbSource = new DatabaseSync(join(dossier, "snapshot.sqlite3"), { readOnly: true });
const sources = dbSource.prepare(
  "SELECT id, fichier, json_extract(metadonnees, '$.sequence') AS sequence FROM sources",
).all() as { id: string; fichier: string; sequence: string }[];
const lignes = (dbSource.prepare(
  "SELECT id, source_id AS sourceId, fichier, mime FROM images ORDER BY rowid",
).all() as Omit<Ligne, "rel">[]).map((l) => {
  const source = sources.find((s) => s.id === l.sourceId)!;
  return { ...l, rel: `${source.sequence}/${source.fichier}` };
});
dbSource.close();
const plier = (s: string) =>
  s.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const cible = (g: number | string): { source: string; rubrique?: string }[] => {
  if (typeof g === "number") {
    const rel = imgOrder[g];
    if (!rel) throw new Error(`Gold image ${g} absent`);
    return sources.filter((s) => s.fichier === nomSur(basename(rel)) && s.sequence === dirname(rel))
      .map((s) => ({ source: s.id }));
  }
  if (g.includes("#")) {
    return docs.filter((d) => d.id.toLowerCase().includes(g.toLowerCase())).flatMap((d) => {
      const rubrique = d.titre.split(" — ").at(-1);
      return sources.filter((s) => s.fichier === nomSur(d.id.split("#")[0]))
        .map((s) => ({ source: s.id, rubrique }));
    });
  }
  return sources.filter((s) => plier(`${s.sequence} ${s.fichier}`).includes(plier(g)))
    .map((s) => ({ source: s.id }));
};
const pct = (n: number, d: number) => d ? Math.round(1000 * n / d) / 10 : 0;
const quantile = (a: number[], p: number) => a.length
  ? [...a].sort((x, y) => x - y)[Math.ceil(p * a.length) - 1]
  : null;
const resumer = (a: { rang: number }[]) => ({
  n: a.length,
  succes_5: pct(a.filter((x) => x.rang > 0).length, a.length),
  mrr: a.length ? Math.round(1000 * a.reduce((s, x) => s + (x.rang ? 1 / x.rang : 0), 0) / a.length) / 1000 : 0,
});

// Vérifie la correspondance des 181 images et des 59 cibles avant tout appel payant.
if (lignes.length !== 181 || requetes.length !== 59 ||
  imgOrder.some((rel) => !lignes.some((l) =>
    l.rel === `${dirname(rel)}/${nomSur(basename(rel))}`)) ||
  requetes.some((r) => !r.gold.flatMap(cible).length)) {
  throw new Error("Corpus ou cibles non alignés avec le banc figé");
}
if (resumer([{ rang: 1 }, { rang: 0 }, { rang: 2 }]).mrr !== 0.5) {
  throw new Error("Calcul MRR incorrect");
}

const vraiFetch = globalThis.fetch;
let mesureActive: Mesure | undefined;
globalThis.fetch = async (input, init) => {
  const reponse = await vraiFetch(input, init);
  if (mesureActive && String(input).endsWith("/chat/completions") && reponse.ok) {
    const json = await reponse.clone().json();
    if (typeof json.usage?.completion_tokens === "number") {
      mesureActive.completionTokens = json.usage.completion_tokens;
    }
    if (typeof json.model === "string") mesureActive.resolvedModel = json.model;
    const fournisseur = json.provider ?? reponse.headers.get("x-openrouter-provider");
    if (typeof fournisseur === "string") mesureActive.provider = fournisseur;
  }
  return reponse;
};

async function legender(modele: string, probe: boolean) {
  const chemin = join(dossier, `vision-${modele.replaceAll("/", "-")}.json`);
  const donnees: Record<string, Mesure> = await Deno.readTextFile(chemin).then(JSON.parse).catch(() => ({}));
  const modeles = openrouter({ ...config.modeles, legende: modele }); // aucun cache
  const aFaire = probe ? lignes.slice(0, 1) : lignes;
  for (const [i, l] of aFaire.entries()) {
    if (donnees[l.id]?.texte) continue;
    const t = performance.now();
    const mesure: Mesure = { ms: 0 };
    mesureActive = mesure;
    try {
      const img = await Deno.readFile(join(RACINE, "data/content", l.sourceId, "assets", l.fichier));
      const { texte } = await modeles.legender(img, l.mime, "arts-appliques");
      donnees[l.id] = { ...mesure, texte, ms: Math.round(performance.now() - t) };
    } catch (e) {
      donnees[l.id] = { ...mesure, erreur: String(e).slice(0, 400), ms: Math.round(performance.now() - t) };
      if (probe) throw e;
    } finally {
      mesureActive = undefined;
    }
    await Deno.writeTextFile(chemin, JSON.stringify(donnees));
    console.log(`${modele} ${i + 1}/${aFaire.length} ${donnees[l.id].erreur ? "ERREUR" : "ok"}`);
    // Mistral direct est partagé avec un autre banc ; même via OpenRouter, 24 débuts/min maximum.
    if (modele.startsWith("mistralai/") && !probe) {
      await new Promise((r) => setTimeout(r, Math.max(0, 2500 - (performance.now() - t))));
    }
  }
  return donnees;
}

async function evaluer(modele: string) {
  const slug = modele.replaceAll("/", "-");
  const donnees = JSON.parse(await Deno.readTextFile(join(dossier, `vision-${slug}.json`))) as
    Record<string, Mesure>;
  if (lignes.some((l) => !donnees[l.id]?.texte)) throw new Error(`${modele}: légendes incomplètes`);
  const copie = join(dossier, `vision-${slug}.sqlite3`);
  if (!(await Deno.stat(copie).catch(() => null))) {
    await Deno.copyFile(join(dossier, "snapshot.sqlite3"), copie);
  }
  const db = new DatabaseSync(copie);
  const maj = db.prepare(
    "UPDATE images SET legende = ?, legende_origine = 'generated', legende_statut = 'unreviewed', modele = ? WHERE id = ?",
  );
  for (const l of lignes) maj.run(donnees[l.id].texte!, modele, l.id);
  for (const s of sources) if (lignes.some((l) => l.sourceId === s.id)) indexer(db, s.id);
  const rechercheChemin = join(dossier, `recherche-${slug}.json`);
  const resultats: { qid: string; type: string; rang: number; cibles: number }[] =
    await Deno.readTextFile(rechercheChemin).then(JSON.parse).catch(() => []);
  if (!resultats.length) {
    const modeles = openrouter(config.modeles); // même reclasseur que la production, sans cache
    for (const r of requetes) {
      const attendus = r.gold.flatMap(cible);
      const trouves = (await chercher(db, modeles, r.q, { lecteur: null, schoolId: config.schoolId }, config.seuil)).retenus;
      const rang = trouves.findIndex((c) => attendus.some((a) =>
        a.source === c.source_id && (!a.rubrique || c.titre.endsWith(`: ${a.rubrique}`))
      )) + 1;
      resultats.push({ qid: r.qid, type: r.type, rang, cibles: attendus.length });
      console.log(`${modele} recherche ${resultats.length}/${requetes.length}`);
    }
    await Deno.writeTextFile(rechercheChemin, JSON.stringify(resultats));
  }
  db.close();
  const mesures = lignes.map((l) => donnees[l.id]);
  const lat = mesures.map((m) => m.ms);
  const mots = mesures.map((m) => m.texte!.trim().split(/\s+/u).length);
  const avecJetons = mesures.filter((m) => m.completionTokens !== undefined);
  const completionTokens = avecJetons.reduce((n, m) => n + m.completionTokens!, 0);
  const rapport = {
    modele,
    images: lignes.length,
    erreurs: mesures.filter((m) => m.erreur).length,
    mots_moyens: Math.round(mots.reduce((a, b) => a + b, 0) / mots.length),
    mots_40_70_pct: pct(mots.filter((n) => n >= 40 && n <= 70).length, mots.length),
    latence_ms: { p50: quantile(lat, 0.5), p95: quantile(lat, 0.95) },
    completion_tokens: avecJetons.length ? completionTokens : null,
    completion_tokens_couverture: `${avecJetons.length}/${mesures.length}`,
    effective_completion_tps: avecJetons.length
      ? Math.round(100 * completionTokens / (avecJetons.reduce((n, m) => n + m.ms, 0) / 1000)) / 100
      : null,
    fournisseurs: [...new Set(mesures.map((m) => m.provider).filter(Boolean))],
    modeles_resolus: [...new Set(mesures.map((m) => m.resolvedModel).filter(Boolean))],
    recherche: {
      tous: resumer(resultats),
      E: resumer(resultats.filter((x) => x.type === "E")),
      F: resumer(resultats.filter((x) => x.type === "F")),
      echecs: resultats.filter((x) => !x.rang).map((x) => x.qid),
    },
  };
  return rapport;
}

async function empreinte(chemin: string) {
  const bytes = await Deno.readFile(chemin);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function enveloppe(rapports: unknown[]) {
  const prompt = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CONSIGNE_LEGENDE));
  const imageHashes = [];
  for (const l of lignes) {
    imageHashes.push(`${l.id}:${await empreinte(join(RACINE, "data/content", l.sourceId, "assets", l.fichier))}`);
  }
  const images = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(imageHashes.join("\n")));
  const hex = (bytes: ArrayBuffer) =>
    [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return {
    date: new Date().toISOString(),
    corpus: "181 images et 59 requêtes figées",
    reclasseur: config.modeles.reclasseur,
    sha256: {
      snapshot: await empreinte(join(dossier, "snapshot.sqlite3")),
      requetes: await empreinte(join(RACINE, "evaluation/queries_real.json")),
      ordre_images: await empreinte(join(RACINE, "../mesures/thot-real/img_order.json")),
      images: hex(images),
      consigne: hex(prompt),
    },
    modeles: rapports,
  };
}

const action = Deno.args[0];
if (action === "probe") {
  for (const m of modeleIds) await legender(m, true);
} else if (action === "run") {
  const rapports = [];
  for (const m of modeleIds) {
    await legender(m, false);
    rapports.push(await evaluer(m));
  }
  await Deno.writeTextFile(join(RACINE, "evaluation/resultats/ml4-vision.json"),
    JSON.stringify(await enveloppe(rapports), null, 2));
} else if (action === "eval") {
  const rapports = [];
  for (const m of modeleIds) rapports.push(await evaluer(m));
  await Deno.writeTextFile(join(RACINE, "evaluation/resultats/ml4-vision.json"),
    JSON.stringify(await enveloppe(rapports), null, 2));
} else {
  throw new Error("Usage: bench_vision.ts probe|run|eval");
}
