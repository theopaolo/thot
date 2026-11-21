import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Db } from "../src/app/db.ts";
import { config } from "../src/app/config.ts";
import { creerCompte, creerLien } from "../src/app/comptes.ts";
import { cours, coursDuCompte, desinscrire, matiere } from "../src/app/domaines.ts";
import { creerApp } from "../src/app/routes.ts";
import { environnement, fauxModeles, ORIGINE } from "./outils.ts";
import {
  administrateur,
  compte,
  deuxCours,
  envoyer,
  nomme,
  type Qui,
  statut,
  texteDe,
} from "./acces_outils.ts";

test("élèves : seuls les administrateurs gèrent ceux sans cours", async () => {
  const { db, dir, c1, profA, profB, eleveA, eleveB } = await deuxCours();
  try {
    const sansCours = await compte(db, "eleve");
    const admin = await administrateur(db);
    const profSansCours = await compte(db, "enseignant");
    const eleves = [eleveA, eleveB, sansCours];
    const identifiant = (e: Qui) =>
      db.prepare("SELECT identifiant FROM comptes WHERE id = ?").get(e.id)!.identifiant as string;
    const empreinte = (e: Qui) =>
      db.prepare("SELECT empreinte FROM comptes WHERE id = ?").get(e.id)!.empreinte as string;
    const listes = async (qui: Qui) => {
      const page = await texteDe(qui, "/prof/eleves");
      return eleves.filter((e) => page.includes(identifiant(e))).map((e) => e.id);
    };
    const reinitialiser = (qui: Qui, e: Qui) =>
      statut(envoyer(qui, `/prof/eleves/${e.id}/reinitialiser`));
    const avantB = empreinte(eleveB);
    assertEquals(await reinitialiser(profA, eleveB), 404);
    assertEquals(empreinte(eleveB), avantB, "le mot de passe d'un autre cours a changé");
    const avantA = empreinte(eleveA);
    assertEquals(await reinitialiser(profA, eleveA), 200);
    assert(empreinte(eleveA) !== avantA, "le mot de passe n'a pas changé");
    const avantSansCours = empreinte(sansCours);
    assertEquals(await reinitialiser(profA, sansCours), 404);
    assertEquals(await reinitialiser(profSansCours, sansCours), 404);
    assertEquals(empreinte(sansCours), avantSansCours, "le mot de passe sans cours a changé");
    assertEquals(await listes(profA), [eleveA.id]);
    assertEquals(await listes(profB), [eleveB.id]);
    assertEquals(await listes(profSansCours), []);
    assertEquals(
      await listes(admin),
      eleves.map((e) => e.id),
    );

    assertEquals(await reinitialiser(profB, eleveA), 404);
    assertEquals(await reinitialiser(profB, eleveB), 200);
    assertEquals(await reinitialiser(admin, eleveA), 200);
    assertEquals(await reinitialiser(admin, eleveB), 200);
    assertEquals(await reinitialiser(admin, sansCours), 200);

    desinscrire(db, c1, eleveA.id);
    assertEquals(await listes(profA), []);
    assertEquals(
      await listes(admin),
      eleves.map((e) => e.id),
    );
    const apresRetrait = empreinte(eleveA);
    assertEquals(await reinitialiser(profA, eleveA), 404);
    assertEquals(await reinitialiser(profSansCours, eleveA), 404);
    assertEquals(empreinte(eleveA), apresRetrait, "le retrait a ouvert la réinitialisation");
    assertEquals(await reinitialiser(admin, eleveA), 200);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("élèves : un enseignant ajoute un élève à ses cours et l'en retire, le compte reste", async () => {
  const { db, dir, c1, c2, profA, profB, profC, eleveA, eleveB, publie, libre } = await deuxCours();
  try {
    const admin = await administrateur(db);
    const comptes = () => db.prepare("SELECT count(*) n FROM comptes").get()!.n as number;
    const ajouter = (qui: Qui, identifiant: string, cours: string[]) => {
      const corps = new URLSearchParams({ identifiant, nom: "Léa Martin" });
      for (const id of cours) corps.append("cours", id);
      return qui.requete("/prof/eleves/ajouter", { method: "POST", body: corps });
    };
    const retirer = (qui: Qui, eleveId: string, coursId: string) =>
      statut(envoyer(qui, `/prof/eleves/${eleveId}/retirer`, { cours_id: coursId }));

    const avant = comptes();
    const refus = await ajouter(profB, "lea.martin", [c1]);
    assertEquals(refus.status, 400);
    assertStringIncludes(await refus.text(), "vos cours");
    assertEquals((await ajouter(profA, "lea.martin", [])).status, 400);
    const pris = db.prepare("SELECT identifiant FROM comptes WHERE id = ?").get(eleveA.id)!;
    const doublon = await ajouter(profA, pris.identifiant as string, [c1]);
    assertEquals(doublon.status, 400);
    assertStringIncludes(await doublon.text(), "rejoint vos cours par un lien d");
    assertEquals((await ajouter(profA, "LÉA", [c1])).status, 400);
    assertEquals(comptes(), avant);

    // Le code s'affiche une fois. L'élève choisit son mot de passe, puis lit les ressources du cours.
    const feuille = await ajouter(profA, "lea.martin", [c1]);
    assertEquals(feuille.status, 200);
    assertEquals(feuille.headers.get("cache-control"), "no-store");
    const lea = db.prepare("SELECT id FROM comptes WHERE identifiant = 'lea.martin'").get()!
      .id as string;
    const cookie = await premiereConnexion(
      profA,
      "lea.martin",
      await codeRemis(feuille),
      "le secret de léa",
    );
    const lit = (id: string) =>
      statut(profA.app.request(`/eleve/sources/${id}`, { headers: { cookie } }));
    assertEquals(await lit(publie), 200);
    assertStringIncludes(await texteDe(profA, "/prof/eleves"), "lea.martin");
    assert(!(await texteDe(profB, "/prof/eleves")).includes("lea.martin"));

    // Un enseignant ne retire que les élèves de ses cours.
    assertEquals(await retirer(profB, lea, c1), 404);
    assertEquals(await retirer(profA, eleveB.id, c2), 404);
    assertEquals(await retirer(profA, profC.id, c1), 404);
    assertEquals(await lit(publie), 200);

    assertEquals(await retirer(profA, lea, c1), 303);
    assertEquals(await lit(publie), 404);
    assertEquals(await lit(libre), 200, "le compte retiré n'existe plus");
    assert(!(await texteDe(profA, "/prof/eleves")).includes("lea.martin"));
    assertEquals(await statut(envoyer(profA, `/prof/eleves/${lea}/reinitialiser`)), 404);
    const page = await texteDe(admin, "/prof/eleves");
    assert(page.indexOf("lea.martin") > page.indexOf("<h2>Sans cours</h2>"));
    assertEquals(await statut(envoyer(admin, `/prof/eleves/${lea}/reinitialiser`)), 200);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

/** Un lien d'inscription demandé par `qui` pour ces cours. */
const lienDe = (qui: Qui, cours: string[], places = "40") => {
  const corps = new URLSearchParams({ jours: "14", places });
  for (const id of cours) corps.append("cours", id);
  return qui.requete("/prof/eleves/liens", { method: "POST", body: corps });
};
const dernierJeton = (db: Db) =>
  db.prepare("SELECT jeton FROM liens ORDER BY rowid DESC LIMIT 1").get()!.jeton as string;
/** Une requête sans session, en GET, ou en POST avec un corps. */
const visiteur = (qui: Qui, chemin: string, corps?: Record<string, string>) =>
  qui.app.request(
    chemin,
    corps ? { method: "POST", headers: { origin: ORIGINE }, body: new URLSearchParams(corps) } : {},
  );
const LEA = { nom: "Léa Martin", identifiant: "lea.martin", mot_de_passe: "un mot de passe sûr" };

test("lien d'inscription : un visiteur crée son compte, un élève d'un autre cours rejoint d'un clic", async () => {
  const { db, dir, c1, c2, profA, profB, eleveB, publie } = await deuxCours();
  try {
    db.prepare("UPDATE comptes SET nom = 'M. Detienne' WHERE id = ?").run(profA.id);
    // Un enseignant ne crée de lien que pour ses cours.
    assertEquals(await statut(lienDe(profA, [c2])), 400);
    assertEquals(await statut(lienDe(profA, [])), 400);
    assertEquals(await statut(lienDe(profA, [c1], "0")), 400);
    assertEquals(db.prepare("SELECT count(*) n FROM liens").get()!.n, 0);
    assertEquals(await statut(lienDe(profA, [c1])), 303);
    const jeton = dernierJeton(db);
    assertEquals(Buffer.from(jeton, "base64url").length, 16);
    assertStringIncludes(await texteDe(profA, "/prof/eleves"), `/inscription/${jeton}`);
    assert(!(await texteDe(profB, "/prof/eleves")).includes(jeton));

    const page = await (await visiteur(profA, `/inscription/${jeton}`)).text();
    assertStringIncludes(page, "M. Detienne");
    assertStringIncludes(page, "Design");
    const places = () => db.prepare("SELECT places FROM liens WHERE jeton = ?").get(jeton)!.places;
    const comptes = () => db.prepare("SELECT count(*) n FROM comptes").get()!.n;
    const avant = comptes();
    const pris = db.prepare("SELECT identifiant FROM comptes WHERE id = ?").get(eleveB.id)!;
    for (const refus of [
      { ...LEA, mot_de_passe: "court" },
      { ...LEA, identifiant: pris.identifiant as string },
      { ...LEA, identifiant: "LÉA" },
    ]) {
      assertEquals(await statut(visiteur(profA, `/inscription/${jeton}`, refus)), 400);
    }
    assertEquals([comptes(), places()], [avant, 40]);

    // Le compte créé ouvre sa session sur /eleve et lit les ressources publiées du cours.
    const r = await visiteur(profA, `/inscription/${jeton}`, LEA);
    assertEquals(r.status, 303);
    assertEquals(r.headers.get("location"), "/eleve");
    const cookie = r.headers.get("set-cookie")!.split(";")[0];
    const commeLea = (chemin: string) => profA.app.request(chemin, { headers: { cookie } });
    assertEquals(await statut(commeLea("/eleve")), 200);
    assertEquals(await statut(commeLea(`/eleve/sources/${publie}`)), 200);
    assertEquals(places(), 39);
    assertStringIncludes(await texteDe(profA, "/prof/eleves"), "lea.martin");
    // Le mot de passe choisi reste le sien : la connexion n'en demande pas un autre.
    const connexion = await visiteur(profA, "/connexion", {
      identifiant: LEA.identifiant,
      mot_de_passe: LEA.mot_de_passe,
    });
    assertEquals(connexion.headers.get("location"), "/");

    // Un élève d'un autre cours rejoint d'un clic et garde ses cours. Un second clic est sans effet.
    assertStringIncludes(await texteDe(eleveB, `/inscription/${jeton}`), "Rejoindre</button>");
    assertEquals(await statut(envoyer(eleveB, `/inscription/${jeton}`)), 303);
    assertEquals(coursDuCompte(db, eleveB.id), new Set([c2, c1]));
    assertEquals(await statut(eleveB.requete(`/eleve/sources/${publie}`)), 200);
    assertEquals(await statut(envoyer(eleveB, `/inscription/${jeton}`)), 303);
    assertEquals(places(), 38);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("lien d'inscription : expiré, révoqué ou complet, il n'inscrit personne", async () => {
  const { db, dir, c1, profA, profB, eleveB } = await deuxCours();
  try {
    const comptes = () => db.prepare("SELECT count(*) n FROM comptes").get()!.n;
    const inutile = async (jeton: string) => {
      const avant = comptes();
      assertEquals(await statut(visiteur(profA, `/inscription/${jeton}`)), 404);
      const noe = { ...LEA, identifiant: "noe.petit" };
      assertEquals(await statut(visiteur(profA, `/inscription/${jeton}`, noe)), 404);
      assertEquals(await statut(envoyer(eleveB, `/inscription/${jeton}`)), 404);
      assertEquals(comptes(), avant);
      assert(!coursDuCompte(db, eleveB.id).has(c1));
    };

    await lienDe(profA, [c1], "1");
    const complet = dernierJeton(db);
    assertEquals(await statut(visiteur(profA, `/inscription/${complet}`, LEA)), 303);
    await inutile(complet);

    await lienDe(profA, [c1]);
    const expire = dernierJeton(db);
    db.prepare("UPDATE liens SET expire_le = '2000-01-01T00:00:00Z' WHERE jeton = ?").run(expire);
    await inutile(expire);

    // Seul un enseignant de ses cours révoque un lien. Les élèves qu'il a inscrits restent.
    await lienDe(profA, [c1]);
    const revoque = dernierJeton(db);
    const max = { ...LEA, identifiant: "max.roux" };
    assertEquals(await statut(visiteur(profA, `/inscription/${revoque}`, max)), 303);
    // La page désigne le lien par une clé : le jeton ne révoque rien.
    assertEquals(await statut(envoyer(profA, `/prof/eleves/liens/${revoque}/revoquer`)), 404);
    const revoquer = (await texteDe(profA, "/prof/eleves")).match(
      new RegExp(`/inscription/${revoque}".*?action="([^"]+/revoquer)"`, "s"),
    )![1];
    assertEquals(await statut(envoyer(profB, revoquer)), 404);
    assertEquals(await statut(envoyer(profA, revoquer)), 303);
    assert(!(await texteDe(profA, "/prof/eleves")).includes(revoque));
    await inutile(revoque);
    const maxId = db.prepare("SELECT id FROM comptes WHERE identifiant = 'max.roux'").get()!;
    assert(coursDuCompte(db, maxId.id as string).has(c1), "la révocation a retiré l'élève");

    // Un enseignant retiré du cours : son lien n'y inscrit plus.
    await lienDe(profA, [c1]);
    const orphelin = dernierJeton(db);
    desinscrire(db, c1, profA.id);
    await inutile(orphelin);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("lien d'inscription : une session enseignant n'est pas inscrite, la connexion revient au lien", async () => {
  const { db, dir, c1, profA, profB } = await deuxCours();
  try {
    const admin = await administrateur(db);
    await lienDe(profA, [c1]);
    const jeton = dernierJeton(db);
    for (const qui of [profB, admin]) {
      const avant = coursDuCompte(db, qui.id);
      assertStringIncludes(
        await texteDe(qui, `/inscription/${jeton}`),
        "Ce lien inscrit des élèves",
      );
      assertEquals(await statut(envoyer(qui, `/inscription/${jeton}`)), 403);
      assertEquals(coursDuCompte(db, qui.id), avant);
    }
    assertEquals(db.prepare("SELECT places FROM liens").get()!.places, 40);

    // Un élève qui a un compte se connecte, puis revient au lien. Aucune autre adresse de retour.
    const page = await (await visiteur(profA, `/inscription/${jeton}`)).text();
    assertStringIncludes(page, `/connexion?retour=/inscription/${jeton}`);
    const formulaire = await visiteur(profA, `/connexion?retour=/inscription/${jeton}`);
    assertStringIncludes(await formulaire.text(), `value="/inscription/${jeton}"`);
    const ailleurs = await (await visiteur(profA, "/connexion?retour=/prof")).text();
    assert(!ailleurs.includes('name="retour"'));
    const motDePasse = await creerCompte(db, "noe.petit", "Noé Petit", "eleve");
    const retour = async (adresse: string) =>
      (
        await visiteur(profA, "/connexion", {
          identifiant: "noe.petit",
          mot_de_passe: motDePasse,
          retour: adresse,
        })
      ).headers.get("location");
    assertEquals(await retour(`/inscription/${jeton}`), `/inscription/${jeton}`);
    for (const adresse of [
      "https://exemple.org/inscription/x",
      "//exemple.org/inscription/x",
      "/\\exemple.org/inscription/x",
      "/prof",
      "/inscription/",
      "/inscription/../prof",
      "/inscription/x?y=1",
    ]) {
      assertEquals(await retour(adresse), "/", adresse);
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

/** Une connexion sans session, avec ce mot de passe. */
const entrer = (qui: Qui, identifiant: string, mot_de_passe: string) =>
  visiteur(qui, "/connexion", { identifiant, mot_de_passe });
const cookieDe = (r: Response) => r.headers.get("set-cookie")!.split(";")[0];
/** L'élève consomme le code remis, choisit son mot de passe et se reconnecte. Rend son cookie. */
async function premiereConnexion(qui: Qui, identifiant: string, code: string, choisi: string) {
  const provisoire = cookieDe(await entrer(qui, identifiant, code));
  await qui.app.request("/mot-de-passe", {
    method: "POST",
    headers: { origin: ORIGINE, cookie: provisoire },
    body: new URLSearchParams({ mot_de_passe: choisi, confirmation: choisi }),
  });
  return cookieDe(await entrer(qui, identifiant, choisi));
}
const codeRemis = async (feuille: Response) =>
  (await feuille.text()).match(/Mot de passe : <strong>([0-9a-f]+)</)![1];

test("mot de passe : celui que remet un enseignant est provisoire, l'élève choisit le sien", async () => {
  const { db, dir, c1, profA, publie } = await deuxCours();
  try {
    const corps = new URLSearchParams({ identifiant: "lea.martin", nom: "Léa Martin", cours: c1 });
    const code = await codeRemis(
      await profA.requete("/prof/eleves/ajouter", { method: "POST", body: corps }),
    );
    const lea = db.prepare("SELECT id FROM comptes WHERE identifiant = 'lea.martin'").get()!
      .id as string;
    const avec = (cookie: string, chemin: string, init: RequestInit = {}) =>
      profA.app.request(chemin, { ...init, headers: { origin: ORIGINE, cookie } });

    // Le code ne sert qu'une fois et n'ouvre que la page du choix.
    const entree = await entrer(profA, "lea.martin", code);
    assertEquals(entree.headers.get("location"), "/mot-de-passe");
    const provisoire = cookieDe(entree);
    assertEquals(await statut(entrer(profA, "lea.martin", code)), 401);
    assertEquals((await avec(provisoire, "/eleve")).headers.get("location"), "/mot-de-passe");
    const choix = await (await avec(provisoire, "/mot-de-passe")).text();
    assertStringIncludes(choix, "Choisis ton mot de passe");
    assert(!choix.includes('name="ancien"'));
    const choisir = (mot_de_passe: string) =>
      avec(provisoire, "/mot-de-passe", {
        method: "POST",
        body: new URLSearchParams({ mot_de_passe, confirmation: mot_de_passe }),
      });
    assertEquals(await statut(choisir("court")), 400);
    assertEquals((await choisir("le secret de léa")).headers.get("location"), "/connexion");
    // L'enseignant qui garde la feuille ne se connecte plus avec.
    assertEquals(await statut(entrer(profA, "lea.martin", code)), 401);
    const cookie = cookieDe(await entrer(profA, "lea.martin", "le secret de léa"));
    assertEquals(await statut(avec(cookie, `/eleve/sources/${publie}`)), 200);

    // Une réinitialisation ferme la session et remet un code, provisoire lui aussi.
    const nouveau = await codeRemis(await envoyer(profA, `/prof/eleves/${lea}/reinitialiser`));
    assertEquals(await statut(avec(cookie, "/eleve")), 302);
    assertEquals(await statut(entrer(profA, "lea.martin", "le secret de léa")), 401);
    assertEquals(
      (await entrer(profA, "lea.martin", nouveau)).headers.get("location"),
      "/mot-de-passe",
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("mot de passe : un élève et un enseignant le changent en donnant l'ancien", async () => {
  const { db, dir } = await environnement();
  try {
    const app = creerApp(db, fauxModeles().modeles);
    for (const [role, accueil] of [
      ["eleve", "/eleve"],
      ["enseignant", "/prof"],
    ] as const) {
      const ancien = await creerCompte(db, role, `Compte ${role}`, role);
      const entrer = (mot_de_passe: string) =>
        app.request("/connexion", {
          method: "POST",
          headers: { origin: ORIGINE },
          body: new URLSearchParams({ identifiant: role, mot_de_passe }),
        });
      const cookie = cookieDe(await entrer(ancien));
      const avec = (chemin: string, corps?: Record<string, string>) =>
        app.request(chemin, {
          method: corps ? "POST" : "GET",
          headers: { origin: ORIGINE, cookie },
          body: corps && new URLSearchParams(corps),
        });
      assertStringIncludes(await (await avec(accueil)).text(), 'href="/mot-de-passe"');
      const formulaire = await avec("/mot-de-passe");
      assertEquals(formulaire.status, 200);
      assertStringIncludes(await formulaire.text(), 'name="ancien"');
      const changer = (ancien: string, mot_de_passe = "un nouveau secret") =>
        avec("/mot-de-passe", { ancien, mot_de_passe, confirmation: mot_de_passe });
      assertEquals(await statut(changer("pas le bon")), 400);
      assertEquals(await statut(changer("")), 400);
      assertEquals(await statut(changer(ancien, "court")), 400);
      assertEquals(await statut(avec(accueil)), 200, "un refus a fermé la session");
      assertEquals((await changer(ancien)).headers.get("location"), "/connexion");
      // Le changement ferme toutes les sessions du compte.
      assertEquals(await statut(avec(accueil)), 302);
      assertEquals(await statut(entrer(ancien)), 401);
      assertEquals((await entrer("un nouveau secret")).headers.get("location"), "/");
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("lien d'inscription : son adresse ne se montre qu'aux enseignants de tous ses cours", async () => {
  const { db, dir, c1, c2, profA, profB } = await deuxCours();
  try {
    const deux = await compte(db, "enseignant", undefined, [c1, c2]);
    const admin = await administrateur(db);
    assertEquals(await statut(lienDe(deux, [c1, c2])), 303);
    const jeton = dernierJeton(db);
    for (const qui of [deux, admin]) {
      assertStringIncludes(await texteDe(qui, "/prof/eleves"), `/inscription/${jeton}`);
    }
    // L'enseignant d'un seul de ses cours sait que le lien existe, sans son adresse ni l'autre
    // cours. Il le révoque quand même : le lien ouvre son cours.
    for (const [qui, autre] of [
      [profA, "Histoire de l'art"],
      [profB, "Design"],
    ] as const) {
      const page = await texteDe(qui, "/prof/eleves");
      assertStringIncludes(page, "40 places restantes");
      assert(!page.includes(jeton), "le jeton est dans la page");
      assert(!nomme(page, autre), `la page nomme ${autre}`);
    }
    const revoquer = (await texteDe(profA, "/prof/eleves")).match(
      /action="(\/prof\/eleves\/liens\/[^"]+\/revoquer)"/,
    )![1];
    const etranger = await compte(db, "enseignant");
    assertEquals(await statut(envoyer(etranger, revoquer)), 404);
    assertEquals(await statut(envoyer(profA, revoquer)), 303);
    assertEquals(await statut(visiteur(profA, `/inscription/${jeton}`)), 404);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("lien d'inscription : un identifiant pris est refusé comme un identifiant invalide", async () => {
  const { db, dir, c1, profA } = await deuxCours();
  try {
    await lienDe(profA, [c1]);
    const jeton = dernierJeton(db);
    const pris = db.prepare("SELECT identifiant FROM comptes WHERE id = ?").get(profA.id)!
      .identifiant as string;
    const comptes = () => db.prepare("SELECT count(*) n FROM comptes").get()!.n;
    const avant = comptes();
    const refus = async (identifiant: string) => {
      const r = await visiteur(profA, `/inscription/${jeton}`, { ...LEA, identifiant });
      assertEquals(r.status, 400);
      return (await r.text()).match(/<p role="alert">(.*?)<\/p>/s)![1];
    };
    const message = await refus(pris);
    assert(!/utilisé|existe/.test(message), message);
    assertEquals(message, await refus("x"));
    assertEquals(comptes(), avant);
    assertEquals(db.prepare("SELECT places FROM liens").get()!.places, 40);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("lien d'inscription : son adresse part de l'origine configurée, pas de la requête", async () => {
  const { db, dir } = await environnement();
  const avant = config.origine;
  try {
    config.origine = "https://thot.example.org";
    const c1 = cours(db, matiere(db, "Arts appliqués"), "Design");
    const mot_de_passe = await creerCompte(db, "prof", "Prof", "enseignant", [c1]);
    const app = creerApp(db, fauxModeles().modeles);
    // Le proxy termine TLS : l'application reçoit la requête en HTTP.
    const requete = (chemin: string, init: RequestInit = {}, cookie = "") =>
      app.request(`http://thot.example.org${chemin}`, {
        ...init,
        headers: { origin: config.origine, cookie },
      });
    const cookie = cookieDe(
      await requete("/connexion", {
        method: "POST",
        body: new URLSearchParams({ identifiant: "prof", mot_de_passe }),
      }),
    );
    const id = db.prepare("SELECT id FROM comptes").get()!.id as string;
    const jeton = creerLien(db, id, [c1], 14, 40);
    assertStringIncludes(
      await (await requete("/prof/eleves", {}, cookie)).text(),
      `data-copier="https://thot.example.org/inscription/${jeton}"`,
    );
    const feuille = await requete(
      "/prof/eleves/ajouter",
      {
        method: "POST",
        body: new URLSearchParams({ identifiant: "lea.martin", nom: "Léa Martin", cours: c1 }),
      },
      cookie,
    );
    assertStringIncludes(await feuille.text(), "Adresse : <span>https://thot.example.org</span>");
  } finally {
    config.origine = avant;
    db.close();
    await rm(dir, { recursive: true });
  }
});
