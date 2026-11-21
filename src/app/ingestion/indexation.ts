import { decouper } from "../../core/document.ts";
import { type ChunkIndexe, indexerSource, transaction } from "../../core/recherche.ts";
import type { Db } from "../db.ts";
import { renommer } from "../domaines.ts";
import { lireDocument, lireSource, type Source } from "./revisions.ts";

export type Meta = { sequence?: string; seance?: string };

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
  const chunks = decouper(lireDocument(sourceId, n));
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
