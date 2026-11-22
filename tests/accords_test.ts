import { test } from "vite-plus/test";
import { assertEquals } from "@std/assert";
import { formes, majuscule, minuscule } from "../src/core/accords.ts";

test("un terme s'accorde dans une phrase selon son genre et sa première lettre", () => {
  const cours = formes("Cours", "Cours", "m");
  assertEquals(
    [cours.un, cours.le, cours.du, cours.au, cours.ce, cours.de, cours.ton, cours.aucun],
    [
      "un cours",
      "le cours",
      "du cours",
      "au cours",
      "ce cours",
      "de cours",
      "ton cours",
      "aucun cours",
    ],
  );
  assertEquals(`Les ${cours.noms} coché${cours.e}s`, "Les cours cochés");

  const matiere = formes("Matière", "Matières", "f");
  assertEquals(
    [matiere.un, matiere.le, matiere.du, matiere.au, matiere.ce, matiere.son, matiere.aucun],
    [
      "une matière",
      "la matière",
      "de la matière",
      "à la matière",
      "cette matière",
      "sa matière",
      "aucune matière",
    ],
  );
  assertEquals(matiere.selon("le premier", "la première"), "la première");

  // Devant une voyelle, l'article s'élide et le possessif féminin devient « ton ».
  const unite = formes("Unité", "Unités", "f");
  assertEquals(
    [unite.le, unite.du, unite.au, unite.ce, unite.de, unite.ton, `créé${unite.e}`],
    ["l'unité", "de l'unité", "à l'unité", "cette unité", "d'unité", "ton unité", "créée"],
  );
  const atelier = formes("Atelier", "Ateliers", "m");
  assertEquals([atelier.le, atelier.ce, atelier.un], ["l'atelier", "cet atelier", "un atelier"]);
});

test("un sigle garde ses capitales dans une phrase", () => {
  assertEquals([minuscule("Cours"), minuscule("UE"), minuscule("École")], ["cours", "UE", "école"]);
  assertEquals(formes("UE", "UE", "f").ce, "cette UE");
  assertEquals(majuscule("aucune matière"), "Aucune matière");
});
