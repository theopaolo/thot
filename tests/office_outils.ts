import JSZip from "jszip";

// Fixtures synthétiques : chaque paquet Office est construit ici, avec JSZip.

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
export const PPTX =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";

export async function zip(fichiers: Record<string, string | Uint8Array>) {
  const z = new JSZip();
  for (const [nom, contenu] of Object.entries(fichiers)) z.file(nom, contenu);
  return z.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

const types = (principal: string, type: string) =>
  `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>
<Override PartName="/${principal}" ContentType="${type}"/></Types>`;

/** `[id, type, cible]`, et `true` en quatrième pour une cible externe. */
export type Rel = [string, string, string, boolean?];
const rels = (liste: Rel[]) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${liste
    .map(
      ([id, type, cible, externe]) =>
        `<Relationship Id="${id}" Type="${REL}/${type}" Target="${cible}"${externe ? ' TargetMode="External"' : ""}/>`,
    )
    .join("")}</Relationships>`;

/** Un PNG réduit à son en-tête : signature et dimensions suffisent à l'extracteur. */
export const png = (largeur = 2, hauteur = 2, n = 0) => {
  const o = new Uint8Array(40);
  o.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(o.buffer);
  v.setUint32(16, largeur);
  v.setUint32(20, hauteur);
  o[39] = n;
  return o;
};

export const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${REL}"
xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"
xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
xmlns:v="urn:schemas-microsoft-com:vml"`;

export const docx = (
  corps: string,
  o: { rels?: Rel[]; parties?: Record<string, string | Uint8Array>; type?: string } = {},
) =>
  zip({
    "[Content_Types].xml": types("word/document.xml", o.type ?? DOCX),
    "_rels/.rels": rels([["rId1", "officeDocument", "word/document.xml"]]),
    "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body>${corps}</w:body></w:document>`,
    "word/_rels/document.xml.rels": rels(o.rels ?? []),
    ...o.parties,
  });

export const t = (texte: string) => `<w:r><w:t xml:space="preserve">${texte}</w:t></w:r>`;
export const p = (contenu: string, style = "") =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${contenu}</w:p>`;
const item = (texte: string, niveau: number) =>
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="${niveau}"/><w:numId w:val="1"/></w:numPr></w:pPr>${t(texte)}</w:p>`;
const cellule = (texte: string) => `<w:tc>${p(t(texte))}</w:tc>`;
export const image = (attribut: string) =>
  `<w:r><w:drawing><wp:inline><wp:docPr id="1" name="i" descr="texte alternatif"/><a:graphic>
<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill>
<a:blip ${attribut}/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

const NUMEROTATION = `<w:numbering ${W}><w:abstractNum w:abstractNumId="0">
<w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/></w:lvl>
</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

export const COURS_DOCX = () =>
  docx(
    [
      p(t("La Casa Batlló"), "Heading1"),
      p(
        t("Gaudí 🎨 refuse la ligne droite") +
          `<w:r><w:footnoteReference w:id="1"/></w:r>` +
          t("."),
      ),
      p(`<w:hyperlink r:id="rId9">${t("Lire la suite")}</w:hyperlink>`),
      item("Matériaux", 0),
      item("céramique irisée", 1),
      item("fer forgé", 1),
      item("Formes", 0),
      p(t("Les détails"), "Heading2"),
      `<w:tbl><w:tr>${cellule("Élément")}${cellule("Matière")}</w:tr><w:tr>${cellule("Toit")}${cellule("écailles « vernies »")}</w:tr></w:tbl>`,
      p(image('r:embed="rId5"')),
      p(t("Le toit rappelle un dragon.")),
    ].join(""),
    {
      rels: [
        ["rId9", "hyperlink", "javascript:alert(1)", true],
        ["rId5", "image", "media/toit.png"],
      ],
      parties: {
        "word/numbering.xml": NUMEROTATION,
        "word/footnotes.xml": `<w:footnotes ${W}><w:footnote w:id="1">${p(t("Source : Gombrich."))}</w:footnote></w:footnotes>`,
        "word/media/toit.png": png(),
      },
    },
  );

// ------------------------------------------------------------ PowerPoint

const P = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${REL}"`;

const corps = (...paragraphes: string[]) =>
  `<p:txBody>${paragraphes.map((x) => `<a:p><a:r><a:t>${x}</a:t></a:r></a:p>`).join("")}</p:txBody>`;
export const forme = (type: string, ...paragraphes: string[]) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="1" name="f"/><p:cNvSpPr/><p:nvPr>${
    type ? `<p:ph type="${type}"/>` : ""
  }</p:nvPr></p:nvSpPr>${corps(...paragraphes)}</p:sp>`;
const tableau = (lignes: string[][]) =>
  `<p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>${lignes
    .map((l) => `<a:tr>${l.map((c) => `<a:tc>${corps(c)}</a:tc>`).join("")}</a:tr>`)
    .join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
export const photo = (id: string) =>
  `<p:pic><p:blipFill><a:blip r:embed="${id}"/></p:blipFill></p:pic>`;

export type Diapo = { formes: string; masquee?: boolean; notes?: string; rels?: Rel[] };

/** Une présentation. `ordre` donne l'ordre de `p:sldIdLst` en indices de `diapos`. */
export const pptx = (
  diapos: Diapo[],
  o: { medias?: Record<string, Uint8Array>; ordre?: number[]; type?: string } = {},
) => {
  const ordre = o.ordre ?? diapos.map((_, i) => i);
  const fichiers: Record<string, string | Uint8Array> = {
    "[Content_Types].xml": types("ppt/presentation.xml", o.type ?? PPTX),
    "_rels/.rels": rels([["rId1", "officeDocument", "ppt/presentation.xml"]]),
    "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst>${ordre
      .map((i) => `<p:sldId id="${256 + i}" r:id="rIdS${i}"/>`)
      .join("")}</p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": rels(
      diapos.map((_, i): Rel => [`rIdS${i}`, "slide", `slides/slide${i + 1}.xml`]),
    ),
  };
  for (const [nom, octets] of Object.entries(o.medias ?? {})) fichiers[`ppt/media/${nom}`] = octets;
  diapos.forEach((d, i) => {
    fichiers[`ppt/slides/slide${i + 1}.xml`] =
      `<?xml version="1.0"?><p:sld ${P}${d.masquee ? ' show="0"' : ""}><p:cSld><p:spTree>${d.formes}</p:spTree></p:cSld></p:sld>`;
    const liste: Rel[] = [...(d.rels ?? [])];
    if (d.notes) {
      liste.push(["rIdN", "notesSlide", `../notesSlides/notesSlide${i + 1}.xml`]);
      fichiers[`ppt/notesSlides/notesSlide${i + 1}.xml`] =
        `<?xml version="1.0"?><p:notes ${P}><p:cSld><p:spTree>${forme("sldImg")}${forme("body", d.notes)}${forme("sldNum", "12")}</p:spTree></p:cSld></p:notes>`;
    }
    fichiers[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = rels(liste);
  });
  return zip(fichiers);
};

const PIED = forme("ftr", "Lycée Gaudí, 2026") + forme("sldNum", "3");
export const DECK: Diapo[] = [
  {
    formes: forme("", "Introduction au modernisme") + forme("ctrTitle", "L'Art nouveau") + PIED,
    notes: "Corrigé de l'évaluation : la réponse est 1907.",
  },
  {
    formes:
      forme("title", "Matériaux") +
      `<p:grpSp><p:nvGrpSpPr/><p:grpSpPr/>${forme("", "Céramique", "Fer forgé")}<p:grpSp>${forme("", "Verre")}</p:grpSp></p:grpSp>` +
      tableau([
        ["Œuvre", "Lieu"],
        ["Casa Batlló", "Barcelone"],
      ]) +
      photo("rIdI") +
      PIED,
    rels: [["rIdI", "image", "../media/facade.png"]],
  },
  { formes: forme("title", "Brouillon") + forme("", "Texte retiré du cours"), masquee: true },
  {
    formes:
      photo("rIdI") +
      photo("rIdJ") +
      `<p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></p:graphicFrame>` +
      `<p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"/></a:graphic></p:graphicFrame>`,
    rels: [
      ["rIdI", "image", "../media/facade.png"],
      ["rIdJ", "image", "../media/plan.png"],
    ],
  },
];
export const MEDIAS = { "facade.png": png(4, 3, 1), "plan.png": png(5, 5, 2) };
