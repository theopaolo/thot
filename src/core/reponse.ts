import type { DatabaseSync } from "node:sqlite";
import { type Message, type Modeles, PanneModele } from "./modeles.ts";
import { chercher, type ChunkIndexe, type Perimetre } from "./recherche.ts";
import { trouver } from "./texte.ts";
import type { Profil } from "./profils.ts";
import { bloc, COMPARAISON, profilSources, SYSTEME } from "./reponse/consignes.ts";
import { actualiserResultat } from "./reponse/conservee.ts";
import type { Affirmation, Journal, Repondue, Resultat } from "./reponse/resultat.ts";
import { lire, ranger, verifier } from "./reponse/verification.ts";

export { profilSources } from "./reponse/consignes.ts";
export { actualiserResultat, journalSans, resultatSans } from "./reponse/conservee.ts";
export type { Affirmation, BlocReponse, Journal, Resultat } from "./reponse/resultat.ts";
export { lire, ranger, verifier } from "./reponse/verification.ts";

/**
 * Probabilité de soutien sous laquelle une affirmation est refusée. Le juge raisonne puis rend
 * presque toujours 0 ou 1. Sur 223 paires et trois passages
 * (`evaluation/resultats/soutien-calibrage-*.json`), aucune paire fausse ne dépasse 0,35 et
 * aucune bonne phrase ne tombe entre 0,35 et 0,59.
 */
export const SEUIL_SOUTIEN = 0.5;
/** Un appel du juge dure 1 s en médiane, mais la queue monte à 10 s: au-delà, il ne bloque pas. */
const DELAI_JUGE_MS = 4000;

/**
 * Le juge vérifie que chaque citation, lue sous le titre de son extrait, prouve sa phrase.
 * Un juge injoignable ou trop lent laisse passer l'affirmation: les citations restent vérifiées
 * mot pour mot, la panne est notée au journal et la réponse porte `juge_indisponible`.
 * Un appel interrompu par `signal` lève : aucune affirmation ne passe sans verdict.
 */
export async function juger(
  modeles: Modeles,
  affirmations: Affirmation[],
  journal: Journal,
  profil: Profil,
  signal?: AbortSignal,
) {
  const verdicts = await Promise.allSettled(
    affirmations.map((a) => {
      const controle = new AbortController();
      let minuteur: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        modeles.soutenir(
          a.texte,
          a.citation,
          a.titre,
          AbortSignal.any([controle.signal, ...(signal ? [signal] : [])]),
          profil,
        ),
        new Promise<never>((_, non) => {
          minuteur = setTimeout(() => {
            const erreur = new Error("juge au-delà du délai");
            controle.abort(erreur);
            non(erreur);
          }, DELAI_JUGE_MS);
        }),
      ]).finally(() => clearTimeout(minuteur));
    }),
  );
  signal?.throwIfAborted();
  const soutenues: Affirmation[] = [];
  const erreurs: string[] = [];
  const probabilites: (number | null)[] = [];
  verdicts.forEach((v, i) => {
    const a = affirmations[i];
    if (v.status === "rejected") {
      journal.juge_indisponible = (v.reason as Error).message;
      probabilites.push(null);
      return soutenues.push(a);
    }
    probabilites.push(v.value.probabilite);
    if (v.value.probabilite >= SEUIL_SOUTIEN) return soutenues.push(a);
    erreurs.push(
      `L'affirmation « ${a.texte} » dit plus que sa citation. Reformule-la au plus près de la citation, sans rien ajouter, ou retire-la.`,
    );
  });
  return { soutenues, erreurs, probabilites };
}

/**
 * Recherche, génération, vérification. Aucune exception ne sort: une panne devient `failed`.
 * `signal` interrompt l'appel de modèle en cours.
 */
export async function demander(
  db: DatabaseSync,
  modeles: Modeles,
  question: string,
  p: Perimetre,
  seuil: number,
  etape: (nom: string) => void = () => {},
  questionPrecedente?: string,
  signal?: AbortSignal,
): Promise<{ resultat: Resultat; journal: Journal }> {
  const journal: Journal = { seuil };
  let gardees: Repondue = { affirmations: [] };
  let sansPassage: string[] = [];
  let retenus: ChunkIndexe[] = [];
  const repondre = (reponse: Repondue, partielle = false) => {
    for (const a of reponse.affirmations) {
      const images = db
        .prepare(
          "SELECT id, legende, legende_statut FROM images WHERE source_id = ? ORDER BY position",
        )
        .all(a.source_id) as { id: string; legende: string | null; legende_statut: string }[];
      const image =
        images.find(
          (i) =>
            a.debut === undefined &&
            i.legende_statut === "certified" &&
            i.legende &&
            trouver(i.legende, a.citation),
        ) ?? images[0];
      if (image) {
        a.image_id = image.id;
      }
    }
    return {
      resultat: actualiserResultat(
        db,
        {
          etat: "answered",
          ...reponse,
          ...(partielle && { partielle }),
          ...(sansPassage.length > 0 && { sans_passage: sansPassage }),
        },
        p,
        // Une révision certifiée pendant le calcul : la citation se revérifie dans les extraits
        // lus au départ.
        (id, n) => retenus.filter((c) => c.source_id === id && c.revision === n),
      ),
      journal,
    };
  };
  try {
    let recherche = question;
    if (questionPrecedente) {
      etape("Mise en contexte de la question");
      try {
        const reformulee = await modeles.reformuler(questionPrecedente, question, signal);
        if (!reformulee || reformulee.length > 1000) {
          throw new Error("Reformulation vide ou trop longue.");
        }
        recherche = reformulee;
      } catch (e) {
        // La relance part telle quelle. Si la recherche n'aboutit pas, c'est une panne.
        journal.reformulation_indisponible = (e as Error).message;
      }
      journal.question_recherche = recherche;
    }
    etape("Recherche dans les documents du cours");
    const r = await chercher(db, modeles, recherche, p, seuil, signal);
    journal.score = r.score;
    if (r.traduction) journal.traduction = r.traduction;
    if (r.panneTraduction) journal.traduction_indisponible = r.panneTraduction;
    if (r.panneReclasseur) journal.reclasseur_indisponible = r.panneReclasseur;
    journal.candidats = r.candidats.map((c) => ({
      id: c.id,
      source_id: c.source_id,
      rang_fts: c.rang_fts,
      score: c.score,
      matieres: c.matieres,
    }));
    sansPassage = r.sansPassage ?? [];
    retenus = r.retenus;
    if (sansPassage.length) journal.sans_passage = sansPassage;
    // Une question cherchée sans sa reformulation ou sa traduction : ne rien trouver ne prouve
    // pas une limite du cours.
    const panneRecherche = (journal.reformulation_indisponible ?? r.panneTraduction) as
      | string
      | undefined;
    if (panneRecherche && (r.horsCorpus || sansPassage.length)) {
      return {
        resultat: { etat: "failed", code: "MODEL_UNAVAILABLE", message: panneRecherche },
        journal,
      };
    }
    if (r.horsCorpus) return { resultat: { etat: "out_of_corpus", raison: "seuil" }, journal };

    etape("Rédaction à partir des passages trouvés");
    const profil = profilSources(
      db,
      r.retenus.map((c) => c.source_id),
    );
    // `sansPassage` n'existe qu'en comparaison, même vide.
    const comparaison = r.sansPassage && profil === "general" ? `\n${COMPARAISON}` : "";
    const messages: Message[] = [
      { role: "system", content: SYSTEME[profil] + comparaison },
      {
        role: "user",
        content: `Extraits du corpus :\n\n${bloc(r.retenus)}\n\n${
          questionPrecedente ? `Question précédente : ${questionPrecedente}\n` : ""
        }Question de l'eleve : ${question}`,
      },
    ];
    const tentatives: unknown[] = [];
    journal.tentatives = tentatives;
    for (let essai = 0; essai < 2; essai++) {
      const { texte, modele } = await modeles.generer(messages, signal);
      journal.modele = modele;
      etape("Vérification des citations");
      const brute = lire(texte);
      const v = verifier(brute, r.retenus);
      if (v.refus) {
        tentatives.push({ sortie: texte, erreurs: v.erreurs });
        if (gardees.affirmations.length) return repondre(gardees, true);
        // Des extraits mal triés ou mal cherchés: leur refus ne prouve pas une limite du cours.
        const panne = r.panneReclasseur ?? panneRecherche;
        if (panne) {
          return {
            resultat: { etat: "failed", code: "MODEL_UNAVAILABLE", message: panne },
            journal,
          };
        }
        return { resultat: { etat: "out_of_corpus", raison: "refus_modele" }, journal };
      }
      const j = await juger(modeles, v.affirmations, journal, profil, signal);
      const erreurs = [...v.erreurs, ...j.erreurs];
      tentatives.push({ sortie: texte, erreurs, soutien: j.probabilites });
      // Les réponses d'arts appliqués restent plates, comme l'évaluation les a mesurées.
      const rangee: Repondue = {
        ...ranger(
          profil === "general" ? brute?.blocs : undefined,
          v.parRang.map((a) => (a && j.soutenues.includes(a) ? a : undefined)),
        ),
        ...(j.probabilites.includes(null) && { juge_indisponible: true }),
      };
      if (rangee.affirmations.length > gardees.affirmations.length) gardees = rangee;
      if (!erreurs.length) return repondre(rangee);
      messages.push(
        { role: "assistant", content: texte },
        {
          role: "user",
          content:
            `Ta reponse ne passe pas la verification :\n- ${erreurs.join("\n- ")}\n` +
            `Rends le JSON complet corrige. Chaque citation doit etre recopiee mot pour mot de l'extrait indique.`,
        },
      );
    }
    if (gardees.affirmations.length) return repondre(gardees, true);
    return {
      resultat: {
        etat: "failed",
        code: "CITATION_UNVERIFIED",
        message:
          "La réponse proposée cite des passages introuvables dans le cours, ou qui ne prouvent pas ses phrases.",
      },
      journal,
    };
  } catch (e) {
    const code = e instanceof PanneModele ? e.code : "INTERNAL_ERROR";
    journal.erreur = (e as Error).message;
    if (gardees.affirmations.length) {
      try {
        return repondre(gardees, true);
      } catch {
        /* Une erreur de base reste une panne. */
      }
    }
    return { resultat: { etat: "failed", code, message: (e as Error).message }, journal };
  }
}
