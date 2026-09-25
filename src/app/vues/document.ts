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
    const titre = b.section !== section && b.texte !== b.section
      ? intertitre(b.section, niveau)
      : "";
    section = b.section;
    const t = Array.from(b.texte);
    if (marque && marque[0] < b.fin && marque[1] > b.debut) {
      const a = Math.max(0, marque[0] - b.debut);
      const z = Math.min(t.length, marque[1] - b.debut);
      return html`
        ${titre}<p id="${b.id}">${t.slice(0, a).join("")}<mark id="passage">${t.slice(a, z).join(
          "",
        )}</mark>${t.slice(z).join("")}</p>
      `;
    }
    return b.texte === b.section ? intertitre(b.texte, niveau, b.id) : html`
      ${titre}<p id="${b.id}">${b.texte}</p>
    `;
  });
};
