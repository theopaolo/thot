import JSZip from "jszip";
import { test } from "vite-plus/test";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { assembler, coherent } from "../src/core/document.ts";
import { extraireDocx } from "../src/core/docx.ts";
import { BORNES, detecterOffice, ouvrirArchive } from "../src/core/ooxml.ts";
import { extrairePptx, notesPptx } from "../src/core/pptx.ts";
import { chercherFts } from "../src/core/recherche.ts";
import { tranche } from "../src/core/texte.ts";
import type { Db } from "../src/app/db.ts";
import {
  lireDocument,
  reextraire,
  revendiquer,
  revisionEnAttente,
  statuer,
  traiter,
} from "../src/app/ingestion.ts";
import { lireInstance } from "../src/app/instance.ts";
import { environnement, fauxModeles, session } from "./outils.ts";

// Fixtures synthétiques : chaque paquet Office est construit ici, avec JSZip.

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";

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
type Rel = [string, string, string, boolean?];
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

const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${REL}"
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

const t = (texte: string) => `<w:r><w:t xml:space="preserve">${texte}</w:t></w:r>`;
const p = (contenu: string, style = "") =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${contenu}</w:p>`;
const item = (texte: string, niveau: number) =>
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="${niveau}"/><w:numId w:val="1"/></w:numPr></w:pPr>${t(texte)}</w:p>`;
const cellule = (texte: string) => `<w:tc>${p(t(texte))}</w:tc>`;
const image = (attribut: string) =>
  `<w:r><w:drawing><wp:inline><wp:docPr id="1" name="i" descr="texte alternatif"/><a:graphic>
<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill>
<a:blip ${attribut}/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

const NUMEROTATION = `<w:numbering ${W}><w:abstractNum w:abstractNumId="0">
<w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/></w:lvl>
</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

const COURS_DOCX = () =>
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

test("DOCX : titres en sections, listes imbriquées, tableau, note, lien réduit à son texte", async () => {
  const ext = await extraireDocx(await COURS_DOCX(), "Repli");
  assertEquals(
    ext.parties.map((x) => [x.texte, x.section]),
    [
      ["La Casa Batlló", "La Casa Batlló"],
      ["Gaudí 🎨 refuse la ligne droite[1].", "La Casa Batlló"],
      ["Lire la suite", "La Casa Batlló"],
      ["Matériaux\ncéramique irisée\nfer forgé\nFormes", "La Casa Batlló"],
      ["Les détails", "Les détails"],
      ["Élément | Matière\nToit | écailles « vernies »", "Les détails"],
      ["Le toit rappelle un dragon.", "Les détails"],
      ["[1] Source : Gombrich.", "Notes"],
    ],
  );
  assert(
    ext.parties.every((x) => x.page === undefined),
    "pas de page inventée pour un Word",
  );
  const doc = assembler(ext.parties);
  assert(coherent(doc));
  assert(!doc.texte.includes("javascript") && !doc.texte.includes("texte alternatif"));
  assertEquals(ext.images.length, 1);
  assertEquals(ext.images[0].section, "Les détails");
  assertEquals(ext.images[0].mime, "image/png");
  assertEquals(ext.avertissements, []);
});

test("DOCX : texte supprimé et commentaires hors du texte, insertions lues comme acceptées", async () => {
  const ext = await extraireDocx(
    await docx(
      p(
        t("Le mouvement naît en ") +
          `<w:del w:id="1" w:author="A"><w:r><w:delText>1920</w:delText></w:r></w:del>` +
          `<w:ins w:id="2" w:author="A">${t("1907")}</w:ins>` +
          `<w:commentRangeStart w:id="0"/>${t(".")}<w:commentRangeEnd w:id="0"/>` +
          `<w:r><w:commentReference w:id="0"/></w:r>`,
      ),
      {
        rels: [["rId3", "comments", "comments.xml"]],
        parties: {
          "word/comments.xml": `<w:comments ${W}><w:comment w:id="0" w:author="A">${p(t("Corrigé : 1907, pas 1920."))}</w:comment></w:comments>`,
        },
      },
    ),
    "Repli",
  );
  const doc = assembler(ext.parties);
  assertEquals(doc.texte, "Le mouvement naît en 1907.");
  assertEquals(ext.avertissements, [
    "Modifications suivies : le texte inséré est lu comme accepté, le texte supprimé est écarté.",
    "Commentaires ignorés : ils n'entrent pas dans le texte.",
  ]);
});

test("DOCX : équation, zone de texte, objet et images refusées deviennent des avertissements", async () => {
  const ext = await extraireDocx(
    await docx(
      [
        p(t("Avant.") + `<m:oMath><m:r><m:t>x²</m:t></m:r></m:oMath>`),
        p(
          `<w:r><w:pict><v:shape><v:textbox><w:txbxContent>${p(t("Encadré"))}</w:txbxContent></v:textbox></v:shape></w:pict></w:r>`,
        ),
        p(
          `<w:r><w:object><o:OLEObject xmlns:o="urn:schemas-microsoft-com:office:office"/></w:object></w:r>`,
        ),
        // Une image liée à un fichier du serveur, une image géante, un EMF.
        p(image('r:link="rId6"') + image('r:embed="rId7"') + image('r:embed="rId8"')),
      ].join(""),
      {
        rels: [
          ["rId6", "image", "file:///etc/passwd", true],
          ["rId7", "image", "media/geante.png"],
          ["rId8", "image", "media/schema.emf"],
        ],
        parties: {
          "word/media/geante.png": png(10_000, 10_000),
          "word/media/schema.emf": new Uint8Array([1, 0, 0, 0, 0x6c, 0, 0, 0]),
        },
      },
    ),
    "Repli",
  );
  assertEquals(ext.images, []);
  const texte = assembler(ext.parties).texte;
  assertStringIncludes(texte, "Encadré");
  assert(!texte.includes("root:"));
  assertEquals(ext.avertissements, [
    "Équations non extraites.",
    "Zones de texte : leur texte peut manquer, ou se lire après le paragraphe qui les ancre.",
    "Objets intégrés non extraits.",
    "Images liées à un fichier externe, non importées : 1.",
    "Images non importées (1) : 10000 × 10000 pixels, 50 millions au maximum.",
    "Images non importées (1) : format que le navigateur n'affiche pas (EMF, WMF, TIFF, SVG…).",
  ]);
});

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
const photo = (id: string) => `<p:pic><p:blipFill><a:blip r:embed="${id}"/></p:blipFill></p:pic>`;

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
const DECK: Diapo[] = [
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
const MEDIAS = { "facade.png": png(4, 3, 1), "plan.png": png(5, 5, 2) };

test("PPTX : diapositives dans l'ordre de la présentation, titres, groupes, tableau, images", async () => {
  // La liste de la présentation met la quatrième diapositive en premier.
  const ext = extrairePptx(await pptx(DECK, { medias: MEDIAS, ordre: [3, 0, 1, 2] }));
  assertEquals(
    ext.parties.map((x) => [x.page, x.section, x.texte]),
    [
      [1, "Diapositive 1", "Diapositive 1"],
      [2, "Diapositive 2 : L'Art nouveau", "Diapositive 2 : L'Art nouveau"],
      [2, "Diapositive 2 : L'Art nouveau", "Introduction au modernisme"],
      [3, "Diapositive 3 : Matériaux", "Diapositive 3 : Matériaux"],
      [3, "Diapositive 3 : Matériaux", "Céramique\nFer forgé"],
      [3, "Diapositive 3 : Matériaux", "Verre"],
      [3, "Diapositive 3 : Matériaux", "Œuvre | Lieu\nCasa Batlló | Barcelone"],
    ],
  );
  assert(coherent(assembler(ext.parties)));
  // Le pied de page répété et la diapositive masquée n'entrent pas dans le texte.
  const texte = assembler(ext.parties).texte;
  assert(!texte.includes("Lycée Gaudí") && !texte.includes("Texte retiré"));
  // Une image répétée n'entre qu'une fois, avec la première diapositive qui la montre.
  assertEquals(
    ext.images.map((i) => [i.section, i.octets[39]]),
    [
      ["Diapositive 1", 1],
      ["Diapositive 1", 2],
    ],
  );
  assertEquals(ext.avertissements, [
    "Diapositives masquées, exclues du texte : diapositive 4.",
    "Graphiques non extraits : diapositive 1.",
    "Diagrammes SmartArt non extraits : diapositive 1.",
  ]);
});

test("PPTX : des zones de texte placées se lisent de haut en bas puis de gauche à droite", async () => {
  // L'ordre du fichier est celui de superposition : « 1. » a été ajouté en dernier.
  const place = (x: number, y: number, texte: string) =>
    forme("", texte).replace(
      "</p:nvSpPr>",
      `</p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/></a:xfrm></p:spPr>`,
    );
  const ext = extrairePptx(
    await pptx([
      {
        formes:
          place(4_000_000, 2_000_000, "2. Découvrir") +
          place(8_000_000, 2_100_000, "3. Auditer") +
          place(500_000, 2_050_000, "1. Comprendre") +
          place(500_000, 5_000_000, "Conclusion"),
      },
    ]),
  );
  assertEquals(
    ext.parties.slice(1).map((x) => x.texte),
    ["1. Comprendre", "2. Découvrir", "3. Auditer", "Conclusion"],
  );
});

test("PPTX : une diapositive masquée s'inclut sur demande, marquée comme telle", async () => {
  const ext = extrairePptx(await pptx(DECK, { medias: MEDIAS }), true);
  assertEquals(
    ext.parties.filter((x) => x.page === 3).map((x) => x.texte),
    ["Diapositive 3 (masquée) : Brouillon", "Texte retiré du cours"],
  );
  assertEquals(
    ext.avertissements[0],
    "Diapositives masquées, incluses dans le texte : diapositive 3.",
  );
});

test("PPTX : les notes de l'orateur restent hors de l'extraction, lues à part pour la relecture", async () => {
  const octets = await pptx(DECK, { medias: MEDIAS });
  const ext = extrairePptx(octets, true);
  assert(ext.parties.every((x) => !x.texte.includes("Corrigé") && !x.texte.includes("1907")));
  assertEquals(notesPptx(octets), [
    { diapositive: 1, texte: "Corrigé de l'évaluation : la réponse est 1907." },
  ]);
});

test("PPTX : équation et vidéo signalées, image absente ou refusée nommée", async () => {
  const ext = extrairePptx(
    await pptx([
      {
        formes:
          forme("title", "Formule") +
          `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
<mc:Choice Requires="a14">${forme("", "")}<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"/></mc:Choice>
<mc:Fallback>${forme("", "E = mc²")}</mc:Fallback></mc:AlternateContent>` +
          `<p:pic><p:nvPicPr><p:nvPr><a:videoFile r:link="rIdV"/></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rIdX"/></p:blipFill></p:pic>` +
          "<p:timing/>",
        rels: [["rIdX", "image", "../media/absente.png"]],
      },
    ]),
  );
  assertEquals(
    ext.parties.map((x) => x.texte),
    ["Diapositive 1 : Formule", "E = mc²"],
  );
  assertEquals(ext.avertissements, [
    "Équations non extraites : diapositive 1.",
    "Vidéos et sons non extraits : diapositive 1.",
    "Animations ignorées, le texte se lit en entier : diapositive 1.",
    "Images non importées (1) : image absente de l'archive, diapositive 1.",
  ]);
});

// ------------------------------------------------------------ Détection et bornes

/** Réécrit la taille décompressée qu'annonce le répertoire central pour `nom`. */
function declarer(octets: Uint8Array, nom: string, taille: number) {
  const v = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  for (let i = 0; i < octets.length - 46; i++) {
    if (v.getUint32(i, true) !== 0x02014b50) continue;
    const n = v.getUint16(i + 28, true);
    if (new TextDecoder().decode(octets.subarray(i + 46, i + 46 + n)) === nom) {
      v.setUint32(i + 24, taille, true);
      return octets;
    }
  }
  throw new Error(`${nom} absent`);
}

test("détection : Word et PowerPoint au contenu, refus motivés des autres paquets", async () => {
  assertEquals(detecterOffice(await COURS_DOCX()), { format: "docx" });
  assertEquals(detecterOffice(await pptx(DECK, { medias: MEDIAS })), { format: "pptx" });
  assertEquals(detecterOffice(new TextEncoder().encode("<html>")), undefined);
  // Un cours Markdown qui commence par « PK » reste du Markdown.
  assertEquals(detecterOffice(new TextEncoder().encode("PKI : clés publiques\n")), undefined);
  const erreur = async (o: Uint8Array | Promise<Uint8Array>) => {
    const r = detecterOffice(await o);
    return r && "erreur" in r ? r.erreur : undefined;
  };
  assertStringIncludes(
    (await erreur(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])))!,
    "chiffré ou ancien format",
  );
  assertStringIncludes(
    (await erreur(
      docx(p(t("x")), { type: "application/vnd.ms-word.document.macroEnabled.main+xml" }),
    ))!,
    "macros",
  );
  assertStringIncludes(
    (await erreur(pptx(DECK, { medias: { "../vbaProject.bin": new Uint8Array(4) } })))!,
    "macros",
  );
  // Un tableur, un zip quelconque, une extension renommée : le contenu décide.
  assertStringIncludes(
    (await erreur(zip({ "xl/workbook.xml": "<workbook/>" })))!,
    "non prise en charge",
  );
  assertStringIncludes((await erreur(docx(p(t("x")), { type: PPTX })))!, "non prise en charge");
});

test("bornes : trop d'entrées, tailles annoncées au-delà des bornes, archive cassée", async () => {
  const nombreuses: Record<string, string> = {};
  for (let i = 0; i <= BORNES.entrees; i++) nombreuses[`f${i}`] = "";
  const trop = await zip(nombreuses);
  assertThrows(() => ouvrirArchive(trop), Error, `${BORNES.entrees + 1} entrées`);

  const xml = declarer(await COURS_DOCX(), "word/document.xml", BORNES.xml + 1);
  assertThrows(() => ouvrirArchive(xml), Error, "20 Mo au maximum");
  const image = declarer(await COURS_DOCX(), "word/media/toit.png", BORNES.entree + 1);
  assertThrows(() => ouvrirArchive(image), Error, "50 Mo au maximum");
  const total = await zip({ a: "", b: "", c: "" });
  for (const nom of ["a", "b", "c"]) declarer(total, nom, 40 * 1024 * 1024);
  assertThrows(() => ouvrirArchive(total), Error, "plus de 100 Mo");
  // Au dépôt, la détection lit le répertoire central : la bombe annoncée est refusée.
  assertStringIncludes((detecterOffice(total) as { erreur: string }).erreur, "plus de 100 Mo");

  const tronquee = (await COURS_DOCX()).slice(0, -30);
  assertStringIncludes(
    (detecterOffice(tronquee) as { erreur: string }).erreur,
    "Archive corrompue",
  );
  const z = new JSZip();
  z.file("a.xml", "<texte>intact</texte>", { compression: "STORE" });
  const alteree = await z.generateAsync({ type: "uint8array" });
  alteree[alteree.indexOf(0x69, 40)] = 0x49;
  assertThrows(() => ouvrirArchive(alteree).lire("a.xml"), Error, "somme de contrôle");
});

test("bornes : une bombe qui ment sur sa taille s'arrête à la taille déclarée", async () => {
  // 30 Mo d'espaces se compressent en quelques dizaines de Ko, annoncés comme 1 Ko.
  const bombe = declarer(
    await docx(p(t("x")) + " ".repeat(30 * 1024 * 1024)),
    "word/document.xml",
    1024,
  );
  assertEquals(detecterOffice(bombe), { format: "docx" });
  assertThrows(
    () => ouvrirArchive(bombe).lire("word/document.xml"),
    Error,
    "dépasse sa taille déclarée",
  );
  await assertRejects(() => extraireDocx(bombe, "Repli"), Error, "dépasse sa taille déclarée");
});

test("bornes : trop d'éléments XML, texte extrait trop long", async () => {
  const touffu = await docx("<w:p/>".repeat(BORNES.elements));
  await assertRejects(() => extraireDocx(touffu, "Repli"), Error, "éléments XML");
  const bavard = await pptx([{ formes: forme("", "a".repeat(BORNES.texte + 1)) }]);
  assertThrows(() => extrairePptx(bavard), Error, "Texte extrait au-delà de 10 Mo");
});

// ------------------------------------------------------------ Dépôt, relecture et accès

const deposer = (
  requete: (chemin: string, init?: RequestInit) => Response | Promise<Response>,
  octets: Uint8Array,
  nom: string,
) => {
  const f = new FormData();
  f.append("type_document", "cours");
  f.append("audience", "eleves");
  f.append("reponses", "1");
  f.append("fichier", new File([octets as Uint8Array<ArrayBuffer>], nom));
  return requete("/prof/depot", { method: "POST", body: f });
};
const sourceDeposee = (db: Db) =>
  db.prepare("SELECT id, format, titre FROM sources").get() as {
    id: string;
    format: string;
    titre: string;
  };

test("DOCX : dépôt, offsets exacts, image dans sa section, original téléchargé, réextraction identique", async () => {
  const { db } = await environnement();
  const { modeles } = fauxModeles();
  const { requete } = await session(db, modeles, "enseignant");
  assertEquals((await deposer(requete, await COURS_DOCX(), "Casa Batlló.docx")).status, 200);
  const s = sourceDeposee(db);
  assertEquals([s.format, s.titre], ["docx", "Casa Batlló"]);
  await traiter(db, revendiquer(db)!, modeles);
  const doc = lireDocument(s.id, 1);
  assert(coherent(doc));
  for (const b of doc.blocs) assertEquals(tranche(doc.texte, b.debut, b.fin), b.texte);
  assertEquals(db.prepare("SELECT section FROM images").get()!.section, "Les détails");
  const original = await requete(`/prof/sources/${s.id}/original`);
  assertEquals(
    original.headers.get("content-type"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assertStringIncludes(original.headers.get("content-disposition")!, "attachment");
  assertEquals(await reextraire(db, s.id), "identique");
});

test("dépôt : un fichier Office chiffré, à macros ou cassé est refusé avec sa raison", async () => {
  const { db } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  const docm = await docx(p(t("x")), {
    type: "application/vnd.ms-word.document.macroEnabled.main+xml",
  });
  for (const [octets, nom, raison] of [
    [cfb, "protege.docx", "chiffré ou ancien format"],
    [docm, "macro.docx", "macros"],
    [(await COURS_DOCX()).slice(0, -30), "casse.docx", "Archive corrompue"],
  ] as const) {
    const r = await deposer(requete, octets, nom);
    assertEquals(r.status, 400, nom);
    assertStringIncludes(await r.text(), raison);
  }
  assertEquals(db.prepare("SELECT count(*) n FROM sources").get()!.n, 0);
});

test("PPTX : une note de l'orateur qui porte le corrigé n'atteint ni l'index ni l'élève", async () => {
  const { db } = await environnement();
  const { modeles } = fauxModeles({ legende: "Façade ondulée" });
  const auteur = await session(db, modeles, "enseignant");
  const deck = await pptx(DECK, { medias: MEDIAS });
  assertEquals((await deposer(auteur.requete, deck, "Art nouveau.pptx")).status, 200);
  const s = sourceDeposee(db);
  assertEquals(s.format, "pptx");
  await traiter(db, revendiquer(db)!, modeles);
  statuer(db, s.id, "certifiee", "Test");

  const doc = lireDocument(s.id, 1);
  assert(coherent(doc));
  assert(!doc.texte.includes("Corrigé") && !doc.texte.includes("1907"));
  const fuites = db
    .prepare(
      "SELECT count(*) n FROM chunks WHERE texte LIKE '%1907%' OR rappel LIKE '%1907%' OR preuve LIKE '%1907%'",
    )
    .get()!.n;
  assertEquals(fuites, 0);
  const schoolId = lireInstance(db).school_id;
  assertEquals(chercherFts(db, "corrigé évaluation 1907", { lecteur: null, schoolId }), []);
  assert(chercherFts(db, "céramique fer forgé", { lecteur: null, schoolId }).length > 0);
  // La légende accompagne le passage de sa diapositive, pas le premier du document.
  const chunks = db.prepare("SELECT titre, rappel FROM chunks ORDER BY n").all() as {
    titre: string;
    rappel: string;
  }[];
  assertEquals(
    chunks.filter((c) => c.rappel.includes("Façade ondulée")).map((c) => c.titre),
    ["Art nouveau : Diapositive 2 : Matériaux", "Art nouveau : Diapositive 4"],
  );

  assertEquals(await reextraire(db, s.id), "identique");

  // L'élève lit les diapositives, sans les notes ni l'original. Une citation ouvre sa diapositive.
  const eleve = await session(db, modeles, "eleve");
  const verre = doc.blocs.find((b) => b.texte === "Verre")!;
  const lecture = await (
    await eleve.requete(`/eleve/sources/${s.id}?revision=1&debut=${verre.debut}&fin=${verre.fin}`)
  ).text();
  const titre = lecture.indexOf("Diapositive 2 : Matériaux");
  assert(titre >= 0 && titre < lecture.indexOf('<mark id="passage">Verre</mark>'));
  assert(!lecture.includes("Corrigé"));
  assertEquals((await eleve.requete(`/prof/sources/${s.id}/original`)).status, 403);

  // L'auteur relit les notes. Un collègue qui lit la source sans la relire ne les voit pas.
  const relecture = await (await auteur.requete(`/prof/sources/${s.id}`)).text();
  assertStringIncludes(relecture, "Notes de l'orateur");
  assertStringIncludes(relecture, "la réponse est 1907.");
  assertEquals((await auteur.requete(`/prof/sources/${s.id}/original`)).status, 200);
  const collegue = await session(db, modeles, "enseignant", false);
  const vue = await collegue.requete(`/prof/sources/${s.id}`);
  assertEquals(vue.status, 200);
  assert(!(await vue.text()).includes("1907"));
  assertEquals((await collegue.requete(`/prof/sources/${s.id}/original`)).status, 403);
});

test("PPTX : inclure les diapositives masquées relance l'extraction en une version à relire", async () => {
  const { db } = await environnement();
  const { modeles } = fauxModeles();
  const { requete } = await session(db, modeles, "enseignant");
  await deposer(requete, await pptx(DECK, { medias: MEDIAS }), "deck.pptx");
  const s = sourceDeposee(db);
  await traiter(db, revendiquer(db)!, modeles);
  statuer(db, s.id, "certifiee", "Test");
  assertStringIncludes(await (await requete(`/prof/sources/${s.id}`)).text(), "Les inclure");

  const inclure = (valeur: string) =>
    requete(`/prof/sources/${s.id}/diapositives-masquees`, {
      method: "POST",
      body: new URLSearchParams({ inclure: valeur }),
    });
  assertEquals((await inclure("1")).status, 303);
  // Une seconde demande pendant l'extraction est refusée.
  assertEquals((await inclure("0")).status, 409);
  await traiter(db, revendiquer(db)!, modeles);

  assertEquals(revisionEnAttente(db, s.id)?.n, 2);
  assertStringIncludes(lireDocument(s.id, 2).texte, "Diapositive 3 (masquée) : Brouillon");
  assert(!lireDocument(s.id, 1).texte.includes("Brouillon"), "la version servie ne change pas");
  assertStringIncludes(await (await requete(`/prof/sources/${s.id}`)).text(), "Les exclure");
});
