import { createRequire } from "node:module";
import type { Extraction, Image, Partie } from "./document.ts";
import { imageOffice, imagesEcartees } from "./ooxml.ts";
import { longueur } from "./texte.ts";

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

const decoderAvec = (entites: Record<string, string>) => (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (tout, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1));
      return n <= 0x10ffff ? String.fromCodePoint(n) : tout;
    }
    return entites[e] ?? tout;
  });

/** Entités des pages Pearltrees et du Markdown. Une liste plus longue changerait leur texte. */
export const decoder = decoderAvec(ENTITES);

// Toutes les entités nommées du HTML, d'après la table de xmldom.
const decoderHtml = decoderAvec(
  (
    createRequire(import.meta.url)("@xmldom/xmldom/lib/entities.js") as {
      HTML_ENTITIES: Record<string, string>;
    }
  ).HTML_ENTITIES,
);

/** Un chemin relatif, sans schéma (`https:`, `data:`) ni `//`. */
export const RELATIF = /^(?![a-z][a-z\d+.-]*:|\/\/)/i;

const sansBalises = (s: string) =>
  decoder(s.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();

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
  const seul = !reste && gras.split(" ").length <= 12 && !gras.endsWith(":");
  return gras && (seul || /^[—–] /.test(reste)) ? gras : undefined;
}

const RE_IMG = /src="data:image\/(jpeg|jpg|png|gif|webp)[^,"]*base64,\s*([A-Za-z0-9+/=\s]+)"/i;

/**
 * Page d'un export Pearltrees: un titre, du texte, des images en base64. Seule la première image
 * est gardée. Le profil arts appliqués lit ainsi toute page HTML, les autres profils passent par
 * `extraireHtml()`.
 */
// ponytail: les images suivantes d'un article long sont ignorées. Les garder demande une
// légende et une relecture de plus par image, sans mesure qui le justifie sur le pilote.
export function extrairePearltrees(html: string, titreParDefaut: string): Extraction {
  const titre = sansBalises(
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ??
      html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ??
      titreParDefaut,
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

/** Éléments sans texte de lecture: titre de l'onglet, code, menus, commandes et figures SVG. */
const ECARTES =
  /<(title|script|style|template|noscript|svg|iframe|nav|button|select|textarea)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCS = new Set(
  "address article aside blockquote body br caption center dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr html li main menu ol p pre section summary table tbody td tfoot th thead tr ul".split(
    " ",
  ),
);
const LISTES = new Set(["ul", "ol", "menu", "dl"]);
const ENTREES = new Set(["li", "dt", "dd"]);

/**
 * Page HTML: le texte que montre le navigateur, celui du `<main>` quand la page en a un. Les
 * titres ouvrent les sections, une liste garde une ligne par entrée, un tableau une ligne par
 * rangée avec ses cellules séparées par « | ». Un `<pre>` reste mot pour mot, un `<code>` en ligne
 * garde sa plage. Les images intégrées en `data:` sont importées, les images liées nommées.
 */
// ponytail: lecture par balises, sans arbre. Un `</li>` ou un `</p>` oublié ne gêne pas, mais un
// `>` dans un attribut coupe la balise. Prendre parse5 si des pages réelles le demandent.
export function extraireHtml(html: string, titreParDefaut: string): Extraction {
  const source = html.replace(/<!--[\s\S]*?-->/g, "");
  const onglet = source.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? "";
  let figures = 0;
  const corps = (source.match(/<main\b[^>]*>([\s\S]*)<\/main\s*>/i)?.[1] ?? source).replace(
    ECARTES,
    (_, nom: string) => {
      if (nom.toLowerCase() === "svg") figures++;
      return "";
    },
  );
  const enClair = (s: string) =>
    decoderHtml(s.replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
  const titre =
    enClair(corps.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1] ?? "") ||
    enClair(onglet) ||
    titreParDefaut;

  const parties: Partie[] = [{ texte: titre, section: titre }];
  const images: Image[] = [];
  const ecartees: string[] = [];
  const liees: string[] = [];
  let section = titre;
  // Le bloc courant, sa longueur en points de code et son dernier caractère.
  let texte = "";
  let n = 0;
  let dernier = "";
  let codes: [number, number][] = [];
  let blanc = false;
  // Début du `<code>` ouvert, -1 avant son premier mot.
  let code: number | undefined;
  let listes = 0;
  let tables = 0;
  let cellules = 0;
  let rangee = 0;

  const ecrire = (s: string) => {
    texte += s;
    n += longueur(s);
    dernier = s.at(-1) ?? dernier;
  };
  const vider = () => {
    texte = "";
    n = 0;
    dernier = "";
    codes = [];
    blanc = false;
    code = undefined;
  };
  const fermer = () => {
    const t = texte.trimEnd();
    if (t) parties.push({ texte: t, section, ...(codes.length && { codes }) });
    vider();
  };
  const ligne = () => {
    if (texte && dernier !== "\n") ecrire("\n");
    blanc = false;
  };
  const mots = (brut: string) => {
    for (const m of decoderHtml(brut).split(/(\s+)/)) {
      if (!m) continue;
      if (/^\s/.test(m)) {
        blanc = true;
        continue;
      }
      if (blanc && texte && dernier !== " " && dernier !== "\n") ecrire(" ");
      blanc = false;
      if (code === -1) code = n;
      ecrire(m);
    }
  };
  // Une rangée sans texte, cellules vides comprises, ne laisse rien.
  const finRangee = () => {
    if (!/[^|\s]/.test(texte.slice(rangee))) {
      texte = texte.slice(0, rangee);
      n = longueur(texte);
      dernier = texte.at(-1) ?? "";
    }
    ligne();
    rangee = texte.length;
    cellules = 0;
  };
  const image = (attributs: string) => {
    const src = decoderHtml(attributs.match(/\bsrc\s*=\s*(["'])([\s\S]*?)\1/i)?.[2] ?? "").trim();
    const donnees = src.match(/^data:image\/[^,]*;base64,([\s\S]*)$/i);
    if (donnees) {
      const im = imageOffice(Buffer.from(donnees[1], "base64"));
      if (typeof im === "string") ecartees.push(im);
      else images.push({ ...im, section });
    } else if (src && RELATIF.test(src)) liees.push(src);
  };

  const balise = (nom: string, ferme: boolean) => {
    if (nom === "code") {
      if (!ferme) code = -1;
      else {
        if (code !== undefined && code >= 0 && n > code) codes.push([code, n]);
        code = undefined;
      }
    } else if (!BLOCS.has(nom)) {
      // Lien, emphase, span : leur texte reste dans le bloc courant.
    } else if (nom === "table" && !ferme) {
      if (!tables++) {
        if (listes) ligne();
        else fermer();
        rangee = texte.length;
        cellules = 0;
      }
    } else if (nom === "table" && tables) {
      if (!--tables) {
        finRangee();
        if (!listes) fermer();
      }
    } else if (tables) {
      // Dans un tableau, seules les rangées et les cellules du premier niveau comptent.
      if (tables === 1 && nom === "tr") finRangee();
      else if (tables === 1 && !ferme && (nom === "td" || nom === "th")) {
        if (cellules++) ecrire(" | ");
        blanc = false;
      } else blanc = true;
    } else if (LISTES.has(nom)) {
      if (!ferme) {
        if (listes++) ligne();
        else fermer();
      } else if (listes) {
        if (--listes) ligne();
        else fermer();
      }
    } else if (listes) {
      if (ENTREES.has(nom)) ligne();
      else blanc = true;
    } else if (nom === "br") ligne();
    else if (/^h[1-6]$/.test(nom) && ferme) {
      const t = texte.replace(/\s+/g, " ").trim();
      vider();
      if (!t) return;
      section = t;
      // Le premier titre qui répète le titre de la page n'est pas redit.
      if (parties.length > 1 || t !== titre) parties.push({ texte: t, section });
    } else fermer();
  };

  const jetons = /<[!?][^>]*>|<(\/?)([a-z][a-z0-9]*)\b([^>]*)>|[^<]+|</gi;
  const finPre = /<\/pre\s*>/gi;
  for (let m; (m = jetons.exec(corps));) {
    const [jeton, ferme, nomBrut, attributs] = m;
    if (nomBrut === undefined) {
      if (!/^<[!?]/.test(jeton)) mots(jeton);
      continue;
    }
    const nom = nomBrut.toLowerCase();
    if (nom === "img") image(attributs);
    else if (nom === "pre" && !ferme && !tables) {
      fermer();
      finPre.lastIndex = jetons.lastIndex;
      const fin = finPre.exec(corps);
      const brut = corps.slice(jetons.lastIndex, fin?.index ?? corps.length);
      jetons.lastIndex = fin ? finPre.lastIndex : corps.length;
      const classes = `${attributs} ${brut.match(/^\s*<code\b([^>]*)>/i)?.[1] ?? ""}`;
      const langage = classes.match(/\blang(?:uage)?-([\w+#-]+)/i)?.[1].toLowerCase();
      const lignes = decoderHtml(brut.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
        .replace(/\r\n?/g, "\n")
        .replace(/^\n/, "");
      if (lignes.trim()) {
        parties.push({ texte: lignes, section, code: true, ...(langage && { langage }) });
      }
    } else balise(nom, ferme === "/");
  }
  fermer();

  const avertissements: string[] = [];
  if (liees.length) {
    avertissements.push(
      `Images liées, non jointes à la source : ${[...new Set(liees)].join(", ")}.`,
    );
  }
  if (figures) avertissements.push(`Figures SVG non extraites : ${figures}.`);
  return { parties, images, avertissements: [...avertissements, ...imagesEcartees(ecartees)] };
}

/**
 * Page Pearltrees sans contenu propre: un titre, un lien, une vignette hébergée chez Pearltrees.
 * `fichier` nomme le fichier du même dossier qu'elle présente (« ./Fiche Cubisme.pdf »).
 */
export function pageVide(html: string): { fichier?: string } | undefined {
  const e = extrairePearltrees(html, "");
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
