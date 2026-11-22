import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import { formes } from "../src/core/accords.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { config } from "../src/app/config.ts";
import { creerApp } from "../src/app/routes.ts";
import { page } from "../src/app/vues/page.ts";
import { environnement, fauxModeles } from "./outils.ts";
import { sources } from "../src/app/vues/prof-bibliotheque.ts";
import { depot } from "../src/app/vues/prof-depot.ts";
import { eleves } from "../src/app/vues/prof-eleves.ts";
import { pageLegendes } from "../src/app/vues/prof-legendes.ts";
import { lignesSources } from "../src/app/vues/prof-lignes.ts";
import { detailSource } from "../src/app/vues/prof-source.ts";
import { panneauSource, reponse } from "../src/app/vues/echange.ts";
import { pageChapitre } from "../src/app/vues/eleve-chapitre.ts";
import { chat } from "../src/app/vues/eleve-chat.ts";
import {
  legendeSchema,
  sansDirectives,
  sections,
  texteDocument,
} from "../src/app/vues/document.ts";
import type { BlocReponse } from "../src/core/reponse.ts";

const LIBELLES = {
  matiere: "Matière",
  matieres: "Matières",
  cours: "Cours",
  cours_pluriel: "Cours",
  niveau: "Classe",
  regroupement: "Séquence",
  regroupements: "Séquences",
  sousRegroupement: "Sous-matière",
  seance: "Séance",
  formes: { matiere: formes("Matière", "Matières", "f"), cours: formes("Cours", "Cours", "m") },
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
    perimetre: { matiere_id: "", cours_id: "", theme_id: "" },
    catalogue: { matieres: [], cours: [], themes: [] },
    libelles: LIBELLES,
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
    '<p id="b2" class="lignes">FROM node:26\n  RUN &lt;b&gt;x&lt;/b&gt;</p>',
  );
});

test("un bloc tableau se rend en tableau, un passage à cheval sur deux cellules garde une ancre", async () => {
  const texte = "Smell | Action\nNom opaque | Renommer\nCode dupliqué | Extraire";
  const [tableau] = texteDocument(
    [{ id: "b1", texte, section: "S", debut: 10, fin: 10 + texte.length }],
    // « opaque | Renom » : la fin d'une cellule et le début de la suivante.
    [10 + texte.indexOf("opaque"), 10 + texte.indexOf("mer")],
    2,
    "S",
  );
  const rendu = String(await tableau);
  assertStringIncludes(rendu, '<th scope="col">Smell</th><th scope="col">Action</th>');
  assertStringIncludes(rendu, '<td>Nom <mark id="passage">opaque</mark></td>');
  assertStringIncludes(rendu, "<td><mark>Renom</mark>mer</td>");
  assertStringIncludes(rendu, "<td>Code dupliqué</td><td>Extraire</td>");
  // Une ligne dont le nombre de cellules diffère n'est pas un tableau.
  const [liste] = texteDocument([
    { id: "b2", texte: "un | deux\ntrois | quatre | cinq", section: "", debut: 0, fin: 30 },
  ]);
  assertStringIncludes(String(await liste), '<p id="b2" class="lignes">un | deux\ntrois');
});

test("le code en ligne se rend en code, un passage qui le traverse s'y coupe sans le scinder", async () => {
  const texte = "Garde tool_calls en mémoire.";
  const a = texte.indexOf("tool_calls");
  const bloc = { id: "b1", texte, section: "", debut: 0, fin: texte.length };
  const [p] = texteDocument([{ ...bloc, codes: [[a, a + 10]] }], [0, a + 4]);
  assertStringIncludes(
    String(await p),
    '<p id="b1"><mark id="passage">Garde </mark><code><mark>tool</mark>_calls</code> en mémoire.</p>',
  );
  // Une extraction antérieure, sans plages, reste du texte.
  assertStringIncludes(String(await texteDocument([bloc])[0]), "Garde tool_calls en");
});

test("une formule d'une source se rend entière sous la marque, un code en ligne garde ses dollars", async () => {
  const texte = "La loi d'Ohm s'écrit $U = R \\times I$ pour un conducteur.";
  const a = texte.indexOf("$");
  const z = texte.lastIndexOf("$") + 1;
  const bloc = { id: "b1", texte, section: "", debut: 0, fin: texte.length };
  const formule = '<span class="formule" data-tex="U = R \\times I">$U = R \\times I$</span>';
  assertStringIncludes(
    String(await texteDocument([bloc])[0]),
    `<p id="b1">La loi d&#39;Ohm s&#39;écrit ${formule} pour un conducteur.</p>`,
  );
  // Le passage s'arrête au milieu de la formule : la marque la prend entière.
  assertStringIncludes(
    String(await texteDocument([bloc], [a - 8, a + 4])[0]),
    `<mark id="passage">s&#39;écrit </mark><mark>${formule}</mark> pour`,
  );
  const [code] = texteDocument([{ ...bloc, codes: [[a, z]] }]);
  assertEquals(String(await code).includes("data-tex"), false);
  assertEquals(
    String(await texteDocument([{ ...bloc, texte: "Entre 5 $ et 10 $ la place." }])[0]).includes(
      "data-tex",
    ),
    false,
  );
});

test("le gras et le niveau d'un titre se rendent, un passage qui coupe un gras reste surligné", () => {
  const texte = "Un agent lit le code.";
  const a = texte.indexOf("agent");
  const blocs = [
    { id: "b0", texte: "Rôles", section: "Rôles", debut: 0, fin: 5, niveau: 2 },
    { id: "b1", texte: "Harness", section: "Harness", debut: 7, fin: 14, niveau: 3 },
    { id: "b2", texte, section: "Harness", debut: 16, fin: 16 + texte.length, gras: [[a, a + 9]] },
    { id: "b3", texte: "Fond", section: "Fond", debut: 40, fin: 44, niveau: 6 },
  ] satisfies Parameters<typeof texteDocument>[0];
  const eleve = texteDocument(blocs, [16 + a + 6, 16 + a + 16], 2).join("");
  assertStringIncludes(eleve, '<h2 class="intertitre" id="b0">Rôles</h2>');
  assertStringIncludes(eleve, '<h3 class="intertitre" id="b1">Harness</h3>');
  assertStringIncludes(
    eleve,
    '<p id="b2">Un <strong>agent </strong><mark id="passage"><strong>lit</strong></mark><mark> le cod</mark>e.</p>',
  );
  // Sous « Texte extrait », un cran plus bas, sans dépasser h6.
  const prof = texteDocument(blocs).join("");
  assertStringIncludes(prof, '<h4 id="b1">Harness</h4>');
  assertStringIncludes(prof, '<h6 id="b3">Fond</h6>');
  assertEquals(sections(blocs), [
    { titre: "Rôles", ancre: "b0", niveau: 2 },
    { titre: "Harness", ancre: "b1", niveau: 3 },
    { titre: "Fond", ancre: "b3", niveau: 6 },
  ]);
});

test("le panneau de vérification rend le passage dans son tableau, la ligne citée surlignée", async () => {
  const texte = "Problème | Mécanisme\nPlusieurs destinataires | Observer";
  const debut = 40 + texte.indexOf("Plusieurs");
  const rendu = String(
    await panneauSource({
      titre: "Patterns",
      citation: "Plusieurs destinataires",
      source_id: "s1",
      debut,
      fin: debut + 23,
      blocs: [{ id: "blk_3", texte, section: "S", debut: 40, fin: 40 + texte.length }],
    }),
  );
  assertStringIncludes(rendu, '<div class="document">');
  assertStringIncludes(rendu, '<div class="cadre-tableau"><table id="blk_3">');
  // Le panneau ne vise pas l'ancre du lecteur.
  assertStringIncludes(rendu, "<td><mark>Plusieurs destinataires</mark></td>");
  assertEquals(rendu.includes(" | "), false);
});

test("un bloc animé de carnet devient un schéma, ses notes passent en liste sous le dessin", async () => {
  const code = [
    "sequenceDiagram",
    "  accTitle: Deux tours",
    "  participant H as Harness",
    "  %% ctx: system 1200 Prompt",
    "  %% note: Le harness ajoute la demande.",
    "  H->>H: Contrôle",
    "  %% note: Le modèle <b>répond</b>.",
  ].join("\n");
  const bloc = { id: "b1", section: "", debut: 0, fin: 200, code: true as const };
  const [figure, texte] = texteDocument([
    { ...bloc, texte: code, langage: "animated" },
    { ...bloc, id: "b2", texte: "étape 1\nétape 2", langage: "animated" },
  ]);
  const rendu = String(await figure);
  assertStringIncludes(rendu, '<figure class="figure-schema"><pre id="b1" data-mermaid=');
  assertStringIncludes(
    rendu,
    '<ol class="notes-schema"><li>Le harness ajoute la demande.</li><li>Le modèle &lt;b&gt;répond&lt;/b&gt;.</li></ol><figcaption><strong>Deux tours</strong>',
  );
  // Un bloc animé qui n'est pas un diagramme de séquence reste du code.
  assertStringIncludes(String(await texte), '<pre id="b2" data-langage="animated">');
});

test("un schéma du lecteur devient une figure légendée, le sommaire ancre chaque section", async () => {
  const code =
    "flowchart TB\n  accTitle: Les couches\n  accDescr: Le harness <b>appelle</b>\n  A --> B";
  const blocs = [
    { id: "b0", texte: "Intro.", section: "Titre", debut: 0, fin: 6 },
    { id: "b1", texte: "Couches", section: "Couches", debut: 8, fin: 15 },
    {
      id: "b2",
      texte: code,
      section: "Couches",
      debut: 17,
      fin: 90,
      code: true as const,
      langage: "mermaid",
    },
    { id: "b3", texte: "Suite.", section: "Pages", debut: 92, fin: 98 },
  ];
  const rendu = texteDocument(blocs, undefined, 2, "Titre").join("");
  assertEquals(rendu.includes(">Titre</h2>"), false);
  assertStringIncludes(rendu, '<figure class="figure-schema"><pre id="b2" data-mermaid=');
  assertStringIncludes(
    rendu,
    "<figcaption><strong>Les couches</strong> Le harness &lt;b&gt;appelle&lt;/b&gt;</figcaption></figure>",
  );
  assertEquals(sections(blocs, "Titre"), [
    { titre: "Couches", ancre: "b1" },
    { titre: "Pages", ancre: "s-b3" },
  ]);
  assertStringIncludes(rendu, '<h2 class="intertitre" id="s-b3">Pages</h2>');
  assertEquals(legendeSchema("graph TD\n  accDescr {\n  Deux\n  lignes\n  }"), {
    titre: undefined,
    description: "Deux lignes",
  });
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
        { type: "frise", affirmations: [4] } as unknown as BlocReponse,
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

test("un schéma se lit toujours en liste citée, son texte Mermaid voyage échappé", async () => {
  const piege = '<script>alert(1)</script>"';
  const affirmation = (texte: string, citation = "Passage") => ({
    texte,
    titre: "Cours",
    source_id: "source-1",
    chunk_id: "c",
    citation,
  });
  const rendu = String(
    await reponse("m3", {
      etat: "answered",
      affirmations: [
        affirmation("La pile décrit le conteneur."),
        affirmation("La vitesse vaut $v = d/t$.", "on note $v=d/t$ la vitesse"),
        affirmation("L'énergie vaut $E = mc^2$."),
      ],
      blocs: [
        {
          type: "schema",
          titre: piege,
          noeuds: [{ titre: piege, affirmation: 0 }, { titre: "%%{init}%%" }, { titre: "C" }],
          relations: [
            { de: 0, vers: 1, lien: "cause", affirmation: 1 },
            { de: 1, vers: 2, lien: "suite", affirmation: 2 },
          ],
        },
      ],
    }),
  );
  assert(!rendu.includes("<script>"));
  assertStringIncludes(rendu, "<figcaption>&lt;script&gt;");
  assertStringIncludes(
    rendu,
    "<li><strong>&lt;script&gt;alert(1)&lt;/script&gt;&quot;</strong> : <span>La pile",
  );
  assertStringIncludes(rendu, "<li><strong>%%{init}%%</strong> précède <strong>C</strong> : ");
  assertEquals(
    [...rendu.matchAll(/citations\/(\d)/g)].map((m) => m[1]),
    ["0", "1", "2"],
  );
  // L'attribut porte le texte écrit par `texteMermaid`, échappé une seconde fois pour le HTML.
  const mermaid = rendu.match(/data-mermaid="([^"]*)"/)![1];
  assertStringIncludes(
    mermaid,
    "flowchart TD;\nn0[&quot;#lt;script#gt;alert(1)#lt;/script#gt;&#39; [1]&quot;];\nn1[&quot;%{init}%&quot;]",
  );
  assertStringIncludes(mermaid, "n0 --&gt;|&quot;entraîne [2]&quot;| n1");
  // Une formule que sa citation écrit se rend, l'autre reste du texte.
  assertStringIncludes(
    rendu,
    '<span>La vitesse vaut <span class="formule" data-tex="v = d/t">$v = d/t$</span>.</span>',
  );
  assertStringIncludes(rendu, "<span>L&#39;énergie vaut $E = mc^2$.</span>");
  assertEquals((rendu.match(/data-tex=/g) ?? []).length, 1);
});

test("un bloc mermaid du lecteur garde son code, sans front matter ni directive", async () => {
  const code = [
    "---",
    "config:",
    "  securityLevel: loose",
    "---",
    '%%{init: {"securityLevel": "loose"}}%%',
    "graph TD",
    '  A["<b>A</b>"] --> B',
    "%%{init: sans fin",
  ].join("\n");
  assertEquals(sansDirectives(code), '\ngraph TD\n  A["<b>A</b>"] --> B\n');
  const [schema, autre] = texteDocument([
    { id: "b1", texte: code, section: "", debut: 0, fin: 1, code: true, langage: "mermaid" },
    { id: "b2", texte: code, section: "", debut: 2, fin: 3, code: true, langage: "yaml" },
  ]);
  assertStringIncludes(
    String(await schema),
    '<pre id="b1" data-mermaid="\ngraph TD\n  A[&quot;&lt;b&gt;A&lt;/b&gt;&quot;] --&gt; B\n"><code>---\nconfig:',
  );
  assertStringIncludes(String(await autre), '<pre id="b2" data-langage="yaml"><code>---');
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
            theme: "Arts",
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

test("la liste de la bibliothèque range les ressources par cours, ou par thème dans un seul cours", async () => {
  const ligne = (
    id: string,
    titre: string,
    ordre: number | null,
    cours: string[],
    statut = "certifiee",
    theme: string | null = null,
    images_a_relire = 0,
  ) => ({
    id,
    titre,
    ordre,
    statut,
    cours: cours.map((c) => ({ id: c, nom: `Cours ${c}` })),
    theme,
    format: "md",
    etat: "awaiting_review",
    erreur: null,
    images_a_relire,
    revision_en_attente: 0,
    images: 0,
    legendes: 0,
    image_id: null,
  });
  const html = String(
    await lignesSources(
      [
        ligne("b2", "Suite", 2, ["b"]),
        ligne("b0", "Introduction", 0, ["b"], "certifiee", null, 1),
        ligne("a1", "Sans ordre", null, ["a"], "a_relire"),
        ligne("ab", "Commune", 1, ["a", "b"]),
      ],
      "",
    ),
  );
  const plis = html.split('<details class="pli"').slice(1);
  assertEquals(plis.length, 2);
  // Le cours A a une ressource à relire : son pli s'ouvre. Le cours B, tout certifié, reste fermé
  // malgré sa légende non relue, qu'il signale sans dire « certifiée ».
  assert(plis[0].startsWith(' data-pli="a" open') && plis[0].includes("1 à relire"));
  assert(plis[1].startsWith(' data-pli="b" >') && !plis[1].includes("à relire"));
  assertStringIncludes(plis[1], '<span class="statut unreviewed">1 légende non relue</span>');
  assert(!html.includes("certifiée"));
  const titres = (pli: string) =>
    [...pli.matchAll(/>([^<]+)<\/a><span class="pli-etat">/g)].map((m) => m[1]);
  assertEquals(titres(plis[0]), ["Commune", "Sans ordre"]);
  assertEquals(titres(plis[1]), ["Introduction", "Commune", "Suite"]);
  // L'introduction d'ordre 0 garde ce numéro. La ressource commune a une seconde case, à son id.
  assertStringIncludes(plis[1], 'aria-hidden="true">0</span>');
  assertStringIncludes(plis[1], 'id="selection-ab-1"');
  // Toutes dans un seul cours : un pli par séquence, et « Sans séquence » à la fin.
  const seul = String(
    await lignesSources(
      [
        ligne("s1", "Affiche", null, ["a"], "certifiee", "Bauhaus"),
        ligne("s2", "Chaise", null, ["a"], "certifiee", "Art nouveau"),
        ligne("s3", "Note", null, ["a"]),
      ],
      "",
      false,
      "",
      LIBELLES,
    ),
  );
  assertEquals(
    [...seul.matchAll(/data-pli="([^"]*)"/g)].map((m) => m[1]),
    ["Art nouveau", "Bauhaus", ""],
  );
  assertStringIncludes(seul, "Sans séquence");
});

test("hors d'un cours, la page Élèves liste d'abord les cours qui ont des élèves", async () => {
  const cours = (id: string) => ({
    id,
    matiere_id: "m",
    nom: `Cours ${id}`,
    public: "",
    objectif: "",
  });
  const cat = {
    matieres: [{ id: "m", nom: "Web", profil: "general" }],
    cours: ["a", "b", "c"].map(cours),
    themes: [],
  } as unknown as Parameters<typeof eleves>[0]["cat"];
  const eleve = { id: "e", identifiant: "ada", nom: "Ada" };
  const page = String(
    await eleves({
      cat,
      groupes: [
        { cours: cours("a"), eleves: [] },
        { cours: cours("b"), eleves: [eleve] },
        { cours: cours("c"), eleves: [] },
      ],
      adresse: "",
      l: { ...LIBELLES, cours: "Cours", cours_pluriel: "Cours" },
    }),
  );
  const ajout = page.slice(page.indexOf('class="ajout"'));
  assert(ajout.indexOf("Cours b") < ajout.indexOf("<details>"));
  assertStringIncludes(ajout, "<summary>2 cours sans élève</summary>");
  assert(ajout.indexOf("<details>") < ajout.indexOf("Cours a"));
});

test("une recherche sans résultat le dit et s'efface sans perdre les autres filtres", async () => {
  const f = { q: "zzz", statut: "a_relire", theme: "", lot: "", vue: "" };
  const vide = String(await sources([], f, [], LIBELLES, true));
  assertStringIncludes(vide, "Aucun titre de ressource ne contient « zzz ».");
  assertStringIncludes(vide, 'href="/prof?q=&amp;statut=a_relire&amp;');
  assert(!vide.includes("Déposer le premier"));
  // Sans recherche, une bibliothèque vide invite au premier dépôt.
  const neuve = String(await sources([], { ...f, q: "", statut: "" }, [], LIBELLES, true));
  assertStringIncludes(neuve, "Déposer le premier");
});

test("ressources statiques : feuille réunie, cache immuable sur les assets hachés, ETag/304 ailleurs", async () => {
  const { db, dir } = await environnement();
  const app = creerApp(db, fauxModeles().modeles);
  const dev = config.dev;
  try {
    config.dev = false;
    const htmlProd = String(page("Titre", null, ""));
    const liensProd = [...htmlProd.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(
      (m) => m[1],
    );
    assertEquals(liensProd.length, 1);
    assert(liensProd[0].startsWith("/static/dist/assets/styles-"), liensProd[0]);

    const css = await app.request(liensProd[0]);
    assertEquals(css.status, 200);
    assertEquals(css.headers.get("cache-control"), "public, max-age=31536000, immutable");

    const police = await app.request("/static/fonts/atkinson-hyperlegible-latin-400-normal.woff2");
    assertEquals(police.status, 200);
    assertEquals(police.headers.get("cache-control"), "public, max-age=31536000, immutable");

    const js = await app.request("/static/dist/app.js");
    assertEquals(js.status, 200);
    assertEquals(js.headers.get("cache-control"), "no-cache");
    const tag = js.headers.get("etag");
    assert(tag, "ETag attendu sur app.js");
    const revalidate = await app.request("/static/dist/app.js", {
      headers: { "if-none-match": tag },
    });
    assertEquals(revalidate.status, 304);

    assertEquals((await app.request("/static/dist/.vite/manifest.json")).status, 404);

    config.dev = true;
    const htmlDev = String(page("Titre", null, ""));
    const liensDev = [...htmlDev.matchAll(/<link rel="stylesheet" href="\/static\/css\/[^"]+">/g)];
    assertEquals(liensDev.length, 16);
  } finally {
    config.dev = dev;
    db.close();
    await rm(dir, { recursive: true });
  }
});
