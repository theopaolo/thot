import { readFileSync, rmSync } from "node:fs";
import type { Db } from "../db.ts";
import { dossierRevision } from "./revisions.ts";

/**
 * Une image d'une extraction, à sa place dans le document. `legende` et `modele` : la légende
 * proposée pour une image que la source ne sert pas encore.
 */
export type ImageRevision = {
  checksum: string;
  fichier: string;
  mime: string;
  section: string | null;
  legende?: string;
  modele?: string;
};

/** Le fichier d'une image servie, dans le dossier de la révision qui l'a apportée. */
export const cheminImage = (sourceId: string, i: { revision: number; fichier: string }) =>
  `${dossierRevision(sourceId, i.revision)}/assets/${i.fichier}`;

/** Les images d'une révision en attente. `undefined` si elle vient de `reextraire`, sans images. */
export function lireInventaire(sourceId: string, n: number): ImageRevision[] | undefined {
  try {
    return readFileSync(`${dossierRevision(sourceId, n)}/images.jsonl`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ImageRevision);
  } catch {
    return undefined;
  }
}

/**
 * Fait des images de la révision `n` celles que la source sert. Une image suit ses octets : celle
 * que la source servait déjà garde son identifiant, sa légende et sa relecture, et prend sa
 * nouvelle place. Les autres entrent avec la légende proposée. Celles que la révision n'a plus
 * sortent, et leurs fichiers sont rendus pour être effacés une fois la transaction validée.
 * Sans transaction.
 */
export function servirImages(db: Db, sourceId: string, n: number, images: ImageRevision[]) {
  // ponytail: le numéro repart du plus grand encore servi. Celui d'une image retirée peut donc
  // revenir à une autre, et une activité qui montrait la première montrerait la seconde. Un
  // compteur par source l'éviterait.
  let numero = db
    .prepare(
      "SELECT coalesce(max(CAST(substr(id, ?) AS INTEGER)), -1) + 1 AS n FROM images WHERE source_id = ?",
    )
    .get(sourceId.length + 2, sourceId)!.n as number;
  // Les places passent sous zéro le temps du rangement : `(source_id, position)` est unique, et
  // ce qui reste sous zéro à la fin n'est plus dans la révision.
  db.prepare("UPDATE images SET position = -1 - position WHERE source_id = ?").run(sourceId);
  const garder = db.prepare(
    `UPDATE images SET position = ?, section = ? WHERE id = (
       SELECT id FROM images WHERE source_id = ? AND checksum = ? AND position < 0
       ORDER BY position DESC LIMIT 1)`,
  );
  const ajouter = db.prepare(
    `INSERT INTO images (id, source_id, revision, position, fichier, mime, checksum, section,
       legende, legende_origine, modele)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [position, i] of images.entries()) {
    if (garder.run(position, i.section, sourceId, i.checksum).changes) continue;
    ajouter.run(
      `${sourceId}-${numero++}`,
      sourceId,
      n,
      position,
      i.fichier,
      i.mime,
      i.checksum,
      i.section,
      i.legende ?? null,
      i.legende ? "generated" : null,
      i.modele ?? null,
    );
  }
  return (
    db
      .prepare(
        "DELETE FROM images WHERE source_id = ? AND position < 0 RETURNING revision, fichier",
      )
      .all(sourceId) as { revision: number; fichier: string }[]
  ).map((i) => cheminImage(sourceId, i));
}

export const retirer = (chemins: string[]) => chemins.forEach((c) => rmSync(c, { force: true }));
