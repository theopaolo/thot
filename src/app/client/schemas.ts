import DOMPurify from "dompurify";
import mermaid from "mermaid";

// Au-delà, le schéma n'est pas dessiné : Mermaid remplacerait le texte trop long par un message.
const MAX_TEXTE = 20_000;

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  htmlLabels: false,
  // Le schéma garde sa taille : sur un téléphone, il défile au lieu de rapetisser son texte.
  flowchart: { useMaxWidth: false },
  maxTextSize: MAX_TEXTE,
  maxEdges: 200,
  suppressErrorRendering: true,
  // Un réglage venu du texte du schéma ne change ni la sécurité ni l'apparence.
  secure: [
    "securityLevel",
    "startOnLoad",
    "maxTextSize",
    "maxEdges",
    "suppressErrorRendering",
    "htmlLabels",
    "flowchart",
    "theme",
    "themeVariables",
    "themeCSS",
    "fontFamily",
  ],
  theme: "base",
  fontFamily: '"Atkinson Hyperlegible", system-ui, sans-serif',
  themeVariables: {
    fontFamily: '"Atkinson Hyperlegible", system-ui, sans-serif',
    fontSize: "16px",
    primaryColor: "#fdfcfa",
    primaryBorderColor: "#6b6460",
    primaryTextColor: "#1c1815",
    lineColor: "#1c1815",
    edgeLabelBackground: "#f5f2ec",
  },
});

// Une adresse hors du schéma chargerait une ressource ou ouvrirait un lien : seules restent les
// références internes, `url(#…)` et `href="#…"`, des pointes de flèche.
const EXTERNE = /url\s*\(\s*['"]?(?!#)|@import/i;
DOMPurify.addHook("uponSanitizeAttribute", (_, attribut) => {
  const lien = /href$/i.test(attribut.attrName) && !attribut.attrValue.startsWith("#");
  if (lien || EXTERNE.test(attribut.attrValue)) attribut.keepAttr = false;
});
DOMPurify.addHook("uponSanitizeElement", (noeud, data) => {
  if (data.tagName === "style" && EXTERNE.test(noeud.textContent ?? "")) noeud.textContent = "";
});

let compteur = 0;

/**
 * Dessine une fois chaque schéma de `racine`, au-dessus de l'élément qui porte son texte. Le SVG
 * de Mermaid repasse par DOMPurify, en SVG seul, sans lien ni HTML : un `click` du texte d'un
 * auteur reste sans effet. Un échec, ou un élément retiré pendant le rendu, laisse le texte seul.
 */
export async function dessiner(racine: Element) {
  for (const el of racine.querySelectorAll<HTMLElement>("[data-mermaid]:not([data-rendu])")) {
    el.dataset.rendu = "";
    const texte = el.dataset.mermaid ?? "";
    if (!texte.trim() || texte.length > MAX_TEXTE) continue;
    try {
      const { svg } = await mermaid.render(`schema-${++compteur}`, texte);
      const propre = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        ADD_ATTR: ["dominant-baseline"],
        FORBID_TAGS: ["a", "foreignobject"],
        RETURN_DOM_FRAGMENT: true,
      });
      if (!el.isConnected || !propre.querySelector("svg")) continue;
      const cadre = document.createElement("div");
      cadre.className = "schema";
      // Le texte qui suit dit la même chose : un lecteur d'écran ne lit pas le dessin.
      cadre.setAttribute("aria-hidden", "true");
      cadre.append(propre);
      el.before(cadre);
    } catch {
      /* Le texte reste. */
    }
  }
}
