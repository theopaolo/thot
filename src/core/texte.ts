// Les offsets de citation comptent des points de code, comme en Python. Les chaînes
// JavaScript comptent des unités UTF-16. Tout découpage de `document.txt` passe par ici.

export const longueur = (s: string) => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

export const tranche = (s: string, debut: number, fin: number) =>
  Array.from(s).slice(debut, fin).join("");

/**
 * Ce qu'on montre autour d'une citation: le paragraphe qui la contient, au plus `marge` points
 * de code de chaque côté, coupé sur une espace. `coupe*` dit s'il faut des points de suspension.
 */
export function contexte(texte: string, debut: number, fin: number, marge = 300) {
  const c = Array.from(texte);
  const limiteA = Math.max(0, debut - marge);
  let a = debut;
  while (a > limiteA && !(c[a - 1] === "\n" && c[a - 2] === "\n")) a--;
  const coupeAvant = a === limiteA && a > 0 && !(c[a - 1] === "\n" && c[a - 2] === "\n");
  if (coupeAvant) {
    while (a < debut && !/\s/.test(c[a - 1])) a++;
  }
  const limiteZ = Math.min(c.length, fin + marge);
  let z = fin;
  while (z < limiteZ && !(c[z] === "\n" && c[z + 1] === "\n")) z++;
  const coupeApres = z === limiteZ && z < c.length && !(c[z] === "\n" && c[z + 1] === "\n");
  if (coupeApres) {
    while (z > fin && !/\s/.test(c[z])) z--;
  }
  return {
    avant: c.slice(a, debut).join(""),
    milieu: c.slice(debut, fin).join(""),
    apres: c.slice(fin, z).join("").trimEnd(),
    coupeAvant,
    coupeApres,
  };
}

/**
 * Forme de comparaison d'un point de code: apostrophes et guillemets unifiés, espaces réduites,
 * casse ignorée. Une puce compte comme une espace: le modèle recolle les listes en une phrase.
 * Le trait d'union conditionnel, les espaces sans chasse et les liants disparaissent, une ligature
 * d'imprimerie redevient ses lettres: un PDF en met là où le modèle n'en recopie pas.
 */
const plier = (c: string) => {
  if ("\u00AD\u200B\u200C\u200D\u2060\uFEFF".includes(c)) return "";
  if (c >= "\uFB00" && c <= "\uFB06") return c.normalize("NFKC");
  if ("’‘ʼ`´".includes(c)) return "'";
  if ("«»“”„".includes(c)) return '"';
  if ("‐‑‒–—−".includes(c)) return "-";
  if (/\s/.test(c) || "•▪◦".includes(c)) return " ";
  return c.toLowerCase();
};

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Un accent combinant resté seul après NFC appartient au mot qu'il suit.
const DE_MOT = /[\p{L}\p{N}\p{M}_]/u;
const colles = (a?: string, b?: string) =>
  a !== undefined && b !== undefined && DE_MOT.test(a) && DE_MOT.test(b);

/**
 * Cherche `citation` d'un seul tenant dans `texte`, sans tenir compte des espaces, de la casse,
 * de la forme des apostrophes ni de la forme Unicode (NFC ou NFD). La citation commence et finit
 * sur une frontière de mot: « mort » ne se trouve pas dans « mortel ». Rend les offsets en points
 * de code dans `texte`, ou null.
 */
export function trouver(texte: string, citation: string): [number, number] | null {
  // La forme NFC d'un graphème n'a pas toujours autant de points de code que lui: chaque point
  // de code replié garde les bornes de son graphème dans `texte`.
  // ponytail: le texte est replié à chaque appel. Garder la forme repliée d'un chunk si l'ancrage
  // d'une longue source ralentit.
  const src: string[] = [];
  const debuts: number[] = [];
  const fins: number[] = [];
  let i = 0;
  for (const { segment } of GRAPHEMES.segment(texte)) {
    const fin = i + longueur(segment);
    for (const c of segment.normalize("NFC")) {
      for (const p of plier(c)) {
        if (!(p === " " && src.at(-1) === " ")) {
          src.push(p);
          debuts.push(i);
          fins.push(fin);
        }
      }
    }
    i = fin;
  }
  const cible = Array.from(citation.normalize("NFC"), plier).join("").replace(/ +/g, " ").trim();
  if (!cible) return null;
  const plie = src.join("");
  for (let at = plie.indexOf(cible); at >= 0; at = plie.indexOf(cible, at + 1)) {
    // indexOf compte des unités UTF-16 sur une chaîne de points de code repliés: on repasse
    // par la longueur en points de code du préfixe.
    const debut = longueur(plie.slice(0, at));
    const fin = debut + longueur(cible) - 1;
    if (!colles(src[debut - 1], src[debut]) && !colles(src[fin], src[fin + 1])) {
      return [debuts[debut], fins[fin]];
    }
  }
  return null;
}

const STOP = new Set(
  `le la les un une des du de d au aux et ou a en dans sur pour par avec
sans sous entre vers chez que qui quoi dont ou est sont etre avoir il elle ils elles
on nous vous je tu ce cet cette ces son sa ses leur leurs mon ma mes ton ta tes notre
votre y ne pas plus moins tres bien tout tous toute toutes meme aussi comme quand
si alors donc car mais or ni cela ceci celui celle ceux se sa lui eux d'un d'une
qu'est-ce est-ce qu comment pourquoi quel quelle quels quelles combien peut peuvent
fait faire fais sert servent veut veulent doit doivent quelque quelques
c'est n'est s'en l'on`.split(/\s+/),
);

export const sansAccents = (s: string) => s.normalize("NFD").replace(/\p{Mn}/gu, "");

/** Mots utiles d'un texte, comme `terms()` du banc d'essai. */
export function mots(texte: string): string[] {
  const out: string[] = [];
  for (const [w] of texte.toLowerCase().matchAll(/[\p{L}\p{N}_']+/gu)) {
    const m = sansAccents(w).replace(/^'+|'+$/g, "");
    if (m.length > 2 && !STOP.has(m)) out.push(m);
  }
  return out;
}
