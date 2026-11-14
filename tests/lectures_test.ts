import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { activiteProf, inserer, publier as publierActivite, relire } from "../src/app/activites.ts";
import { type Compte, lireCompte } from "../src/app/comptes.ts";
import { type Db, purgerMessages } from "../src/app/db.ts";
import { affiliations, cours, matiere, theme } from "../src/app/domaines.ts";
import type { Contenu } from "../src/core/activite.ts";
import { environnement, fauxModeles, publier, session } from "./outils.ts";

const ordonner = (db: Db, id: string, ordre: number) =>
  db
    .prepare("UPDATE sources SET metadonnees = json_set(metadonnees, '$.ordre', ?) WHERE id = ?")
    .run(ordre, id);

/** Un exercice publié dans le cours, dont l'unique question renvoie à `ou` pour chercher. */
function exercice(db: Db, prof: Compte, coursId: string, titre: string, ou?: string) {
  const contenu: Contenu = {
    correction: "serie",
    questions: [
      {
        id: "q1",
        type: "redigee",
        consigne: { texte: "Q ?", citations: [] },
        retour: { texte: "", citations: [] },
        attendu: { texte: "R.", citations: [] },
        criteres: [],
        ...(ou && { ou }),
      },
    ],
  };
  const id = inserer(db, prof, {
    type: "exercice",
    coursId,
    objectifId: "",
    intitule: titre,
    reference: "",
    titre,
    contenu,
  });
  const a = activiteProf(db, prof, id)!;
  assert(relire(db, prof, a, a.revision));
  assertEquals(publierActivite(db, prof, id, a.revision), "publiee");
  return id;
}

const dernierCompte = (db: Db) =>
  lireCompte(
    db,
    db.prepare("SELECT id FROM comptes ORDER BY rowid DESC LIMIT 1").get()!.id as string,
  )!;

test("marquer lue une ressource demande de pouvoir la lire", async () => {
  const { db } = await environnement();
  const c = cours(db, matiere(db, "Informatique"), "Docker");
  const source = await publier(db, "Les conteneurs", c);
  const membre = await session(db, fauxModeles().modeles, "eleve");
  const horsCours = await session(db, fauxModeles().modeles, "eleve", false);
  const lectures = () => db.prepare("SELECT compte_id, revision FROM lectures").all();

  for (const chemin of [`/eleve/sources/${source}/lu`, "/eleve/sources/inconnue/lu"]) {
    assertEquals((await horsCours.requete(chemin, { method: "POST" })).status, 404, chemin);
  }
  assertEquals(lectures().length, 0);
  assertEquals(
    (await membre.requete(`/eleve/sources/${source}/lu`, { method: "POST" })).status,
    204,
  );
  assertEquals(
    lectures().map((l) => l.revision),
    [1],
  );
  // Le lecteur porte la sentinelle qui envoie cette lecture.
  assertStringIncludes(
    await (await membre.requete(`/eleve/sources/${source}`)).text(),
    `data-fin-lecture="/eleve/sources/${source}/lu"`,
  );
});

test("le sommaire d'un cours numérote ses ressources et place ses activités", async () => {
  const { db } = await environnement();
  const c = cours(db, matiere(db, "Informatique"), "Docker");
  const approfondir = theme(db, c, "Approfondir");
  const intro = await publier(db, "Introduction", c);
  const images = await publier(db, "Les images", c);
  const volumes = await publier(db, "Les volumes", c);
  const reseaux = await publier(db, "Les réseaux", c);
  affiliations(db, reseaux, [{ cours_id: c, theme_id: approfondir }]);
  // Des ordres avec des trous : le numéro suit la position. Le thème vient après les ressources
  // sans thème, même avec un ordre plus petit.
  for (const [id, ordre] of [
    [intro, 0],
    [images, 2],
    [volumes, 5],
    [reseaux, 1],
  ] as const) {
    ordonner(db, id, ordre);
  }
  await session(db, fauxModeles().modeles, "enseignant");
  const auteur = dernierCompte(db);
  const surImages = exercice(db, auteur, c, "Construire une image", images);
  const general = exercice(db, auteur, c, "Bilan du cours");
  const eleve = await session(db, fauxModeles().modeles, "eleve");
  const sommaire = async () => (await eleve.requete(`/eleve?cours_id=${c}`)).text();

  let page = await sommaire();
  const positions = [
    `/eleve/sources/${intro}"`,
    `/eleve/sources/${images}"`,
    `/eleve/activites/${surImages}"`,
    `/eleve/sources/${volumes}"`,
    "<h3>Approfondir</h3>",
    `/eleve/sources/${reseaux}"`,
    `/eleve/activites/${general}"`,
  ].map((x) => page.indexOf(x));
  assert(
    positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])),
    `ordre du sommaire : ${positions}`,
  );
  for (const [n, id] of [intro, images, volumes, reseaux].entries()) {
    assertStringIncludes(
      page,
      `<span class="numero chiffres">${n}</span><a href="/eleve/sources/${id}">`,
    );
  }
  assertStringIncludes(page, '<span class="chiffres">4</span> chapitres');
  assertStringIncludes(page, '<span class="chiffres">1</span> question');
  assertStringIncludes(page, "Commencer ici");
  assert(!page.includes("Tu en es là"));

  await eleve.requete(`/eleve/sources/${intro}/lu`, { method: "POST" });
  page = await sommaire();
  assert(!page.includes("Commencer ici"));
  assertStringIncludes(page, '<span class="chiffres">1 sur 4</span> lu');
  const ici = /<li class="ici">(.*?)<\/li>/.exec(page)?.[1] ?? "";
  assertStringIncludes(ici, `/eleve/sources/${images}"`);
  assertStringIncludes(ici, "Tu en es là");
  assertStringIncludes(page, `<li class="lu"><span class="numero chiffres">0</span>`);

  // Un autre élève n'a rien lu : les lectures sont à chaque compte.
  const autre = await session(db, fauxModeles().modeles, "eleve");
  assertStringIncludes(await (await autre.requete(`/eleve?cours_id=${c}`)).text(), "Commencer ici");

  // Limité au thème, le sommaire garde ses ressources sans les activités qui citent ailleurs.
  const dansTheme = await (
    await eleve.requete(`/eleve?cours_id=${c}&theme_id=${approfondir}`)
  ).text();
  assertStringIncludes(dansTheme, `/eleve/sources/${reseaux}"`);
  assert(!dansTheme.includes(`/eleve/sources/${images}"`));
  assert(!dansTheme.includes(`/eleve/activites/${general}"`));

  // À la racine, le cours a sa ligne, sa progression et ses activités à faire.
  const racine = await (await eleve.requete("/eleve")).text();
  assertStringIncludes(racine, `<a href="/eleve?cours_id=${c}">Docker</a>`);
  assertStringIncludes(racine, '<span class="chiffres">1 sur 4</span>');
  assertStringIncludes(racine, '<span class="chiffres">2</span> à faire');
});

test("le sommaire numérote à partir de 1 sans introduction d'ordre 0", async () => {
  const { db } = await environnement();
  const c = cours(db, matiere(db, "Informatique"), "Veille");
  const premiere = await publier(db, "Choisir ses sources", c);
  ordonner(db, premiere, 3);
  await publier(db, "Trier", c);
  const eleve = await session(db, fauxModeles().modeles, "eleve");
  const page = await (await eleve.requete(`/eleve?cours_id=${c}`)).text();
  assertStringIncludes(
    page,
    `<span class="numero chiffres">1</span><a href="/eleve/sources/${premiere}">`,
  );
  assert(!page.includes('<span class="numero chiffres">0</span>'));
});

test("la purge supprime les lectures plus anciennes que la rétention", async () => {
  const { db } = await environnement();
  const c = cours(db, matiere(db, "Informatique"), "Docker");
  const ancienne = await publier(db, "Les images", c);
  const recente = await publier(db, "Les volumes", c);
  await session(db, fauxModeles().modeles, "eleve");
  const compte = dernierCompte(db);
  const lire = db.prepare("INSERT INTO lectures VALUES (?, ?, 1, ?)");
  lire.run(compte.id, ancienne, "2026-01-01T00:00:00Z");
  lire.run(compte.id, recente, "2026-03-20T00:00:00Z");
  purgerMessages(db, 30, Date.parse("2026-04-01T00:00:00Z"));
  assertEquals(
    db
      .prepare("SELECT source_id FROM lectures")
      .all()
      .map((l) => l.source_id),
    [recente],
  );
});
