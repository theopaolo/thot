import type { DatabaseSync } from "node:sqlite";
import type { Modeles } from "./modeles.ts";
import type { Perimetre } from "./recherche.ts";
import { demander } from "./reponse.ts";

/** Une question qui renvoie à un support que l'élève n'a pas sous les yeux. */
const RENVOI =
  /\b(extraits?|(selon|dans|d'après|d’après) (le|ce) (texte|document|passage)|(ce|du) (texte|document)|ce passage)\b/i;

const CONSIGNE = `Voici un extrait d'un cours de lycee.

Ecris deux questions qu'un eleve de Terminale pourrait poser, dont la reponse se trouve
dans cet extrait et seulement dans cet extrait. Questions courtes, 6 a 15 mots, en
francais simple, comme un eleve les poserait. Une question porte sur une idee, une cause
ou une oeuvre, jamais sur un detail de mise en page. L'eleve ne voit pas l'extrait :
une question ne mentionne jamais « l'extrait », « le texte », « le document » ou « le passage ».

Rends uniquement un objet JSON : {"questions": ["...", "..."]}`;

/**
 * Propose des questions sur un passage, puis ne garde que celles auxquelles la chaîne de réponse
 * répond avec des citations vérifiées tirées de la même source.
 */
export async function questionsVerifiees(
  db: DatabaseSync,
  modeles: Modeles,
  passage: { source_id: string; titre: string; texte: string },
  p: Perimetre,
  seuil: number,
): Promise<{ question: string; modele: string }[]> {
  const { texte, modele } = await modeles.generer([
    { role: "system", content: CONSIGNE },
    { role: "user", content: `${passage.titre}\n\n${passage.texte}` },
  ]);
  let questions: string[] = [];
  try {
    questions = JSON.parse(texte.slice(texte.indexOf("{"), texte.lastIndexOf("}") + 1)).questions ??
      [];
  } catch {
    return [];
  }
  const gardees = [];
  for (
    const q of questions.filter((q) =>
      typeof q === "string" && q.trim().endsWith("?") && !RENVOI.test(q)
    ).slice(0, 2)
  ) {
    const { resultat } = await demander(db, modeles, q.trim(), p, seuil);
    if (
      resultat.etat === "answered" &&
      resultat.affirmations.some((a) => a.source_id === passage.source_id)
    ) {
      gardees.push({ question: q.trim(), modele });
    }
  }
  return gardees;
}
