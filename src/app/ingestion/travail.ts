import { mkdir, readFile } from "node:fs/promises";
import { assembler, type Extraction } from "../../core/document.ts";
import { extraireDocx } from "../../core/docx.ts";
import { extraireHtml, extrairePearltrees } from "../../core/html.ts";
import { extraireMarkdown } from "../../core/markdown.ts";
import type { Modeles } from "../../core/modeles.ts";
import { extrairePdf } from "../../core/pdf.ts";
import { extrairePptx, type Note } from "../../core/pptx.ts";
import { estAnglais, transaction } from "../../core/recherche.ts";
import { contenu } from "../config.ts";
import { type Db, maintenant } from "../db.ts";
import { sha256 } from "../depot.ts";
import { cheminImage, type ImageRevision, retirer, servirImages } from "./images.ts";
import { indexer, reindexer } from "./indexation.ts";
import {
  dossierRevision,
  ecrireAtomique,
  enregistrer,
  jsonl,
  lireSource,
  revisionEnAttente,
  type Source,
} from "./revisions.ts";

const VERROU_MS = 5 * 60_000;
const MAX_TENTATIVES = 3;
/**
 * Images légendées par extraction. Chaque légende est un appel payant d'au plus deux fois 90 s, et
 * le worker ne traite qu'un document à la fois. Les images suivantes sont importées sans légende.
 */
export const MAX_LEGENDES = 50;

const horodatage = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";

export type Job = { id: string; source_id: string; tentatives: number };

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
  return db
    .prepare(
      `UPDATE ingestion_jobs SET etat = 'extracting', tentatives = tentatives + 1,
       verrou_expire_le = ?, maj_le = ?
     WHERE id = (SELECT id FROM ingestion_jobs
                 WHERE etat = 'received'
                    OR (etat IN ('extracting', 'enriching') AND verrou_expire_le < ?)
                 ORDER BY cree_le LIMIT 1)
     RETURNING id, source_id, tentatives`,
    )
    .get(horodatage(maintenantMs + VERROU_MS), t, t) as Job | undefined;
}

/**
 * La tentative qui tient le travail. Chaque revendication incrémente `tentatives` : une tentative
 * dont le travail a été repris, terminé ou supprimé avec sa source ne retrouve plus sa ligne.
 */
const TENU = "id = ? AND tentatives = ? AND etat IN ('extracting', 'enriching')";

/** Prolonge le verrou de la tentative. Rend `false` quand elle ne tient plus le travail. */
const prolonger = (db: Db, job: Job) =>
  db
    .prepare(`UPDATE ingestion_jobs SET verrou_expire_le = ? WHERE ${TENU}`)
    .run(horodatage(Date.now() + VERROU_MS), job.id, job.tentatives).changes > 0;

const REMPLACEE = "Tentative remplacée.";

async function extraire(s: Source): Promise<Extraction & { notes?: Note[] }> {
  const chemin = contenu(s.id, "original", s.fichier);
  if (s.format === "pdf") return await extrairePdf(chemin, s.profil);
  if (s.format === "html") {
    // Le pilote arts appliqués dépose des exports Pearltrees. Une autre lecture changerait le
    // texte de ses sources à la réextraction.
    const lire = s.profil === "arts-appliques" ? extrairePearltrees : extraireHtml;
    return lire(await readFile(chemin, "utf8"), s.titre);
  }
  if (s.format === "md") return extraireMarkdown(await readFile(chemin, "utf8"), s.titre);
  if (s.format === "docx") return await extraireDocx(await readFile(chemin), s.titre);
  if (s.format === "pptx") {
    const meta = JSON.parse(s.metadonnees) as { diapositives_masquees?: boolean };
    return extrairePptx(await readFile(chemin), meta.diapositives_masquees === true);
  }
  const extension = s.format;
  return {
    parties: [{ texte: s.titre, section: s.titre }],
    images: [
      {
        octets: await readFile(chemin),
        mime: extension === "jpg" ? "image/jpeg" : `image/${extension}`,
        extension,
      },
    ],
    avertissements: [],
  };
}

/** Change l'état du travail. Lève si la tentative ne le tient plus. */
function etat(db: Db, job: Job, etat: string, avertissements: string[], fin = false) {
  const { changes } = db
    .prepare(
      `UPDATE ingestion_jobs SET etat = ?, etape = ?, avertissements = ?, maj_le = ?,
         progression = ?, verrou_expire_le = CASE WHEN ? THEN NULL ELSE verrou_expire_le END
       WHERE ${TENU}`,
    )
    .run(
      etat,
      etat,
      JSON.stringify(avertissements),
      maintenant(),
      fin ? 1 : 0.5,
      fin ? 1 : 0,
      job.id,
      job.tentatives,
    );
  if (!changes) throw new Error(REMPLACEE);
}

/**
 * Extraction puis légendes. Un échec de légende devient un avertissement, pas un échec du travail.
 * La tentative prolonge son verrou tant qu'elle travaille : aucun autre worker ne reprend le
 * travail, et `supprimerSource` refuse la source. Une tentative qui a perdu le travail n'écrit
 * plus rien, ni fichier, ni ligne, ni échec.
 */
export async function traiter(db: Db, job: Job, modeles: Modeles) {
  const s = lireSource(db, job.source_id);
  // Appelé avant chaque écriture : elle se fait alors sous un verrou qui vient d'être prolongé.
  const tenir = () => {
    if (!prolonger(db, job)) throw new Error(REMPLACEE);
  };
  // Une extraction ou une légende peut durer plus longtemps que le verrou.
  const minuteur = setInterval(() => {
    try {
      prolonger(db, job);
    } catch (e) {
      console.error(`verrou du travail ${job.id}:`, e);
    }
  }, VERROU_MS / 4);
  try {
    tenir();
    const ext = await extraire(s);
    const doc = assembler(ext.parties);
    const avertissements = [...ext.avertissements];
    if (s.langue !== "fr" && !estAnglais(s.langue)) {
      avertissements.push("Langue non prise en charge pour la recherche : " + s.langue);
    }
    if (!doc.texte && !ext.images.length) avertissements.push("Aucun texte ni image extrait.");

    const servies = new Set(
      db
        .prepare("SELECT checksum FROM images WHERE source_id = ?")
        .all(s.id)
        .map((i) => i.checksum as string),
    );
    // Une image répétée dans le document entre une fois, à sa première place. Le fichier porte
    // le nom de ses octets : un nom ne désigne jamais d'autres octets, et une image que la source
    // sert déjà garde le sien.
    const parOctets = new Map<string, ImageRevision>();
    const nouvelles: [string, Uint8Array][] = [];
    for (const img of ext.images) {
      const checksum = await sha256(img.octets);
      if (parOctets.has(checksum)) continue;
      const fichier = `${checksum}.${img.extension}`;
      if (!servies.has(checksum)) nouvelles.push([fichier, img.octets]);
      parOctets.set(checksum, { checksum, fichier, mime: img.mime, section: img.section ?? null });
    }
    // Les élèves lisent une source certifiée : ses images n'entrent ni ne sortent sans relecture.
    // Les mêmes images dans un autre ordre se rangent en place.
    const autresImages =
      s.statut === "certifiee" && (nouvelles.length > 0 || parOctets.size !== servies.size);

    tenir();
    enregistrer(db, s, doc, ext.avertissements, ext.notes, autresImages);
    // L'extraction vient de devenir la révision en attente, ou de confirmer la révision servie.
    const attente = revisionEnAttente(db, s.id);
    const n = attente?.n ?? s.revision;
    const dossier = dossierRevision(s.id, n);
    await mkdir(`${dossier}/assets`, { recursive: true });
    for (const [fichier, octets] of nouvelles) {
      tenir();
      ecrireAtomique(`${dossier}/assets/${fichier}`, octets);
    }
    const images = [...parOctets.values()];
    tenir();
    if (!attente) retirer(transaction(db, () => servirImages(db, s.id, n, images)));
    etat(db, job, "enriching", avertissements);

    const aLegender: { chemin: string; mime: string; garder(l: string, m: string): void }[] =
      attente
        ? images
            .filter((i) => !servies.has(i.checksum))
            .map((i) => ({
              chemin: `${dossier}/assets/${i.fichier}`,
              mime: i.mime,
              garder: (legende, modele) => void Object.assign(i, { legende, modele }),
            }))
        : (
            db
              .prepare(
                `SELECT id, revision, fichier, mime FROM images
                 WHERE source_id = ? AND legende IS NULL AND legende_statut = 'unreviewed'
                 ORDER BY position`,
              )
              .all(s.id) as { id: string; revision: number; fichier: string; mime: string }[]
          ).map((i) => ({
            chemin: cheminImage(s.id, i),
            mime: i.mime,
            // Un enseignant a pu relire l'image pendant l'appel : sa légende l'emporte.
            garder: (legende, modele) =>
              void db
                .prepare(
                  `UPDATE images SET legende = ?, legende_origine = 'generated', modele = ?
                   WHERE id = ? AND legende IS NULL AND legende_statut = 'unreviewed'`,
                )
                .run(legende, modele, i.id),
          }));
    const reste = aLegender.length - MAX_LEGENDES;
    if (reste > 0) {
      avertissements.push(
        `${reste} image${reste > 1 ? "s" : ""} sans légende proposée : Thot en légende ${MAX_LEGENDES} par extraction.`,
      );
    }
    for (const img of aLegender.slice(0, MAX_LEGENDES)) {
      // Hors du `try` des légendes : un travail perdu s'arrête, il ne devient pas un avertissement.
      tenir();
      let legende;
      try {
        legende = await modeles.legender(await readFile(img.chemin), img.mime, s.profil);
      } catch (e) {
        avertissements.push(`Légende non produite: ${(e as Error).message}`);
        continue;
      }
      tenir();
      img.garder(legende.texte, legende.modele);
    }
    tenir();
    // Les images d'une révision en attente restent dans son dossier, avec leur légende proposée :
    // `statuer` les sert quand un enseignant la certifie, `ecarterRevision` les efface avec elle.
    if (attente) ecrireAtomique(`${dossier}/images.jsonl`, jsonl(images));
    // Une source déjà certifiée qu'on réingère se réindexe avec ses sections et légendes. Un
    // échec de l'index annule la fin du travail, qui passe alors en échec.
    transaction(db, () => {
      etat(db, job, "awaiting_review", avertissements, true);
      if (s.statut === "certifiee") reindexer(db, s.id);
    });
  } catch (e) {
    const { changes } = db
      .prepare(
        `UPDATE ingestion_jobs SET etat = 'failed', erreur = ?, verrou_expire_le = NULL, maj_le = ?
         WHERE ${TENU}`,
      )
      .run((e as Error).message, maintenant(), job.id, job.tentatives);
    if (!changes) console.error(`travail ${job.id} abandonné : ${(e as Error).message}`);
  } finally {
    clearInterval(minuteur);
  }
}

/**
 * Rejoue l'extraction d'une source extraite, après une amélioration de l'extracteur. Un texte
 * changé devient une révision en attente : les citations déjà données gardent la leur.
 */
export async function reextraire(db: Db, sourceId: string) {
  const s = lireSource(db, sourceId);
  const job = db.prepare("SELECT etat FROM ingestion_jobs WHERE source_id = ?").get(sourceId);
  if (
    !["html", "pdf", "md", "docx", "pptx"].includes(s.format) ||
    job?.etat !== "awaiting_review"
  ) {
    return "ignoree";
  }
  const ext = await extraire(s);
  const r = enregistrer(db, s, assembler(ext.parties), ext.avertissements, ext.notes);
  if (r === "mise_a_jour") indexer(db, s.id);
  return r;
}
