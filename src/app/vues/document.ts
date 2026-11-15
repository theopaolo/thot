import { html, raw } from "hono/html";
import type { Bloc } from "../../core/document.ts";
import { longueur, tranche } from "../../core/texte.ts";

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

/**
 * Le code Mermaid d'un auteur, sans front matter ni directive `%%{…}%%` : la configuration du
 * rendu reste celle de l'application. Une directive sans fermeture court jusqu'à la fin du code,
 * comme Mermaid la lirait.
 */
export const sansDirectives = (code: string) =>
  code.replace(/^\s*---\n[\s\S]*?\n---[ \t]*(?:\n|$)/, "").replace(/%%\{[\s\S]*?(?:\}%%|$)/g, "");

/**
 * Un schéma Mermaid, ou un bloc `animated` de carnet : un diagramme de séquence que le carnet
 * déroule pas à pas. Ses lignes `%%` sont des commentaires pour Mermaid, qui en dessine l'état final.
 */
const schema = (b: Bloc) =>
  b.langage === "mermaid" || (b.langage === "animated" && /^\s*sequenceDiagram\b/.test(b.texte));

/** Les notes `%% note:` d'un bloc `animated`, qui commentent chaque pas du diagramme. */
const notesSchema = (code: string) =>
  [...code.matchAll(/^[ \t]*%%[ \t]*note[ \t]*:[ \t]*(.+?)[ \t]*$/gm)].map((m) => m[1]);

/** Le titre et la description que l'auteur d'un schéma Mermaid lui donne (`accTitle`, `accDescr`). */
export function legendeSchema(code: string) {
  const titre = code.match(/^[ \t]*accTitle[ \t]*:[ \t]*(.+?)[ \t]*$/m)?.[1];
  const description = (
    code.match(/^[ \t]*accDescr[ \t]*:[ \t]*(.+?)[ \t]*$/m)?.[1] ??
    code.match(/^[ \t]*accDescr[ \t]*\{([^}]*)\}/m)?.[1]
  )
    ?.trim()
    .replace(/\s+/g, " ");
  return { titre, description };
}

// Les extracteurs écrivent un tableau une rangée par ligne, ses cellules séparées par « | ».
const CELLULE = " | ";

/** Les cellules d'un bloc tableau, en offsets du bloc, ou rien si ses lignes n'en forment pas un. */
function cellules(texte: string) {
  const lignes = texte.split("\n");
  const n = lignes[0].split(CELLULE).length;
  if (lignes.length < 2 || n < 2 || lignes.some((l) => l.split(CELLULE).length !== n)) return;
  let p = 0;
  return lignes.map((ligne) =>
    ligne.split(CELLULE).map((c, i, rang) => {
      const debut = p;
      p += longueur(c) + (i < rang.length - 1 ? CELLULE.length : 1);
      return [debut, debut + longueur(c)] as const;
    }),
  );
}

// Un bloc de code dont le texte répète sa section reste du code. Un intertitre généré porte
// l'ancre `s-` de son premier bloc, un titre extrait celle de son bloc.
const intitule = (b: Bloc) => b.texte === b.section && !b.code;
const ancre = (b: Bloc) => (intitule(b) ? b.id : `s-${b.id}`);

/** Les sections du document dans l'ordre de lecture, avec l'ancre de leur intertitre. */
export function sections(blocs: Bloc[], depuis = "") {
  const liste: { titre: string; ancre: string }[] = [];
  let section = depuis;
  for (const b of blocs) {
    if (b.section && b.section !== section) liste.push({ titre: b.section, ancre: ancre(b) });
    section = b.section;
  }
  return liste;
}

/**
 * Blocs du document, avec intertitres et passage surligné entre `debut` et `fin`. `depuis` est la
 * section déjà titrée par la page : le titre du document n'est pas redit en intertitre.
 * `avecAncre` pose `id="passage"` sur la marque, que seul le lecteur vise.
 */
export const texteDocument = (
  blocs: Bloc[],
  marque?: [number, number],
  niveau: 2 | 3 = 3,
  depuis = "",
  avecAncre = true,
) => {
  let section = depuis;
  let ancrePosee = !avecAncre;
  // Le texte du bloc entre `debut` et `fin`, avec la part du passage `m` et le code en ligne qui
  // s'y trouvent. Un passage à cheval sur plusieurs cellules ou sur un code a une marque par
  // morceau, l'ancre sur la première.
  const marquer = (
    t: string,
    debut: number,
    fin: number,
    m?: readonly [number, number],
    codes: readonly (readonly [number, number])[] = [],
  ) => {
    const bornes = [...new Set([debut, fin, ...(m ?? []), ...codes.flat()])]
      .filter((x) => x >= debut && x <= fin)
      .sort((x, y) => x - y);
    // Les morceaux d'un même code restent dans un seul <code>, la marque se coupe à l'intérieur.
    const groupes: { code: number; morceaux: unknown[] }[] = [];
    for (const [i, a] of bornes.slice(0, -1).entries()) {
      const z = bornes[i + 1];
      let morceau = html`${tranche(t, a, z)}`;
      if (m && m[0] <= a && z <= m[1]) {
        morceau = html`<mark${raw(ancrePosee ? "" : ' id="passage"')}>${morceau}</mark>`;
        ancrePosee = true;
      }
      const code = codes.findIndex(([c, d]) => c <= a && z <= d);
      const dernier = groupes.at(-1);
      if (dernier && code >= 0 && dernier.code === code) dernier.morceaux.push(morceau);
      else groupes.push({ code, morceaux: [morceau] });
    }
    return groupes.map((g) => (g.code < 0 ? g.morceaux : html`<code>${g.morceaux}</code>`));
  };
  return blocs.map((b) => {
    const titre =
      b.section && b.section !== section && !intitule(b)
        ? intertitre(b.section, niveau, ancre(b))
        : "";
    section = b.section;
    const m =
      marque && marque[0] < b.fin && marque[1] > b.debut
        ? ([marque[0] - b.debut, marque[1] - b.debut] as const)
        : undefined;
    if (intitule(b) && !m) return intertitre(b.texte, niveau, b.id);
    const fin = longueur(b.texte);
    // Pas d'espace dans le <pre>: il s'afficherait. Le code d'un schéma reste visible sous la
    // légende, et remplace le dessin si celui-ci échoue.
    if (schema(b)) {
      const l = legendeSchema(b.texte);
      const notes = notesSchema(b.texte);
      return html`
        ${titre}<figure class="figure-schema"><pre id="${b.id}" data-mermaid="${sansDirectives(
          b.texte,
        )}"><code>${marquer(b.texte, 0, fin, m)}</code></pre>${
          notes.length
            ? html`<ol class="notes-schema">${notes.map((n) => html`<li>${n}</li>`)}</ol>`
            : ""
        }${
          l.titre || l.description
            ? html`<figcaption>${l.titre ? html`<strong>${l.titre}</strong> ` : ""}${
                l.description ?? ""
              }</figcaption>`
            : ""
        }</figure>
      `;
    }
    if (b.code) {
      // coloration.ts colore le code d'un langage nommé.
      const langage = b.langage ? html` data-langage="${b.langage}"` : "";
      return html`
        ${titre}<pre id="${b.id}"${langage}><code>${marquer(b.texte, 0, fin, m)}</code></pre>
      `;
    }
    const rangs = cellules(b.texte);
    if (rangs) {
      const [entete, ...corps] = rangs;
      return html`
        ${titre}<div class="cadre-tableau"><table id="${b.id}">
          <thead><tr>${entete.map(
            ([a, z]) => html`<th scope="col">${marquer(b.texte, a, z, m, b.codes)}</th>`,
          )}</tr></thead>
          <tbody>${corps.map(
            (r) =>
              html`<tr>${r.map(
                ([a, z]) => html`<td>${marquer(b.texte, a, z, m, b.codes)}</td>`,
              )}</tr>`,
          )}</tbody>
        </table></div>
      `;
    }
    // Une liste extraite garde une entrée par ligne : les lignes restent des lignes à l'écran.
    const lignes = raw(b.texte.includes("\n") ? ' class="lignes"' : "");
    return html`
      ${titre}<p id="${b.id}"${lignes}>${marquer(b.texte, 0, fin, m, b.codes)}</p>
    `;
  });
};
