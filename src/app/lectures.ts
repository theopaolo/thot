import { type Db, maintenant } from "./db.ts";

/** Le compte a lu la révision servie jusqu'au bout. Une relecture remplace la lecture précédente. */
export const marquerLu = (db: Db, compteId: string, sourceId: string, revision: number) =>
  db
    .prepare(
      `INSERT INTO lectures (compte_id, source_id, revision, lu_le) VALUES (?, ?, ?, ?)
       ON CONFLICT (compte_id, source_id) DO UPDATE SET revision = excluded.revision,
         lu_le = excluded.lu_le`,
    )
    .run(compteId, sourceId, revision, maintenant());

/** Les sources de la liste que le compte a lues, quelle que soit la révision lue. */
export const lues = (db: Db, compteId: string, ids: string[]) =>
  new Set(
    db
      .prepare(
        `SELECT source_id FROM lectures
         WHERE compte_id = ? AND source_id IN (SELECT value FROM json_each(?))`,
      )
      .all(compteId, JSON.stringify(ids))
      .map((l) => l.source_id as string),
  );
