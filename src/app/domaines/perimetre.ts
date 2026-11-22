import { FILTRE_DOMAINE, parametresDomaine } from "../../core/recherche.ts";
import type { Db } from "../db.ts";

/** `matieres` : les matières d'une comparaison, identifiants triés et séparés par des virgules. */
export type Scope = { matiere_id: string; cours_id: string; theme_id: string; matieres?: string };
export const idsMatieres = (matieres = "") => matieres.split(",").filter(Boolean);
/** Les matières arrivent en cases cochées ou en liste séparée par des virgules. */
export const lireScope = (champs: Record<string, unknown>): Scope => {
  const ids = [
    ...new Set([champs.matieres ?? []].flat().flatMap((v) => idsMatieres(String(v)))),
  ].sort();
  return {
    // Une seule matière cochée n'est pas une comparaison : c'est le périmètre de cette matière.
    matiere_id: ids.length > 1 ? "" : (ids[0] ?? String(champs.matiere_id ?? "")),
    cours_id: String(champs.cours_id ?? ""),
    theme_id: String(champs.theme_id ?? ""),
    ...(ids.length > 1 && { matieres: ids.join(",") }),
  };
};
export function sourcesPerimetre(db: Db, p: Scope) {
  return new Set(
    db
      .prepare(`SELECT s.id FROM sources s WHERE ${FILTRE_DOMAINE}`)
      .all(
        parametresDomaine({
          schoolId: "",
          lecteur: null,
          matiereId: p.matiere_id,
          matieres: idsMatieres(p.matieres),
          coursId: p.cours_id,
          themeId: p.theme_id,
        }),
      )
      .map((s) => s.id as string),
  );
}
