// Les offsets de citation comptent des points de code, comme en Python. Les chaînes
// JavaScript comptent des unités UTF-16. Tout découpage de `document.txt` passe par ici.

export const longueur = (s: string) => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

export const tranche = (s: string, debut: number, fin: number) =>
  Array.from(s).slice(debut, fin).join("");

/** Forme de comparaison: apostrophes et guillemets unifiés, espaces réduites, casse ignorée. */
const plier = (c: string) => {
  if ("’‘ʼ`´".includes(c)) return "'";
  if ("«»“”„".includes(c)) return '"';
  if ("‐‑‒–—−".includes(c)) return "-";
  if (/\s/.test(c)) return " ";
  return c.toLowerCase();
};

/**
 * Cherche `citation` dans `texte` sans tenir compte des espaces, de la casse et de la forme des
 * apostrophes. Rend les offsets en points de code dans `texte`, ou null.
 */
export function trouver(texte: string, citation: string): [number, number] | null {
  const src: string[] = [];
  const pos: number[] = [];
  let i = 0;
  for (const c of texte) {
    const p = plier(c);
    if (!(p === " " && src.at(-1) === " ")) {
      src.push(p);
      pos.push(i);
    }
    i++;
  }
  const cible = Array.from(citation.trim()).map(plier).join("").replace(/ +/g, " ");
  if (!cible) return null;
  const at = src.join("").indexOf(cible);
  if (at < 0) return null;
  // indexOf compte des unités UTF-16 sur une chaîne de points de code repliés: on repasse
  // par la longueur en points de code du préfixe.
  const debut = longueur(src.join("").slice(0, at));
  const fin = debut + longueur(cible) - 1;
  return [pos[debut], pos[fin] + 1];
}

/**
 * Citation coupée par des points de suspension: chaque fragment doit se trouver mot pour mot,
 * dans l'ordre. Rend la portée du premier au dernier fragment.
 */
export function trouverFragments(texte: string, citation: string): [number, number] | null {
  const fragments = citation.split(/\s*(?:\[…\]|\(…\)|…|\.\.\.)\s*/).map((f) => f.trim())
    .filter((f) => f.split(/\s+/).length >= 3);
  if (!fragments.length) return null;
  let debut = -1;
  let fin = 0;
  for (const f of fragments) {
    const reste = tranche(texte, fin, longueur(texte));
    const t = trouver(reste, f);
    if (!t) return null;
    if (debut < 0) debut = fin + t[0];
    fin += t[1];
  }
  return [debut, fin];
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
