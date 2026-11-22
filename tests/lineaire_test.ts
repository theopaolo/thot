import JSZip from "jszip";
import { test } from "vite-plus/test";
import { assert } from "@std/assert";
import { extraireHtml, extrairePearltrees, rubriquesSommaire } from "../src/core/html.ts";
import { extraireMarkdown, lireFrontMatter } from "../src/core/markdown.ts";
import { detecterOffice } from "../src/core/ooxml.ts";

// Le pire cas de chaque motif qui lit un fichier déposé : une ouverture répétée que rien ne
// ferme, ou des blancs qu'un motif rend un à un. Un motif qui repart de chaque ouverture met un
// temps qui croît comme le carré de la taille, et dépasse la seconde dès 64 Ko.

const MO = 1024 * 1024;
const repete = (s: string, taille = MO) => s.repeat(Math.ceil(taille / s.length));

function enMoinsDuneSeconde(lire: () => unknown) {
  const debut = performance.now();
  lire();
  const duree = performance.now() - debut;
  assert(duree < 1000, `${Math.round(duree)} ms`);
}

const markdown = (s: string) => extraireMarkdown(s, "repli");
const html = (s: string) => extraireHtml(s, "repli");
const pearltrees = (s: string) => extrairePearltrees(s, "repli");

const CAS: [string, (s: string) => unknown, string][] = [
  [
    "front matter : `title:`, des espaces, un mot",
    lireFrontMatter,
    `---\ntitle: a${repete(" ")}b\n---\n`,
  ],
  [
    "front matter : `order:`, des espaces, un mot",
    lireFrontMatter,
    `---\norder: 1${repete(" ")}b\n---\n`,
  ],
  ["front matter jamais fermé", lireFrontMatter, `---\n${repete("a\n")}`],
  ["Markdown : `![` sans `]`", markdown, repete("![")],
  ["Markdown : `![a](` sans `)`", markdown, repete("![a](")],
  ["Markdown : `![a](` puis des espaces", markdown, `![a](${repete(" ")}`],
  ["Markdown : `[` sans `]`", markdown, repete("[")],
  ["Markdown : `[a](` sans `)`", markdown, repete("[a](")],
  ["Markdown : `[a ` sans `]`, lien et référence", markdown, repete("[a ")],
  ["Markdown : `<!--` sans `-->`", markdown, repete("<!--")],
  ["Markdown : `<!--` sans `-->` avant un U+2028", markdown, `${repete("<!--")} `],
  ["Markdown : `<a ` sans `>`", markdown, repete("<a ")],
  ["Markdown : `**` sans fermeture", markdown, repete("**a ")],
  ["Markdown : `__` sans fermeture", markdown, repete("__a ")],
  ["Markdown : `**` et `__` mêlés sans fermeture", markdown, repete("**a __b ")],
  ["Markdown : `~~` sans fermeture", markdown, repete("~~a ")],
  ["Markdown : `*` sans fermeture", markdown, repete("*a ")],
  ["Markdown : `_` sans fermeture", markdown, repete(" _a")],
  ["Markdown : titre, des espaces, un mot", markdown, `# a${repete(" ")}b`],
  ["Markdown : titre fait de `#`", markdown, `# ${repete("#")}b`],
  [
    "Markdown : puce, des espaces, une ligne coupée par U+2028",
    markdown,
    `- ${repete(" ", MO / 2)}${repete("a", MO / 2)} b`,
  ],
  ["HTML : `<!--` sans `-->`", html, repete("<!--")],
  ["HTML : rangées de tableau", html, `<table>${repete("<tr><td>a</td></tr>")}</table>`],
  [
    "HTML : rangées vides après un long texte",
    html,
    `<table><tr><td>${repete("a ", MO / 2)}</td></tr>${repete("<tr></tr>", MO / 2)}</table>`,
  ],
  [
    "HTML : rangées de cellules vides après un long texte",
    html,
    `<table><tr><td>${repete("a ", MO / 2)}</td></tr>${repete("<tr><td></td><td></td></tr>", MO / 2)}</table>`,
  ],
  [
    "Sommaire Pearltrees : rubriques sans fermeture",
    rubriquesSommaire,
    repete('<div class="pearl">'),
  ],
  ["HTML : `<title>` sans `</title>`", html, repete("<title>")],
  ["HTML : `<title ` sans `>`", html, repete("<title ")],
  ["HTML : `<main>` sans `</main>`", html, repete("<main>")],
  ["HTML : `<main ` sans `>`", html, repete("<main ")],
  ["HTML : `<nav>` sans `</nav>`", html, repete("<nav>")],
  ["HTML : éléments écartés mêlés, sans fermeture", html, repete("<svg><nav><script><style>")],
  ["HTML : `<h1>` sans `</h1>`", html, repete("<h1>")],
  ["HTML : `<h1 ` sans `>`", html, repete("<h1 ")],
  ["HTML : `<a ` sans `>`", html, repete("<a ")],
  ["HTML : `<! ` sans `>`", html, repete("<! ")],
  ["HTML : `</pre ` sans `>`", html, `<pre>${repete("</pre ")}`],
  ['HTML : `<img src="` sans `>`', html, repete('<img src="')],
  ["HTML : `<` dans un titre", html, `<h1>${repete("<")}</h1>`],
  ["HTML : `<` dans un `<pre>`", html, `<pre>${repete("<")}</pre>`],
  ["Pearltrees : `<h1` sans `>`", pearltrees, repete("<h1")],
  ["Pearltrees : `<h1>` sans `</h1>`", pearltrees, repete("<h1>")],
  ["Pearltrees : `<title>` sans `</title>`", pearltrees, repete("<title>")],
  ["Pearltrees : `<head` sans `</head>`", pearltrees, repete("<head")],
  ["Pearltrees : `<script` sans `</script>`", pearltrees, repete("<script")],
  ["Pearltrees : scripts, styles et cadres mêlés", pearltrees, repete("<style<script<iframe")],
  ["Pearltrees : `<div ` sans `>`", pearltrees, repete("<div ")],
  ["Pearltrees : `<div ` répété avant un seul `>`", pearltrees, `${repete("<div ")}>`],
  ["Pearltrees : bandeau de médailles sans lien", pearltrees, repete('<div class="medals">')],
  [
    'Pearltrees : `class="medals"` répété dans une balise',
    pearltrees,
    `<div ${repete('class="medals" ')}>`,
  ],
  ["Pearltrees : `<img ` sans `>`", pearltrees, repete("<img ")],
  ["Pearltrees : `<` sans `>`", pearltrees, repete("<")],
  ["Pearltrees : `<h2 ` sans `>`", pearltrees, repete("<h2 ")],
  [
    "Pearltrees : image `data:`, des espaces, pas de guillemet",
    pearltrees,
    `<img src="data:image/png;base64,${repete(" ")}!">`,
  ],
];

for (const [nom, lire, entree] of CAS) {
  test(`${nom} : 1 Mo en moins d'une seconde`, () => enMoinsDuneSeconde(() => lire(entree)));
}

// Chaque ligne ou cellule passe par tous les motifs du Markdown : 1 Mo de lignes de deux
// caractères prend déjà plus d'une seconde sur une machine d'intégration, en temps linéaire.
// À 128 Ko, la lecture linéaire tient en un quart de seconde et un assemblage qui relit son bloc
// à chaque ligne en prendrait dix.
const KO_128 = MO / 8;
const CAS_PAR_LIGNE: [string, string][] = [
  ["paragraphe de lignes courtes", repete("a\n", KO_128)],
  ["liste d'entrées courtes", repete("- a\n", KO_128)],
  ["rangée de tableau aux nombreuses cellules", `|${repete("a|", KO_128)}`],
];
for (const [nom, entree] of CAS_PAR_LIGNE) {
  test(`Markdown : ${nom} : 128 Ko en moins d'une seconde`, () =>
    enMoinsDuneSeconde(() => markdown(entree)));
}

test("Office : `<Override ` sans `>` dans la liste des types, 1 Mo en moins d'une seconde", async () => {
  const z = new JSZip();
  z.file("[Content_Types].xml", repete("<Override "));
  z.file("word/document.xml", "<a/>");
  const archive = await z.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  enMoinsDuneSeconde(() => detecterOffice(archive));
});
