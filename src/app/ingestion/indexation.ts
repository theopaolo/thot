import { type Chunk, decouper } from "../../core/document.ts";
import { type ChunkIndexe, indexerSource, transaction } from "../../core/recherche.ts";
import { config } from "../config.ts";
import type { Db } from "../db.ts";
import { renommer } from "../domaines.ts";
import { lireDocument, lireSource, type Source } from "./revisions.ts";

export type Meta = { sequence?: string; seance?: string };

/**
 * Cache borné des chunks découpés d'anciennes révisions (`n < s.revision`), immuables sur disque.
 * Les titres, thèmes et légendes restent lus en base à chaque appel : seul le découpage du fichier
 * est gardé. Clé préfixée par `config.donnees` pour isoler les répertoires de données.
 */
const MAX_CACHE_REVISIONS = 64;
const cacheRevisions = new Map<string, Chunk[]>();

function chunksRevision(sourceId: string, n: number, historique: boolean): Chunk[] {
  if (!historique) return decouper(lireDocument(sourceId, n));
  const cle = `${config.donnees}\0${sourceId}\0${n}`;
  const connu = cacheRevisions.get(cle);
  if (connu) {
    cacheRevisions.delete(cle);
    cacheRevisions.set(cle, connu);
    return connu;
  }
  const decoupes = decouper(lireDocument(sourceId, n));
  cacheRevisions.set(cle, decoupes);
  if (cacheRevisions.size > MAX_CACHE_REVISIONS) {
    cacheRevisions.delete(cacheRevisions.keys().next().value!);
  }
  return decoupes;
}

/** Retire du cache mémoire les anciennes révisions d'une source supprimée. */
export function viderCacheRevisions(sourceId: string) {
  const prefixe = `${config.donnees}\0${sourceId}\0`;
  for (const cle of cacheRevisions.keys()) {
    if (cle.startsWith(prefixe)) cacheRevisions.delete(cle);
  }
}

/**
 * Ce qui range la source : les noms de ses thèmes, tous, par ordre alphabétique. Une source dans
 * plusieurs cours a un thème par cours, et chaque nom donne un mot de plus à la recherche. Une
 * source sans thème garde l'ancienne séquence.
 */
export function regroupement(db: Db, s: Source) {
  const noms = db
    .prepare(
      `SELECT DISTINCT t.nom FROM source_cours sc JOIN themes t ON t.id = sc.theme_id
       WHERE sc.source_id = ? ORDER BY t.nom`,
    )
    .all(s.id)
    .map((t) => t.nom as string);
  return noms.length ? noms.join(" / ") : (JSON.parse(s.metadonnees) as Meta).sequence;
}

/**
 * Renomme une matière, un cours, un thème ou un champ. L'en-tête des passages porte le nom de
 * leurs thèmes : les sources d'un thème renommé se réindexent dans la même transaction.
 */
export function renommerEntree(db: Db, genre: string, id: string, nom: string) {
  transaction(db, () => {
    renommer(db, genre, id, nom);
    if (genre !== "theme") return;
    const ids = db.prepare("SELECT source_id FROM source_cours WHERE theme_id = ?").all(id);
    for (const { source_id } of ids) reindexer(db, source_id as string);
  });
}

/**
 * Chunks d'une révision, la servie par défaut: texte de recherche avec toutes les légendes,
 * preuve avec les certifiées. Titres et légendes sont ceux d'aujourd'hui, même pour une ancienne.
 */
export function chunksSource(db: Db, sourceId: string, revision?: number): ChunkIndexe[] {
  const s = lireSource(db, sourceId);
  const n = revision ?? s.revision;
  const meta = JSON.parse(s.metadonnees) as Meta;
  const contexte = [
    s.profil === "arts-appliques" ? regroupement(db, s)?.replace(/^ATC /, "") : regroupement(db, s),
    meta.seance,
  ]
    .filter(Boolean)
    .join(" / ");
  const images = db
    .prepare(
      `SELECT legende, legende_statut, section FROM images
     WHERE source_id = ? AND legende IS NOT NULL AND legende_statut != 'rejected' ORDER BY position`,
    )
    .all(sourceId) as { legende: string; legende_statut: string; section: string | null }[];
  const chunks = chunksRevision(sourceId, n, n < s.revision);
  // Une image accompagne le premier passage de sa section, une diapositive par exemple. Sans
  // section connue, ou si la révision n'a plus cette section, le premier passage du document.
  const place = (section: string | null) =>
    Math.max(0, section === null ? 0 : chunks.findIndex((c) => c.section === section));
  return chunks.map((c, i) => {
    const legendes = images.filter((l) => place(l.section) === i);
    const titre =
      c.section && c.section !== s.titre && c.section !== "Introduction"
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
      rappel: [contexte, titre, c.texte, ...legendes.map((l) => l.legende)]
        .filter(Boolean)
        .join("\n"),
      preuve: [
        c.texte,
        ...legendes
          .filter((l) => l.legende_statut === "certified")
          .map((l) => `Image : ${l.legende}`),
      ].join("\n\n"),
      revision: n,
    };
  });
}

/** Seule une source certifiée entre dans l'index. Toute autre en sort. Sans transaction. */
export function reindexer(db: Db, sourceId: string) {
  const s = lireSource(db, sourceId);
  indexerSource(db, sourceId, s.statut === "certifiee" ? chunksSource(db, sourceId) : []);
}

export const indexer = (db: Db, sourceId: string) => transaction(db, () => reindexer(db, sourceId));
