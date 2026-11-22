import type { Affirmation, BlocReponse } from "./reponse.ts";

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

/** Une question rédigée par Thot garde ses champs de cet ancien format, sans `id` ni `type`. */
export type Redaction = { consigne: Champ; attendu: Champ; criteres: Champ[]; retour: Champ };

export const TYPES_QUESTION = ["redigee", "choix", "choix_multiple", "terme"] as const;
export type TypeQuestion = (typeof TYPES_QUESTION)[number];

/**
 * Une image déposée avec l'activité (`fichier`) ou prise parmi celles d'une source (`media`, avec
 * l'identifiant de cette source dans `source`).
 */
export type ImageQuestion = { fichier?: string; media?: string; source?: string; alt: string };

type Commun = {
  /** Stable d'une version à l'autre : une réponse d'élève s'y rattache. */
  id: string;
  consigne: Champ;
  /** L'explication lue une fois la question corrigée. Son texte peut rester vide. */
  retour: Champ;
  /** Montré après une première erreur, quand la correction suit chaque question. */
  indice?: string;
  image?: ImageQuestion;
  /** L'identifiant d'une source du cours où chercher la réponse. */
  ou?: string;
};
/** Une option fausse n'affirme rien : elle n'a pas besoin de citation. */
export type Option = { id: string; texte: Champ; juste: boolean };
export type Question =
  | (Commun & { type: "redigee"; attendu: Champ; criteres: Champ[]; langage?: string })
  | (Commun & { type: "choix" | "choix_multiple"; options: Option[] })
  | (Commun & { type: "terme"; accepte: string[] });

/**
 * Un exercice : une série de questions. `correction` : le corrigé d'une question sort après sa
 * propre réponse (`question`) ou après la remise de toute la série (`serie`).
 */
export type Contenu = { questions: Question[]; correction: "question" | "serie" };

export const CRITERES = { min: 2, max: 5 };
export const OPTIONS = { min: 2, max: 8 };
export const MAX_QUESTIONS = 40;
export const MAX_TEXTE = 2000;

/**
 * Une explication d'étude : la réponse vérifiée de `demander()` à l'objectif, affirmations et
 * blocs, chacune avec la révision de sa source.
 */
export type Explication = {
  affirmations: Affirmation[];
  blocs?: BlocReponse[];
  /** des phrases dont la citation ne tenait pas ont été retirées */
  partielle?: boolean;
  juge_indisponible?: boolean;
};

/** Les champs d'une question dans l'ordre de lecture, du consigne au retour. */
export const champsQuestion = (q: Question): Champ[] => [
  q.consigne,
  ...(q.type === "redigee"
    ? [q.attendu, ...q.criteres]
    : q.type === "terme"
      ? []
      : q.options.map((o) => o.texte)),
  q.retour,
];

/** Les champs de toutes les questions d'un exercice. */
export const champs = (c: Contenu) => c.questions.flatMap(champsQuestion);

/** La question dont chaque champ passe par `f`. */
export const transformer = (q: Question, f: (ch: Champ) => Champ): Question => {
  const commun = { consigne: f(q.consigne), retour: f(q.retour) };
  if (q.type === "redigee") {
    return { ...q, ...commun, attendu: f(q.attendu), criteres: q.criteres.map(f) };
  }
  if (q.type === "terme") return { ...q, ...commun };
  return { ...q, ...commun, options: q.options.map((o) => ({ ...o, texte: f(o.texte) })) };
};

/**
 * Les sources qu'une question montre sans les citer : celle d'une image prise dans une source, et
 * celle où chercher la réponse. Elles doivent rester lisibles, comme une source citée.
 */
export const sourcesMontrees = (c: Contenu) =>
  c.questions.flatMap((q) => [q.image?.source, q.ou].filter((s): s is string => !!s));

/** Les passages qu'une activité cite : sa source, sa révision et son titre. */
export const citationsDe = (
  c: Contenu | Explication,
): Pick<Citation, "source_id" | "revision" | "titre">[] =>
  "affirmations" in c
    ? c.affirmations.map((a) => ({
        source_id: a.source_id,
        revision: a.revision ?? 1,
        titre: a.titre,
      }))
    : champs(c).flatMap((ch) => ch.citations);
