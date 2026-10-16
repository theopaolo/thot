import { crc32, inflateRawSync } from "node:zlib";
import { createRequire } from "node:module";
import type { Image, Partie } from "./document.ts";

/**
 * Bornes d'un document Word ou PowerPoint. Le dépôt borne déjà le fichier à 25 Mo. Les tailles
 * décompressées se vérifient sur le répertoire central, avant toute décompression. La mémoire
 * d'une analyse suit surtout le nombre d'éléments XML (mesures dans docs/exploitation.md).
 */
export const BORNES = {
  entrees: 5000,
  /** octets décompressés d'une entrée, d'une partie XML, de toute l'archive */
  entree: 50 * 1024 * 1024,
  xml: 20 * 1024 * 1024,
  total: 100 * 1024 * 1024,
  /** éléments XML de toutes les parties lues dans une archive */
  elements: 200_000,
  /** pixels d'une image, lus dans son en-tête */
  pixels: 50_000_000,
  /** caractères du texte extrait, comme pour un PDF */
  texte: 10 * 1024 * 1024,
  delaiMs: 30_000,
};

export type Archive = { noms: string[]; lire(nom: string): Uint8Array | undefined };

type Entree = { methode: number; compresse: number; taille: number; crc: number; decalage: number };

const mo = (n: number) => `${Math.ceil(n / 1024 / 1024)} Mo`;
const corrompue = (raison: string) => new Error(`Archive corrompue : ${raison}.`);

/**
 * Lit le répertoire central d'un zip et refuse une archive dont les tailles déclarées dépassent
 * les bornes. `lire` décompresse une entrée sans dépasser sa taille déclarée, puis vérifie
 * taille et CRC : une archive qui ment sur ses tailles s'arrête à la borne.
 */
export function ouvrirArchive(octets: Uint8Array): Archive {
  const v = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  const entrees = new Map<string, Entree>();
  try {
    let fin = octets.length - 22;
    const plancher = Math.max(0, fin - 0xffff);
    while (fin >= plancher && v.getUint32(fin, true) !== 0x06054b50) fin--;
    if (fin < plancher) throw corrompue("fin d'archive introuvable");
    const n = v.getUint16(fin + 10, true);
    let p = v.getUint32(fin + 16, true);
    if (v.getUint16(fin + 4, true) || n === 0xffff || p === 0xffffffff) {
      throw corrompue("archive en plusieurs parties ou zip64");
    }
    if (n > BORNES.entrees) {
      throw new Error(`Archive de ${n} entrées, ${BORNES.entrees} au maximum.`);
    }
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (v.getUint32(p, true) !== 0x02014b50) throw corrompue("répertoire central illisible");
      const longueurNom = v.getUint16(p + 28, true);
      const nom = new TextDecoder().decode(octets.subarray(p + 46, p + 46 + longueurNom));
      const e: Entree = {
        methode: v.getUint16(p + 10, true),
        crc: v.getUint32(p + 16, true),
        compresse: v.getUint32(p + 20, true),
        taille: v.getUint32(p + 24, true),
        decalage: v.getUint32(p + 42, true),
      };
      if (v.getUint16(p + 8, true) & 1) {
        throw new Error("Archive chiffrée : enregistrer le document sans mot de passe.");
      }
      p += 46 + longueurNom + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
      if (e.methode !== 0 && e.methode !== 8) throw corrompue(`compression ${e.methode} inconnue`);
      if (entrees.has(nom)) throw corrompue(`« ${nom} » en double`);
      const max = /\.(xml|rels)$/i.test(nom) ? BORNES.xml : BORNES.entree;
      if (e.taille > max) {
        throw new Error(`« ${nom} » ferait ${mo(e.taille)} décompressé, ${mo(max)} au maximum.`);
      }
      total += e.taille;
      if (total > BORNES.total) {
        throw new Error(`Archive de plus de ${mo(BORNES.total)} une fois décompressée.`);
      }
      entrees.set(nom, e);
    }
  } catch (e) {
    throw e instanceof RangeError ? corrompue("archive tronquée") : e;
  }

  let elements = 0;
  const comptees = new Set<string>();
  return {
    noms: [...entrees.keys()],
    lire(nom) {
      const e = entrees.get(nom);
      if (!e) return undefined;
      let sortie: Uint8Array;
      try {
        if (v.getUint32(e.decalage, true) !== 0x04034b50) throw corrompue(`en-tête de « ${nom} »`);
        const debut =
          e.decalage + 30 + v.getUint16(e.decalage + 26, true) + v.getUint16(e.decalage + 28, true);
        const brut = octets.subarray(debut, debut + e.compresse);
        if (brut.length !== e.compresse) throw corrompue(`« ${nom} » tronqué`);
        sortie =
          e.methode === 0 ? brut : inflateRawSync(brut, { maxOutputLength: Math.max(1, e.taille) });
      } catch (err) {
        if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
          throw new Error(`Archive : « ${nom} » dépasse sa taille déclarée.`);
        }
        throw (err as { code?: string }).code || err instanceof RangeError
          ? corrompue(`« ${nom} » illisible`)
          : err;
      }
      if (sortie.length !== e.taille || crc32(sortie) !== e.crc) {
        throw corrompue(`« ${nom} » ne correspond pas à sa taille ou à sa somme de contrôle`);
      }
      // Les balises ouvrantes d'une partie XML comptent une fois, même relue.
      if (/\.(xml|rels)$/i.test(nom) && !comptees.has(nom)) {
        comptees.add(nom);
        for (let i = 0; i < sortie.length - 1; i++) {
          const c = sortie[i + 1] | 0x20;
          if (sortie[i] === 0x3c && c >= 0x61 && c <= 0x7a) elements++;
        }
        if (elements > BORNES.elements) {
          throw new Error(`Document de plus de ${BORNES.elements} éléments XML.`);
        }
      }
      return sortie;
    },
  };
}

/** Refuse un texte extrait au-delà de la borne, sinon rend les passages. */
export function bornerTexte(parties: Partie[]) {
  let n = 0;
  for (const p of parties) n += p.texte.length;
  if (n > BORNES.texte) throw new Error(`Texte extrait au-delà de ${mo(BORNES.texte)}.`);
  return parties;
}

/** Ce que les extracteurs lisent d'un nœud xmldom, document, élément ou texte. */
export type Noeud = {
  nodeType: number;
  nodeValue: string | null;
  textContent: string | null;
  localName: string;
  documentElement: Noeud;
  childNodes: ArrayLike<Noeud>;
  getAttribute(nom: string): string | null;
  getAttributeNS(espace: string, nom: string): string | null;
  getElementsByTagNameNS(espace: string, nom: string): ArrayLike<Noeud>;
};

// Les types publiés par xmldom chargent ceux du DOM dans tout le projet. `Noeud` les remplace.
const { DOMParser } = createRequire(import.meta.url)("@xmldom/xmldom") as {
  DOMParser: new (o: object) => { parseFromString(texte: string, type: string): Noeud };
};

/** Les éléments enfants, ceux d'un nom local donné si `nom` est fourni. */
export const enfants = (n: Noeud, nom?: string) =>
  Array.from(n.childNodes).filter((c) => c.nodeType === 1 && (!nom || c.localName === nom));
/** Les éléments descendants d'un nom local, quel que soit leur préfixe. */
export const tous = (n: Noeud, nom: string) => Array.from(n.getElementsByTagNameNS("*", nom));
export const premier = (n: Noeud, nom: string): Noeud | undefined => tous(n, nom)[0];

/** Analyse un XML et lève une erreur lisible au premier défaut. */
export function analyserXml(texte: string, nom: string) {
  const lever = (m: unknown) => {
    throw new Error(`XML illisible dans « ${nom} » : ${String(m).split("\n")[0]}`);
  };
  return new DOMParser({
    errorHandler: { warning: () => {}, error: lever, fatalError: lever },
  }).parseFromString(texte, "text/xml");
}

/** Une partie XML de l'archive. xmldom ne développe pas les entités d'une DTD. */
export function lireXml(a: Archive, nom: string) {
  const octets = a.lire(nom);
  return octets && analyserXml(new TextDecoder().decode(octets), nom);
}

const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const MACROS = "Document avec macros (.docm, .pptm) refusé : l'enregistrer en .docx ou .pptx.";
const PRINCIPAL = {
  docx: [
    "word/document.xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  ],
  pptx: [
    "ppt/presentation.xml",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  ],
} as const;

/**
 * Reconnaît un document Word ou PowerPoint à son contenu : la partie principale et son type
 * déclaré dans `[Content_Types].xml`. Rend `undefined` pour un fichier qui n'est ni un zip ni un
 * conteneur OLE. Lit seulement le répertoire central et la liste des types.
 */
export function detecterOffice(
  octets: Uint8Array,
): { format: "docx" | "pptx" } | { erreur: string } | undefined {
  if (CFB.every((b, i) => octets[i] === b)) {
    return {
      erreur:
        "Document Office chiffré ou ancien format (.doc, .ppt) : l'enregistrer sans mot de passe en .docx ou .pptx.",
    };
  }
  // « PK » puis 3 4 (première entrée) ou 5 6 (archive vide). « PK » seul ouvre aussi un texte.
  const zip =
    octets[0] === 0x50 &&
    octets[1] === 0x4b &&
    ((octets[2] === 3 && octets[3] === 4) || (octets[2] === 5 && octets[3] === 6));
  if (!zip) return undefined;
  try {
    const a = ouvrirArchive(octets);
    if (a.noms.some((n) => /(^|\/)vbaProject\.bin$/i.test(n))) return { erreur: MACROS };
    // Le serveur lit cette liste à chaque dépôt : une expression régulière, sans arbre XML.
    const types = new TextDecoder().decode(a.lire("[Content_Types].xml"));
    for (const [format, [partie, type]] of Object.entries(PRINCIPAL)) {
      const declare = types
        .match(new RegExp(`<Override[^>]*PartName="/${partie.replace(".", "\\.")}"[^>]*>`))?.[0]
        .match(/ContentType="([^"]*)"/)?.[1];
      if (/macroEnabled/i.test(declare ?? "")) return { erreur: MACROS };
      if (declare === type && a.noms.includes(partie)) {
        return { format: format as "docx" | "pptx" };
      }
    }
  } catch (e) {
    return { erreur: (e as Error).message };
  }
  return {
    erreur:
      "Archive non prise en charge : seuls les documents Word (.docx) et PowerPoint (.pptx) sont acceptés.",
  };
}

const be16 = (o: Uint8Array, i: number) => (o[i] << 8) | o[i + 1];

/** Type et dimensions lus dans l'en-tête. PNG, JPEG et GIF : le navigateur et le modèle les lisent. */
function enTete(o: Uint8Array) {
  if (o.length < 24) return undefined;
  if (o[0] === 0x89 && o[1] === 0x50 && o[2] === 0x4e && o[3] === 0x47) {
    const v = new DataView(o.buffer, o.byteOffset, o.byteLength);
    return { mime: "image/png", extension: "png", l: v.getUint32(16), h: v.getUint32(20) };
  }
  if (o[0] === 0x47 && o[1] === 0x49 && o[2] === 0x46) {
    return { mime: "image/gif", extension: "gif", l: o[6] | (o[7] << 8), h: o[8] | (o[9] << 8) };
  }
  if (o[0] !== 0xff || o[1] !== 0xd8) return undefined;
  // JPEG : les dimensions sont dans le premier segment SOF.
  for (let i = 2; i + 9 < o.length;) {
    if (o[i] !== 0xff) return undefined;
    const m = o[i + 1];
    if (m === 0xff) i++;
    else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { mime: "image/jpeg", extension: "jpg", l: be16(o, i + 7), h: be16(o, i + 5) };
    } else i += 2 + be16(o, i + 2);
  }
  return undefined;
}

/** Une image du document, ou la raison de l'écarter. */
export function imageOffice(octets: Uint8Array): Image | string {
  const e = enTete(octets);
  if (!e) return "format que le navigateur n'affiche pas (EMF, WMF, TIFF, SVG…)";
  if (e.l * e.h > BORNES.pixels) {
    return `${e.l} × ${e.h} pixels, ${BORNES.pixels / 1e6} millions au maximum`;
  }
  return { octets, mime: e.mime, extension: e.extension };
}

/** Un avertissement par raison d'écarter des images, avec leur nombre. */
export const imagesEcartees = (raisons: string[]) =>
  [...new Set(raisons)].map(
    (r) => `Images non importées (${raisons.filter((x) => x === r).length}) : ${r}.`,
  );
