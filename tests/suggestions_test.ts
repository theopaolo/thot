import { test } from "vite-plus/test";
import { assertEquals } from "@std/assert";
import { renvoie } from "../src/core/suggestions.ts";

test("une suggestion qui renvoie à une image absente est écartée, une question qui la nomme passe", () => {
  for (const q of [
    "Quel est le sujet du motif de la tapisserie ?",
    "Quel principe du fauvisme se retrouve dans ce portrait ?",
    "Pourquoi les couleurs vert et bleu sont-elles alternées dans le motif ?",
    "Que montre cette œuvre ?",
    "Que dit l'extrait sur le Bauhaus ?",
  ]) {
    assertEquals(renvoie(q), true, q);
  }
  for (const q of [
    "Que représente le motif floral de William Morris ?",
    "Quel portrait Matisse a-t-il fait de sa femme ?",
    "Pourquoi les Arts and Crafts aiment-ils les motifs végétaux ?",
    "Pourquoi Gaudí refuse-t-il la ligne droite ?",
  ]) {
    assertEquals(renvoie(q), false, q);
  }
});
