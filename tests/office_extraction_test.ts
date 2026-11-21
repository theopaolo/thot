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
import { extrairePptx } from "../src/core/pptx.ts";
import {
  COURS_DOCX,
  DECK,
  docx,
  forme,
  image,
  MEDIAS,
  p,
  png,
  pptx,
  PPTX,
  t,
  W,
  zip,
} from "./office_outils.ts";

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
  const ext = extrairePptx(await pptx(DECK, { medias: MEDIAS }), true);
  assert(ext.parties.every((x) => !x.texte.includes("Corrigé") && !x.texte.includes("1907")));
  assertEquals(ext.notes, [
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

/** Le répertoire central d'un zip sans commentaire : sa taille et son adresse. */
const repertoire = (o: Uint8Array) => {
  const v = new DataView(o.buffer, o.byteOffset, o.byteLength);
  return { taille: v.getUint32(o.length - 10, true), debut: v.getUint32(o.length - 6, true) };
};

test("bornes : Mammoth lit les entrées contrôlées, pas un second répertoire central", async () => {
  // L'enregistrement de fin annonce le répertoire du document contrôlé. Celui du document caché
  // le suit : JSZip décale alors toutes les adresses et lit ce second répertoire.
  const vu = await docx(p(t("Texte contrôlé")));
  const cache = await docx(p(t("Texte caché")));
  const a = repertoire(vu);
  const b = repertoire(cache);
  const second = cache.slice(b.debut, b.debut + b.taille);
  const v = new DataView(second.buffer);
  for (let i = 0; i < second.length;) {
    v.setUint32(i + 42, v.getUint32(i + 42, true) + a.debut - b.taille, true);
    i += 46 + v.getUint16(i + 28, true) + v.getUint16(i + 30, true) + v.getUint16(i + 32, true);
  }
  const fin = vu.slice(-22);
  new DataView(fin.buffer).setUint32(16, a.debut + b.debut, true);
  const double = Buffer.concat([
    vu.subarray(0, a.debut),
    cache.subarray(0, b.debut),
    vu.subarray(a.debut, a.debut + a.taille),
    second,
    fin,
  ]);
  assertStringIncludes(
    new TextDecoder().decode(ouvrirArchive(double).lire("word/document.xml")),
    "Texte contrôlé",
  );
  assertEquals(
    (await extraireDocx(double, "Repli")).parties.map((x) => x.texte),
    ["Texte contrôlé"],
  );
});

test("bornes : tout nœud XML compte, quel que soit son nom, et les attributs aussi", async () => {
  const deck = (formes: string) => pptx([{ formes }]);
  for (const noeud of ["<_/>", "<é/>", "<!---->", "<?i?>"]) {
    const touffu = await deck(noeud.repeat(BORNES.elements));
    assertThrows(() => extrairePptx(touffu), Error, "éléments XML", noeud);
  }
  const attributs = Array.from({ length: 20 }, (_, i) => `a${i}=""`).join(" ");
  const pare = await deck(`<a:x ${attributs}/>`.repeat(BORNES.attributs / 20));
  assertThrows(() => extrairePptx(pare), Error, "attributs XML");
  // Un attribut sans valeur ne porte pas de « = » : l'analyse s'arrête au premier.
  const sansValeur = await deck(`<a:x b c d/>`);
  assertThrows(() => extrairePptx(sansValeur), Error, "XML illisible");
  await assertRejects(
    async () => extraireDocx(await docx(`<w:p b c d/>`), "Repli"),
    Error,
    "XML illisible dans « word/document.xml »",
  );
});
