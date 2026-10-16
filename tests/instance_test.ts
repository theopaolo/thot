import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { test } from "vite-plus/test";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "node:path";
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import {
  authentifier,
  creerAdministrateur,
  creerCompte,
  reinitialiserMotDePasse,
} from "../src/app/comptes.ts";
import { config, RACINE } from "../src/app/config.ts";
import { cacheModeles, connexion, migrer } from "../src/app/db.ts";
import { deposer } from "../src/app/depot.ts";
import { configurerInstance, lireInstance } from "../src/app/instance.ts";
import { revendiquer, statuer, traiter } from "../src/app/ingestion.ts";
import { creerApp } from "../src/app/routes.ts";
import { environnement, fauxModeles, ORIGINE, session } from "./outils.ts";

test("migration du pilote : comptes, sources, cache et identité conservés", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thot-"));
  const avant = config.donnees;
  config.donnees = dir;
  const db = connexion();
  try {
    db.exec("CREATE TABLE migrations (nom TEXT PRIMARY KEY, applique_le TEXT NOT NULL)");
    for (const nom of [
      "0001_depot.sql",
      "0002_mvp.sql",
      "0003_suggestions.sql",
      "0004_pilote.sql",
      "0005_coherence.sql",
    ]) {
      db.exec(await readFile(join(RACINE, "migrations", nom), "utf8"));
      db.prepare("INSERT INTO migrations VALUES (?, 'fixture')").run(nom);
    }
    const mdp = await creerCompte(db, "pilote", "Prof pilote", "enseignant");
    db.exec(`INSERT INTO sources
      (id, school_id, titre, metadonnees, fichier, format, checksum, octets, enseignant, cree_le)
      VALUES ('ancien', 'ecole-historique', 'Document', '{}', 'cours.html', 'html', 'abc', 1, 'Prof', 'fixture')`);
    db.exec(`INSERT INTO chunks (id, source_id, school_id, titre, debut, fin, texte, rappel, preuve)
      VALUES ('chk_0', 'ancien', 'ecole-historique', 'Document', 0, 5, 'Texte', 'Texte', 'Texte')`);
    cacheModeles(db).ecrire("commun", "pilote");
    db.exec(`INSERT INTO messages (id, compte_id, question, etat, cree_le, maj_le)
      SELECT 'historique', id, 'Question du pilote', 'out_of_corpus', 'fixture', 'fixture' FROM comptes`);
    assertEquals(migrer(db), [
      "0006_instance.sql",
      "0007_domaines.sql",
      "0008_acces.sql",
      "0009_membres.sql",
      "0010_liens.sql",
      "0011_revisions.sql",
      "0012_reglages.sql",
      "0013_conversations.sql",
      "0014_reponses.sql",
      "0015_lots.sql",
      "0016_comparaison.sql",
      "0017_suppression.sql",
      "0018_themes.sql",
      "0019_activites.sql",
      "0020_credits.sql",
    ]);
    const instance = lireInstance(db);
    assertEquals(instance.school_id, "ecole-historique");
    assertEquals(instance.mode, "shared");
    assertEquals((await authentifier(db, "pilote", mdp))?.administrateur, 0);
    assertEquals(await authentifier(db, "pilote", "mauvais"), null);
    assertEquals(cacheModeles(db).lire("commun"), "pilote");
    assertEquals(db.prepare("SELECT question FROM messages").get()!.question, "Question du pilote");
    assertEquals(db.prepare("SELECT school_id FROM sources").get()!.school_id, "ecole-historique");
    // Les fichiers du pilote et son index deviennent la révision 1, servie.
    assertEquals(
      {
        ...db
          .prepare(
            `SELECT s.revision AS servie, r.n, c.revision AS indexee FROM sources s
             JOIN revisions r ON r.source_id = s.id JOIN chunks c ON c.source_id = s.id`,
          )
          .get(),
      },
      { servie: 1, n: 1, indexee: 1 },
    );
    assertEquals(migrer(db), []);
    configurerInstance(db, "Nouveau nom");
    assertEquals(lireInstance(db).id, instance.id);
    assertEquals(lireInstance(db).school_id, instance.school_id);
    assertThrows(() => configurerInstance(db, ""));
    assertThrows(() => configurerInstance(db, undefined, "personal"));
    assertThrows(() => configurerInstance(db, "Autre", "invalide"));
    assertEquals(lireInstance(db).nom, "Nouveau nom");
    const code = await creerAdministrateur(db, "pilote", "Prof pilote");
    assertEquals((await authentifier(db, "pilote", code))?.administrateur, 1);
    assertEquals(db.prepare("SELECT count(*) n FROM comptes").get()!.n, 1);
  } finally {
    db.close();
    config.donnees = avant;
    await rm(dir, { recursive: true });
  }
});

test("administrateur personnel : code à usage unique, changement obligatoire, récupération", async () => {
  const { db, dir } = await environnement();
  const dev = config.dev;
  try {
    const app = creerApp(db, fauxModeles().modeles);
    configurerInstance(db, "Mon étude <privée>", "personal");
    const code = await creerAdministrateur(db, "owner", "Alex");
    await assertRejects(() => creerAdministrateur(db, "second", "Second"));
    const login = (mot_de_passe: string) =>
      app.request("/connexion", {
        method: "POST",
        headers: { origin: ORIGINE },
        body: new URLSearchParams({ identifiant: "owner", mot_de_passe }),
      });
    config.dev = true;
    assertEquals((await login("mauvais")).status, 401);
    config.dev = false;
    const entree = await login(code);
    assertEquals(entree.headers.get("location"), "/mot-de-passe");
    const provisoire = entree.headers.get("set-cookie")!.split(";")[0];
    assertEquals((await login(code)).status, 401);
    const requete = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: { origin: ORIGINE, cookie: provisoire },
      });
    assertEquals((await requete("/prof")).headers.get("location"), "/mot-de-passe");
    assert(!(await (await requete("/mot-de-passe")).text()).includes('href="/prof"'));
    assertEquals((await requete("/administration")).headers.get("location"), "/mot-de-passe");
    const changer = (mot_de_passe: string, confirmation = mot_de_passe) =>
      requete("/mot-de-passe", {
        method: "POST",
        body: new URLSearchParams({ mot_de_passe, confirmation }),
      });
    assertEquals((await changer("court")).status, 400);
    assertEquals((await changer("mot-de-passe-long", "autre")).status, 400);
    assertEquals((await changer("mot-de-passe-long")).headers.get("location"), "/connexion");
    assertEquals((await requete("/administration")).headers.get("location"), "/connexion");
    const entreeComplete = await login("mot-de-passe-long");
    const cookie = entreeComplete.headers.get("set-cookie")!.split(";")[0];
    const get = (path: string) => app.request(path, { headers: { cookie } });
    assertEquals((await get("/")).headers.get("location"), "/eleve");
    assertStringIncludes(await (await get("/eleve")).text(), "Mes documents");
    const gestion = await (await get("/prof")).text();
    assert(!gestion.includes('href="/prof/eleves"'));
    assertStringIncludes(gestion, "Mon étude &lt;privée&gt;");
    // Un dépôt personnel n'a qu'un lecteur : les lecteurs par défaut ne se règlent pas.
    const administration = await get("/administration");
    assertEquals(administration.status, 200);
    assert(!(await administration.text()).includes('name="lecteurs"'));
    const formulaire = new FormData();
    for (const [k, v] of Object.entries({
      titre: "Cours",
      type_document: "cours",
      matiere: "physique-chimie",
    }))
      formulaire.set(k, v);
    formulaire.set(
      "fichier",
      new File(["<html><p>Un document sans classe.</p></html>"], "cours.html"),
    );
    assertEquals(
      (
        await app.request("/prof/depot", {
          method: "POST",
          headers: { cookie, origin: ORIGINE },
          body: formulaire,
        })
      ).status,
      200,
    );
    const meta = JSON.parse(
      db.prepare("SELECT metadonnees FROM sources").get()!.metadonnees as string,
    );
    assertEquals(meta.classe, "");
    const prof = await session(db, fauxModeles().modeles, "enseignant");
    assertEquals((await prof.requete("/administration")).status, 403);
    const id = db.prepare("SELECT id FROM comptes WHERE administrateur = 1").get()!.id as string;
    const recuperation = await reinitialiserMotDePasse(db, id, "enseignant");
    assertEquals((await get("/administration")).headers.get("location"), "/connexion");
    assertEquals((await login("mot-de-passe-long")).status, 401);
    assertEquals((await login(recuperation!)).headers.get("location"), "/mot-de-passe");
  } finally {
    config.dev = dev;
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("deux déploiements et restauration indépendante, mêmes comptes et titres", async () => {
  const racine = await mkdtemp(join(tmpdir(), "thot-"));
  const avant = config.donnees;
  const processus = new Set<ChildProcess>();
  const cli = async (dir: string, ...args: string[]) => {
    const sortie = spawnSync(process.execPath, ["src/cli.ts", ...args], {
      cwd: RACINE,
      encoding: "utf8",
      env: {
        ...process.env,
        THOT_DATA_DIR: dir,
        OPENROUTER_API_KEY: "cle-interdite",
        MISTRAL_API_KEY: "cle-interdite",
        THOT_OPENROUTER_ENABLED: "0",
        THOT_MISTRAL_ENABLED: "0",
        THOT_ORIGIN: "",
        THOT_DEV: "0",
      },
    });
    assert(sortie.status === 0, sortie.stderr);
    return sortie.stdout;
  };
  const preparer = async (nom: string) => {
    const dir = join(racine, nom);
    await cli(dir, "instance", `--nom=${nom}`);
    config.donnees = dir;
    const db = connexion();
    try {
      const mdp = await creerCompte(db, "commun", "Compte commun", "enseignant");
      db.exec("UPDATE comptes SET id = 'compte-commun'");
      const { source_id } = await deposer(db, {
        nomFichier: "cours.html",
        format: "html",
        schoolId: lireInstance(db).school_id,
        enseignant: "Prof",
        audience: "eleves",
        reponses: true,
        octets: new TextEncoder().encode(
          `<html><p>Texte confidentiel ${nom} avec un contenu pédagogique propre à cette instance.</p></html>`,
        ),
        meta: {
          titre: "Titre commun",
          type_document: "cours",
          matiere: "arts-appliques",
          classe: "terminale",
          sous_matiere: "",
          sequence: "",
          seance: "",
          resume: "",
          objectifs: "",
          evaluation: "",
        },
      });
      await traiter(db, revendiquer(db)!, fauxModeles().modeles);
      statuer(db, source_id, "certifiee", "Prof");
      // L'import crée le cours « Arts appliqués » : l'opérateur y inscrit le compte.
      db.exec("INSERT INTO membres_cours SELECT id, 'compte-commun' FROM cours");
      cacheModeles(db).ecrire("cle-commune", nom);
      const id = lireInstance(db).id;
      return { dir, mdp, source_id, id };
    } finally {
      db.close();
    }
  };
  const lancer = async (dir: string) => {
    const reservation = createServer().listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const { port } = reservation.address() as { port: number };
    reservation.close();
    const origine = `http://127.0.0.1:${port}`;
    const p = spawn(process.execPath, ["src/main.ts"], {
      cwd: RACINE,
      stdio: "ignore",
      env: {
        ...process.env,
        THOT_DATA_DIR: dir,
        THOT_HOST: "127.0.0.1",
        THOT_PORT: String(port),
        THOT_ORIGIN: origine,
        OPENROUTER_API_KEY: "cle-interdite",
        MISTRAL_API_KEY: "cle-interdite",
        THOT_OPENROUTER_ENABLED: "0",
        THOT_MISTRAL_ENABLED: "0",
        THOT_DEV: "0",
        THOT_SECRET: "",
      },
    });
    processus.add(p);
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`${origine}/connexion`);
        await r.text();
        if (r.ok) return { p, origine };
      } catch {
        /* Le serveur n'écoute pas encore. */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Le déploiement ne démarre pas.");
  };
  const arreter = async (p: ChildProcess) => {
    const fin = once(p, "exit");
    p.kill("SIGTERM");
    assertEquals((await fin)[0], 0, "un arrêt demandé sort en 0");
    processus.delete(p);
  };
  const requete = async (origine: string, path: string, cookie = "", body?: URLSearchParams) => {
    const r = await fetch(origine + path, {
      redirect: "manual",
      method: body ? "POST" : "GET",
      headers: { origin: origine, cookie },
      body,
    });
    return { status: r.status, headers: r.headers, texte: await r.text() };
  };
  const login = async (origine: string, mdp: string) => {
    const r = await requete(
      origine,
      "/connexion",
      "",
      new URLSearchParams({ identifiant: "commun", mot_de_passe: mdp }),
    );
    assertEquals(r.status, 302);
    const cookie = r.headers.get("set-cookie")!;
    assertStringIncludes(cookie, "HttpOnly");
    assert(!cookie.includes("Domain="));
    return cookie.split(";")[0];
  };
  try {
    const a = await preparer("Atelier A");
    const b = await preparer("Atelier B");
    assert(a.id !== b.id);
    let serveurA = await lancer(a.dir);
    const serveurB = await lancer(b.dir);
    const cookieA = await login(serveurA.origine, a.mdp);
    const cookieB = await login(serveurB.origine, b.mdp);
    assertEquals(
      (
        await requete(
          serveurB.origine,
          "/connexion",
          "",
          new URLSearchParams({ identifiant: "commun", mot_de_passe: a.mdp }),
        )
      ).status,
      401,
    );
    assertEquals(
      (await requete(serveurB.origine, "/prof", cookieA)).headers.get("location"),
      "/connexion",
    );
    assertEquals(
      (await requete(serveurB.origine, "/prof", cookieA.replace(a.id, b.id))).headers.get(
        "location",
      ),
      "/connexion",
    );
    assertStringIncludes(
      (await requete(serveurA.origine, `/eleve/sources/${a.source_id}`, cookieA)).texte,
      "Atelier A",
    );
    assertEquals(
      (await requete(serveurB.origine, `/eleve/sources/${a.source_id}`, cookieB)).status,
      404,
    );
    assertStringIncludes(
      (await requete(serveurB.origine, `/eleve/sources/${b.source_id}`, cookieB)).texte,
      "Atelier B",
    );
    assert(
      (await readFile(join(a.dir, "secret"), "utf8")) !==
        (await readFile(join(b.dir, "secret"), "utf8")),
    );
    assert((await stat(join(a.dir, "tmp"))).isDirectory());
    await arreter(serveurA.p);
    const sauvegarde = join(racine, "sauvegarde-a");
    await cp(a.dir, sauvegarde, { recursive: true });
    await cli(a.dir, "instance", "--nom=Modifié après sauvegarde");
    await rm(a.dir, { recursive: true });
    await cp(sauvegarde, a.dir, { recursive: true });
    serveurA = await lancer(a.dir);
    assertStringIncludes(
      (await requete(serveurA.origine, `/eleve/sources/${a.source_id}`, cookieA)).texte,
      "Atelier A",
    );
    assertStringIncludes(
      (await requete(serveurB.origine, `/eleve/sources/${b.source_id}`, cookieB)).texte,
      "Atelier B",
    );
    for (const [dir, valeur] of [
      [a.dir, "Atelier A"],
      [b.dir, "Atelier B"],
    ]) {
      config.donnees = dir;
      const db = connexion();
      assertEquals(cacheModeles(db).lire("cle-commune"), valeur);
      db.close();
    }
    const politique = JSON.parse(await cli(a.dir, "instance"));
    assert(
      politique.traitements.every(
        (f: { autorise: boolean; disponible: boolean }) => !f.autorise && !f.disponible,
      ),
    );
    assertEquals(politique.id, a.id);
  } finally {
    for (const p of processus) await arreter(p);
    config.donnees = avant;
    await rm(racine, { recursive: true });
  }
});

test("origine HTTPS derrière proxy : cookies sécurisés et formulaires limités à l'instance", async () => {
  const { db, dir } = await environnement();
  const avant = config.origine;
  try {
    config.origine = "https://thot.example.org";
    const mdp = await creerCompte(db, "prof", "Prof", "enseignant");
    const app = creerApp(db, fauxModeles().modeles);
    const login = (origin: string) =>
      app.request("http://thot.example.org/connexion", {
        method: "POST",
        headers: { origin },
        body: new URLSearchParams({ identifiant: "prof", mot_de_passe: mdp }),
      });
    assertEquals((await login("https://autre.example.org")).status, 403);
    assertEquals((await app.request("http://autre.example.org/connexion")).status, 421);
    const r = await login(config.origine);
    assertEquals(r.status, 302);
    const cookie = r.headers.get("set-cookie")!;
    assert(cookie.startsWith("__Host-thot_session_"));
    assertStringIncludes(cookie, "Secure");
    assertStringIncludes(cookie, "HttpOnly");
    assertStringIncludes(cookie, "Path=/");
    assert(!cookie.includes("Domain="));
    const sortie = await app.request("http://thot.example.org/deconnexion", {
      method: "POST",
      headers: { origin: config.origine, cookie: cookie.split(";")[0] },
    });
    assertStringIncludes(sortie.headers.get("set-cookie")!, "Secure");
  } finally {
    config.origine = avant;
    db.close();
    await rm(dir, { recursive: true });
  }
});
