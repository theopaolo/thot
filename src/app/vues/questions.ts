import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { ImageQuestion, TypeQuestion } from "../../core/activite.ts";

export const NOMS_TYPE: Record<TypeQuestion, string> = {
  redigee: "Réponse rédigée",
  choix: "Choix unique",
  choix_multiple: "Choix multiple",
  terme: "Réponse à taper",
};

/** A, B, C… dans l'ordre affiché. */
export const lettre = (i: number) => String.fromCharCode(65 + i);

const echapper = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Le code entre accents graves, le reste échappé. */
const enLigne = (s: string) =>
  s
    .split(/(`[^`\n]+`)/)
    .map((x) => (/^`[^`\n]+`$/.test(x) ? `<code>${echapper(x.slice(1, -1))}</code>` : echapper(x)))
    .join("");

/**
 * Le texte d'une question, d'une option ou d'un retour, comme dans carnet-quiz : le code entre
 * accents graves, un bloc entre trois accents graves avec son langage, que `coloration.ts` colore.
 * Une ligne vide sépare deux paragraphes. Tout le reste est échappé.
 */
export function enrichi(texte: string): HtmlEscapedString | Promise<HtmlEscapedString> {
  const morceaux = texte.split(/^```([\w+#-]*)[^\n]*\n([\s\S]*?)^```[ \t]*$/m);
  const sortie: string[] = [];
  for (let i = 0; i < morceaux.length; i += 3) {
    for (const p of morceaux[i].split(/\n\s*\n/)) {
      if (p.trim()) sortie.push(`<p>${enLigne(p.trim()).replace(/\n/g, "<br>")}</p>`);
    }
    if (i + 2 < morceaux.length) {
      const langage = morceaux[i + 1] ? ` data-langage="${echapper(morceaux[i + 1])}"` : "";
      sortie.push(
        `<pre${langage}><code>${echapper(morceaux[i + 2].replace(/\n$/, ""))}</code></pre>`,
      );
    }
  }
  return raw(sortie.join(""));
}

/** Un texte court sur une ligne, une option par exemple : le code en ligne, sans paragraphe. */
export const enrichiLigne = (texte: string) => raw(enLigne(texte));

/** L'adresse d'une image de question : déposée avec l'activité, ou image d'une source. */
export const srcImage = (activiteId: string, i: ImageQuestion) =>
  i.fichier ? `/activites/${activiteId}/images/${i.fichier}` : `/media/${i.media}`;

/** L'image d'une question, qui s'ouvre en grand dans un nouvel onglet. */
export const imageQuestion = (activiteId: string, i?: ImageQuestion) =>
  i
    ? html`<figure class="image-question"><a href="${srcImage(activiteId, i)}" target="_blank" rel="noopener"><img src="${srcImage(activiteId, i)}" alt="${i.alt}" loading="lazy"></a></figure>`
    : "";
