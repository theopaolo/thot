import type { Extraction, Image, Partie } from "./document.ts";

const ENTITES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  laquo: "«",
  raquo: "»",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  oelig: "œ",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  euml: "ë",
  agrave: "à",
  acirc: "â",
  ccedil: "ç",
  icirc: "î",
  iuml: "ï",
  ocirc: "ô",
  ugrave: "ù",
  ucirc: "û",
  aacute: "á",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  ntilde: "ñ",
  szlig: "ß",
  deg: "°",
  Eacute: "É",
  Ecirc: "Ê",
  Ocirc: "Ô",
  OElig: "Œ",
  Egrave: "È",
  Agrave: "À",
  Ccedil: "Ç",
};

export const decoder = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (tout, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1));
      return Number.isFinite(n) ? String.fromCodePoint(n) : tout;
    }
    return ENTITES[e] ?? tout;
  });

const sansBalises = (s: string) => decoder(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/**
 * Les synthèses Pearltrees marquent leurs parties en gras, sans balise de titre: un paragraphe
 * court entièrement en gras, ou un gras suivi d'un tiret long (« <b>Les Fauves</b> — libérer la
 * couleur »). Un gras suivi de deux-points (« <b>Dimensions</b> : 81 cm ») reste une étiquette.
 */
function intertitreGras(morceau: string) {
  const m = morceau.match(
    /^\s*(?:<(?!b\b|strong\b)[^>]+>\s*)*<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>([\s\S]*)$/i,
  );
  if (!m) return undefined;
  const gras = sansBalises(m[2]);
  const reste = sansBalises(m[3]);
  const seul = !reste && gras.split(" ").length <= 12 && !/:$/.test(gras);
  return gras && (seul || /^[—–] /.test(reste)) ? gras : undefined;
}

const RE_IMG = /src="data:image\/(jpeg|jpg|png|gif|webp)[^,"]*base64,\s*([A-Za-z0-9+/=\s]+)"/i;

/**
 * Page d'un export Pearltrees: un titre, du texte, des images en base64. Seule la première image
 * est gardée.
 */
// ponytail: les images suivantes d'un article long sont ignorées. Les garder demande une
// légende et une relecture de plus par image, sans mesure qui le justifie sur le pilote.
export function extraireHtml(html: string, titreParDefaut: string): Extraction {
  const titre = sansBalises(
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ??
      html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? titreParDefaut,
  );
  const images: Image[] = [];
  const img = html.match(RE_IMG);
  if (img) {
    const type = img[1].toLowerCase() === "jpg" ? "jpeg" : img[1].toLowerCase();
    images.push({
      octets: Uint8Array.from(atob(img[2].replace(/\s/g, "")), (c) => c.charCodeAt(0)),
      mime: `image/${type}`,
      extension: type === "jpeg" ? "jpg" : type,
    });
  }

  const corps = html
    .replace(/<head[\s\S]*?<\/head>/i, "")
    .replace(/<(script|style|iframe)[\s\S]*?<\/\1>/gi, "")
    .replace(/<h1[\s\S]*?<\/h1>/i, "")
    .replace(/<div[^>]*class="medals"[\s\S]*?Voir dans Pearltrees<\/a>\s*<\/div>\s*<\/div>/i, "")
    .replace(/<img[^>]*>/gi, "");
  const parties: Partie[] = [{ texte: titre, section: titre }];
  let section = titre;
  for (const morceau of corps.split(/<\/(?:p|div|h[2-6]|li|blockquote)>|<br\s*\/?>/i)) {
    const intertitre = morceau.match(/<h([2-6])[^>]*>([\s\S]*)$/i);
    const texte = sansBalises(morceau);
    if (!texte || texte === "–") continue;
    if (intertitre) section = texte;
    else section = intertitreGras(morceau) ?? section;
    parties.push({ texte, section });
  }
  return { parties, images, avertissements: [] };
}

/**
 * Page Pearltrees sans contenu propre: un titre, un lien, une vignette hébergée chez Pearltrees.
 * `fichier` nomme le fichier du même dossier qu'elle présente (« ./Fiche Cubisme.pdf »).
 */
export function pageVide(html: string): { fichier?: string } | undefined {
  const e = extraireHtml(html, "");
  if (e.parties.length > 1 || e.images.length) return undefined;
  const href = html.match(/href="\.\/([^"]+)"/i)?.[1];
  return { fichier: href && decoder(href) };
}

/** Rubrique de chaque fichier d'un sommaire Pearltrees, par son `href`. */
export function rubriquesSommaire(html: string): Map<string, string> {
  const out = new Map<string, string>();
  let rubrique = "";
  for (const m of html.matchAll(/<div class="(section|pearl)">([\s\S]*?)<\/div>/g)) {
    if (m[1] === "section") {
      rubrique = sansBalises(m[2]).replace(/_+/g, " ").trim() || rubrique;
    } else {
      const href = m[2].match(/href="([^"]+)"/)?.[1];
      if (href) out.set(decoder(href), rubrique);
    }
  }
  return out;
}
