import type { Extraction, Partie } from "./document.ts";
import { decoder } from "./html.ts";

/** Front matter YAML en tête de fichier. Seul `title` est lu, `corps` est le reste. */
export function lireFrontMatter(md: string): { titre?: string; corps: string } {
  const texte = md.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = texte.match(/^---\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/);
  if (!m) return { corps: texte };
  const titre = m[1]?.match(/^title:[ \t]*(.+?)[ \t]*$/m)?.[1].replace(/^(["'])(.*)\1$/, "$2");
  return { titre: titre || undefined, corps: texte.slice(m[0].length) };
}

const RE_IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]*)[^)]*\)/g;
const RELATIF = /^(?![a-z][a-z\d+.-]*:|\/\/)/i;

/**
 * Le texte qu'un lecteur voit: liens, emphases et code en ligne réduits à leur contenu, balises
 * HTML retirées (une cellule de tableau devient « | »), échappements et entités résolus.
 */
function lisible(s: string, images: string[]) {
  const sansLiens = s
    .replace(RE_IMAGE, (_, url: string) => {
      if (url && RELATIF.test(url)) images.push(url);
      return "";
    })
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  return sansLiens
    .split(/(`[^`]+`)/)
    .map((p, i) =>
      i % 2
        ? p.slice(1, -1)
        : decoder(
            p
              .replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/gi, " | ")
              .replace(/<!--.*?-->|<\/?[a-z][^>]*>/gi, " ")
              .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
              .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
              .replace(/\*(?=\S)(.+?)(?<=\S)\*/g, "$1")
              .replace(/(?<![\p{L}\p{N}])_(?=\S)(.+?)(?<=\S)_(?![\p{L}\p{N}])/gu, "$1")
              .replace(/\\([!-/:-@[-`{-~])/g, "$1"),
          ),
    )
    .join("")
    .replace(/[ \t\u00a0\u202f]+/g, " ")
    .trim();
}

/**
 * Cours en Markdown: le texte que rend la page, sans les marques. Les titres ouvrent les sections,
 * les blocs de code gardent leurs lignes telles quelles, une liste ou un tableau garde une ligne
 * par entrée. Les images ne sont pas jointes, un avertissement nomme celles d'un chemin relatif.
 */
// ponytail: titres ATX seulement (`#`), ni titres soulignés, ni notes de bas de page. Le contenu
// d'un `<style>` ou `<script>` hors bloc de code resterait du texte.
export function extraireMarkdown(md: string, titreParDefaut: string): Extraction {
  const { titre: titreFm, corps } = lireFrontMatter(md);
  const titre = titreFm ?? titreParDefaut;
  const parties: Partie[] = [{ texte: titre, section: titre }];
  const images: string[] = [];
  let section = titre;
  let lignes: string[] = [];
  const fermer = () => {
    if (lignes.length) parties.push({ texte: lignes.join("\n"), section });
    lignes = [];
  };
  // Une ligne de plus dans le bloc courant, ou la suite de la dernière quand `nouvelle` est faux.
  const ajouter = (l: string, nouvelle: boolean) => {
    if (!l) return;
    if (nouvelle || !lignes.length) lignes.push(l);
    else lignes[lignes.length - 1] += " " + l;
  };

  const brut = corps.split("\n");
  for (let i = 0; i < brut.length; i++) {
    const ligne = brut[i];
    const t = ligne.trim();
    const ouvre = ligne.match(/^(\s*)(`{3,}|~{3,})/);
    const titreLigne = ligne.match(/^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/);
    if (!t) fermer();
    else if (ouvre) {
      fermer();
      const [, retrait, cloture] = ouvre;
      const langage = ligne.slice(ouvre[0].length).trim().split(/\s/)[0].toLowerCase();
      const code: string[] = [];
      const ferme = (l: string) => {
        const f = l.trim();
        return f.length >= cloture.length && f === cloture[0].repeat(f.length);
      };
      for (i++; i < brut.length && !ferme(brut[i]); i++) {
        code.push(brut[i].replace(new RegExp(`^ {0,${retrait.length}}`), ""));
      }
      parties.push({ texte: code.join("\n"), section, code: true, ...(langage && { langage }) });
    } else if (titreLigne) {
      fermer();
      section = lisible(titreLigne[1], images);
      // Le premier titre qui répète le titre du document n'est pas redit.
      if (parties.length > 1 || section !== titre) parties.push({ texte: section, section });
    } else if (/^ {0,3}([-*_])( *\1){2,} *$/.test(ligne)) fermer();
    else if (/^[\s|:-]+$/.test(t) && t.includes("|") && t.includes("-")) continue;
    else if (/^ {0,3}\[[^\]]+\]:\s*\S/.test(ligne)) continue;
    else if (t.startsWith("|")) {
      const cellules = t.replace(/^\||\|$/g, "").split("|");
      ajouter(cellules.map((c) => lisible(c, images)).join(" | "), true);
    } else {
      const item = ligne.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
      ajouter(lisible(item ? item[1] : ligne.replace(/^\s{0,3}(?:>\s?)+/, ""), images), !!item);
    }
  }
  fermer();

  const noms = [...new Set(images)];
  return {
    parties,
    images: [],
    avertissements: noms.length
      ? [`Images liées, non jointes à la source : ${noms.join(", ")}.`]
      : [],
  };
}
