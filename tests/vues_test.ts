import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { page } from "../src/app/vues/page.ts";
import { depot, detailSource, lignesSources, pageLegendes } from "../src/app/vues/prof.ts";
import { chat, pageChapitre, panneauSource, reponse } from "../src/app/vues/eleve.ts";
import { texteDocument } from "../src/app/vues/document.ts";
import type { BlocReponse } from "../src/core/reponse.ts";

const LIBELLES = {
  niveau: "Classe",
  regroupement: "Séquence",
  regroupements: "Séquences",
  sousRegroupement: "Sous-matière",
  seance: "Séance",
};

test("les vues partagent le bundle et gardent leurs contrats de fragments et d'échappement", async () => {
  const titre = "<script>alert(1)</script>";
  const chapitre = await pageChapitre(
    "Arts",
    [
      {
        id: "source-1",
        titre,
        seance: "Architecture",
        date: "1904",
        quiz_reponse: "Antoni Gaudí",
        image_id: "image-1",
      },
    ],
    [],
    undefined,
    undefined,
    "",
    "",
    LIBELLES,
  );
  const conversation = await chat({
    compte: "compte-1",
    conversation: { id: "conversation-1", titre, archivee: false },
    messages: [
      {
        id: "message-1",
        question: titre,
        etat: "answered",
        avis: null,
        resultat: JSON.stringify({
          etat: "answered",
          affirmations: [{ texte: titre, titre, source_id: "source-1", citation: "Passage" }],
        }),
      },
    ],
    idees: ["Et ensuite ?"],
    liste: [
      {
        id: "conversation-1",
        titre,
        perimetre: titre,
        active_le: "2026-01-01T00:00:00Z",
        etat: null,
      },
    ],
    archivees: 0,
    suite: "",
    perimetre: { chapitre: "", matiere_id: "", cours_id: "", theme_id: "" },
    catalogue: { matieres: [], cours: [], themes: [] },
    theme: "Thème",
    indisponible: false,
  });
  const panneau = await panneauSource(
    { titre, citation: "Passage", source_id: "source-1" },
    {
      id: "message-1",
      n: 0,
      total: 2,
    },
  );
  const legendes = await pageLegendes(
    {
      id: "image-1",
      source_id: "source-1",
      titre,
      restantes: 1,
      legende: titre,
      legende_statut: "unreviewed",
      legende_origine: "generated",
      modele: "test",
      credit: null,
    },
    [],
  );
  const rendus = await Promise.all([
    page("Chapitre", null, chapitre),
    page("Chat", null, conversation),
    page("Légendes", null, legendes, "", "/prof/legendes"),
    page(
      "Dépôt",
      null,
      depot({ informations: [], libelles: LIBELLES, lecteurs: "eleves" }),
      "",
      "/prof/depot",
    ),
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
  // « Pour continuer » envoie dans la conversation ouverte, avec sa propre clé d'envoi.
  assertStringIncludes(String(conversation), 'hx-include="[name=conversation]"');
  assertStringIncludes(String(conversation), 'name="conversation" value="conversation-1"');
  assertStringIncludes(String(panneau), 'data-reponse="message-1" data-citation="1"');
  assertStringIncludes(String(legendes), 'data-raccourci="v"');
  assertStringIncludes(String(conversation), "&lt;script&gt;alert(1)&lt;/script&gt;");
  const blocs = texteDocument(
    [{ id: "b1", texte: "🎨 Gaudí", section: "", debut: 0, fin: 7 }],
    [2, 7],
  );
  assertStringIncludes(String(await blocs[0]), '<mark id="passage">Gaudí</mark>');
});

test("un bloc de code se rend en pre avec son surlignage, un ancien bloc reste un paragraphe", async () => {
  const code = "FROM node:26\n  RUN <b>x</b>";
  const blocs = [
    { id: "b1", texte: code, section: "", debut: 0, fin: 26, code: true as const },
    { id: "b2", texte: code, section: "", debut: 28, fin: 54 },
  ];
  const [avecCode, ancien] = texteDocument(blocs, [5, 12]);
  assertStringIncludes(
    String(await avecCode),
    '<pre id="b1"><code>FROM <mark id="passage">node:26</mark>\n  RUN &lt;b&gt;x&lt;/b&gt;</code></pre>',
  );
  assertEquals(String(await texteDocument([blocs[0]])[0]).includes("<mark"), false);
  assertStringIncludes(
    String(await ancien),
    '<p id="b2">FROM node:26\n  RUN &lt;b&gt;x&lt;/b&gt;</p>',
  );
});

test("une réponse en blocs passe par les gabarits de l'application, chaque phrase avec sa citation", async () => {
  const piege = '<img src=x onerror="alert(1)">';
  const affirmations = ["Un", "Deux", "Trois", "Quatre", piege].map((texte) => ({
    texte,
    titre: "Cours",
    source_id: "source-1",
    chunk_id: "c",
    citation: "Passage",
  }));
  const rendu = String(
    await reponse("m1", {
      etat: "answered",
      affirmations,
      blocs: [
        { type: "etapes", titre: piege, affirmations: [0, 1] },
        { type: "liste", affirmations: [2] },
        {
          type: "tableau",
          colonnes: ["SSR", piege],
          lignes: [{ titre: piege, affirmations: [null, 3] }],
        },
        { type: "schema", affirmations: [4] } as unknown as BlocReponse,
      ],
      juge_indisponible: true,
    }),
  );
  assert(!rendu.includes(piege));
  assertStringIncludes(rendu, "Vérification partielle : une étape de contrôle n&#39;a pas pu");
  assert(!rendu.includes("Réponse vérifiée"));
  assertStringIncludes(rendu, "<ol><li><span>Un</span>");
  assertStringIncludes(rendu, "<ul><li><span>Trois</span>");
  assertStringIncludes(rendu, '<th scope="col">SSR</th>');
  assertStringIncludes(rendu, '<th scope="row">&lt;img');
  assertStringIncludes(rendu, "<td></td><td><span>Quatre</span>");
  assertStringIncludes(rendu, "<p><span>&lt;img");
  assertEquals(
    [...rendu.matchAll(/citations\/(\d)/g)].map((m) => m[1]),
    ["0", "1", "2", "3", "4"],
  );
  const ancienne = String(
    await reponse("m2", { etat: "answered", affirmations: affirmations.slice(0, 2) }),
  );
  assertStringIncludes(ancienne, "Réponse vérifiée dans les cours validés");
  assertStringIncludes(ancienne, "<p><span>Un</span>");
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
    matiere_id: null,
  };
  const d = {
    source,
    meta: {},
    informations: [],
    libelles: LIBELLES,
    job: { etat: "extracting", erreur: null, avertissements: [] },
    images: [],
    blocs: [],
  };
  const detail = String(await detailSource(d));
  assert(detail.indexOf("</form>") < detail.indexOf('id="traitement-source"'));
  assertStringIncludes(detail, 'hx-select="#traitement-source"');
  assertStringIncludes(detail, 'hx-disinherit="hx-select"');
  assert(
    !String(await detailSource({ ...d, job: { ...d.job, etat: "awaiting_review" } })).includes(
      'hx-trigger="every 3s"',
    ),
  );
  for (const grille of [false, true]) {
    const lignes = String(
      await lignesSources(
        [
          {
            ...source,
            sequence: "Arts",
            etat: "extracting",
            erreur: null,
            images_a_relire: 0,
            revision_en_attente: 0,
            images: 0,
            legendes: 0,
            image_id: null,
          },
        ],
        "",
        grille,
      ),
    );
    assertStringIncludes(lignes, 'id="selection-source-1" hx-preserve');
    assertStringIncludes(lignes, 'hx-trigger="every 3s"');
  }
});
