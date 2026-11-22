import {
  type Champ,
  champsQuestion,
  type Contenu,
  MAX_TEXTE,
  OPTIONS,
  type Option,
  type Question,
} from "./contenu.ts";
import { sansAccents } from "./texte.ts";

// Correction d'une réponse. Le barème et le format des quiz viennent de carnet-quiz.

/**
 * Les mots d'une réponse, en minuscules, sans accents ni ponctuation : « Loi de Jakob ! » devient
 * loi, de, jakob. Le signe moins collé devant un chiffre fait partie du nombre : « -1 » ne vaut
 * pas « 1 », alors que « Jean-Paul » se lit comme deux mots.
 */
const mots = (s: string) =>
  sansAccents(s)
    .toLowerCase()
    .replace(/\u2212/g, "-")
    .match(/(?:(?<![a-z0-9])-(?=\d))?[a-z0-9]+/g) ?? [];

/** Mots qui entourent la réponse sans la changer : « c'est la loi de Jakob » se compare comme « jakob ». */
const FILLERS = new Set(
  "c est ce cest le la les l un une des de du d loi lois principe effet regle the a an of law effect principle".split(
    " ",
  ),
);
/**
 * Un mot de liaison ne s'efface que devant un autre mot. Le dernier mot reste : dans « balise a »
 * ou « la loi », il est la réponse.
 */
const noyau = (s: string) => {
  const liste = mots(s);
  return liste.filter((m, i) => i === liste.length - 1 || !FILLERS.has(m));
};

function distance(a: string, b: string): number {
  let prec = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const ligne = [i];
    for (let j = 1; j <= b.length; j++) {
      ligne[j] = Math.min(
        prec[j] + 1,
        ligne[j - 1] + 1,
        prec[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prec = ligne;
  }
  return prec[b.length];
}

/** Les fautes de frappe tolérées dans un mot. Aucune dès qu'il porte un chiffre : « 1798 » est une autre date que « 1789 ». */
const tolerance = (attendu: string, saisi: string) =>
  /\d/.test(attendu + saisi) ? 0 : attendu.length >= 10 ? 2 : attendu.length >= 5 ? 1 : 0;

/**
 * Une saisie est juste si, mots de liaison retirés, chacun de ses mots vaut le mot de même rang
 * d'une variante acceptée, à la tolérance de ce mot près. Toute la réponse compte : « Jakob Hick »
 * ne vaut pas « Jakob ».
 */
export function correspond(saisie: string, acceptes: string[]): boolean {
  const x = noyau(saisie);
  if (!x.length) return false;
  return acceptes.some((variante) => {
    const y = noyau(variante);
    return y.length === x.length && y.every((m, i) => distance(x[i], m) <= tolerance(m, x[i]));
  });
}

/**
 * Vrai si la saisie est acceptée sans être une des variantes, casse et espaces mis à part. Accent,
 * ponctuation, mot de liaison ou faute de frappe : l'enseignant relit ce que Thot a laissé passer.
 */
export function approchee(saisie: string, acceptes: string[]): boolean {
  const brut = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return correspond(saisie, acceptes) && !acceptes.some((a) => brut(a) === brut(saisie));
}

const ordre = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const idsTries = (ids: string[]) => [...new Set(ids)].sort(ordre).join(",");

/** La valeur reçue du navigateur, mise en forme pour la base. `null` si elle ne convient pas à la question. */
export function valeur(q: Question, brut: unknown): string | null {
  if (q.type === "choix") {
    return typeof brut === "string" && q.options.some((o) => o.id === brut) ? brut : null;
  }
  if (q.type === "choix_multiple") {
    const liste = Array.isArray(brut) ? brut : [brut];
    if (!liste.every((id) => typeof id === "string" && q.options.some((o) => o.id === id)))
      return null;
    return liste.length ? idsTries(liste) : null;
  }
  // Le navigateur envoie les fins de ligne en CRLF, alors que `maxlength` les compte pour un caractère.
  const texte = typeof brut === "string" ? brut.replace(/\r\n?/g, "\n").trim() : "";
  const max = q.type === "redigee" ? 4000 : 200;
  return texte && texte.length <= max ? texte : null;
}

/** Vrai pour une saisie que `valeur()` refuse alors qu'elle n'est pas vide : un texte trop long, une option inconnue. */
export const refusee = (q: Question, brut: unknown) =>
  valeur(q, brut) === null &&
  !(
    brut === undefined ||
    (typeof brut === "string" ? !brut.trim() : Array.isArray(brut) && !brut.length)
  );

/** Une réponse rédigée n'est jamais notée par Thot. */
export function juste(q: Question, v: string): boolean {
  if (q.type === "choix") return q.options.some((o) => o.id === v && o.juste);
  if (q.type === "choix_multiple") {
    return (
      v ===
      q.options
        .filter((o) => o.juste)
        .map((o) => o.id)
        .sort()
        .join(",")
    );
  }
  return q.type === "terme" && correspond(v, q.accepte);
}

/** Une question à choix s'arrête quand il ne reste qu'une option. */
export function essaisMax(q: Question, correction: Contenu["correction"]): number {
  if (correction === "serie" || q.type === "redigee") return 1;
  return q.type === "choix" ? Math.min(2, q.options.length - 1) : 2;
}

/** Finie quand une réponse est juste ou que les essais sont épuisés. */
export const finie = (q: Question, essais: string[], correction: Contenu["correction"]) =>
  essais.some((v) => juste(q, v)) || essais.length >= essaisMax(q, correction);

/**
 * 1 point au premier essai, 0,5 au deuxième, 0 ensuite. La note du professeur l'emporte.
 * `null` : réponse rédigée en attente de note.
 */
export function points(
  q: Question,
  essais: string[],
  correction: Contenu["correction"],
  note: number | null = null,
): number | null {
  if (note !== null) return note;
  if (q.type === "redigee") return essais.length ? null : 0;
  const rang = essais.slice(0, essaisMax(q, correction)).findIndex((v) => juste(q, v));
  return rang === 0 ? 1 : rang === 1 ? 0.5 : 0;
}

/** Un mélange qui ne change pas au rechargement : même graine, même ordre. */
export function melanger<T>(liste: T[], graine: string): T[] {
  // FNV-1a pour la graine, mulberry32 pour la suite
  let h = 2166136261;
  for (const c of graine) h = Math.imul(h ^ c.codePointAt(0)!, 16777619);
  let etat = h >>> 0;
  const hasard = () => {
    etat = (etat + 0x6d2b79f5) >>> 0;
    let t = Math.imul(etat ^ (etat >>> 15), 1 | etat);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const sortie = [...liste];
  for (let i = sortie.length - 1; i > 0; i--) {
    const j = Math.floor(hasard() * (i + 1));
    [sortie[i], sortie[j]] = [sortie[j], sortie[i]];
  }
  return sortie;
}

/** Ce qui rend une question inutilisable, un message par défaut. L'appelant ajoute le numéro. */
export function erreursQuestion(q: Question): string[] {
  const erreurs: string[] = [];
  if (!q.consigne.texte.trim()) erreurs.push("la consigne est vide.");
  if (champsQuestion(q).some((c) => c.texte.length > MAX_TEXTE)) {
    erreurs.push(`un texte dépasse ${MAX_TEXTE} caractères.`);
  }
  if (q.type === "choix" || q.type === "choix_multiple") {
    const { options } = q;
    if (options.length < OPTIONS.min || options.length > OPTIONS.max) {
      erreurs.push(`il faut de ${OPTIONS.min} à ${OPTIONS.max} options.`);
    }
    if (new Set(options.map((o) => o.id)).size !== options.length || options.some((o) => !o.id)) {
      erreurs.push("les identifiants d'options doivent être différents et non vides.");
    }
    if (options.some((o) => !o.texte.texte.trim())) erreurs.push("une option est vide.");
    const justes = options.filter((o) => o.juste).length;
    if (q.type === "choix" && justes !== 1) erreurs.push("il faut exactement une bonne option.");
    if (q.type === "choix_multiple" && justes < 1)
      erreurs.push("il faut au moins une bonne option.");
  }
  if (q.type === "terme") {
    if (!q.accepte.length) erreurs.push("il faut au moins une réponse acceptée.");
    for (const a of q.accepte) {
      if (!noyau(a).length) erreurs.push(`la réponse acceptée « ${a} » n'a ni lettre ni chiffre.`);
    }
  }
  if (q.image) {
    if (!q.image.alt.trim()) erreurs.push("l'image a besoin d'un texte alternatif.");
    if (!q.image.fichier === !q.image.media) {
      erreurs.push(
        "l'image vient soit d'un fichier déposé, soit d'une source, pas des deux ni d'aucun.",
      );
    }
  }
  const langage = "langage" in q ? q.langage : undefined;
  if (langage !== undefined && (q.type !== "redigee" || !/^[a-z0-9+#-]{1,20}$/.test(langage))) {
    erreurs.push(`le langage « ${langage} » est invalide, ou la question n'est pas rédigée.`);
  }
  return erreurs;
}

// Import d'un quiz carnet-quiz

type Brut = Record<string, unknown>;
const dict = (v: unknown): Brut => (v && typeof v === "object" ? (v as Brut) : {});
const chaine = (v: unknown) => (typeof v === "string" ? v.trim() : "");
/** Un texte écrit par le professeur : aucun passage de source ne le prouve. */
const champ = (v: unknown): Champ => ({ texte: chaine(v), citations: [] });

const LETTRES = "ABCDEFGH";

/** Les anciens decks `{ flashcards: [...] }` deviennent des questions à choix unique. */
function depuisFlashcards(cartes: unknown): Brut[] {
  const clair = (t: unknown) =>
    String(t ?? "")
      .replace(/`/g, "")
      .trim()
      .toLowerCase();
  const questions: Brut[] = [];
  for (const c of Array.isArray(cartes) ? cartes.map(dict) : []) {
    if (!Array.isArray(c.choices) || !c.choices.length) continue;
    const bonne =
      typeof c.correct_choice_index === "number"
        ? c.correct_choice_index
        : c.choices.findIndex((ch) => clair(c.reponse).startsWith(clair(ch)));
    if (bonne < 0 || bonne >= c.choices.length) continue;
    const id = (j: number) => LETTRES[j] ?? String(j + 1);
    questions.push({
      id: `q${questions.length + 1}`,
      question: c.question,
      options: c.choices.map((label, j) => ({ id: id(j), label })),
      correctAnswer: id(bonne),
      explanation: c.explanation,
    });
  }
  return questions;
}

const TYPES_CARNET = {
  choice: "choix",
  multiple: "choix_multiple",
  text: "terme",
  open: "redigee",
};

function convertir(b: Brut, id: string): Question | string {
  const type = b.type ?? "choice";
  if (typeof type !== "string" || !(type in TYPES_CARNET))
    return `type inconnu « ${String(type)} ».`;
  const indice = [chaine(b.hint), chaine(b.lookup) && `Cherchez dans ${chaine(b.lookup)}.`]
    .filter(Boolean)
    .join(" ");
  const commun = {
    id,
    consigne: champ(b.question),
    retour: champ(b.explanation),
    ...(indice && { indice }),
  };
  const bonnes = (
    type === "choice" ? [b.correctAnswer] : Array.isArray(b.correctAnswers) ? b.correctAnswers : []
  ).filter((x): x is string => typeof x === "string");
  const options: Option[] = (Array.isArray(b.options) ? b.options : []).map((o) => {
    const id = String(dict(o).id ?? "");
    return { id, texte: champ(dict(o).label), juste: bonnes.includes(id) };
  });
  switch (type) {
    case "choice":
      return { ...commun, type: "choix", options };
    case "multiple": {
      const ids = new Set(options.map((o) => o.id));
      const inconnues = bonnes.some((x) => !ids.has(x));
      return inconnues
        ? "correctAnswers cite une option qui n'existe pas."
        : { ...commun, type: "choix_multiple", options };
    }
    case "text":
      return {
        ...commun,
        type: "terme",
        accepte: (Array.isArray(b.accept) ? b.accept : []).map((a) => chaine(a)),
      };
    default:
      return { ...commun, type: "redigee", attendu: champ(b.expected), criteres: [] };
  }
}

/**
 * Convertit un quiz carnet-quiz déjà lu en JSON. `ignores` dit, une fois par sorte, ce que Thot n'a
 * pas repris. Les images ne passent pas : Thot ne sert que les fichiers qu'il garde.
 */
export function depuisCarnet(
  json: unknown,
): { titre: string; questions: Question[]; ignores: string[] } | { erreurs: string[] } {
  const quiz = dict(json);
  const bruts = (
    Array.isArray(quiz.questions) ? quiz.questions : depuisFlashcards(quiz.flashcards)
  ).map(dict);
  const titre = chaine(quiz.title);
  const erreurs: string[] = [];
  if (!titre) erreurs.push("Il manque le titre (title).");
  if (!bruts.length) erreurs.push("Il n'y a aucune question.");

  // Les identifiants du fichier ne sont pas repris. Celui d'une question entre dans une adresse et
  // nomme un champ du formulaire de l'élève, ceux des options se joignent par une virgule.
  const questions: Question[] = [];
  bruts.forEach((b, i) => {
    const q = convertir(b, `q${i + 1}`);
    const problemes = typeof q === "string" ? [q] : erreursQuestion(q);
    for (const p of problemes) erreurs.push(`Question ${i + 1} : ${p}`);
    if (typeof q === "string") return;
    questions.push(
      "options" in q
        ? { ...q, options: q.options.map((o, j) => ({ ...o, id: LETTRES[j] ?? String(j + 1) })) }
        : q,
    );
  });
  if (erreurs.length) return { erreurs };

  const ignores = [
    [bruts.some((b) => b.trap !== undefined || b.trapAnswers !== undefined), "pièges anti-IA"],
    [Number(quiz.timeLimit) > 0 || bruts.some((b) => Number(b.timeLimit) > 0), "chrono"],
    [bruts.some((b) => b.lookupUrl), "liens de recherche"],
    [bruts.some((b) => b.image), "images : déposez-les dans Thot"],
    [quiz.courseUrl, "lien vers le cours (courseUrl)"],
  ].flatMap(([present, nom]) => (present ? [nom as string] : []));
  return { titre, questions, ignores };
}
