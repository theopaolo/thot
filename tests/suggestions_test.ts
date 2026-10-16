import { test } from "vite-plus/test";
import { assertEquals } from "@std/assert";
import { PanneModele } from "../src/core/modeles.ts";
import { questionsProches, renvoie } from "../src/core/suggestions.ts";
import { fauxModeles } from "./outils.ts";

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

test("après un refus, seules les questions proches du sens de la question sont proposées", async () => {
  const candidates = [
    "Qui est Gaudí ?",
    "Qu'est-ce que l'Art nouveau ?",
    "Que réunit le Bauhaus ?",
  ];
  const proches = (scores: number[]) => {
    const { modeles } = fauxModeles();
    modeles.reclasser = (_q, docs) =>
      Promise.resolve(docs.map((_, index) => ({ index, score: scores[index] })));
    return questionsProches(modeles, "Où a vécu Gaudí ?", candidates, 0.5);
  };
  assertEquals(await proches([0.9, 0.1, 0.6]), ["Qui est Gaudí ?", "Que réunit le Bauhaus ?"]);
  assertEquals(await proches([0.01, 0.02, 0.03]), [], "rien de proche, rien de proposé");

  const { modeles } = fauxModeles();
  modeles.reclasser = () => Promise.reject(new PanneModele("reclasseur 503"));
  assertEquals(await questionsProches(modeles, "Où a vécu Gaudí ?", candidates, 0.5), []);
});
