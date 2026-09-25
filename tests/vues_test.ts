import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { page } from "../src/app/vues/page.ts";
import { depot, pageLegendes } from "../src/app/vues/prof.ts";
import { chat, pageChapitre, panneauSource } from "../src/app/vues/eleve.ts";
import { texteDocument } from "../src/app/vues/document.ts";

Deno.test("les vues partagent le bundle et gardent leurs contrats de fragments et d'échappement", async () => {
  const titre = "<script>alert(1)</script>";
  const chapitre = await pageChapitre("Arts", [{
    id: "source-1",
    titre,
    seance: "Architecture",
    date: "1904",
    quiz_reponse: "Antoni Gaudí",
    image_id: "image-1",
  }], []);
  const conversation = await chat([{
    id: "message-1",
    question: titre,
    etat: "answered",
    avis: null,
    resultat: JSON.stringify({
      etat: "answered",
      affirmations: [{ texte: titre, titre, source_id: "source-1", citation: "Passage" }],
    }),
  }]);
  const panneau = await panneauSource({ titre, citation: "Passage", source_id: "source-1" }, {
    id: "message-1",
    n: 0,
    total: 2,
  });
  const legendes = await pageLegendes({
    id: "image-1",
    source_id: "source-1",
    titre,
    restantes: 1,
    legende: titre,
    legende_statut: "unreviewed",
    legende_origine: "generated",
    modele: "test",
  }, []);
  const rendus = await Promise.all([
    page("Chapitre", null, chapitre),
    page("Chat", null, conversation),
    page("Légendes", null, legendes, "", "/prof/legendes"),
    page("Dépôt", null, depot({}), "", "/prof/depot"),
  ]);
  for (const rendu of rendus.map(String)) {
    assertStringIncludes(rendu, '<script type="module" src="/static/dist/app.js"></script>');
    assertEquals((rendu.match(/\/static\/dist\/app\.js/g) ?? []).length, 1);
    assert(!/<script\s*>|\s(?:on\w+|hx-on[^\s=]*)\s*=/i.test(rendu));
    assert(!rendu.includes(titre));
  }
  assertStringIncludes(String(chapitre), 'hx-target="#lecteur"');
  assertStringIncludes(String(chapitre), "data-verifier-quiz");
  assertStringIncludes(String(conversation), 'hx-target="#source"');
  assertStringIncludes(String(conversation), "data-ouvrir-feuille");
  assertStringIncludes(String(panneau), 'data-reponse="message-1" data-citation="1"');
  assertStringIncludes(String(legendes), 'data-raccourci="v"');
  assertStringIncludes(String(conversation), "&lt;script&gt;alert(1)&lt;/script&gt;");
  const blocs = texteDocument([{ id: "b1", texte: "🎨 Gaudí", section: "", debut: 0, fin: 7 }], [
    2,
    7,
  ]);
  assertStringIncludes(String(await blocs[0]), '<mark id="passage">Gaudí</mark>');
});
