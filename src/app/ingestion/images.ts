import { readFileSync, rmSync } from "node:fs";
import type { Db } from "../db.ts";
import { dossierRevision, revisionEnAttente } from "./revisions.ts";

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
 * Ce que certifier la révision en attente `n` changerait aux images servies : celles qu'elle
 * ajoute, avec leur légende proposée, et celles qu'elle retire. `undefined` sans inventaire.
 */
export function imagesEnAttente(db: Db, sourceId: string, n: number) {
  const inventaire = lireInventaire(sourceId, n);
  if (!inventaire) return undefined;
  const servies = db
    .prepare("SELECT id, checksum, legende FROM images WHERE source_id = ? ORDER BY position")
    .all(sourceId) as { id: string; checksum: string; legende: string | null }[];
  const deja = new Set(servies.map((i) => i.checksum));
  const gardees = new Set(inventaire.map((i) => i.checksum));
  return {
    ajoutees: inventaire.filter((i) => !deja.has(i.checksum)),
    retirees: servies.filter((i) => !gardees.has(i.checksum)),
  };
}

/**
 * Une image que la révision en attente `n` ajoute, pour qui la relit. `undefined` si la révision
 * n'attend plus ou si son inventaire ne nomme pas ce fichier.
 */
export function imageEnAttente(db: Db, sourceId: string, n: number, fichier: string) {
  if (revisionEnAttente(db, sourceId)?.n !== n) return undefined;
  const i = imagesEnAttente(db, sourceId, n)?.ajoutees.find((x) => x.fichier === fichier);
  return i && { mime: i.mime, chemin: `${dossierRevision(sourceId, n)}/assets/${i.fichier}` };
}

/**
 * Fait des images de la révision `n` celles que la source sert. Une image suit ses octets : celle
 * que la source servait déjà garde son identifiant, sa légende et sa relecture, et prend sa
 * nouvelle place. Les autres entrent avec la légende proposée. Celles que la révision n'a plus
 * sortent, et leurs fichiers sont rendus pour être effacés une fois la transaction validée.
 * Sans transaction.
 */
export function servirImages(db: Db, sourceId: string, n: number, images: ImageRevision[]) {
  // Le compteur de la source ne redescend pas : le numéro d'une image retirée ne revient à aucune
  // autre, et une activité qui la montrait ne montre pas la suivante à sa place.
  let numero = db.prepare("SELECT images_numero AS n FROM sources WHERE id = ?").get(sourceId)!
    .n as number;
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
  db.prepare("UPDATE sources SET images_numero = ? WHERE id = ?").run(numero, sourceId);
  return (
    db
      .prepare(
        "DELETE FROM images WHERE source_id = ? AND position < 0 RETURNING revision, fichier",
      )
      .all(sourceId) as { revision: number; fichier: string }[]
  ).map((i) => cheminImage(sourceId, i));
}

export const retirer = (chemins: string[]) => chemins.forEach((c) => rmSync(c, { force: true }));
