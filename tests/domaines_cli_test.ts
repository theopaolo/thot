import { spawnSync } from "node:child_process";
import { mkdir, writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "node:path";
import { connexion } from "../src/app/db.ts";
import { RACINE } from "../src/app/config.ts";
import { catalogue, cours, matiere } from "../src/app/domaines.ts";
import { environnement } from "./outils.ts";
import { ressource } from "./domaines_outils.ts";

test("import CLI : un cours choisi sans thème range la source dans le thème du nom de son dossier", async () => {
  const { db, dir } = await environnement();
  try {
    const c = cours(db, matiere(db, "Physique"), "Optique");
    const ids = [
      await ressource(db, { sequence: "Lumière" }, [{ cours_id: c, theme_id: null }]),
      await ressource(db, { sequence: "Lumière" }, [{ cours_id: c, theme_id: null }]),
      await ressource(db, {}, [{ cours_id: c, theme_id: null }]),
    ];
    const themes = ids.map(
      (id) =>
        db
          .prepare(
            "SELECT t.nom FROM source_cours sc LEFT JOIN themes t ON t.id = sc.theme_id WHERE sc.source_id = ?",
          )
          .get(id)!.nom,
    );
    assertEquals(themes, ["Lumière", "Lumière", null]);
    assertEquals(catalogue(db).themes.length, 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("import CLI : un sous-dossier donne le thème, la racine du chemin va directement dans le cours", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thot-"));
  try {
    const cli = (...args: string[]) => {
      const r = spawnSync(process.execPath, ["src/cli.ts", ...args], {
        cwd: RACINE,
        encoding: "utf8",
        env: { ...process.env, THOT_DATA_DIR: dir, THOT_ORIGIN: "", THOT_MISTRAL_ENABLED: "0" },
      });
      assert(r.status === 0, r.stderr);
      return r.stdout.trim();
    };
    const racine = join(dir, "docker");
    for (const [chemin, texte] of [
      ["index.md", "Docker isole une application dans un conteneur."],
      ["Réseau/ponts.md", "Un pont relie les conteneurs d'un même hôte."],
      ["Réseau/annexes/ports.md", "Publier un port l'ouvre hors de l'hôte."],
      ["Volumes/nommes.md", "Un volume nommé survit au conteneur."],
    ]) {
      await mkdir(dirname(join(racine, chemin)), { recursive: true });
      await writeFile(join(racine, chemin), texte);
    }
    const m = cli("matiere", "Développement");
    const c = cli("cours", m, "Docker");
    cli("ingest", racine, `--matiere-id=${m}`, `--cours-id=${c}`);
    const db = connexion(join(dir, "state.sqlite3"));
    try {
      const rangees = db
        .prepare(
          `SELECT s.fichier, json_extract(s.metadonnees, '$.sequence') AS sequence, t.nom AS theme
           FROM sources s JOIN source_cours sc ON sc.source_id = s.id
           LEFT JOIN themes t ON t.id = sc.theme_id ORDER BY s.fichier`,
        )
        .all();
      assertEquals(
        rangees.map((r) => [r.fichier, r.theme]),
        [
          ["index.md", null],
          ["nommes.md", "Volumes"],
          ["ponts.md", "Réseau"],
          ["ports.md", "Réseau"],
        ],
      );
      // L'évaluation retrouve encore un fichier par le nom de son dossier.
      assertEquals(rangees[0].sequence, "docker");
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("CLI : configurer des collections, changer le profil, importer, rattacher, renommer, supprimer, refuser un second profil", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thot-"));
  try {
    const lancer = (...args: string[]) =>
      spawnSync(process.execPath, ["src/cli.ts", ...args], {
        cwd: RACINE,
        encoding: "utf8",
        env: {
          ...process.env,
          THOT_DATA_DIR: dir,
          THOT_ORIGIN: "",
          THOT_OPENROUTER_ENABLED: "0",
          THOT_MISTRAL_ENABLED: "0",
        },
      });
    const cli = async (...args: string[]) => {
      const r = lancer(...args);
      assert(r.status === 0, r.stderr);
      return r.stdout.trim();
    };
    const profils = async () =>
      JSON.parse(await cli("domaines")).matieres.map((m: { profil: string }) => m.profil);
    const arts = await cli("matiere", "Arts", "--profil=arts-appliques");
    const physique = await cli("matiere", "Physique");
    assertEquals(await profils(), ["arts-appliques", "arts-appliques"]);
    await cli("profil", "general");
    assertEquals(await profils(), ["general", "general"]);
    await cli("matiere", "REAPER");
    const socio = await cli("matiere", "Sociologie");
    const c = await cli("cours", physique, "Optique"),
      t = await cli("theme", c, "Introduction");
    await cli("compte", "lea", "Léa Martin", "eleve");
    const effectif = async () =>
      JSON.parse(await cli("domaines")).cours.find((x: { id: string }) => x.id === c).membres;
    assertEquals(await effectif(), 0);
    await cli("membre", c, "lea");
    await cli("membre", c, "LEA");
    assertEquals(await effectif(), 1);
    const inconnu = lancer("membre", c, "personne");
    assert(inconnu.status !== 0);
    assertStringIncludes(inconnu.stderr, "Compte introuvable");
    assert(lancer("membre", "absent", "lea").status !== 0);
    // Une commande refuse l'option d'une autre.
    const etrangere = lancer("matiere", "Chimie", "--niveau=1");
    assert(etrangere.status !== 0);
    assertStringIncludes(etrangere.stderr, "--niveau");
    assertEquals(await effectif(), 1);
    await cli("retirer-membre", c, "lea");
    assertEquals(await effectif(), 0);
    // `compte --cours` inscrit le compte qu'il crée. Un cours inconnu ne crée aucun compte.
    await cli("compte", "noe", "Noé Petit", "eleve", `--cours=${c}`);
    assertEquals(await effectif(), 1);
    assert(lancer("compte", "max", "Max Roux", "eleve", "--cours=absent").status !== 0);
    assert(
      lancer("compte", "max", "Max Roux", "eleve").status === 0,
      "le cours inconnu a créé max",
    );
    await cli("retirer-membre", c, "noe");
    const fichier = join(dir, "physique.html");
    await writeFile(fichier, "<p>La lumière traverse le prisme transparent.</p>");
    // L'import prend les lecteurs par défaut de l'instance.
    const reglage = connexion(join(dir, "state.sqlite3"));
    reglage.prepare("UPDATE instance SET lecteurs = 'collegues'").run();
    reglage.close();
    await cli(
      "ingest",
      fichier,
      `--matiere-id=${physique}`,
      `--cours-id=${c}`,
      `--theme-id=${t}`,
      "--auteur=Newton",
      "--langue=en",
    );
    await cli("traiter");
    const db = connexion(join(dir, "state.sqlite3"));
    try {
      const s = db.prepare("SELECT * FROM sources").get()!;
      assertEquals(s.profil, "general");
      assertEquals(s.langue, "en");
      assertEquals(s.audience, "collegues");
      const meta = JSON.parse(s.metadonnees as string);
      assertEquals(meta.auteur, "Newton");
      assertEquals(meta.classe, "");
      assertEquals(db.prepare("SELECT theme_id FROM source_cours").get()!.theme_id, t);
      const c2 = await cli("cours", arts, "Images");
      await cli("rattacher", s.id as string, c2);
      assertEquals(db.prepare("SELECT count(*) n FROM source_cours").get()!.n, 2);
      assert(lancer("profil", "arts-appliques").status !== 0);
      assert(lancer("matiere", "Design", "--profil=arts-appliques").status !== 0);
      assert(lancer("supprimer", "matiere", physique).status !== 0);
      await cli("renommer", "cours", c, "Optique", "géométrique");
      await cli("supprimer", "matiere", socio);
      assertEquals(
        db.prepare("SELECT nom FROM cours WHERE id = ?").get(c)!.nom,
        "Optique géométrique",
      );
      await cli("reextraire");
      await cli("rebuild");
      assertEquals(db.prepare("SELECT profil FROM sources").get()!.profil, "general");
      assertEquals(db.prepare("SELECT enseignant FROM sources").get()!.enseignant, s.enseignant);
      assertEquals(JSON.parse(await cli("domaines")).matieres.length, 3);
      assertEquals(db.prepare("SELECT count(*) n FROM sources").get()!.n, 1);
      // Sans sa dernière ressource, la matière se supprime.
      await cli("supprimer", "source", s.id as string);
      assertEquals(db.prepare("SELECT count(*) n FROM sources").get()!.n, 0);
      await cli("supprimer", "matiere", physique);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});
