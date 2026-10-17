// Schémas et formules d'une réponse. Ce module n'importe rien : le navigateur et les tests le
// lisent aussi.

/** Les trois sortes de relation d'un schéma, et le verbe qui les nomme dans le schéma et son texte. */
export const LIENS = { cause: "entraîne", suite: "précède", theme: "est lié à" } as const;
export type Lien = keyof typeof LIENS;

/**
 * Un schéma relie des nœuds nommés en quelques mots. Un nœud qui énonce un fait et chaque relation
 * désignent l'affirmation qui les prouve, par son indice dans la réponse.
 */
export type Schema = {
  type: "schema";
  titre?: string;
  noeuds: { titre: string; affirmation?: number }[];
  /** `de` et `vers` désignent des nœuds, à partir de 0 */
  relations: { de: number; vers: number; lien: Lien; affirmation: number }[];
};

// Une cause et une suite sont orientées, un lien de thème ne l'est pas. Le trait les distingue
// aussi sans la couleur.
const TRAITS: Record<Lien, string> = { cause: "-->", suite: "==>", theme: "-.-" };

// Les signes d'un nom qui ont un rôle dans une chaîne Mermaid. `<`, `>` et `&` passent par les
// seules entités qu'une étiquette SVG décode, `ﬂ` ouvrirait une entité codée par Mermaid.
const SIGNES: Record<string, string> = {
  '"': "'",
  "`": "'",
  ";": ",",
  "<": "#lt;",
  ">": "#gt;",
  "&": "#amp;",
  ﬂ: "fl",
};

/**
 * Le texte Mermaid d'un schéma validé. Seul ce code écrit la syntaxe : un nom garde ses
 * caractères, sauf les `SIGNES` et les doubles `%%` et `$$` d'une directive ou d'une formule.
 * Aucune directive, aucun lien, aucun clic. Les numéros entre crochets sont ceux des citations.
 */
export function texteMermaid(s: Schema) {
  const texte = (t: string) =>
    `"${t
      .replace(/\s+/g, " ")
      .replace(/%{2,}/g, "%")
      .replace(/\${2,}/g, "$")
      .replace(/["`;<>&ﬂ]/g, (c) => SIGNES[c])}"`;
  const numero = (n?: number) => (n === undefined ? "" : ` [${n + 1}]`);
  // Le flux SSE remplace les sauts de ligne par des espaces : le `;` sépare encore les lignes.
  // Mermaid retire le dernier `;` d'une ligne où il lit `style…:…#`, d'où le `;` final.
  return `${[
    "flowchart TD",
    ...s.noeuds.map((n, i) => `n${i}[${texte(n.titre + numero(n.affirmation))}]`),
    ...s.relations.map(
      (r) =>
        `n${r.de} ${TRAITS[r.lien]}|${texte(LIENS[r.lien] + numero(r.affirmation))}| n${r.vers}`,
    ),
  ].join(";\n")};`;
}

// `$$…$$` en bloc, `$…$` dans la ligne. Un `$` suivi d'une espace n'ouvre rien, un `$` suivi d'un
// chiffre ne ferme rien : « entre 5 $ et 10 $ » reste du texte.
// ponytail: un `\$` dans une formule la coupe, à traiter si un cours en écrit.
const FORMULE = /\$\$([^$]+)\$\$|\$(?=[^\s$])([^$\n]+?)(?<=\S)\$(?!\d)/g;
const MAX_FORMULE = 400;

export type Formule = { tex: string; bloc: boolean; source: string };

/**
 * Une phrase découpée en texte et formules. Une formule est un fait : elle ne se rend que si la
 * citation de la phrase écrit la même expression, espaces mis à part. Sinon elle reste du texte.
 */
export function formules(texte: string, citation: string): (string | Formule)[] {
  const plat = (s: string) => s.replace(/\s+/g, "");
  const appuis = new Set([...citation.matchAll(FORMULE)].map((m) => plat(m[1] ?? m[2])));
  const morceaux: (string | Formule)[] = [];
  let curseur = 0;
  for (const m of texte.matchAll(FORMULE)) {
    const tex = (m[1] ?? m[2]).trim();
    if (!tex || tex.length > MAX_FORMULE || !appuis.has(plat(tex))) continue;
    morceaux.push(texte.slice(curseur, m.index), { tex, bloc: m[1] !== undefined, source: m[0] });
    curseur = m.index + m[0].length;
  }
  morceaux.push(texte.slice(curseur));
  return morceaux.filter((x) => x !== "");
}

/**
 * Les options de KaTeX, neuves à chaque formule : une macro définie par l'une (`\gdef`) ne sert
 * pas à la suivante. `trust: false` refuse `\href`, `\url`, `\includegraphics` et `\html…`.
 * `maxExpand` arrête une macro récursive, `maxSize` borne une taille en em.
 */
export const optionsKatex = (bloc: boolean) => ({
  displayMode: bloc,
  output: "htmlAndMathml" as const,
  throwOnError: false,
  trust: false,
  strict: "warn" as const,
  maxSize: 10,
  maxExpand: 100,
  macros: {},
});
