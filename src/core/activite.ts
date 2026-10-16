import type { Message, Modeles } from "./modeles.ts";
import type { ChunkIndexe } from "./recherche.ts";
import { type Affirmation, juger, lire, verifier } from "./reponse.ts";

/** Un passage cité : la révision de la source et ses offsets dans son `document.txt`. */
export type Citation = {
  source_id: string;
  revision: number;
  chunk_id: string;
  titre: string;
  citation: string;
  debut: number;
  fin: number;
};
/**
 * Un champ de l'exercice et les passages qui le prouvent. `soutien` : l'avis du juge sur le champ
 * entier, `null` si le juge n'a pas répondu, absent avant tout jugement.
 */
export type Champ = { texte: string; citations: Citation[]; soutien?: number | null };
export type Contenu = { consigne: Champ; attendu: Champ; criteres: Champ[]; retour: Champ };

export const CRITERES = { min: 2, max: 5 };
export const MAX_TEXTE = 2000;

/** Les champs dans l'ordre de lecture : consigne, réponse attendue, critères, retour. */
export const champs = (c: Contenu) => [c.consigne, c.attendu, ...c.criteres, c.retour];

// Pas encore mesurée : ni jeu d'exercices annoté ni évaluation (`evaluation/`).
export const CONSIGNE_ACTIVITE = `Tu prepares un exercice a reponse courte pour une personne qui apprend, a partir
d'extraits de ressources fournies et de RIEN d'autre. L'exercice sert l'objectif donne.

Regles, sans exception :
1. Tout ce que tu ecris se trouve dans les extraits. Tu n'ajoutes aucune connaissance personnelle.
2. Si les extraits ne permettent pas d'exercice sur cet objectif, tu rends exactement {"refus": true}.
3. Tu rends uniquement un objet JSON, sans texte autour, de cette forme :
   {"consigne": CHAMP, "attendu": CHAMP, "criteres": [CHAMP, CHAMP], "retour": CHAMP}
   ou chaque CHAMP vaut {"texte": "...", "citations": [{"extrait": 1, "citation": "..."}]}
   - "consigne" : la question posee, en une ou deux phrases.
   - "attendu" : la reponse attendue, en quelques phrases.
   - "criteres" : de ${CRITERES.min} a ${CRITERES.max} criteres de reussite, un element a retrouver par critere.
   - "retour" : une explication courte a lire apres avoir repondu.
   - "citations" : un a trois passages par champ. "extrait" est le numero de l'extrait, "citation"
     un passage de 5 a 40 mots recopie EXACTEMENT, mot pour mot, de cet extrait, qui prouve le
     champ. Un seul passage continu, sans points de suspension, sans guillemets ajoutes, sans
     corriger l'orthographe.
4. Un champ ne dit rien de plus que ses citations.`;

/** Une affirmation vérifiée devient une citation si elle a des offsets dans le texte du document. */
const enCitation = (a: Affirmation): Citation | undefined =>
  a.debut === undefined || a.fin === undefined
    ? undefined
    : {
        source_id: a.source_id,
        revision: a.revision ?? 1,
        chunk_id: a.chunk_id,
        titre: a.titre,
        citation: a.citation,
        debut: a.debut,
        fin: a.fin,
      };

/**
 * Un champ du modèle, gardé si chacune de ses citations se retrouve mot pour mot dans l'extrait
 * qu'elle désigne (`verifier`, comme une réponse). Sinon le motif du rejet, sans texte de source :
 * il reste enregistré après la suppression d'une source.
 */
function ancrerChamp(x: unknown, nom: string, passages: ChunkIndexe[]): Champ | string {
  const brut = (x ?? {}) as { texte?: unknown; citations?: unknown };
  const texte = typeof brut.texte === "string" ? brut.texte.trim() : "";
  const liste = Array.isArray(brut.citations)
    ? (brut.citations as (Record<string, unknown> | null)[])
    : [];
  if (!texte || texte.length > MAX_TEXTE) return `${nom} : texte vide ou trop long.`;
  if (!liste.length) return `${nom} : aucune citation.`;
  const v = verifier(
    { affirmations: liste.map((c) => ({ texte, extrait: c?.extrait, citation: c?.citation })) },
    passages,
  );
  // Une citation trouvée seulement dans une légende d'image n'a pas d'offsets : elle ne compte pas.
  const citations = v.affirmations.flatMap((a) => enCitation(a) ?? []);
  if (v.erreurs.length || citations.length !== liste.length) {
    return `${nom} : une citation ne se retrouve pas mot pour mot dans le texte des extraits.`;
  }
  return { texte, citations };
}

/**
 * Un appel du générateur rédige consigne, réponse attendue, critères et retour, chacun avec ses
 * citations. Un champ mal ancré est rejeté et compté (ADR 0002). Sans consigne, réponse attendue,
 * retour et deux critères ancrés, il n'y a pas d'exercice.
 */
export async function genererActivite(
  modeles: Modeles,
  objectif: string,
  passages: ChunkIndexe[],
  signal?: AbortSignal,
): Promise<{ contenu?: Contenu; rejets: string[]; modele: string; refus?: true }> {
  const messages: Message[] = [
    { role: "system", content: CONSIGNE_ACTIVITE },
    {
      role: "user",
      content: `Extraits :\n\n${passages
        .map((p, i) => `[${i + 1}] ${p.titre}\n${p.texte}`)
        .join("\n\n")}\n\nObjectif : ${objectif}`,
    },
  ];
  const { texte, modele } = await modeles.generer(messages, signal);
  const brute = lire(texte) as Record<string, unknown> | null;
  if (!brute) return { rejets: ["La sortie n'est pas un objet JSON."], modele };
  if (brute.refus) return { rejets: [], modele, refus: true };
  const rejets: string[] = [];
  const garder = (x: unknown, nom: string) => {
    const r = ancrerChamp(x, nom, passages);
    if (typeof r !== "string") return r;
    rejets.push(r);
  };
  const consigne = garder(brute.consigne, "Consigne");
  const attendu = garder(brute.attendu, "Réponse attendue");
  const criteres = (Array.isArray(brute.criteres) ? brute.criteres.slice(0, CRITERES.max) : [])
    .map((c, i) => garder(c, `Critère ${i + 1}`))
    .filter((c) => c !== undefined);
  const retour = garder(brute.retour, "Retour");
  if (!consigne || !attendu || !retour || criteres.length < CRITERES.min) return { rejets, modele };
  const contenu = { consigne, attendu, criteres, retour };
  await jugerChamps(modeles, champs(contenu), signal);
  return { contenu, rejets, modele };
}

/**
 * Une citation retrouvée ne prouve que son passage, pas tout le champ. Le juge de soutien des
 * réponses lit chaque champ sans avis contre ses passages mis bout à bout, un appel par champ, en
 * parallèle. Il ne rejette rien : l'enseignant relit les champs qu'il ne soutient pas.
 */
export async function jugerChamps(modeles: Modeles, liste: Champ[], signal?: AbortSignal) {
  const sans = liste.filter((ch) => typeof ch.soutien !== "number");
  const { probabilites } = await juger(
    modeles,
    sans.map((ch) => ({
      texte: ch.texte,
      citation: ch.citations.map((c) => c.citation).join(" […] "),
      titre: [...new Set(ch.citations.map((c) => c.titre))].join(", "),
      source_id: ch.citations[0].source_id,
      chunk_id: ch.citations[0].chunk_id,
    })),
    {},
    "general",
    signal,
  );
  sans.forEach((ch, i) => (ch.soutien = probabilites[i]));
}

/**
 * Retrouve un passage dans les chunks d'une révision, comme `verifier` le cherche dans un extrait.
 * Rend la citation du premier chunk qui le contient, ou `undefined`.
 */
export function ancrer(citation: string, chunks: ChunkIndexe[]): Citation | undefined {
  const v = verifier(
    { affirmations: chunks.map((_, i) => ({ texte: "-", extrait: i + 1, citation })) },
    chunks,
  );
  return v.affirmations.map(enCitation).find((c) => c !== undefined);
}
