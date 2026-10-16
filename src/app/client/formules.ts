import katex from "katex";
// Copier une formule rendue copie sa source entre `$`.
import "katex/contrib/copy-tex";
import "katex/dist/katex.min.css";
import { optionsKatex } from "../../core/notation.ts";

/**
 * Rend une fois chaque formule de `racine`. KaTeX garde l'expression source dans son MathML, et
 * une erreur affiche cette source en rouge avec sa cause.
 */
export function ecrire(racine: Element) {
  for (const el of racine.querySelectorAll<HTMLElement>("[data-tex]:not([data-rendu])")) {
    el.dataset.rendu = "";
    el.innerHTML = katex.renderToString(
      el.dataset.tex ?? "",
      optionsKatex(el.classList.contains("formule-bloc")),
    );
  }
}
