import type { DatabaseSync } from "node:sqlite";
import { type Message, type Modeles, PanneModele } from "./modeles.ts";
import { type Candidat, chercher, type Perimetre } from "./recherche.ts";
import { trouverFragments } from "./texte.ts";

export type Affirmation = {
  texte: string;
  citation: string;
  source_id: string;
  chunk_id: string;
  titre: string;
  image_id?: string;
  /** offsets dans `document.txt`, absents quand la citation vient d'une légende certifiée */
  debut?: number;
  fin?: number;
};

export type Resultat =
  | { etat: "answered"; affirmations: Affirmation[]; partielle?: boolean }
  | { etat: "out_of_corpus"; raison: "seuil" | "refus_modele" }
  | { etat: "failed"; code: string; message: string };

export type Journal = Record<string, unknown>;

const SYSTEME = `Tu reponds a des eleves de Terminale a partir d'extraits d'un corpus de cours
fourni par leur professeur, et de RIEN d'autre.

Regles, sans exception :
1. Chaque affirmation de ta reponse doit se trouver dans les extraits fournis.
   Tu n'ajoutes aucune connaissance personnelle, meme si tu es sur d'elle.
2. Si les extraits ne contiennent pas de quoi repondre, tu rends exactement {"refus": true}.
   Une reponse partielle vaut mieux qu'une invention, mais une invention ne vaut jamais
   mieux qu'un refus.
3. Tu rends uniquement un objet JSON, sans texte autour, de cette forme :
   {"affirmations": [{"texte": "...", "extrait": 2, "citation": "..."}]}
   - "texte" : une phrase de ta reponse, en francais, dans une langue simple.
   - "extrait" : le numero de l'extrait qui justifie cette phrase.
   - "citation" : un passage de 5 a 40 mots recopie EXACTEMENT, mot pour mot, de cet
     extrait, et qui prouve la phrase. Un seul passage continu, sans points de
     suspension, sans guillemets ajoutes, sans corriger l'orthographe du cours.
4. Cinq affirmations au maximum, 120 mots de reponse au total.`;

const bloc = (retenus: Candidat[]) =>
  retenus.map((c, i) => `[${i + 1}] ${c.titre}\n${c.preuve}`).join("\n\n");

type Brute = {
  refus?: boolean;
  affirmations?: { texte?: string; extrait?: number; citation?: string }[];
};

function lire(sortie: string): Brute | null {
  const debut = sortie.indexOf("{");
  const fin = sortie.lastIndexOf("}");
  if (debut < 0 || fin < debut) return null;
  try {
    return JSON.parse(sortie.slice(debut, fin + 1));
  } catch {
    return null;
  }
}

/** Contrôles déterministes: chaque citation existe mot pour mot dans l'extrait qu'elle désigne. */
export function verifier(brute: Brute | null, retenus: Candidat[]) {
  const erreurs: string[] = [];
  const affirmations: Affirmation[] = [];
  if (!brute) return { erreurs: ["La sortie n'est pas un objet JSON."], affirmations };
  if (brute.refus) return { erreurs, affirmations, refus: true };
  const liste = brute.affirmations ?? [];
  if (!liste.length) erreurs.push("Aucune affirmation.");
  liste.forEach((a, i) => {
    const c = retenus[(a.extrait ?? 0) - 1];
    const citation = (a.citation ?? "").trim();
    if (!a.texte?.trim()) return erreurs.push(`Affirmation ${i + 1}: texte vide.`);
    if (!c) return erreurs.push(`Affirmation ${i + 1}: l'extrait ${a.extrait} n'existe pas.`);
    if (citation.split(/\s+/).length < 3) {
      return erreurs.push(`Affirmation ${i + 1}: citation trop courte.`);
    }
    const base = { texte: a.texte.trim(), citation, source_id: c.source_id, chunk_id: c.id };
    const dansTexte = trouverFragments(c.texte, citation);
    if (dansTexte) {
      affirmations.push({
        ...base,
        titre: c.titre,
        debut: c.debut + dansTexte[0],
        fin: c.debut + dansTexte[1],
      });
    } else if (trouverFragments(c.preuve, citation)) {
      affirmations.push({ ...base, titre: c.titre });
    } else {
      erreurs.push(
        `Affirmation ${
          i + 1
        }: la citation n'apparaît pas mot pour mot dans l'extrait ${a.extrait}.`,
      );
    }
  });
  return { erreurs, affirmations, refus: false };
}

/** Recherche, génération, vérification. Aucune exception ne sort: une panne devient `failed`. */
export async function demander(
  db: DatabaseSync,
  modeles: Modeles,
  question: string,
  p: Perimetre,
  seuil: number,
  etape: (nom: string) => void = () => {},
  questionPrecedente?: string,
): Promise<{ resultat: Resultat; journal: Journal }> {
  const journal: Journal = { seuil };
  let gardees: Affirmation[] = [];
  const repondre = (affirmations: Affirmation[], partielle = false) => {
    for (const a of affirmations) {
      const images = db.prepare(
        "SELECT id, legende, legende_statut FROM images WHERE source_id = ? ORDER BY position",
      ).all(a.source_id) as { id: string; legende: string | null; legende_statut: string }[];
      const image = images.find((i) =>
        a.debut === undefined && i.legende_statut === "certified" && i.legende &&
        trouverFragments(i.legende, a.citation)
      ) ?? images[0];
      if (image) {
        a.image_id = image.id;
      }
    }
    return {
      resultat: { etat: "answered" as const, affirmations, ...(partielle && { partielle }) },
      journal,
    };
  };
  try {
    let recherche = question;
    if (questionPrecedente) {
      etape("Mise en contexte de la question");
      try {
        const reformulee = await modeles.reformuler(questionPrecedente, question);
        if (reformulee && reformulee.length <= 1000) recherche = reformulee;
      } catch { /* Une reformulation indisponible ne bloque pas la question. */ }
      journal.question_recherche = recherche;
    }
    etape("Recherche dans les documents du cours");
    const r = await chercher(db, modeles, recherche, p, seuil);
    journal.score = r.score;
    journal.candidats = r.candidats.map((c) => ({
      id: c.id,
      source_id: c.source_id,
      rang_fts: c.rang_fts,
      score: c.score,
    }));
    if (r.horsCorpus) return { resultat: { etat: "out_of_corpus", raison: "seuil" }, journal };

    etape("Rédaction à partir des passages trouvés");
    const messages: Message[] = [
      { role: "system", content: SYSTEME },
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
      const { texte, modele } = await modeles.generer(messages);
      journal.modele = modele;
      etape("Vérification des citations");
      const v = verifier(lire(texte), r.retenus);
      tentatives.push({ sortie: texte, erreurs: v.erreurs });
      if (v.refus) {
        return gardees.length
          ? repondre(gardees, true)
          : { resultat: { etat: "out_of_corpus", raison: "refus_modele" }, journal };
      }
      if (v.affirmations.length > gardees.length) gardees = v.affirmations;
      if (!v.erreurs.length) return repondre(v.affirmations);
      messages.push(
        { role: "assistant", content: texte },
        {
          role: "user",
          content: `Ta reponse ne passe pas la verification :\n- ${v.erreurs.join("\n- ")}\n` +
            `Rends le JSON complet corrige. Chaque citation doit etre recopiee mot pour mot de l'extrait indique.`,
        },
      );
    }
    if (gardees.length) return repondre(gardees, true);
    return {
      resultat: {
        etat: "failed",
        code: "CITATION_UNVERIFIED",
        message: "La réponse proposée cite des passages introuvables dans le cours.",
      },
      journal,
    };
  } catch (e) {
    const code = e instanceof PanneModele ? e.code : "INTERNAL_ERROR";
    journal.erreur = (e as Error).message;
    if (gardees.length) {
      try {
        return repondre(gardees, true);
      } catch { /* Une erreur de base reste une panne. */ }
    }
    return { resultat: { etat: "failed", code, message: (e as Error).message }, journal };
  }
}
