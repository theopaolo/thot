import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { creerCompte, lireCompte } from "../src/app/comptes.ts";
import { config, RACINE } from "../src/app/config.ts";
import * as Conversations from "../src/app/conversations.ts";
import { connexion, type Db, migrer, purgerMessages } from "../src/app/db.ts";
import { cours, desinscrire, inscrire, matiere } from "../src/app/domaines.ts";
import { quand } from "../src/app/vues/eleve.ts";
import { BONNE, environnement, fauxModeles, publier, session } from "./outils.ts";

type Session = Awaited<ReturnType<typeof session>>;
const envoyer = (qui: Session, chemin: string, corps: Record<string, string>, htmx = false) =>
  qui.requete(chemin, {
    method: "POST",
    headers: htmx ? { "HX-Request": "true" } : {},
    body: new URLSearchParams(corps),
  });
/** Pose une question comme le composeur et rend l'échange créé. */
async function poser(qui: Session, corps: Record<string, string>) {
  const r = await envoyer(qui, "/eleve/questions", corps, true);
  return { statut: r.status, texte: await r.text() };
}
const idDe = (fragment: string) => fragment.match(/messages\/([\w-]+)\/flux/)![1];
const conversationDe = (db: Db, message: string) =>
  db.prepare("SELECT conversation_id FROM messages WHERE id = ?").get(message)!
    .conversation_id as string;
const texteDe = async (qui: Session, chemin: string) => (await qui.requete(chemin)).text();

test("deux conversations : historique, reformulation et sources ne se mêlent pas", async () => {
  const { db, dir } = await environnement();
  try {
    await publier(db, "Casa Batlló");
    const f = fauxModeles({ sorties: [BONNE, BONNE, BONNE, BONNE] });
    const reformulees: string[] = [];
    f.modeles.reformuler = (precedente, question) => {
      reformulees.push(`${precedente} / ${question}`);
      return Promise.resolve(question);
    };
    const eleve = await session(db, f.modeles, "eleve");
    const repondre = async (corps: Record<string, string>) => {
      const id = idDe((await poser(eleve, corps)).texte);
      await texteDe(eleve, `/eleve/messages/${id}/flux`);
      return id;
    };
    const a = conversationDe(db, await repondre({ texte: "Gaudí et la façade, version A ?" }));
    const b = conversationDe(db, await repondre({ texte: "Gaudí et la céramique, version B ?" }));
    assert(a !== b, "une question sans conversation en ouvre une");
    await repondre({ texte: "Et la ligne droite, en A ?", conversation: a });
    await repondre({ texte: "Et la céramique, en B ?", conversation: b });
    assertEquals(reformulees, [
      "Gaudí et la façade, version A ? / Et la ligne droite, en A ?",
      "Gaudí et la céramique, version B ? / Et la céramique, en B ?",
    ]);
    const demande = f.vus.at(-1)![1].content as string;
    assertStringIncludes(demande, "Question précédente : Gaudí et la céramique, version B ?");
    assert(!demande.includes("version A"));

    const pageA = await texteDe(eleve, `/eleve/chat/${a}`);
    // La liste nomme chaque conversation : seuls les échanges de A suivent son titre.
    const filA = pageA.slice(
      pageA.indexOf('id="conversation"'),
      pageA.indexOf('class="pied-chat"'),
    );
    assertStringIncludes(filA, "Et la ligne droite, en A ?");
    assert(!filA.includes("version B") && !filA.includes("en B ?"));
    assertStringIncludes(pageA, `name="conversation" value="${a}"`);
    assertStringIncludes(await texteDe(eleve, "/eleve/chat"), "Et la céramique, en B ?");
    assertEquals(
      db
        .prepare("SELECT rang FROM messages WHERE conversation_id = ? ORDER BY cree_le, rowid")
        .all(a)
        .map((m) => m.rang),
      [1, 2],
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("conversation : un autre compte reçoit le même 404 qu'un identifiant inconnu", async () => {
  const { db, dir } = await environnement();
  try {
    await publier(db, "Casa Batlló");
    const f = fauxModeles({ sorties: [BONNE] });
    const proprietaire = await session(db, f.modeles, "eleve");
    const autre = await session(db, f.modeles, "eleve");
    const mid = idDe((await poser(proprietaire, { texte: "Question privée sur la façade" })).texte);
    assertStringIncludes(await texteDe(proprietaire, `/eleve/messages/${mid}/flux`), "Gaudí");
    const conv = conversationDe(db, mid);
    // Chaque route qui prend un identifiant de conversation ou d'échange.
    const routes = (c: string, m: string): [string, string, Record<string, string>?][] => [
      ["GET", `/eleve/chat/${c}`],
      ["GET", `/eleve/conversations/${c}/etat`],
      ["POST", `/eleve/chat/${c}/renommer`, { titre: "Volé" }],
      ["POST", `/eleve/chat/${c}/archiver`, {}],
      ["POST", `/eleve/chat/${c}/desarchiver`, {}],
      ["POST", `/eleve/chat/${c}/perimetre`, { matiere_id: "", cours_id: "", theme_id: "" }],
      ["POST", "/eleve/questions", { texte: "Intrus", conversation: c }],
      ["POST", `/eleve/messages/${m}/relancer`, {}],
      ["POST", `/eleve/messages/${m}/arreter`, {}],
      ["POST", `/eleve/messages/${m}/avis`, { avis: "faux" }],
      ["GET", `/eleve/messages/${m}/flux`],
      ["GET", `/eleve/messages/${m}/citations/0`],
    ];
    for (const [c, m] of [
      [conv, mid],
      ["inconnue", "inconnu"],
    ]) {
      for (const [methode, chemin, corps] of routes(c, m)) {
        const r = await autre.requete(chemin, {
          method: methode,
          ...(corps && { body: new URLSearchParams(corps) }),
        });
        assertEquals(r.status, 404, `${methode} ${chemin}`);
      }
    }
    // Les lectures du propriétaire répondent, elles.
    for (const [, chemin] of routes(conv, mid).filter(([methode]) => methode === "GET")) {
      assertEquals((await proprietaire.requete(chemin)).status, 200, chemin);
    }
    assert(!(await texteDe(autre, "/eleve/chat")).includes("Question privée sur la façade"));
    const ligne = db.prepare("SELECT titre, archivee_le FROM conversations").get()!;
    assertEquals({ ...ligne }, { titre: "Question privée sur la façade", archivee_le: null });
    assertEquals(
      { ...db.prepare("SELECT etat, avis FROM messages").get() },
      { etat: "answered", avis: null },
    );
    assertEquals(db.prepare("SELECT count(*) AS n FROM messages").get()!.n, 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("envoi : clé rejouée, une réponse à la fois, conversation archivée en lecture seule", async () => {
  const { db, dir } = await environnement();
  try {
    await publier(db, "Casa Batlló");
    const f = fauxModeles();
    const libre = Promise.withResolvers<void>();
    f.modeles.generer = async () => {
      await libre.promise;
      return { texte: BONNE, modele: "faux" };
    };
    const eleve = await session(db, f.modeles, "eleve");
    // La première question, renvoyée avec sa clé, n'ouvre qu'une conversation.
    const premiere = { texte: "Pourquoi pas de ligne droite ?", cle: "k1" };
    const [r1, r2] = [
      await envoyer(eleve, "/eleve/questions", premiere),
      await envoyer(eleve, "/eleve/questions", premiere),
    ];
    assertEquals([r1.status, r2.status], [303, 303]);
    assertEquals(r1.headers.get("location"), r2.headers.get("location"));
    const conv = r1.headers.get("location")!.split("/").pop()!;
    assertEquals(db.prepare("SELECT count(*) AS n FROM conversations").get()!.n, 1);
    assertStringIncludes(await texteDe(eleve, "/eleve/conversations"), "Réponse en cours");

    const suite = { texte: "Et la façade ?", conversation: conv, cle: "k2" };
    const refus = await poser(eleve, suite);
    assertEquals(refus.statut, 409);
    assertEquals(refus.texte, "Une réponse est déjà en cours dans cette conversation.");
    const premier = db.prepare("SELECT id FROM messages").get()!.id as string;
    libre.resolve();
    await texteDe(eleve, `/eleve/messages/${premier}/flux`);
    const envoi = await poser(eleve, suite);
    const renvoi = await poser(eleve, suite);
    assertEquals([envoi.statut, renvoi.statut], [200, 200]);
    assertEquals(idDe(renvoi.texte), idDe(envoi.texte));
    assertEquals(db.prepare("SELECT count(*) AS n FROM messages").get()!.n, 2);

    const archiver = await envoyer(eleve, `/eleve/chat/${conv}/archiver`, {});
    assertEquals(archiver.headers.get("location"), "/eleve/chat?archivee=1");
    const ailleurs = await poser(eleve, { ...suite, cle: "k3" });
    assertEquals(ailleurs.statut, 409);
    assertStringIncludes(ailleurs.texte, "archivée dans un autre onglet");
    const apres = await texteDe(eleve, "/eleve/chat?archivee=1");
    assertStringIncludes(apres, "Conversation archivée.");
    assertStringIncludes(apres, "Aucune conversation pour l'instant.");
    assertStringIncludes(apres, "Conversations archivées (1)");
    const lecture = await texteDe(eleve, `/eleve/chat/${conv}`);
    assertStringIncludes(lecture, "Cette conversation est archivée.");
    assert(!lecture.includes('id="envoi"'));
    assertStringIncludes(await texteDe(eleve, "/eleve/conversations/archivees"), premiere.texte);
    await envoyer(eleve, `/eleve/chat/${conv}/desarchiver`, {});
    assertStringIncludes(await texteDe(eleve, `/eleve/chat/${conv}`), 'id="envoi"');
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("module : un autre compte n'atteint rien, une seule réponse en file par conversation", async () => {
  const { db, dir } = await environnement();
  try {
    const compte = async (identifiant: string) => {
      await creerCompte(db, identifiant, identifiant, "eleve");
      const id = db.prepare("SELECT id FROM comptes WHERE identifiant = ?").get(identifiant)!.id;
      return lireCompte(db, id as string)!;
    };
    const [a, b] = [await compte("eleve-a"), await compte("eleve-b")];
    const vide = { matiere_id: "", cours_id: "", theme_id: "" };
    const r = Conversations.poser(db, a, { texte: "Une question", cle: null, perimetre: vide });
    assert(typeof r !== "string");
    const suite = { texte: "Une autre", cle: null, perimetre: vide, conversation: r.conversation };
    assertEquals(Conversations.poser(db, a, suite), "en_cours");

    assertEquals(Conversations.poser(db, b, suite), "introuvable");
    assertEquals(Conversations.relancer(db, b, r.echange), "introuvable");
    assertEquals(Conversations.changerPerimetre(db, b, r.conversation, vide), "introuvable");
    assertEquals(
      [
        Conversations.arreter(db, b, r.echange),
        Conversations.renommer(db, b, r.conversation, "Autre titre"),
        Conversations.archiver(db, b, r.conversation, true),
        Conversations.donnerAvis(db, b, r.echange, "utile"),
      ],
      [false, false, false, false],
    );
    assertEquals(Conversations.conversationDe(db, b, r.conversation), undefined);
    assertEquals(Conversations.echange(db, b, r.echange), undefined);
    assertEquals(Conversations.echanges(db, b, r.conversation), []);

    // Arrêtée, la réponse libère la conversation. Une question en file empêche de relancer.
    assert(Conversations.arreter(db, a, r.echange));
    assertEquals(Conversations.echange(db, a, r.echange)?.resultat, Conversations.ARRETEE);
    assert(typeof Conversations.poser(db, a, suite) !== "string");
    assertEquals(Conversations.relancer(db, a, r.echange), "en_cours");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("titre : la question coupée sur une fin de mot, puis le dernier titre enregistré", async () => {
  const { db, dir } = await environnement();
  try {
    const eleve = await session(db, fauxModeles().modeles, "eleve");
    const longue =
      "Pourquoi la façade de la Casa Batlló évoque-t-elle la mer, les os et les masques du carnaval ?";
    const r = await envoyer(eleve, "/eleve/questions", { texte: longue });
    const conv = r.headers.get("location")!.split("/").pop()!;
    const titre = () => db.prepare("SELECT titre FROM conversations").get()!.titre as string;
    assertEquals(
      titre(),
      "Pourquoi la façade de la Casa Batlló évoque-t-elle la mer, les os et les masques",
    );
    const renommer = (t: string) => envoyer(eleve, `/eleve/chat/${conv}/renommer`, { titre: t });
    assertEquals((await renommer("  ")).status, 400);
    assertEquals((await renommer("x".repeat(121))).status, 400);
    assertEquals((await renommer("Gaudí")).status, 303);
    assertEquals((await renommer("Gaudí et la mer")).status, 303);
    assertEquals(titre(), "Gaudí et la mer");
    assertStringIncludes(await texteDe(eleve, `/eleve/chat/${conv}`), "Gaudí et la mer</h1>");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("recherche : titre et questions, jokers LIKE littéraux, archivées seulement dans leur vue", async () => {
  const { db, dir } = await environnement();
  try {
    const f = fauxModeles();
    const eleve = await session(db, f.modeles, "eleve");
    const autre = await session(db, f.modeles, "eleve");
    const ouvrir = async (texte: string) =>
      (await envoyer(eleve, "/eleve/questions", { texte })).headers
        .get("location")!
        .split("/")
        .pop()!;
    await ouvrir("Gaudí et la façade");
    const b = await ouvrir("Bauhaus à 100% pur");
    const c = await ouvrir("Céramique irisée");
    await envoyer(eleve, `/eleve/chat/${c}/renommer`, { titre: "Divers" });
    const trouve = async (q: string, chemin = "/eleve/conversations") => {
      const page = await texteDe(eleve, `${chemin}?${new URLSearchParams({ q })}`);
      return [...page.matchAll(/conversation-titre">([^<]+)</g)].map((m) => m[1]);
    };
    assertEquals(await trouve("façade"), ["Gaudí et la façade"]);
    assertEquals(await trouve("irisée"), ["Divers"], "la question d'une conversation renommée");
    assertEquals(await trouve("%"), ["Bauhaus à 100% pur"], "le % est cherché tel quel");
    assertEquals(await trouve("_"), []);
    assertEquals(await trouve("Ba%pur"), []);
    assertStringIncludes(
      await texteDe(eleve, "/eleve/conversations?q=zzz"),
      "Aucune conversation ne correspond à « zzz ».",
    );
    assertStringIncludes(await texteDe(eleve, "/eleve/conversations?q=%3Cb%3E"), "« &lt;b&gt; »");
    assert(!(await texteDe(autre, "/eleve/conversations?q=façade")).includes("Gaudí"));
    // HTMX ne reçoit que les résultats, la page entière arrive sans lui.
    const fragment = await (
      await eleve.requete("/eleve/conversations?q=façade", { headers: { "HX-Request": "true" } })
    ).text();
    assertStringIncludes(fragment, 'id="resultats-conversations"');
    assert(!fragment.includes("<form") && !fragment.includes("<html"));
    const ouverte = await texteDe(eleve, `/eleve/chat/${c}`);
    assertStringIncludes(ouverte, 'role="search"');
    assertStringIncludes(ouverte, `name="courante" value="${c}"`);
    assertStringIncludes(ouverte, `data-memoire="`);
    // Archivée, B ne sort que de la vue des archives.
    await envoyer(eleve, `/eleve/chat/${b}/archiver`, {});
    assertEquals(await trouve("Bauhaus"), []);
    assertEquals(await trouve("Bauhaus", "/eleve/conversations/archivees"), ["Bauhaus à 100% pur"]);
    assertEquals(await trouve("façade", "/eleve/conversations/archivees"), []);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("périmètre : chaque échange garde le sien, un changement revérifie l'accès", async () => {
  const { db, dir } = await environnement();
  try {
    const m = matiere(db, "Arts appliqués");
    const design = cours(db, m, "Design");
    const histoire = cours(db, m, "Histoire de l'art");
    await publier(db, "Cours du design", design);
    await publier(db, "Cours d'histoire", histoire);
    const eleve = await session(db, fauxModeles({ sorties: [BONNE] }).modeles, "eleve", false);
    const compte = db.prepare("SELECT id FROM comptes WHERE role = 'eleve'").get()!.id as string;
    inscrire(db, design, compte);
    const premier = idDe((await poser(eleve, { texte: "Question", cours_id: design })).texte);
    const conv = conversationDe(db, premier);
    await texteDe(eleve, `/eleve/messages/${premier}/flux`);
    const perimetre = (cours_id: string) =>
      envoyer(eleve, `/eleve/chat/${conv}/perimetre`, { matiere_id: "", cours_id, theme_id: "" });
    assertEquals((await perimetre(histoire)).status, 400, "cours dont l'élève n'est pas membre");
    assertEquals((await perimetre("")).status, 303);
    const second = idDe((await poser(eleve, { texte: "Autre", conversation: conv })).texte);
    const scope = (id: string) =>
      db.prepare("SELECT cours_id FROM messages WHERE id = ?").get(id)!.cours_id;
    assertEquals([scope(premier), scope(second)], [design, ""]);
    assertStringIncludes(
      await texteDe(eleve, `/eleve/chat/${conv}`),
      "Périmètre changé : toutes tes ressources",
    );

    // L'élève quitte le cours : le périmètre de la conversation devient indisponible.
    await texteDe(eleve, `/eleve/messages/${second}/flux`);
    assertEquals((await perimetre(design)).status, 303);
    desinscrire(db, design, compte);
    const page = await texteDe(eleve, `/eleve/chat/${conv}`);
    assertStringIncludes(page, "Dans : Cours indisponible");
    assertStringIncludes(page, "Ce périmètre n'est plus disponible.");
    assertEquals((await poser(eleve, { texte: "Encore", conversation: conv })).statut, 400);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("rétention : une conversation vidée par la purge disparaît avec son titre", async () => {
  const { db, dir } = await environnement();
  try {
    const eleve = await session(db, fauxModeles().modeles, "eleve");
    const vieille = conversationDe(db, idDe((await poser(eleve, { texte: "Ancienne" })).texte));
    const gardee = conversationDe(db, idDe((await poser(eleve, { texte: "Récente" })).texte));
    db.prepare(
      "UPDATE messages SET cree_le = '2020-01-01T00:00:00Z' WHERE conversation_id = ?",
    ).run(vieille);
    assertEquals(purgerMessages(db, 90), 1);
    assertEquals(
      db
        .prepare("SELECT id FROM conversations")
        .all()
        .map((c) => c.id),
      [gardee],
    );
    assert(!(await texteDe(eleve, "/eleve/conversations")).includes("Ancienne"));
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("migrations des conversations et des réponses : échanges intacts, génération orpheline en file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thot-"));
  config.donnees = dir;
  const db = connexion(join(dir, "state.sqlite3"));
  try {
    db.exec("CREATE TABLE migrations (nom TEXT PRIMARY KEY, applique_le TEXT NOT NULL)");
    for (const nom of readdirSync(join(RACINE, "migrations")).sort()) {
      if (nom >= "0013") continue;
      db.exec(readFileSync(join(RACINE, "migrations", nom), "utf8"));
      db.prepare("INSERT INTO migrations VALUES (?, 'fixture')").run(nom);
    }
    db.exec(`INSERT INTO comptes (id, identifiant, nom, role, sel, empreinte, cree_le)
      VALUES ('a', 'a', 'A', 'eleve', '', '', 'x'), ('b', 'b', 'B', 'eleve', '', '', 'x')`);
    // La séquence « Bauhaus » est rangée dans un thème renommé. Un autre cours a un thème
    // « Bauhaus » sans ces sources. « Lumière » est rattachée à un cours sans thème.
    db.exec(`INSERT INTO matieres (id, nom, profil) VALUES ('m', 'Arts', 'arts-appliques');
      INSERT INTO cours (id, matiere_id, nom) VALUES ('c', 'm', 'Design'), ('c2', 'm', 'Autre');
      INSERT INTO themes VALUES ('t', 'c', 'Bauhaus 1919'), ('t2', 'c2', 'Bauhaus');
      INSERT INTO sources (id, school_id, titre, metadonnees, fichier, format, checksum, octets,
        enseignant, cree_le) VALUES
        ('s', 'pilote', 'S', '{"sequence":"Bauhaus"}', 's.html', 'html', 's', 1, 'P', 'x'),
        ('s2', 'pilote', 'S2', '{"sequence":"Lumière"}', 's2.html', 'html', 's2', 1, 'P', 'x');
      INSERT INTO source_cours VALUES ('s', 'c', 't'), ('s2', 'c', NULL);`);
    const resultat = JSON.stringify({
      etat: "answered",
      affirmations: [{ texte: "T", citation: "C", source_id: "source-citee", titre: "S" }],
    });
    const message = db.prepare(
      `INSERT INTO messages (id, compte_id, question, etat, resultat, chapitre, cree_le, maj_le)
       VALUES (?, ?, ?, 'answered', ?, ?, ?, ?)`,
    );
    message.run("a2", "a", "Deuxième", resultat, "", "2026-02-01T00:00:00Z", "x");
    message.run("a1", "a", "Première", resultat, "", "2026-01-01T00:00:00Z", "x");
    message.run("a3", "a", "Dans la séquence", null, "Bauhaus", "2026-03-01T00:00:00Z", "x");
    message.run("b1", "b", "De B", null, "", "2026-01-01T00:00:00Z", "x");
    // Une génération que tenait le flux SSE d'un ancien serveur repart de la file.
    db.exec("UPDATE messages SET etat = 'en_cours', generation_id = 'ancien' WHERE id = 'b1'");
    assertEquals(migrer(db).slice(0, 2), ["0013_conversations.sql", "0014_reponses.sql"]);
    assertEquals(
      {
        ...db.prepare("SELECT etat, generation_id, tentatives FROM messages WHERE id = 'b1'").get(),
      },
      { etat: "en_attente", generation_id: null, tentatives: 0 },
    );
    assertEquals(db.prepare("SELECT count(*) AS n FROM messages WHERE nouvelle").get()!.n, 0);
    const lignes = db
      .prepare(
        `SELECT m.id, m.compte_id, m.rang, m.resultat, v.compte_id AS proprietaire, v.titre,
         v.chapitre, v.cree_le, v.active_le, v.id AS conversation
         FROM messages m JOIN conversations v ON v.id = m.conversation_id ORDER BY m.id`,
      )
      .all();
    assertEquals(
      lignes.map((l) => [l.id, l.proprietaire, l.rang, l.titre, l.chapitre]),
      [
        ["a1", "a", 1, "Anciennes questions", ""],
        ["a2", "a", 2, "Anciennes questions", ""],
        ["a3", "a", 1, "Anciennes questions", "Bauhaus"],
        ["b1", "b", 1, "Anciennes questions", ""],
      ],
    );
    // Le chapitre devient le thème où sont rangées les sources de la séquence.
    assertEquals(
      {
        ...db
          .prepare(
            `SELECT m.theme_id, v.theme_id AS conversation FROM messages m
             JOIN conversations v ON v.id = m.conversation_id WHERE m.id = 'a3'`,
          )
          .get(),
      },
      { theme_id: "t", conversation: "t" },
    );
    assertEquals(
      db
        .prepare(
          "SELECT t.nom FROM source_cours sc JOIN themes t ON t.id = sc.theme_id WHERE sc.source_id = 's2'",
        )
        .get()!.nom,
      "Lumière",
    );
    assertEquals(lignes[0].conversation, lignes[1].conversation);
    assertEquals(new Set(lignes.map((l) => l.conversation)).size, 3);
    assertEquals(lignes[1].resultat, resultat, "les citations gardent leur source");
    assertEquals(
      [lignes[0].cree_le, lignes[0].active_le],
      ["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"],
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("dernière activité : l'heure du jour, hier, puis la date", () => {
  const maintenant = Date.parse("2026-10-16T12:00:00Z");
  assertEquals(quand("2026-10-16T12:02:00Z", maintenant), "14 h 02");
  assertEquals(quand("2026-10-15T09:00:00Z", maintenant), "hier");
  assertEquals(quand("2026-10-12T09:00:00Z", maintenant), "12 oct.");
});
