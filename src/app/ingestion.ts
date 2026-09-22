import { assembler, type Bloc, decouper, type Extraction } from "../core/document.ts";
import { extraireHtml } from "../core/html.ts";
import type { Modeles } from "../core/modeles.ts";
import { extrairePdf } from "../core/pdf.ts";
import { type ChunkIndexe, indexerSource, retirerSource, transaction } from "../core/recherche.ts";
import { contenu } from "./config.ts";
import { type Db, maintenant } from "./db.ts";
import { sha256 } from "./depot.ts";

const VERROU_MS = 5 * 60_000;
const MAX_TENTATIVES = 3;

const horodatage = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";

export type Job = { id: string; source_id: string; tentatives: number };

type Source = {
  id: string;
  school_id: string;
  titre: string;
  metadonnees: string;
  fichier: string;
  format: string;
  statut: string;
};

/**
 * Revendique le plus ancien travail en attente, ou un travail dont le verrou a expiré parce que
 * son worker est mort. Une seule instruction UPDATE: deux workers ne prennent pas le même.
 */
export function revendiquer(db: Db, maintenantMs = Date.now()): Job | undefined {
  const t = horodatage(maintenantMs);
  db.prepare(
    `UPDATE ingestion_jobs SET etat = 'failed', verrou_expire_le = NULL, maj_le = ?,
       erreur = 'Interrompu ${MAX_TENTATIVES} fois, abandonné.'
     WHERE etat IN ('extracting', 'enriching') AND verrou_expire_le < ? AND tentatives >= ?`,
  ).run(t, t, MAX_TENTATIVES);
  return db.prepare(
    `UPDATE ingestion_jobs SET etat = 'extracting', tentatives = tentatives + 1,
       verrou_expire_le = ?, maj_le = ?
     WHERE id = (SELECT id FROM ingestion_jobs
                 WHERE etat = 'received'
                    OR (etat IN ('extracting', 'enriching') AND verrou_expire_le < ?)
                 ORDER BY cree_le LIMIT 1)
     RETURNING id, source_id, tentatives`,
  ).get(horodatage(maintenantMs + VERROU_MS), t, t) as Job | undefined;
}

async function ecrireAtomique(chemin: string, donnees: string | Uint8Array) {
  const tmp = `${chemin}.partiel`;
  if (typeof donnees === "string") await Deno.writeTextFile(tmp, donnees);
  else await Deno.writeFile(tmp, donnees);
  await Deno.rename(tmp, chemin);
}

const lireSource = (db: Db, id: string) =>
  db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as unknown as Source;

async function extraire(s: Source): Promise<Extraction> {
  const chemin = contenu(s.id, "original", s.fichier);
  if (s.format === "pdf") return await extrairePdf(chemin);
  if (s.format === "html") return extraireHtml(await Deno.readTextFile(chemin), s.titre);
  const extension = s.format;
  return {
    parties: [{ texte: s.titre, section: s.titre }],
    images: [{
      octets: await Deno.readFile(chemin),
      mime: extension === "jpg" ? "image/jpeg" : `image/${extension}`,
      extension,
    }],
    avertissements: [],
  };
}

function etat(db: Db, job: Job, etat: string, avertissements: string[], fin = false) {
  db.prepare(
    `UPDATE ingestion_jobs SET etat = ?, etape = ?, avertissements = ?, maj_le = ?,
       progression = ?, verrou_expire_le = CASE WHEN ? THEN NULL ELSE verrou_expire_le END
     WHERE id = ?`,
  ).run(
    etat,
    etat,
    JSON.stringify(avertissements),
    maintenant(),
    fin ? 1 : 0.5,
    fin ? 1 : 0,
    job.id,
  );
}

/** Extraction puis légendes. Un échec de légende devient un avertissement, pas un échec du travail. */
export async function traiter(db: Db, job: Job, modeles: Modeles) {
  const s = lireSource(db, job.source_id);
  try {
    const ext = await extraire(s);
    const doc = assembler(ext.parties);
    const avertissements = [...ext.avertissements];
    if (!doc.texte && !ext.images.length) avertissements.push("Aucun texte ni image extrait.");

    const dossier = contenu(s.id);
    await Deno.mkdir(`${dossier}/assets`, { recursive: true });
    await ecrireAtomique(`${dossier}/document.txt`, doc.texte);
    await ecrireAtomique(
      `${dossier}/blocs.jsonl`,
      doc.blocs.map((b) => JSON.stringify(b)).join("\n"),
    );
    const ins = db.prepare(
      `INSERT OR IGNORE INTO images (id, source_id, position, fichier, mime, checksum)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const [i, img] of ext.images.entries()) {
      const fichier = `image-${i}.${img.extension}`;
      await ecrireAtomique(`${dossier}/assets/${fichier}`, img.octets);
      ins.run(`${s.id}-${i}`, s.id, i, fichier, img.mime, await sha256(img.octets));
    }
    etat(db, job, "enriching", avertissements);

    const aLegender = db.prepare(
      "SELECT id, fichier, mime FROM images WHERE source_id = ? AND legende IS NULL",
    ).all(s.id) as { id: string; fichier: string; mime: string }[];
    for (const img of aLegender) {
      try {
        const { texte, modele } = await modeles.legender(
          await Deno.readFile(`${dossier}/assets/${img.fichier}`),
          img.mime,
        );
        db.prepare(
          "UPDATE images SET legende = ?, legende_origine = 'generated', modele = ? WHERE id = ?",
        ).run(texte, modele, img.id);
      } catch (e) {
        avertissements.push(`Légende non produite: ${(e as Error).message}`);
      }
    }
    etat(db, job, "awaiting_review", avertissements, true);
    // Une source déjà certifiée qu'on réingère se réindexe avec son nouveau texte.
    if (s.statut === "certifiee") indexer(db, s.id);
  } catch (e) {
    db.prepare(
      `UPDATE ingestion_jobs SET etat = 'failed', erreur = ?, verrou_expire_le = NULL, maj_le = ?
       WHERE id = ?`,
    ).run((e as Error).message, maintenant(), job.id);
  }
}

export type Meta = { sequence?: string; seance?: string };

export function lireDocument(sourceId: string): { texte: string; blocs: Bloc[] } {
  const dossier = contenu(sourceId);
  const texte = Deno.readTextFileSync(`${dossier}/document.txt`);
  const blocs = Deno.readTextFileSync(`${dossier}/blocs.jsonl`).split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as Bloc);
  return { texte, blocs };
}

/** Chunks d'une source: texte de recherche avec toutes les légendes, preuve avec les certifiées. */
export function chunksSource(db: Db, sourceId: string): ChunkIndexe[] {
  const s = lireSource(db, sourceId);
  const meta = JSON.parse(s.metadonnees) as Meta;
  const contexte = [meta.sequence?.replace(/^ATC /, ""), meta.seance].filter(Boolean).join(" / ");
  const images = db.prepare(
    `SELECT legende, legende_statut FROM images
     WHERE source_id = ? AND legende IS NOT NULL AND legende_statut != 'rejected' ORDER BY position`,
  ).all(sourceId) as { legende: string; legende_statut: string }[];
  const chunks = decouper(lireDocument(sourceId));
  return chunks.map((c, i) => {
    // Les images d'une page accompagnent son premier passage.
    const legendes = i === 0 ? images : [];
    const titre = c.section && c.section !== s.titre && c.section !== "Introduction"
      ? `${s.titre} : ${c.section}`
      : s.titre;
    return {
      id: c.id,
      source_id: s.id,
      school_id: s.school_id,
      titre,
      debut: c.debut,
      fin: c.fin,
      texte: c.texte,
      rappel: [contexte, titre, c.texte, ...legendes.map((l) => l.legende)].filter(Boolean).join(
        "\n",
      ),
      preuve: [
        c.texte,
        ...legendes.filter((l) => l.legende_statut === "certified").map((l) =>
          `Image : ${l.legende}`
        ),
      ].join("\n\n"),
    };
  });
}

/** Seule une source certifiée entre dans l'index. Toute autre en sort. */
export function indexer(db: Db, sourceId: string) {
  const s = lireSource(db, sourceId);
  const chunks = s.statut === "certifiee" ? chunksSource(db, sourceId) : [];
  transaction(db, () => {
    if (chunks.length) indexerSource(db, sourceId, chunks);
    else retirerSource(db, sourceId);
  });
}

export function statuer(db: Db, sourceId: string, statut: "certifiee" | "rejetee", par: string) {
  db.prepare("UPDATE sources SET statut = ?, statut_par = ?, statut_le = ? WHERE id = ?")
    .run(statut, par, maintenant(), sourceId);
  indexer(db, sourceId);
}

export function relireLegende(
  db: Db,
  imageId: string,
  action: "certified" | "rejected",
  texte: string,
  par: string,
) {
  const img = db.prepare("SELECT source_id, legende FROM images WHERE id = ?").get(imageId) as
    | { source_id: string; legende: string }
    | undefined;
  if (!img) return;
  const corrigee = action === "certified" && texte.trim() && texte.trim() !== img.legende;
  db.prepare(
    `UPDATE images SET legende_statut = ?, relu_par = ?, relu_le = ?,
       legende = CASE WHEN ? THEN ? ELSE legende END,
       legende_origine = CASE WHEN ? THEN 'teacher' ELSE legende_origine END
     WHERE id = ?`,
  ).run(action, par, maintenant(), corrigee ? 1 : 0, texte.trim(), corrigee ? 1 : 0, imageId);
  indexer(db, img.source_id);
}
