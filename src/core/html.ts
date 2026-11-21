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

// Les motifs qui lisent une page déposée lisent chaque caractère une fois. Une ouverture sans
// fermeture prend le reste du texte et y reste telle quelle : les ouvertures suivantes n'auraient
// pas trouvé de fermeture non plus, et les essayer une à une relirait le texte depuis chacune. Un
// motif cherché une seule fois s'écrit `ouverture(?:suite|[^]*$)` : si la suite échoue, il prend
// tout le reste sans rien capturer.
const RE_BALISE = /<[^>]+(>|$)/g;

/** Retire les occurrences fermées de `re`, dont le seul groupe est la fermeture ou la fin. */
const retirer = (s: string, re: RegExp) =>
  s.replace(re, (tout: string, fin: string) => (fin ? "" : tout));

/**
 * Retire les éléments `noms`, contenu compris. `motif` donne l'expression pour ces noms, le nom
 * puis la fermeture en groupes. Un élément sans fermeture reste, et la suite se lit sans son nom :
 * aucun autre ne s'y fermerait.
 */
function sansElements(
  s: string,
  noms: string[],
  motif: (noms: string) => string,
  retire?: (nom: string) => void,
): string {
  return s.replace(new RegExp(motif(noms.join("|")), "gi"), (tout, nom: string, ferme: string) => {
    if (ferme) {
      retire?.(nom.toLowerCase());
      return "";
    }
    const autres = noms.filter((n) => n !== nom.toLowerCase());
    const suite = tout.slice(1);
    return tout[0] + (autres.length ? sansElements(suite, autres, motif, retire) : suite);
  });
}

const sansBalises = (s: string) => decoder(retirer(s, RE_BALISE)).replace(/\s+/g, " ").trim();

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

const RE_IMG = /src="data:image\/(?:jpeg|jpg|png|gif|webp)[^,"]*base64,([A-Za-z0-9+/=\s]+)"/i;
const FIN_MEDAILLES = /Voir dans Pearltrees<\/a>\s*<\/div>\s*<\/div>/gi;

/** Retire le bandeau des médailles, de son `<div class="medals">` au lien « Voir dans Pearltrees ». */
function sansMedailles(html: string) {
  // Chaque `<div` est lu une fois, jusqu'à son `>`.
  for (const m of html.matchAll(/<div[^>]*/gi)) {
    const classe = m[0].search(/class="medals"/i);
    if (classe < 0) continue;
    FIN_MEDAILLES.lastIndex = m.index + classe;
    // Sans lien après ce bandeau, aucun `<div` suivant n'en trouverait.
    if (!FIN_MEDAILLES.exec(html)) break;
    return html.slice(0, m.index) + html.slice(FIN_MEDAILLES.lastIndex);
  }
  return html;
}

/**
 * Page d'un export Pearltrees: un titre, du texte, des images en base64. Seule la première image
 * est gardée, si `imageOffice()` l'accepte. Le profil arts appliqués lit ainsi toute page HTML,
 * les autres profils passent par `extraireHtml()`.
 */
// ponytail: les images suivantes d'un article long sont ignorées. Les garder demande une
// légende et une relecture de plus par image, sans mesure qui le justifie sur le pilote.
export function extrairePearltrees(html: string, titreParDefaut: string): Extraction {
  const titre = sansBalises(
    html.match(/<h1(?:[^>]*>([\s\S]*?)<\/h1>|[^]*$)/i)?.[1] ??
      html.match(/<title>(?:([\s\S]*?)<\/title>|[^]*$)/i)?.[1] ??
      titreParDefaut,
  );
  // Le type vient des octets, comme pour l'image d'un document Word. Celui de l'adresse est ignoré.
  const img = html.match(RE_IMG);
  const image = img ? imageOffice(Buffer.from(img[1], "base64")) : undefined;

  const sansTete = retirer(html, /<head[\s\S]*?(<\/head>|$)/i);
  const sansCode = sansElements(
    sansTete,
    ["script", "style", "iframe"],
    (noms) => `<(${noms})[\\s\\S]*?(<\\/\\1>|$)`,
  );
  const corps = retirer(
    sansMedailles(retirer(sansCode, /<h1[\s\S]*?(<\/h1>|$)/i)),
    /<img[^>]*(>|$)/gi,
  );
  const parties: Partie[] = [{ texte: titre, section: titre }];
  let section = titre;
  for (const morceau of corps.split(/<\/(?:p|div|h[2-6]|li|blockquote)>|<br\s*\/?>/i)) {
    // Le morceau porte un intertitre si son premier `<h2>` à `<h6>` a un `>` après lui. Sinon les
    // suivants n'en ont pas non plus.
    const h = morceau.search(/<h[2-6]/i);
    const intertitre = h >= 0 && morceau.includes(">", h);
    const texte = sansBalises(morceau);
    if (!texte || texte === "–") continue;
    if (intertitre) section = texte;
    else section = intertitreGras(morceau) ?? section;
    parties.push({ texte, section });
  }
  return {
    parties,
    images: typeof image === "object" ? [image] : [],
    avertissements: typeof image === "string" ? imagesEcartees([image]) : [],
  };
}

/** Éléments sans texte de lecture: titre de l'onglet, code, menus, commandes et figures SVG. */
const ECARTES = [
  "title",
  "script",
  "style",
  "template",
  "noscript",
  "svg",
  "iframe",
  "nav",
  "button",
  "select",
  "textarea",
];
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
  const source = retirer(html, /<!--[\s\S]*?(-->|$)/g);
  const onglet = source.match(/<title\b(?:[^>]*>([\s\S]*?)<\/title\s*>|[^]*$)/i)?.[1] ?? "";
  let figures = 0;
  const corps = sansElements(
    source.match(/<main\b(?:[^>]*>([\s\S]*)<\/main\s*>|[^]*$)/i)?.[1] ?? source,
    ECARTES,
    (noms) => `<(${noms})\\b[\\s\\S]*?(<\\/\\1\\s*>|$)`,
    (nom) => {
      if (nom === "svg") figures++;
    },
  );
  const enClair = (s: string) => decoderHtml(retirer(s, RE_BALISE)).replace(/\s+/g, " ").trim();
  const titre =
    enClair(corps.match(/<h1\b(?:[^>]*>([\s\S]*?)<\/h1\s*>|[^]*$)/i)?.[1] ?? "") ||
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
  // La rangée de tableau en cours : où elle commence dans le bloc, la longueur et le dernier
  // caractère du bloc à ce moment, et si elle a reçu autre chose que des blancs et des « | ».
  let rangee = 0;
  let nRangee = 0;
  let dernierRangee = "";
  let pleine = false;
  // Les séparateurs de cellules qui attendent le premier mot à leur suite. Une rangée de cellules
  // vides n'écrit ainsi rien, et n'a rien à retirer du bloc.
  let attente = "";

  const poser = () => {
    if (!attente) return;
    texte += attente;
    n += longueur(attente);
    attente = "";
  };
  const ecrire = (s: string) => {
    poser();
    texte += s;
    n += longueur(s);
    dernier = s.at(-1) ?? dernier;
    if (!pleine && /[^|\s]/.test(s)) pleine = true;
  };
  const ouvrirRangee = () => {
    rangee = texte.length;
    nRangee = n;
    dernierRangee = dernier;
    pleine = false;
    attente = "";
    cellules = 0;
  };
  const vider = () => {
    texte = "";
    n = 0;
    dernier = "";
    codes = [];
    blanc = false;
    code = undefined;
    attente = "";
  };
  const fermer = () => {
    // Un tableau que la page ne ferme pas garde les séparateurs de sa dernière rangée.
    poser();
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
      poser();
      if (blanc && texte && dernier !== " " && dernier !== "\n") ecrire(" ");
      blanc = false;
      if (code === -1) code = n;
      ecrire(m);
    }
  };
  // Une rangée sans texte, cellules vides comprises, ne laisse rien. Le bloc n'est ni relu ni
  // mesuré : ce que la rangée a reçu se sait au fil de l'écriture.
  // ponytail: une rangée faite des seuls « | » d'un texte recopie encore le bloc pour s'en
  // retirer. Un tampon par rangée si un tel tableau se présente.
  const finRangee = () => {
    if (pleine) poser();
    else {
      if (texte.length > rangee) texte = texte.slice(0, rangee);
      n = nRangee;
      dernier = dernierRangee;
      attente = "";
    }
    ligne();
    ouvrirRangee();
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
        ouvrirRangee();
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
        if (cellules++) {
          attente += " | ";
          dernier = " ";
        }
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
  const dernierChevron = corps.lastIndexOf(">");
  for (let m; (m = jetons.exec(corps));) {
    const [jeton, ferme, nomBrut, attributs] = m;
    // Après le dernier `>`, plus aucune balise ne se ferme : le reste est du texte.
    if (jeton === "<" && m.index > dernierChevron) {
      mots(corps.slice(m.index));
      break;
    }
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
      const lignes = decoderHtml(retirer(brut.replace(/<br\s*\/?>/gi, "\n"), RE_BALISE))
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
  // La fermeture se cherche depuis l'ouverture, et la lecture reprend après elle. Sans
  // fermeture, aucune ouverture suivante n'en trouverait non plus.
  const ouverture = /<div class="(section|pearl)">/g;
  for (let m; (m = ouverture.exec(html));) {
    const fin = html.indexOf("</div>", ouverture.lastIndex);
    if (fin < 0) break;
    const contenu = html.slice(ouverture.lastIndex, fin);
    ouverture.lastIndex = fin + "</div>".length;
    if (m[1] === "section") {
      rubrique = sansBalises(contenu).replace(/_+/g, " ").trim() || rubrique;
    } else {
      const href = contenu.match(/href="([^"]+)"/)?.[1];
      if (href) out.set(decoder(href), rubrique);
    }
  }
  return out;
}
