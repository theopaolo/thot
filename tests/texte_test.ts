import { assertEquals } from "@std/assert";
import { assembler, decouper } from "../src/core/document.ts";
import { racines } from "../src/core/recherche.ts";
import { longueur, tranche, trouver, trouverFragments } from "../src/core/texte.ts";

Deno.test("les offsets comptent des points de code, pas des unités UTF-16", () => {
  const s = "Clé 𝄞 de sol";
  assertEquals(s.length, 13);
  assertEquals(longueur(s), 12);
  assertEquals(tranche(s, 4, 5), "𝄞");
  assertEquals(tranche(s, 6, 8), "de");
});

Deno.test("chaque bloc restitue exactement sa tranche de document.txt", () => {
  const doc = assembler([
    { texte: "Titre 𝄞", section: "Titre 𝄞" },
    { texte: "  Premier paragraphe.  ", section: "Quoi ?" },
    { texte: "", section: "Quoi ?" },
    { texte: "Après l'astral 😀 encore.", section: "Pourquoi ?" },
  ]);
  assertEquals(doc.blocs.length, 3);
  for (const b of doc.blocs) assertEquals(tranche(doc.texte, b.debut, b.fin), b.texte);
  for (const c of decouper(doc)) assertEquals(tranche(doc.texte, c.debut, c.fin), c.texte);
});

Deno.test("une citation se retrouve malgré les apostrophes, la casse et les espaces", () => {
  const texte =
    "Le Cubisme veut représenter la connaissance totale d’un objet, 😀 pas sa seule apparence.";
  const [a, b] = trouver(texte, "la connaissance  totale d'un objet")!;
  assertEquals(tranche(texte, a, b), "la connaissance totale d’un objet");
  const [c, d] = trouver(texte, "pas sa seule apparence")!;
  assertEquals(tranche(texte, c, d), "pas sa seule apparence");
  assertEquals(trouver(texte, "une phrase absente"), null);
});

Deno.test("une citation qui recolle une liste à puces se retrouve", () => {
  const texte = "par un artisan :\n• Possibilité de personnaliser\n• Marge de manoeuvre";
  const [a, b] = trouver(texte, "par un artisan : Possibilité de personnaliser")!;
  assertEquals(tranche(texte, a, b), "par un artisan :\n• Possibilité de personnaliser");
});

Deno.test("la racinisation retire l'élision et rapproche les formes", () => {
  assertEquals(racines("d'architecture"), racines("architecture"));
  assertEquals(racines("peintres")[0], racines("peintre")[0]);
});

Deno.test("une citation coupée par des points de suspension passe si chaque fragment est dans l'ordre", () => {
  const texte =
    "Il possède un savoir-faire et une marge de manoeuvre créative. Son travail est donc émancipateur et non aliénant.";
  const r = trouverFragments(
    texte,
    "Il possède un savoir‑faire et une marge… Son travail est donc émancipateur",
  );
  assertEquals(r && tranche(texte, r[0], r[1]).startsWith("Il possède"), true);
  assertEquals(r && tranche(texte, r[0], r[1]).endsWith("émancipateur"), true);
  assertEquals(trouverFragments(texte, "Son travail est donc… Il possède un savoir-faire"), null);
  assertEquals(trouverFragments(texte, "Il possède un savoir-fait et une marge"), null);
});
