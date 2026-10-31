import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";
import githubLight from "shiki/themes/github-light.mjs";

// Le thème github-light, conçu pour un fond blanc. Ces quatre couleurs, foncies, gardent un
// contraste de 4,5:1 sur le fond du bloc et sur celui d'un passage surligné.
const FONCIES = {
  "#e36209": "#b84a00",
  "#d73a49": "#c9303f",
  "#22863a": "#1e7b35",
  "#6a737d": "#5f6874",
};

const surligneur = createHighlighterCore({
  themes: [githubLight],
  engine: createJavaScriptRegexEngine(),
});

// Une règle `::highlight()` par couleur du thème, ajoutée à sa première rencontre.
const feuille = new CSSStyleSheet();
document.adoptedStyleSheets.push(feuille);
const surlignage = (couleur: string) => {
  const nom = `code-${couleur.slice(1)}`;
  let h = CSS.highlights.get(nom);
  if (!h) {
    CSS.highlights.set(nom, (h = new Highlight()));
    feuille.insertRule(`::highlight(${nom}) { color: ${couleur}; }`);
  }
  return h;
};

/**
 * Colore une fois chaque bloc de code de `racine` dont Shiki connaît le langage. Les couleurs
 * passent par `CSS.highlights` : le HTML du bloc reste tel quel, `<mark>` du passage compris. Un
 * navigateur sans cette API affiche le code sans couleur.
 */
export async function colorer(racine: Element) {
  if (!("highlights" in CSS)) return;
  // Les plages d'un document que htmx a retiré ne servent plus.
  for (const h of CSS.highlights.values()) {
    for (const r of h) if (!r.startContainer.isConnected) h.delete(r);
  }
  const shiki = await surligneur;
  const encre = shiki.getTheme("github-light").fg.toLowerCase();
  for (const pre of racine.querySelectorAll<HTMLElement>("pre[data-langage]:not([data-colore])")) {
    pre.dataset.colore = "";
    const langage = pre.dataset.langage ?? "";
    if (!Object.hasOwn(bundledLanguages, langage)) continue;

    const textes: [Text, number][] = [];
    let longueur = 0;
    const marcheur = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    for (let n = marcheur.nextNode(); n; n = marcheur.nextNode()) {
      textes.push([n as Text, longueur]);
      longueur += (n as Text).length;
    }
    const point = (pos: number): [Text, number] => {
      const [noeud, debut] = textes.findLast(([, d]) => d <= pos)!;
      return [noeud, pos - debut];
    };

    try {
      await shiki.loadLanguage(bundledLanguages[langage as keyof typeof bundledLanguages]);
      const lignes = shiki.codeToTokensBase(pre.textContent, {
        lang: langage,
        theme: "github-light",
        colorReplacements: FONCIES,
      });
      for (const jeton of lignes.flat()) {
        // Shiki écrit les couleurs en majuscules. Le texte ordinaire garde l'encre de la page.
        const couleur = jeton.color?.toLowerCase();
        if (!couleur || couleur === encre || !jeton.content) continue;
        const r = new Range();
        r.setStart(...point(jeton.offset));
        r.setEnd(...point(jeton.offset + jeton.content.length));
        surlignage(couleur).add(r);
      }
    } catch {
      /* Le code reste sans couleur. */
    }
  }
}
