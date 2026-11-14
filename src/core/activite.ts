import type { Message, Modeles } from "./modeles.ts";
import type { ChunkIndexe } from "./recherche.ts";
import { erreursQuestion, melanger } from "./questions.ts";
import { type Affirmation, type BlocReponse, juger, lire, verifier } from "./reponse.ts";
import { sansAccents } from "./texte.ts";

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

// Pas encore mesurées : ni jeu de séries annotées ni évaluation (`evaluation/`).
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

const OPTIONS_GENEREES = { min: 3, max: 5 };

/** Les trois types fermés partagent leurs règles : seuls la forme du JSON et le détail changent. */
const consigneFermee = (
  type: string,
  forme: string,
  details: string,
) => `Tu prepares ${type} pour une personne qui apprend, a partir d'extraits de ressources
fournies et de RIEN d'autre. La question sert l'objectif donne et fait partie d'une serie : on te dit
son numero et le nombre de questions de la serie.

Regles, sans exception :
1. Tout ce que tu ecris de vrai se trouve dans les extraits. Tu n'ajoutes aucune connaissance personnelle.
2. Si les extraits ne permettent pas de question sur cet objectif, tu rends exactement {"refus": true}.
3. Tu rends uniquement un objet JSON, sans texte autour, de cette forme :
   ${forme}
   ou chaque CHAMP vaut {"texte": "...", "citations": [{"extrait": 1, "citation": "..."}]}
${details}
   - "retour" : une explication courte a lire apres avoir repondu.
   - "citations" : un a trois passages par champ cite. "extrait" est le numero de l'extrait,
     "citation" un passage de 5 a 40 mots recopie EXACTEMENT, mot pour mot, de cet extrait, qui prouve
     le champ. Un seul passage continu, sans points de suspension, sans guillemets ajoutes, sans
     corriger l'orthographe.
4. Un champ ne dit rien de plus que ses citations.`;

const OPTION = `{"texte": "...", "juste": true, "citations": [{"extrait": 1, "citation": "..."}]}`;
const FAUSSE = `{"texte": "...", "juste": false}`;
const REGLES_OPTIONS = `   - "options" : de ${OPTIONS_GENEREES.min} a ${OPTIONS_GENEREES.max} options. Une bonne option affirme quelque chose de vrai selon les extraits et
     porte ses citations. Une option fausse n'a PAS de citations : elle est plausible pour qui n'a pas
     compris, mais FAUSSE selon les extraits. Les options ont la meme longueur et le meme style, aucune
     n'est « toutes les reponses » ou « aucune ».`;

export const CONSIGNES_QUESTION: Record<TypeQuestion, string> = {
  redigee: CONSIGNE_ACTIVITE,
  choix: consigneFermee(
    "une question a choix unique",
    `{"consigne": CHAMP, "options": [${OPTION}, ${FAUSSE}, ${FAUSSE}], "retour": CHAMP}`,
    `   - "consigne" : la question posee, en une ou deux phrases.
${REGLES_OPTIONS}
     EXACTEMENT UNE option est juste.`,
  ),
  choix_multiple: consigneFermee(
    "une question a choix multiple",
    `{"consigne": CHAMP, "options": [${OPTION}, ${OPTION}, ${FAUSSE}, ${FAUSSE}], "retour": CHAMP}`,
    `   - "consigne" : la question posee, en une ou deux phrases, qui dit que plusieurs reponses peuvent etre justes.
${REGLES_OPTIONS}
     DEUX options justes ou plus, et au moins une fausse.`,
  ),
  terme: consigneFermee(
    "une question dont la reponse est un mot ou une expression courte a taper",
    `{"consigne": CHAMP, "accepte": ["...", "..."], "retour": CHAMP}`,
    `   - "consigne" : la question posee, en une ou deux phrases. Elle ne contient pas la reponse.
   - "accepte" : de 1 a 3 formulations acceptees, un a trois mots chacune, la plus courante en premier.
     La premiere apparait mot pour mot dans une des citations de la consigne ou du retour : c'est
     le passage qui prouve la reponse.`,
  ),
};

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

type Brut = Record<string, unknown>;
/** Une question, ou les motifs qui l'ont fait rejeter. */
type Ecrite = { question?: Question; rejets: string[] };
const lettre = (i: number) => String.fromCharCode(65 + i);

/** Les champs d'une question redigée par le modèle, chacun ancré ou rejeté et compté. */
function ecrire(type: TypeQuestion, brute: Brut, passages: ChunkIndexe[], id: string): Ecrite {
  const rejets: string[] = [];
  const garder = (x: unknown, nom: string) => {
    const r = ancrerChamp(x, nom, passages);
    if (typeof r !== "string") return r;
    rejets.push(r);
  };
  const consigne = garder(brute.consigne, "Consigne");
  const retour = garder(brute.retour, "Retour");
  if (type === "redigee") {
    const attendu = garder(brute.attendu, "Réponse attendue");
    const criteres = (Array.isArray(brute.criteres) ? brute.criteres.slice(0, CRITERES.max) : [])
      .map((c, i) => garder(c, `Critère ${i + 1}`))
      .filter((c) => c !== undefined);
    if (!consigne || !attendu || !retour || criteres.length < CRITERES.min) return { rejets };
    return { question: { id, type, consigne, attendu, criteres, retour }, rejets };
  }
  if (type === "terme") {
    const accepte = (Array.isArray(brute.accepte) ? brute.accepte.slice(0, 3) : [])
      .map((a) => (typeof a === "string" ? a.trim() : ""))
      .filter(Boolean);
    if (!accepte.length) rejets.push("Réponse acceptée : aucune.");
    if (!consigne || !retour || !accepte.length) return { rejets };
    // La réponse elle-même doit tenir dans un passage cité, sans compter casse ni accents.
    const cherche = sansAccents(accepte[0]).toLowerCase();
    const prouvee = [...consigne.citations, ...retour.citations].some((c) =>
      sansAccents(c.citation).toLowerCase().includes(cherche),
    );
    if (!prouvee) {
      return { rejets: [...rejets, "Réponse acceptée : aucune citation ne la contient."] };
    }
    return { question: { id, type, consigne, retour, accepte }, rejets };
  }
  // Une option juste se cite comme tout champ de Thot, une option fausse n'affirme rien. Une bonne
  // option mal ancrée fait tomber la question : sans elle, la correction serait fausse.
  let ratee = false;
  const options: Omit<Option, "id">[] = [];
  const liste = Array.isArray(brute.options)
    ? (brute.options.slice(0, OPTIONS_GENEREES.max) as Brut[])
    : [];
  liste.forEach((o, i) => {
    if (o?.juste === true) {
      const texte = garder(o, `Option ${i + 1}`);
      if (texte) options.push({ texte, juste: true });
      else ratee = true;
    } else if (typeof o?.texte === "string" && o.texte.trim() && o.texte.length <= MAX_TEXTE) {
      options.push({ texte: { texte: o.texte.trim(), citations: [] }, juste: false });
    }
  });
  if (options.length < OPTIONS_GENEREES.min)
    rejets.push("Options : trois au moins sont utilisables.");
  if (!consigne || !retour || ratee || options.length < OPTIONS_GENEREES.min) return { rejets };
  // Le modèle met souvent la bonne option en premier.
  const lettrees = melanger(options, id).map((o, i) => ({ ...o, id: lettre(i) }));
  return { question: { id, type, consigne, retour, options: lettrees }, rejets };
}

export type RangQuestion = { n: number; total: number; eviter?: string[] };

/**
 * Un appel du générateur rédige une question du type demandé, chaque champ avec ses citations. Un
 * champ mal ancré est rejeté et compté (ADR 0002) : sans les champs obligatoires du type, il n'y a
 * pas de question. Une question de `rang.total` > 1 reçoit son numéro, et ses extraits tournent pour
 * que chaque appel parte de passages différents.
 */
export async function genererQuestion(
  modeles: Modeles,
  type: TypeQuestion,
  objectif: string,
  passages: ChunkIndexe[],
  rang: RangQuestion = { n: 1, total: 1 },
  signal?: AbortSignal,
): Promise<{ question?: Question; rejets: string[]; modele: string; refus?: true }> {
  // ponytail: la rotation des extraits diversifie à bas coût, mais deux questions peuvent encore se
  // ressembler. Un appel de planification qui répartit les points entre les questions en est la
  // montée en gamme.
  const decalage = (rang.n - 1) % Math.max(1, passages.length);
  const tournes = [...passages.slice(decalage), ...passages.slice(0, decalage)];
  const serie = rang.total > 1 ? `\n\nQuestion ${rang.n} sur ${rang.total}.` : "";
  const eviter = rang.eviter?.length
    ? `\n\nQuestions deja ecrites, a ne pas reprendre :\n${rang.eviter.map((c) => `- ${c}`).join("\n")}`
    : "";
  const messages: Message[] = [
    { role: "system", content: CONSIGNES_QUESTION[type] },
    {
      role: "user",
      content: `Extraits :\n\n${tournes
        .map((p, i) => `[${i + 1}] ${p.titre}\n${p.texte}`)
        .join("\n\n")}\n\nObjectif : ${objectif}${serie}${eviter}`,
    },
  ];
  const { texte, modele } = await modeles.generer(messages, signal);
  const brute = lire(texte) as Brut | null;
  if (!brute) return { rejets: ["La sortie n'est pas un objet JSON."], modele };
  if (brute.refus) return { rejets: [], modele, refus: true };
  const { question, rejets } = ecrire(type, brute, tournes, crypto.randomUUID().slice(0, 8));
  if (!question) return { rejets, modele };
  const invalide = erreursQuestion(question);
  if (invalide.length) return { rejets: [...rejets, ...invalide], modele };
  await jugerChamps(modeles, champsQuestion(question), signal);
  return { question, rejets, modele };
}

/** Le type de chaque question d'une série : les types choisis, en boucle. */
export const typesDeSerie = (nombre: number, types: TypeQuestion[]) =>
  Array.from({ length: nombre }, (_, i) => types[i % types.length]);

/**
 * Une série : un appel du générateur par question, tous lancés ensemble. Une question rejetée, ou
 * dont l'appel échoue, n'arrête pas les autres. Ses motifs portent « Question n : » quand la série
 * en compte plusieurs. `refus` : le modèle a refusé toutes les questions. Si tous les appels
 * échouent, l'erreur du premier remonte.
 */
export async function genererSerie(
  modeles: Modeles,
  objectif: string,
  passages: ChunkIndexe[],
  types: TypeQuestion[],
  signal?: AbortSignal,
): Promise<{ questions: Question[]; rejets: string[]; modele: string; refus?: true }> {
  const total = types.length;
  const faits = await Promise.allSettled(
    types.map((t, i) =>
      genererQuestion(modeles, t, objectif, passages, { n: i + 1, total }, signal),
    ),
  );
  const ok = faits.flatMap((f) => (f.status === "fulfilled" ? [f.value] : []));
  if (!ok.length) throw (faits[0] as PromiseRejectedResult).reason;
  const rejets = faits.flatMap((f, i) => {
    const motifs = f.status === "fulfilled" ? f.value.rejets : ["l'appel du modèle a échoué."];
    return motifs.map((m) => (total > 1 ? `Question ${i + 1} : ${m}` : m));
  });
  const questions = ok.flatMap((g) => g.question ?? []);
  return {
    questions,
    rejets,
    modele: ok[0].modele,
    ...(!questions.length && ok.every((g) => g.refus) && faits.length === ok.length
      ? { refus: true as const }
      : {}),
  };
}

/**
 * Une citation retrouvée ne prouve que son passage, pas tout le champ. Le juge de soutien des
 * réponses lit chaque champ cité et sans avis contre ses passages mis bout à bout, un appel par
 * champ, en parallèle. Il ne rejette rien : l'enseignant relit les champs qu'il ne soutient pas.
 * Un champ sans passage, rédigé par l'enseignant, n'a rien à soutenir.
 */
export async function jugerChamps(modeles: Modeles, liste: Champ[], signal?: AbortSignal) {
  const sans = liste.filter((ch) => typeof ch.soutien !== "number" && ch.citations.length);
  if (!sans.length) return;
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
