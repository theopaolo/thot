import type { Extraction, Partie } from "./document.ts";
import { decoder, RELATIF } from "./html.ts";
import { longueur } from "./texte.ts";

/**
 * Front matter YAML en tête de fichier. Seuls `title` et `order` sont lus, `corps` est le reste.
 * Il se ferme dans le début du fichier, sinon le fichier n'en a pas : le navigateur lit la même
 * fenêtre, comptée en octets, pour proposer le titre avant l'envoi.
 */
export function lireFrontMatter(md: string): { titre?: string; ordre?: number; corps: string } {
  const texte = md.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = texte.match(/^---\n(?:([\s\S]{0,16384}?)\n)?---[ \t]*(?:\n|$)/);
  if (!m) return { corps: texte };
  // La valeur est rognée hors du motif : `[ \t]*$` après un groupe paresseux relirait la ligne
  // depuis chacun de ses caractères.
  const cle = (nom: string) => {
    const valeur = m[1]?.match(new RegExp(`^${nom}:(.+)$`, "m"))?.[1];
    return (
      valeur &&
      rogner(valeur, " \t")
        .replace(/^[ \t]+/, "")
        .replace(/^(["'])(.*)\1$/, "$2")
    );
  };
  const ordre = Number(cle("order"));
  return {
    titre: cle("title") || undefined,
    ordre: Number.isFinite(ordre) ? ordre : undefined,
    corps: texte.slice(m[0].length),
  };
}

// Les motifs qui suivent lisent chaque caractère une fois. Une ouverture sans fermeture prend le
// reste du texte, que `sinonTel` rend tel quel : les ouvertures suivantes n'auraient pas trouvé
// de fermeture non plus, et les essayer une à une relirait le texte depuis chacune.
const RE_IMAGE = /!\[[^\]]*(?:\]\(([^)]*)(\))?)?/g;
const RE_LIEN = /\[([^\]]*)(?:\]\([^)]*(\))?)?/g;
const RE_REFERENCE = /\[([^\]]+)(?:\]\[[^\]]*(\])?)?/g;
const RE_BALISE = /<\/?[a-z][^>]*(>|$)/gi;
// Un commentaire ou une emphase tient sur une ligne, d'où le drapeau `m` : `$` s'arrête aussi à
// U+2028 et U+2029.
const RE_COMMENTAIRE_OU_BALISE = /<!--.*?(-->|$)|<\/?[a-z][^>]*(>|$)/gim;
const RE_GRAS = /(\*\*|__)(?=\S)(.+?)(?:(?<=\S)(\1)|$)/gm;
const RE_GRAS_SEUL = {
  "**": /\*\*(?=\S)(.+?)(?:(?<=\S)(\*\*)|$)/gm,
  __: /__(?=\S)(.+?)(?:(?<=\S)(__)|$)/gm,
};
const RE_BARRE = /~~(?=\S)(.+?)(?:(?<=\S)(~~)|$)/gm;
const RE_ITALIQUE = /\*(?=\S)(.+?)(?:(?<=\S)(\*)|$)/gm;
const RE_SOULIGNE = /(?<![\p{L}\p{N}])_(?=\S)(.+?)(?:(?<=\S)(_)(?![\p{L}\p{N}])|$)/gmu;

/** Le contenu d'une occurrence fermée, sinon le texte pris tel quel. */
const sinonTel = (tout: string, contenu: string, ferme?: string) => (ferme ? contenu : tout);

/** `s` sans les `caracteres` de sa fin. Un motif fini par `$` relirait cette fin depuis chacun. */
function rogner(s: string, caracteres: string) {
  let fin = s.length;
  while (fin && caracteres.includes(s[fin - 1])) fin--;
  return s.slice(0, fin);
}

/** Le texte d'un titre ATX sans ses `#` de fermeture, `undefined` pour une autre ligne. */
function titreAtx(ligne: string) {
  const m = ligne.match(/^ {0,3}#{1,6}[ \t]+(.*)/);
  if (!m || m[0].length < ligne.length) return undefined;
  const texte = rogner(m[1], " \t");
  const sansDieses = rogner(texte, "#");
  const sansFermeture = rogner(sansDieses, " \t");
  const fermeture = sansDieses.length < texte.length && sansFermeture.length < sansDieses.length;
  return fermeture ? sansFermeture : texte;
}

type Lisible = { texte: string; codes: [number, number][] };

// Bornes d'un code en ligne pendant la réduction, dans la zone d'usage privé d'Unicode.
const OUVRE = "";
const FERME = "";
const BLANC = /[ \t  ]/;

/**
 * Le texte qu'un lecteur voit: liens, emphases et code en ligne réduits à leur contenu, balises
 * HTML retirées (une cellule de tableau devient « | »), échappements et entités résolus. Le code
 * en ligne garde sa plage. Il est mis de côté avant les emphases, pour que `**` autour d'un code
 * tombe aussi et que le contenu du code reste tel quel.
 */
function lisible(s: string, images: string[]): Lisible {
  const sansLiens = s
    .replace(RE_IMAGE, (tout, cible: string, ferme?: string) => {
      if (!ferme) return tout;
      const url = cible.match(/^\s*<?([^\s>]*)/)![1];
      if (url && RELATIF.test(url)) images.push(url);
      return "";
    })
    .replace(RE_LIEN, sinonTel)
    .replace(RE_REFERENCE, sinonTel);
  const codes: string[] = [];
  const reduit = decoder(
    sansLiens
      .replace(/`([^`]+)`/g, (_, c: string) => `${OUVRE}${codes.push(c) - 1}${FERME}`)
      .replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/gi, " | ")
      .replace(RE_COMMENTAIRE_OU_BALISE, (tout, finCommentaire?: string, finBalise?: string) => {
        if (finCommentaire || finBalise) return " ";
        if (!tout.startsWith("<!--")) return tout;
        // Après un `<!--` sans fin, la ligne n'a plus de commentaire, ses balises restent à lire.
        // ponytail: une balise qui y commence et se ferme après un U+2028 reste du texte. La
        // lire demande de parcourir la ligne à la main.
        return `<!--${tout.slice(4).replace(RE_BALISE, (b, fin) => (fin ? " " : b))}`;
      })
      .replace(RE_GRAS, (tout, marque: "**" | "__", contenu: string, ferme?: string) =>
        // Après un gras sans fin, seule l'autre marque peut encore se fermer sur la ligne.
        ferme
          ? contenu
          : marque + tout.slice(2).replace(RE_GRAS_SEUL[marque === "**" ? "__" : "**"], sinonTel),
      )
      .replace(RE_BARRE, sinonTel)
      .replace(RE_ITALIQUE, sinonTel)
      .replace(RE_SOULIGNE, sinonTel)
      .replace(/\\([!-/:-@[-`{-~])/g, "$1"),
  ).replace(new RegExp(`${OUVRE}(\\d+)${FERME}`, "g"), (_, i) => OUVRE + codes[i] + FERME);
  // Les blancs se réduisent à une espace, bornes comprises, et tombent aux deux bouts.
  const sortie: string[] = [];
  const plages: [number, number][] = [];
  let debut = -1;
  let blanc = false;
  for (const c of reduit) {
    if (c === OUVRE) debut = sortie.length + (blanc && sortie.length ? 1 : 0);
    else if (c === FERME) {
      if (debut < sortie.length) plages.push([debut, sortie.length]);
    } else if (BLANC.test(c)) blanc = true;
    else {
      if (blanc && sortie.length) sortie.push(" ");
      blanc = false;
      sortie.push(c);
    }
  }
  return { texte: sortie.join(""), codes: plages };
}

/** Des morceaux mis bout à bout, chaque plage décalée de ce qui la précède. */
function joindre(morceaux: Lisible[], separateur: string): Lisible {
  let texte = "";
  const codes: [number, number][] = [];
  for (const [i, m] of morceaux.entries()) {
    if (i) texte += separateur;
    const n = longueur(texte);
    codes.push(...m.codes.map(([a, z]): [number, number] => [a + n, z + n]));
    texte += m.texte;
  }
  return { texte, codes };
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
  let bloc: Lisible = { texte: "", codes: [] };
  const fermer = () => {
    if (bloc.texte) {
      parties.push({ texte: bloc.texte, section, ...(bloc.codes.length && { codes: bloc.codes }) });
    }
    bloc = { texte: "", codes: [] };
  };
  // Une ligne de plus dans le bloc courant, ou la suite de la dernière quand `nouvelle` est faux.
  const ajouter = (l: Lisible, nouvelle: boolean) => {
    if (l.texte) bloc = bloc.texte ? joindre([bloc, l], nouvelle ? "\n" : " ") : l;
  };

  const brut = corps.split("\n");
  for (let i = 0; i < brut.length; i++) {
    const ligne = brut[i];
    const t = ligne.trim();
    const ouvre = ligne.match(/^(\s*)(`{3,}|~{3,})/);
    const titreLigne = titreAtx(ligne);
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
    } else if (titreLigne !== undefined) {
      fermer();
      section = lisible(titreLigne, images).texte;
      // Le premier titre qui répète le titre du document n'est pas redit.
      if (parties.length > 1 || section !== titre) parties.push({ texte: section, section });
    } else if (/^ {0,3}([-*_])( *\1){2,} *$/.test(ligne)) fermer();
    else if (/^[\s|:-]+$/.test(t) && t.includes("|") && t.includes("-")) continue;
    else if (/^ {0,3}\[[^\]]+\]:\s*\S/.test(ligne)) continue;
    else if (t.startsWith("|")) {
      const cellules = t.replace(/^\||\|$/g, "").split("|");
      ajouter(
        joindre(
          cellules.map((c) => lisible(c, images)),
          " | ",
        ),
        true,
      );
    } else {
      // Le motif n'a pas de `$`, qui ferait relire une ligne coupée par U+2028 à chaque blanc
      // rendu. La longueur lue le remplace.
      const puce = ligne.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)/);
      const item = puce?.[0].length === ligne.length ? puce : null;
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
