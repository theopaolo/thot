import { transaction } from "../../core/recherche.ts";
import { filtreModification, parametresModification, type Compte } from "../comptes.ts";
import { type Db, maintenant } from "../db.ts";
import { nomTheme } from "../domaines.ts";
import { lireInstance } from "../instance.ts";
import { reindexer } from "./indexation.ts";

export function relireLegende(
  db: Db,
  imageId: string,
  action: "certified" | "rejected",
  texte: string,
  par: string,
  credit = "",
) {
  transaction(db, () => {
    const img = db.prepare("SELECT source_id, legende FROM images WHERE id = ?").get(imageId) as
      | { source_id: string; legende: string }
      | undefined;
    if (!img) return;
    const corrigee = action === "certified" && texte.trim() && texte.trim() !== img.legende;
    db.prepare(
      `UPDATE images SET legende_statut = ?, relu_par = ?, relu_le = ?,
       legende = CASE WHEN ? THEN ? ELSE legende END,
       legende_origine = CASE WHEN ? THEN 'teacher' ELSE legende_origine END,
       credit = ?
     WHERE id = ?`,
    ).run(
      action,
      par,
      maintenant(),
      corrigee ? 1 : 0,
      texte.trim(),
      corrigee ? 1 : 0,
      credit.trim() || null,
      imageId,
    );
    reindexer(db, img.source_id);
  });
}

/** Les images que la source sert. Une légende ne se montre qu'une fois relue. */
export const imagesLues = (db: Db, sourceId: string) =>
  db
    .prepare(
      `SELECT id, CASE WHEN legende_statut = 'certified' THEN legende END AS legende, credit
       FROM images WHERE source_id = ? ORDER BY position`,
    )
    .all(sourceId) as { id: string; legende: string | null; credit: string | null }[];

export type ImageALegender = {
  id: string;
  legende: string | null;
  legende_statut: string;
  legende_origine: string | null;
  modele: string | null;
  source_id: string;
  titre: string;
  credit: string | null;
  restantes: number;
};

// La file ne propose que les images des sources que le compte peut relire.
const FILE = `i.legende_statut = 'unreviewed' AND s.statut != 'rejetee' AND s.school_id = $etablissement
  AND ${filtreModification()}`;
const parametresFile = (db: Db, compte: Compte) => ({
  ...parametresModification(compte),
  etablissement: lireInstance(db).school_id,
});

export const aLegender = (db: Db, compte: Compte, imageId = "") => {
  const restantes = db
    .prepare(`SELECT count(*) n FROM images i JOIN sources s ON s.id = i.source_id WHERE ${FILE}`)
    .get(parametresFile(db, compte))!.n as number;
  const i = db
    .prepare(
      `SELECT i.*, s.titre FROM images i JOIN sources s ON s.id = i.source_id WHERE ${FILE}
       ORDER BY (i.id = ?) DESC, ${nomTheme("s")}, s.titre, i.position LIMIT 1`,
    )
    .get(parametresFile(db, compte), imageId) as Omit<ImageALegender, "restantes"> | undefined;
  return i && { ...i, restantes };
};

/** Le nombre de légendes que le compte a à relire, affiché dans le menu. */
export const nombreLegendes = (db: Db, compte: Compte) =>
  db
    .prepare(
      `SELECT count(*) AS n FROM images i JOIN sources s ON s.id = i.source_id WHERE ${FILE}`,
    )
    .get(parametresFile(db, compte))!.n as number;

// Les douze prochaines images de la file, dans l'ordre où elles seront proposées.
export const fileLegendes = (db: Db, compte: Compte) =>
  db
    .prepare(
      `SELECT i.id, s.titre FROM images i JOIN sources s ON s.id = i.source_id WHERE ${FILE}
       ORDER BY ${nomTheme("s")}, s.titre, i.position LIMIT 12`,
    )
    .all(parametresFile(db, compte)) as { id: string; titre: string }[];
