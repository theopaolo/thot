import type { DatabaseSync } from "node:sqlite";
import { type ChunkIndexe, lireChunk, type Perimetre, revisionCitable } from "../recherche.ts";
import type { Affirmation, Journal, Resultat } from "./resultat.ts";
import { verifier } from "./verification.ts";

/**
 * Une réponse conservée perd sa validation dès qu'une de ses preuves est retirée ou modifiée. Une
 * citation d'une révision qui ne sert plus se revérifie dans les chunks que `ancienne` rend pour
 * cette révision. Le résultat rend chaque citation telle que le document l'écrit : une réponse
 * conservée peut encore porter la copie du modèle.
 */
export function actualiserResultat(
  db: DatabaseSync,
  resultat: Resultat,
  p: Perimetre,
  ancienne: (sourceId: string, revision: number) => ChunkIndexe[],
): Resultat {
  if (resultat.etat !== "answered") return resultat;
  const affirmations: Affirmation[] = [];
  for (const a of resultat.affirmations) {
    const n = a.revision ?? 1;
    let c = lireChunk(db, a.source_id, a.chunk_id, p);
    if (c?.revision !== n) {
      const servie = c?.revision ?? revisionCitable(db, a.source_id, p);
      c =
        servie !== undefined && n < servie
          ? ancienne(a.source_id, n).find((x) => x.id === a.chunk_id)
          : undefined;
    }
    const valide = c && verifier({ affirmations: [{ ...a, extrait: 1 }] }, [c]).affirmations[0];
    if (!valide || valide.titre !== a.titre || valide.debut !== a.debut || valide.fin !== a.fin) {
      return {
        etat: "failed",
        code: "EVIDENCE_WITHDRAWN",
        message:
          "Une source de cette réponse a été retirée ou modifiée. Pose à nouveau ta question.",
      };
    }
    affirmations.push({ ...a, citation: valide.citation });
  }
  return { ...resultat, affirmations };
}

/**
 * Une réponse conservée sans les affirmations qui citent une source supprimée. Les autres
 * restent, chacune prouvée par sa citation, en un paragraphe : les titres de blocs viennent du
 * modèle sans preuve et ont pu nommer la source retirée. Sans affirmation, la réponse est
 * indisponible.
 */
export function resultatSans(r: Resultat, sourceId: string): Resultat {
  if (r.etat !== "answered" || !r.affirmations.some((a) => a.source_id === sourceId)) return r;
  const affirmations = r.affirmations.filter((a) => a.source_id !== sourceId);
  if (!affirmations.length) {
    return { etat: "failed", code: "SOURCE_DELETED", message: "Une source citée a été supprimée." };
  }
  const reste = { ...r, affirmations, source_supprimee: true };
  delete reste.blocs;
  return reste;
}

/**
 * Un journal sans les candidats des sources `retiree`. Les sorties du modèle partent avec eux :
 * elles recopient les extraits.
 */
export function journalSans(journal: Journal, retiree: (sourceId: string) => boolean): Journal {
  const candidats = (journal.candidats ?? []) as { source_id: string }[];
  if (!candidats.some((c) => retiree(c.source_id))) return journal;
  const reste: Journal = { ...journal, candidats: candidats.filter((c) => !retiree(c.source_id)) };
  delete reste.tentatives;
  return reste;
}
