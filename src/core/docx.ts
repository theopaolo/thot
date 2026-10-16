import mammoth from "mammoth";
import type { Extraction, Image, Partie } from "./document.ts";
import {
  analyserXml,
  BORNES,
  bornerTexte,
  enfants,
  imageOffice,
  imagesEcartees,
  type Noeud,
  ouvrirArchive,
} from "./ooxml.ts";

/** Ce que le texte ne reprend pas, repéré dans `word/document.xml`. */
const NON_EXTRAIT: [RegExp, string][] = [
  [/<m:oMath[\s>]/, "Équations non extraites."],
  [
    /<w:txbxContent[\s>]/,
    "Zones de texte : leur texte peut manquer, ou se lire après le paragraphe qui les ancre.",
  ],
  [/<(?:w:object|o:OLEObject|w:altChunk)[\s>]/, "Objets intégrés non extraits."],
  [/<c:chart[\s>]/, "Graphiques non extraits."],
  [/<dgm:relIds[\s>]/, "Diagrammes SmartArt non extraits."],
  [
    /<w:(?:ins|del|moveFrom|moveTo)[\s>]/,
    "Modifications suivies : le texte inséré est lu comme accepté, le texte supprimé est écarté.",
  ],
];

const LISTE = new Set(["ul", "ol"]);
/** Espaces réduites, une ligne par ligne non vide. */
const propre = (s: string) =>
  s
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
const uneLigne = (s: string) => propre(s).replace(/\n/g, " ");

/**
 * Document Word : Mammoth le lit, puis ce module transforme son HTML en passages. Ce HTML
 * n'atteint aucune page. Les titres ouvrent les sections, une liste garde une ligne par
 * élément, un tableau une ligne par rangée avec ses cellules séparées par « | », les notes de bas
 * de page se lisent à la fin sous « Notes ». Un lien garde son texte, sans son adresse. Les
 * commentaires et le texte supprimé n'entrent pas dans le texte.
 */
export async function extraireDocx(octets: Uint8Array, titre: string): Promise<Extraction> {
  const limite = Date.now() + BORNES.delaiMs;
  const a = ouvrirArchive(octets);
  // Mammoth décompresse avec JSZip, qui ne borne pas la décompression. Chaque entrée passe
  // d'abord ici, sous sa taille déclarée : JSZip produira ensuite les mêmes octets.
  for (const nom of a.noms) a.lire(nom);
  const xml = new TextDecoder().decode(a.lire("word/document.xml"));
  const avertissements = NON_EXTRAIT.filter(([re]) => re.test(xml)).map(([, m]) => m);
  if (/<w:comment[\s>]/.test(new TextDecoder().decode(a.lire("word/comments.xml")))) {
    avertissements.push("Commentaires ignorés : ils n'entrent pas dans le texte.");
  }

  const lues: Image[] = [];
  const ecartees: string[] = [];
  let liees = 0;
  let html: string;
  try {
    ({ value: html } = await mammoth.convertToHtml(
      { buffer: Buffer.from(octets.buffer, octets.byteOffset, octets.byteLength) },
      {
        // Une table de styles intégrée au document pourrait faire sortir les commentaires.
        includeEmbeddedStyleMap: false,
        externalFileAccess: false,
        styleMap: ["p[style-name='Title'] => h1:fresh"],
        convertImage: mammoth.images.imgElement(async (image) => {
          let lu: Uint8Array;
          try {
            lu = await image.readAsBuffer();
          } catch {
            // Une image liée à un fichier ou une adresse externe : Mammoth refuse de la lire.
            liees++;
            return { src: "" };
          }
          const im = imageOffice(lu);
          if (typeof im === "string") {
            ecartees.push(im);
            return { src: "" };
          }
          lues.push(im);
          return { src: `#${lues.length - 1}` };
        }),
      },
    ));
  } catch (e) {
    throw new Error(`DOCX illisible : ${(e as Error).message}`);
  }
  if (Date.now() > limite) {
    throw new Error(`DOCX : extraction au-delà de ${BORNES.delaiMs / 1000} secondes.`);
  }

  const parties: Partie[] = [];
  const images: Image[] = [];
  let section = titre;
  const ajouter = (texte: string) => texte && parties.push({ texte, section });
  // Les images entrent dans l'ordre du texte, avec leur section : Mammoth les lit en parallèle.
  const enLigne = (n: Noeud): string => {
    if (n.nodeType === 3) return n.nodeValue ?? "";
    if (n.nodeType !== 1) return "";
    const src = n.localName === "img" ? n.getAttribute("src") : null;
    if (src) images.push({ ...lues[Number(src.slice(1))], section });
    if (n.localName === "br") return "\n";
    if (/^#(?:foot|end)note-ref-/.test(n.getAttribute("href") ?? "")) return "";
    const texte = Array.from(n.childNodes).map(enLigne).join("");
    return n.localName === "p" ? `${texte}\n` : texte;
  };
  const lignesListe = (liste: Noeud): string[] =>
    enfants(liste).flatMap((li) => [
      uneLigne(
        Array.from(li.childNodes)
          .filter((c) => !LISTE.has(c.localName))
          .map(enLigne)
          .join(""),
      ),
      ...enfants(li)
        .filter((c) => LISTE.has(c.localName))
        .flatMap(lignesListe),
    ]);
  const lignesTable = (table: Noeud): string[] =>
    enfants(table)
      .flatMap((c) => (c.localName === "tr" ? [c] : enfants(c)))
      .map((tr) =>
        enfants(tr)
          .map((td) =>
            uneLigne(
              enfants(td)
                .map((c) => (c.localName === "table" ? lignesTable(c).join(" ") : enLigne(c)))
                .join(" "),
            ),
          )
          .join(" | "),
      )
      .filter((l) => l.replace(/[| ]/g, ""));

  const racine = analyserXml(`<racine>${html}</racine>`, "HTML de Mammoth");
  for (const el of enfants(racine.documentElement)) {
    if (/^h[1-6]$/.test(el.localName)) {
      const t = uneLigne(enLigne(el));
      if (t) section = t;
      ajouter(t);
    } else if (LISTE.has(el.localName)) {
      const notes = enfants(el).filter((li) =>
        /^(?:foot|end)note-/.test(li.getAttribute("id") ?? ""),
      );
      if (!notes.length) ajouter(lignesListe(el).filter(Boolean).join("\n"));
      else {
        // Mammoth numérote les appels de note dans l'ordre du texte, et liste les notes ainsi.
        section = "Notes";
        notes.forEach((li, i) => ajouter(`[${i + 1}] ${uneLigne(enLigne(li))}`));
      }
    } else if (el.localName === "table") ajouter(lignesTable(el).join("\n"));
    else if (el.localName !== "dl") ajouter(propre(enLigne(el)));
  }

  if (liees) avertissements.push(`Images liées à un fichier externe, non importées : ${liees}.`);
  return {
    parties: bornerTexte(parties),
    images,
    avertissements: [...avertissements, ...imagesEcartees(ecartees)],
  };
}
