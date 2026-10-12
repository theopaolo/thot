import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { page } from "../src/app/vues/page.ts";
import { depot, detailSource, lignesSources, pageLegendes } from "../src/app/vues/prof.ts";
import { chat, pageChapitre, panneauSource } from "../src/app/vues/eleve.ts";
import { texteDocument } from "../src/app/vues/document.ts";

test("les vues partagent le bundle et gardent leurs contrats de fragments et d'échappement", async () => {
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

test("le rafraîchissement enseignant exclut le formulaire et conserve les sélections", async () => {
  const source = {
    id: "source-1",
    titre: "Document",
    statut: "a_relire",
    format: "pdf",
    fichier: "document.pdf",
    statut_par: null,
    statut_le: null,
    enseignant: "Prof",
    cree_le: "2026-01-01T00:00:00Z",
    audience: "eleves" as const,
    reponses: 1,
  };
  const d = {
    source,
    meta: {},
    job: { etat: "extracting", erreur: null, avertissements: [] },
    images: [],
    blocs: [],
  };
  const detail = String(await detailSource(d));
  assert(detail.indexOf("</form>") < detail.indexOf('id="traitement-source"'));
  assertStringIncludes(detail, 'hx-select="#traitement-source"');
  assertStringIncludes(detail, 'hx-disinherit="hx-select"');
  assert(
    !String(await detailSource({ ...d, job: { ...d.job, etat: "awaiting_review" } }))
      .includes('hx-trigger="every 3s"'),
  );
  for (const grille of [false, true]) {
    const lignes = String(
      await lignesSources(
        [{
          ...source,
          sequence: "Arts",
          etat: "extracting",
          erreur: null,
          images_a_relire: 0,
          image_id: null,
        }],
        "",
        grille,
      ),
    );
    assertStringIncludes(lignes, 'id="selection-source-1" hx-preserve');
    assertStringIncludes(lignes, 'hx-trigger="every 3s"');
  }
});
