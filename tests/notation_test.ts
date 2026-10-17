import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import katex from "katex";
import { formules, optionsKatex, type Schema, texteMermaid } from "../src/core/notation.ts";

test("le texte Mermaid d'un schéma ne laisse passer aucune syntaxe venue des noms", () => {
  const pieges = [
    "<script>alert(1)</script>",
    '%%{init: {"securityLevel": "loose"}}%%',
    'A"] --> B["x',
    'click n0 href "javascript:alert(1)"',
    "A\nclick n0 call alert()",
    "$$\\href{javascript:alert(1)}{x}$$",
    "`**gras**`",
    "ﬂ°°60¶ß",
  ];
  const schema: Schema = {
    type: "schema",
    noeuds: [
      ...pieges.map((titre) => ({ titre })),
      { titre: "Éléphant 2", affirmation: 0 },
      { titre: "x < 0 & y ≥ 0, −5 °C, C#, 20 %" },
    ],
    relations: [
      { de: 0, vers: 1, lien: "cause", affirmation: 1 },
      { de: 1, vers: 2, lien: "suite", affirmation: 2 },
      { de: 2, vers: 8, lien: "theme", affirmation: 3 },
    ],
  };
  // Le `;` sépare les lignes même quand le flux SSE remplace les sauts de ligne.
  const lignes = texteMermaid(schema).split(";\n");
  assertEquals(lignes[0], "flowchart TD");
  // Chaque ligne suit la grammaire écrite par le code, avec un nom jamais vide.
  const nom = String.raw`"[^"\n]+"`;
  const forme = new RegExp(`^(?:n\\d\\[${nom}\\]|n\\d (?:-->|==>|-\\.-)\\|${nom}\\| n\\d);?$`, "u");
  for (const ligne of lignes.slice(1)) assert(forme.test(ligne), ligne);
  assertEquals(lignes.length, 1 + 10 + 3);
  assertEquals(lignes[9], 'n8["Éléphant 2 [1]"]');
  assertEquals(lignes[10], 'n9["x #lt; 0 #amp; y ≥ 0, −5 °C, C#, 20 %"]');
  assertEquals(lignes[11], 'n0 -->|"entraîne [2]"| n1');
  assertEquals(lignes[12], 'n1 ==>|"précède [3]"| n2');
  assertEquals(lignes[13], 'n2 -.-|"est lié à [4]"| n8;');
  // Hors des entités que Mermaid décode, un nom n'a aucun signe de sa syntaxe.
  const noms = [...lignes.join("\n").matchAll(/"([^"]*)"/g)]
    .map((m) => m[1].replace(/#(?:lt|gt|amp);/g, ""))
    .join("");
  for (const interdit of ["<", ">", "&", ";", "%%", "$$", "`", "\n", "ﬂ"]) {
    assert(!noms.includes(interdit), interdit);
  }
});

test("une formule ne se rend que si sa citation l'écrit, sinon elle reste du texte", () => {
  assertEquals(formules("La vitesse vaut $v = d / t$ ici.", "on note $v=d/t$ la vitesse"), [
    "La vitesse vaut ",
    { tex: "v = d / t", bloc: false, source: "$v = d / t$" },
    " ici.",
  ]);
  assertEquals(formules("Énergie : $$E = mc^2$$", "la formule $E=mc^2$ relie"), [
    "Énergie : ",
    { tex: "E = mc^2", bloc: true, source: "$$E = mc^2$$" },
  ]);
  // Une formule que la citation n'écrit pas, ou n'écrit qu'en morceau, reste du texte.
  assertEquals(formules("Donc $v = 2d/t$.", "on note $v=d/t$ la vitesse"), ["Donc $v = 2d/t$."]);
  assertEquals(formules("On a $x$.", "x vaut deux"), ["On a $x$."]);
  // Des montants ne sont pas des formules.
  assertEquals(formules("Entre 5 $ et 10 $.", "Entre 5 $ et 10 $."), ["Entre 5 $ et 10 $."]);
  assertEquals(formules("De $5 à $10.", "De $5 à $10."), ["De $5 à $10."]);
  const long = `$${"x".repeat(401)}$`;
  assertEquals(formules(long, long), [long]);
});

test("KaTeX, avec les options de Thot, refuse liens, HTML, macros sans fin et tailles démesurées", () => {
  const avertir = console.warn;
  console.warn = () => {};
  try {
    const rendre = (tex: string, bloc = false) => katex.renderToString(tex, optionsKatex(bloc));
    for (const tex of [
      String.raw`\href{javascript:alert(1)}{x}`,
      String.raw`\url{https://exemple.fr}`,
      String.raw`\htmlClass{piege}{x}`,
      String.raw`\htmlId{piege}{x}`,
      String.raw`\htmlStyle{background:url(https://exemple.fr/a.png)}{x}`,
      String.raw`\htmlData{piege=1}{x}`,
      String.raw`\includegraphics{https://exemple.fr/a.png}`,
      "<script>alert(1)</script>",
    ]) {
      const rendu = rendre(tex);
      // L'annotation MathML recopie la source échappée : seuls les attributs comptent.
      assert(
        !/<a\b|<img|<script|href=|class="piege"|id="piege"|data-piege|style="[^"]*url\(/.test(
          rendu,
        ),
        tex,
      );
    }
    // Une macro récursive ou qui se démultiplie s'arrête à `maxExpand`, en erreur affichée.
    for (const tex of [
      String.raw`\def\a{\a}\a`,
      String.raw`\def\a{xxxxxxxxxx}\def\b{\a\a\a\a\a\a\a\a\a\a}\def\c{\b\b\b\b\b\b\b\b\b\b}\c\c\c`,
    ]) {
      const debut = performance.now();
      assertStringIncludes(rendre(tex), "katex-error");
      assert(performance.now() - debut < 1000);
    }
    // Une macro globale d'une formule n'existe pas pour la suivante.
    rendre(String.raw`\gdef\fuite{1}`);
    assertStringIncludes(rendre(String.raw`\fuite`), "color:#cc0000");
    assertStringIncludes(rendre(String.raw`\rule{1000em}{1000em}`), "border-right-width:10em");
    // Le MathML garde l'expression source pour les lecteurs d'écran et la copie.
    const fraction = rendre(String.raw`\frac{a}{b}`, true);
    assertStringIncludes(fraction, "<math");
    assertStringIncludes(
      fraction,
      '<annotation encoding="application/x-tex">\\frac{a}{b}</annotation>',
    );
    assertStringIncludes(fraction, "katex-display");
  } finally {
    console.warn = avertir;
  }
});
