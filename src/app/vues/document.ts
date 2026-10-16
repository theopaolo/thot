import { html, raw } from "hono/html";
import type { Bloc } from "../../core/document.ts";

/** Blocs du document, avec intertitres et passage surligné entre `debut` et `fin`. */
/** Intertitre de section: h2 sous le titre de la page élève, h3 sous « Texte extrait » côté enseignant. */
const intertitre = (texte: string, niveau: 2 | 3, id?: string) => {
  // Les identifiants de bloc sont générés à l'ingestion (« blk_9 »): pas de texte d'élève ici.
  const ancre = raw(id ? ` id="${id}"` : "");
  return niveau === 2
    ? html`
      <h2 class="intertitre" ${ancre}>${texte}</h2>
    `
    : html`<h3${ancre}>${texte}</h3>`;
};

export const texteDocument = (blocs: Bloc[], marque?: [number, number], niveau: 2 | 3 = 3) => {
  let section = "";
  return blocs.map((b) => {
    // Un bloc de code dont le texte répète sa section reste du code.
    const intitule = b.texte === b.section && !b.code;
    const titre = b.section !== section && !intitule ? intertitre(b.section, niveau) : "";
    section = b.section;
    const vise = marque && marque[0] < b.fin && marque[1] > b.debut;
    if (intitule && !vise) return intertitre(b.texte, niveau, b.id);
    let corps = html`${b.texte}`;
    if (marque && vise) {
      const t = Array.from(b.texte);
      const a = Math.max(0, marque[0] - b.debut);
      const z = Math.min(t.length, marque[1] - b.debut);
      corps = html`${t.slice(0, a).join("")}<mark id="passage">${t
        .slice(a, z)
        .join("")}</mark>${t.slice(z).join("")}`;
    }
    // Pas d'espace dans le <pre>: il s'afficherait.
    return b.code
      ? html`
      ${titre}<pre id="${b.id}"><code>${corps}</code></pre>
    `
      : html`
      ${titre}<p id="${b.id}">${corps}</p>
    `;
  });
};
