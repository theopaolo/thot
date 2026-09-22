import type { Modeles } from "../core/modeles.ts";
import { questionsVerifiees } from "../core/suggestions.ts";
import { trouver } from "../core/texte.ts";
import { config } from "./config.ts";
import { type Db, maintenant } from "./db.ts";

const PASSAGES_PAR_SOURCE = 2;
const LONGUEUR_MIN = 250;

/** Questions vérifiées sur les plus longs passages d'une source certifiée. */
export async function genererSuggestions(db: Db, modeles: Modeles, sourceId: string) {
  const passages = db.prepare(
    `SELECT c.source_id, c.titre, c.texte FROM chunks c JOIN sources s ON s.id = c.source_id
     WHERE c.source_id = ? AND s.statut = 'certifiee' AND length(c.texte) >= ?
     ORDER BY length(c.texte) DESC LIMIT ?`,
  ).all(sourceId, LONGUEUR_MIN, PASSAGES_PAR_SOURCE) as {
    source_id: string;
    titre: string;
    texte: string;
  }[];
  const questions = [];
  for (const p of passages) {
    questions.push(
      ...await questionsVerifiees(db, modeles, p, { schoolId: config.schoolId }, config.seuil),
    );
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM suggestions WHERE source_id = ?").run(sourceId);
    const ins = db.prepare("INSERT INTO suggestions VALUES (?, ?, ?, ?, ?)");
    for (const q of questions) {
      ins.run(crypto.randomUUID(), sourceId, q.question, q.modele, maintenant());
    }
    db.prepare("UPDATE sources SET suggestions_le = ? WHERE id = ?").run(maintenant(), sourceId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return questions.length;
}

/** Prochaine source certifiée sans suggestions, pour le worker. */
export const sourceSansSuggestions = (db: Db) =>
  db.prepare(
    "SELECT id FROM sources WHERE statut = 'certifiee' AND suggestions_le IS NULL LIMIT 1",
  ).get()?.id as string | undefined;

export const marquerSuggestions = (db: Db, sourceId: string) =>
  db.prepare("UPDATE sources SET suggestions_le = ? WHERE id = ?").run(maintenant(), sourceId);

export type Suggestion = { question: string; chapitre: string };

/** Quelques questions par chapitre, tirées au hasard parmi celles des sources certifiées. */
export function suggestionsParChapitre(db: Db, parChapitre = 3): Map<string, string[]> {
  const lignes = db.prepare(
    `SELECT sg.question, coalesce(json_extract(s.metadonnees, '$.sequence'), '') AS chapitre
     FROM suggestions sg JOIN sources s ON s.id = sg.source_id
     WHERE s.statut = 'certifiee' AND s.school_id = ? ORDER BY random()`,
  ).all(config.schoolId) as Suggestion[];
  const out = new Map<string, string[]>();
  for (const l of lignes) {
    const liste = out.get(l.chapitre) ?? [];
    if (liste.length < parChapitre) liste.push(l.question);
    out.set(l.chapitre, liste);
  }
  return out;
}

// Une phrase qui commence par un connecteur ou un pronom renvoie à la précédente: seule, elle
// ne dit rien.
const DEPENDANTE =
  /^(ensuite|puis|alors|enfin|donc|mais|or|ainsi|aussi|de plus|par ailleurs|en effet|cependant|pourtant|il|elle|ils|elles|on|ce|cet|cette|ces|cela|ceci|celui|celle|ceux|c'|c’|là|y|en|leur|leurs|son|sa|ses|voici|voilà)\b/i;

/** Une phrase qui se lit seule et porte un fait: une date ou un nom propre après le premier mot. */
function autonome(x: string) {
  const mots = x.split(/\s+/);
  return mots.length >= 12 && mots.length <= 40 && /^\p{Lu}/u.test(x) && /[.!]$/.test(x) &&
    !DEPENDANTE.test(x) && !/[«»|]/.test(x) &&
    (/\b1[5-9]\d\d\b|\b20\d\d\b/.test(x) || mots.slice(1).some((m) => /^\p{Lu}\p{Ll}/u.test(m)));
}

export type Fait = {
  phrase: string;
  titre: string;
  source_id: string;
  debut: number;
  fin: number;
};

/**
 * « Le saviez-vous ? »: une phrase recopiée telle quelle d'un passage certifié, avec sa position
 * dans le document. Rien n'est généré.
 */
export function faitAuHasard(db: Db): Fait | undefined {
  const passages = db.prepare(
    `SELECT c.source_id, c.titre, c.texte, c.debut FROM chunks c JOIN sources s ON s.id = c.source_id
     WHERE s.statut = 'certifiee' AND c.school_id = ? AND length(c.texte) >= 300
     ORDER BY random() LIMIT 10`,
  ).all(config.schoolId) as { source_id: string; titre: string; texte: string; debut: number }[];
  for (const p of passages) {
    const phrases = p.texte.split(/(?<=[.!])\s+|\n+/).map((x) => x.trim()).filter(autonome);
    if (!phrases.length) continue;
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];
    const position = trouver(p.texte, phrase);
    if (!position) continue;
    return {
      phrase,
      titre: p.titre,
      source_id: p.source_id,
      debut: p.debut + position[0],
      fin: p.debut + position[1],
    };
  }
  return undefined;
}
