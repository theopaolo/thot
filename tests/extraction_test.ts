import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { assembler } from "../src/core/document.ts";
import { extraireHtml, rubriquesSommaire } from "../src/core/html.ts";
import { decouperPdf, extrairePdf } from "../src/core/pdf.ts";
import { tranche } from "../src/core/texte.ts";

Deno.test("PDF: rubriques, lignes recollées, en-têtes répétés retirés, page muette signalée", () => {
  const brut = [
    "ATC : Fiche\n\nCubisme\n\nOù et Quand ?\nQuand\n1907–1920, deux phases :\n• analytique\n• synthétique\n\nLa théorie de la relativité\nd'Einstein circule.\n\n1 sur 3",
    "ATC : Fiche\n\nCubisme\n\nPourquoi ?\nLa perspective impose un\nmensonge.",
    "ATC : Fiche\n\nCubisme\n",
  ].join("\f");
  const { parties, avertissements } = decouperPdf(brut);
  const textes = parties.map((p) => p.texte);
  assert(!textes.includes("ATC : Fiche"));
  assert(textes.includes("La théorie de la relativité d'Einstein circule."));
  assert(textes.includes("Quand 1907–1920, deux phases :\n• analytique\n• synthétique"));
  assertEquals(parties.find((p) => p.texte.startsWith("La perspective"))?.section, "Pourquoi ?");
  assertEquals(avertissements.length, 3, "chaque page est sous 200 caractères");
  const sousTitre =
    decouperPdf("Quoi ?\nRéaction\nLe Fauvisme est une réaction au\nnaturalisme.").parties;
  assertEquals(sousTitre.map((p) => p.texte), [
    "Quoi ?",
    "Réaction",
    "Le Fauvisme est une réaction au naturalisme.",
  ]);
});

Deno.test("un PDF de deux pages conserve le texte propre à chaque page", () => {
  const { parties } = decouperPdf(
    "Fiche ATC\n\nLe cubisme transforme la peinture.\f" +
      "Fiche ATC\n\nLe fauvisme emploie des couleurs vives.\f",
  );
  assertEquals(parties.map((p) => [p.page, p.texte]), [
    [1, "Le cubisme transforme la peinture."],
    [2, "Le fauvisme emploie des couleurs vives."],
  ]);
});

const corpus = fromFileUrl(new URL("../../corpus/", import.meta.url));
const fiches = (() => {
  try {
    return [...Deno.readDirSync(`${corpus}ATC Les avants gardes du XXs`)]
      .filter((f) => f.name.endsWith(".pdf")).map((f) =>
        `${corpus}ATC Les avants gardes du XXs/${f.name}`
      );
  } catch {
    return [];
  }
})();

Deno.test({
  name: "PDF réels du corpus ATC: l'invariant d'offset tient sur chaque bloc",
  ignore: !fiches.length,
  async fn() {
    for (const f of fiches) {
      const doc = assembler((await extrairePdf(f)).parties);
      assert(doc.blocs.length > 5, f);
      for (const b of doc.blocs) assertEquals(tranche(doc.texte, b.debut, b.fin), b.texte);
    }
  },
});

const PAGE = `<html><head><title>Titre de repli</title><style>p{}</style></head><body>
<div class="central-column"><div class="card"><h1 class="pearl-title">Antoni Gaudi, Casa Batll&oacute; (1906)</h1>
<div class="medals"><div class="author-medal"><a href="x">Sdetienne</a></div><div> – </div>
<div class="see-medal"><a href="y">Voir dans Pearltrees</a></div></div>
<img src="data:image/jpeg;charset:utf-8;base64, /9j/4AAQ" />
<p>Le patio est rev&ecirc;tu de c&eacute;ramique bleue.</p><p><i>L&rsquo;intensit&eacute;</i> augmente.</p>
<h2>D&eacute;tails</h2><p>Main courante en bois.</p>
<img src="data:image/png;base64,iVBORw0KGgo=" /></div></div></body></html>`;

Deno.test("HTML Pearltrees: titre, texte décodé, intertitre, première image seule", () => {
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

Deno.test("sommaire Pearltrees: chaque fichier reçoit la rubrique qui le précède", () => {
  const s = rubriquesSommaire(`<div class="pearl"><a href="Synthese sequence.html">x</a></div>
<div class="section">______<br/>S&eacute;ance 1 : Fauvisme</div>
<div class="pearl"><a class="relative-url" href="ATC Fiche Fauvisme.html">y</a></div>`);
  assertEquals(s.get("Synthese sequence.html"), "");
  assertEquals(s.get("ATC Fiche Fauvisme.html"), "Séance 1 : Fauvisme");
});
