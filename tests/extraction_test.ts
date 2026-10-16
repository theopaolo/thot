import { readdirSync } from "node:fs";
import { test } from "vite-plus/test";
import { assert, assertEquals } from "@std/assert";
import { fileURLToPath } from "node:url";
import { assembler } from "../src/core/document.ts";
import { extraireHtml, pageVide, rubriquesSommaire } from "../src/core/html.ts";
import { extraireMarkdown, lireFrontMatter } from "../src/core/markdown.ts";
import { decouperPdf, extrairePdf } from "../src/core/pdf.ts";
import { tranche } from "../src/core/texte.ts";

test("PDF: rubriques, lignes recollées, en-têtes répétés retirés, page muette signalée", () => {
  const brut = [
    "ATC : Fiche\n\nCubisme\n\nOù et Quand ?\nQuand\n1907–1920, deux phases :\n• analytique\n• synthétique\n\nLa théorie de la relativité\nd'Einstein circule.\n\n1 sur 3",
    "ATC : Fiche\n\nCubisme\n\nPourquoi ?\nLa perspective impose un\nmensonge.",
    "ATC : Fiche\n\nCubisme\n",
  ].join("\f");
  const { parties, avertissements } = decouperPdf(brut, "arts-appliques");
  const textes = parties.map((p) => p.texte);
  assert(!textes.includes("ATC : Fiche"));
  assert(textes.includes("La théorie de la relativité d'Einstein circule."));
  assert(textes.includes("Quand 1907–1920, deux phases :\n• analytique\n• synthétique"));
  assertEquals(parties.find((p) => p.texte.startsWith("La perspective"))?.section, "Pourquoi ?");
  assertEquals(avertissements.length, 3, "chaque page est sous 200 caractères");
  const sousTitre = decouperPdf(
    "Quoi ?\nRéaction\nLe Fauvisme est une réaction au\nnaturalisme.",
    "arts-appliques",
  ).parties;
  assertEquals(
    sousTitre.map((p) => p.texte),
    ["Quoi ?", "Réaction", "Le Fauvisme est une réaction au naturalisme."],
  );
});

test("un PDF de deux pages conserve le texte propre à chaque page", () => {
  const { parties } = decouperPdf(
    "Fiche ATC\n\nLe cubisme transforme la peinture.\f" +
      "Fiche ATC\n\nLe fauvisme emploie des couleurs vives.\f",
  );
  assertEquals(
    parties.map((p) => [p.page, p.texte]),
    [
      [1, "Le cubisme transforme la peinture."],
      [2, "Le fauvisme emploie des couleurs vives."],
    ],
  );
});

test("les répétitions dans le corps d'un PDF restent dans le cours", () => {
  const phrase = "Gaudí refuse la ligne droite dans toute la façade.";
  const brut = [
    `Fiche ATC\n\nPremier chapitre\n\n${phrase}\n\nAnalyse première.\n\nPied de page`,
    `Fiche ATC\n\nDeuxième chapitre\n\n${phrase}\n\nAnalyse deuxième.\n\nPied de page`,
    "Fiche ATC\n\nTroisième chapitre\n\nFiche ATC\n\nAnalyse troisième.\n\nPied de page",
  ].join("\f");
  const { parties } = decouperPdf(brut);
  assertEquals(parties.filter((p) => p.texte === phrase).length, 2);
  assertEquals(parties.filter((p) => p.texte === "Fiche ATC").length, 1);
  assert(!parties.some((p) => p.texte === "Pied de page"));
});

const corpus = fileURLToPath(new URL("../../corpus/", import.meta.url));
const fiches = (() => {
  try {
    return readdirSync(`${corpus}ATC Les avants gardes du XXs`, { withFileTypes: true })
      .filter((f) => f.name.endsWith(".pdf"))
      .map((f) => `${corpus}ATC Les avants gardes du XXs/${f.name}`);
  } catch {
    return [];
  }
})();

test.skipIf(!fiches.length)(
  "PDF réels du corpus ATC: l'invariant d'offset tient sur chaque bloc",
  async () => {
    for (const f of fiches) {
      const doc = assembler((await extrairePdf(f, "arts-appliques")).parties);
      assert(doc.blocs.length > 5, f);
      for (const b of doc.blocs) assertEquals(tranche(doc.texte, b.debut, b.fin), b.texte);
    }
  },
);

const PAGE = `<html><head><title>Titre de repli</title><style>p{}</style></head><body>
<div class="central-column"><div class="card"><h1 class="pearl-title">Antoni Gaudi, Casa Batll&oacute; (1906)</h1>
<div class="medals"><div class="author-medal"><a href="x">Sdetienne</a></div><div> – </div>
<div class="see-medal"><a href="y">Voir dans Pearltrees</a></div></div>
<img src="data:image/jpeg;charset:utf-8;base64, /9j/4AAQ" />
<p>Le patio est rev&ecirc;tu de c&eacute;ramique bleue.</p><p><i>L&rsquo;intensit&eacute;</i> augmente.</p>
<h2>D&eacute;tails</h2><p>Main courante en bois.</p>
<img src="data:image/png;base64,iVBORw0KGgo=" /></div></div></body></html>`;

test("HTML Pearltrees: titre, texte décodé, intertitre, première image seule", () => {
  const ext = extraireHtml(PAGE, "repli");
  assertEquals(ext.parties[0].texte, "Antoni Gaudi, Casa Batlló (1906)");
  assertEquals(ext.parties.map((p) => p.texte).slice(1), [
    "Le patio est revêtu de céramique bleue.",
    "L’intensité augmente.",
    "Détails",
    "Main courante en bois.",
  ]);
  assertEquals(ext.parties.at(-1)!.section, "Détails");
  assertEquals(ext.images.length, 1);
  assertEquals(ext.images[0].mime, "image/jpeg");
  assertEquals(Array.from(ext.images[0].octets.slice(0, 3)), [0xff, 0xd8, 0xff]);
});

test("HTML Pearltrees: une page réduite à son titre est vide, sa fiche liée nommée", () => {
  const carte = (lien: string) =>
    `<h1 class="pearl-title">ATC Art Nouveau</h1>
<div class="medals"><div class="author-medal"><a href="x">Sdetienne</a></div><div> – </div>
<div class="see-medal"><a href="y">Voir dans Pearltrees</a></div></div>
<div><a href="${lien}" target="_blank"><img src="https://cdn-thumbshot-ie.pearltrees.com/a.jpg"</a></div>`;
  assertEquals(pageVide(carte("./ATC Art Nouveau.pdf")), { fichier: "ATC Art Nouveau.pdf" });
  assertEquals(pageVide(carte("https://www.admirable-facades.brussels/")), { fichier: undefined });
  assertEquals(pageVide(PAGE), undefined);
});

test("sommaire Pearltrees: chaque fichier reçoit la rubrique qui le précède", () => {
  const s = rubriquesSommaire(`<div class="pearl"><a href="Synthese sequence.html">x</a></div>
<div class="section">______<br/>S&eacute;ance 1 : Fauvisme</div>
<div class="pearl"><a class="relative-url" href="ATC Fiche Fauvisme.html">y</a></div>`);
  assertEquals(s.get("Synthese sequence.html"), "");
  assertEquals(s.get("ATC Fiche Fauvisme.html"), "Séance 1 : Fauvisme");
});

test("HTML Pearltrees: un gras en tête de paragraphe devient intertitre, une étiquette non", () => {
  const ext = extraireHtml(
    `<h1>Synthèse séance 1</h1>
     <p><b>Fauvisme · Expressionnisme · Cubisme</b></p>
     <p>Trois mouvements rompent le contrat.</p>
     <p><b>Les Fauves</b> — libérer la couleur : ils s'attaquent à la couleur.</p>
     <p>Un ciel orange, un visage vert.</p>
     <p><b>Dimensions</b> : 81 cm × 60 cm</p>
     <p><b>Thèse :</b></p>
     <p><b>Décoration peinte</b>, composée de rangées.</p>`,
    "repli",
  );
  assertEquals(
    ext.parties.map((p) => p.section),
    [
      "Synthèse séance 1",
      "Fauvisme · Expressionnisme · Cubisme",
      "Fauvisme · Expressionnisme · Cubisme",
      "Les Fauves",
      "Les Fauves",
      "Les Fauves",
      "Les Fauves",
      "Les Fauves",
    ],
  );
});

const COURS_MD = `---
title: "Docker : les bases"
order: 2
hidden: true
---

# Docker : les bases

Une **image** décrit le _conteneur_ ([voir la doc](https://docs.docker.com)).

## Construire

- \`docker build\` crée l'image
- \`docker run\` la lance

\`\`\`dockerfile
# Image de base
FROM node:26
# Dépendances
RUN pnpm install
\`\`\`

| Commande | Rôle |
|----------|------|
| build    | crée |

![schéma des couches](img/couches.png) ![logo](https://exemple.fr/logo.png)

\`\`\`mermaid
graph TD
  A --> B
\`\`\`
`;

test("Markdown: le front matter donne le titre et sort du texte", () => {
  const ext = extraireMarkdown(COURS_MD, "repli");
  assertEquals(ext.parties[0], { texte: "Docker : les bases", section: "Docker : les bases" });
  assert(ext.parties.every((p) => !p.texte.includes("order") && !p.texte.includes("hidden")));
  assertEquals(extraireMarkdown("# Seul\n\ntexte", "repli").parties[0].texte, "repli");
  assertEquals(lireFrontMatter("---\r\ntitle: 'Cours'\r\n---\r\ncorps").titre, "Cours");
});

test("Markdown: titres en sections, marques réduites, code gardé tel quel", () => {
  const ext = extraireMarkdown(COURS_MD, "repli");
  assertEquals(
    ext.parties.map((p) => [p.texte.split("\n")[0], p.section]),
    [
      ["Docker : les bases", "Docker : les bases"],
      ["Une image décrit le conteneur (voir la doc).", "Docker : les bases"],
      ["Construire", "Construire"],
      ["docker build crée l'image", "Construire"],
      ["# Image de base", "Construire"],
      ["Commande | Rôle", "Construire"],
      ["graph TD", "Construire"],
    ],
  );
  assertEquals(
    ext.parties[4].texte,
    "# Image de base\nFROM node:26\n# Dépendances\nRUN pnpm install",
  );
  assertEquals(ext.parties[3].texte, "docker build crée l'image\ndocker run la lance");
  assertEquals(ext.parties[5].texte, "Commande | Rôle\nbuild | crée");
  assertEquals(ext.parties[6].texte, "graph TD\n  A --> B");
});

test("Markdown: une image relative est nommée dans un avertissement, son alt n'est pas du texte", () => {
  const ext = extraireMarkdown(COURS_MD, "repli");
  assertEquals(ext.avertissements, ["Images liées, non jointes à la source : img/couches.png."]);
  assert(ext.parties.every((p) => !p.texte.includes("schéma") && !p.texte.includes("logo")));
  assertEquals(ext.images, []);
});

test("Markdown: les offsets assemblés retrouvent chaque bloc", () => {
  const doc = assembler(extraireMarkdown(COURS_MD, "repli").parties);
  for (const b of doc.blocs) assertEquals(tranche(doc.texte, b.debut, b.fin), b.texte);
});
