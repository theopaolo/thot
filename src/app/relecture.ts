import { LISIBLE, parametresLisible } from "../core/recherche.ts";
import { type Compte, filtreModification, lecteur, parametresModification } from "./comptes.ts";
import type { Db } from "./db.ts";
import { MES_COURS, mesCours } from "./domaines.ts";

export type Attente = {
  id: string;
  titre: string;
  format: string;
  statut: string;
  revision: number;
  enseignant: string;
  cree_le: string;
  /** Noms des cours de la ressource parmi ceux du compte, vide si elle n'en a pas. */
  cours: string[];
  /** Vrai si une nouvelle version attend, que la ressource soit certifiée ou non. */
  revision_en_attente: boolean;
};

/**
 * Les ressources que le compte relit : à relire, ou dont une nouvelle version attend. Rangées par
 * premier cours puis par titre, celles sans cours en dernier, dans l'ordre où la page les liste.
 */
export function aRelire(db: Db, schoolId: string, compte: Compte): Attente[] {
  const lignes = db
    .prepare(
      `SELECT s.id, s.titre, s.format, s.statut, s.revision, s.enseignant, s.cree_le,
         (SELECT group_concat(nom, char(10)) FROM (
            SELECT DISTINCT c.nom FROM source_cours sc JOIN cours c ON c.id = sc.cours_id
            WHERE sc.source_id = s.id AND ${MES_COURS} ORDER BY c.nom)) AS cours,
         EXISTS (SELECT 1 FROM revisions r WHERE r.source_id = s.id AND r.n > s.revision)
           AS revision_en_attente
       FROM sources s
       WHERE ${LISIBLE} AND coalesce(${filtreModification()}, 0)
         AND (s.statut = 'a_relire'
           OR EXISTS (SELECT 1 FROM revisions r WHERE r.source_id = s.id AND r.n > s.revision))`,
    )
    .all({
      ...parametresModification(compte),
      ...parametresLisible(schoolId, lecteur(compte)),
      ...mesCours(lecteur(compte)),
    }) as unknown as (Omit<Attente, "cours" | "revision_en_attente"> & {
    cours: string | null;
    revision_en_attente: number;
  })[];
  const liste = lignes.map((l) => ({
    ...l,
    cours: l.cours ? l.cours.split("\n") : [],
    revision_en_attente: l.revision_en_attente === 1,
  }));
  const rang = (a: Attente) => (a.cours.length ? a.cours[0] : "￿");
  return liste.sort(
    (a, b) => rang(a).localeCompare(rang(b), "fr") || a.titre.localeCompare(b.titre, "fr"),
  );
}
