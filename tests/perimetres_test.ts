import { readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { filtre } from "../src/app/vues/perimetre.ts";
import { cours, matiere, theme } from "../src/app/domaines.ts";
import { revendiquer, statuer, traiter } from "../src/app/ingestion.ts";
import { formes } from "../src/core/accords.ts";
import { PROFILS } from "../src/core/profils.ts";
import { environnement, fauxModeles, session } from "./outils.ts";

test("dépôt web et questions : périmètres par identifiants conservés jusqu’au flux, erreurs sans données partielles", async () => {
  const { db, dir } = await environnement();
  try {
    const m = matiere(db, "Sociologie"),
      c = cours(db, m, "Théories"),
      t = theme(db, c, "Auteurs");
    const citation = "Durkheim décrit les faits sociaux comme des manières collectives de penser.";
    const faux = fauxModeles({
      sorties: [JSON.stringify({ affirmations: [{ texte: citation, extrait: 1, citation }] })],
    });
    const prof = await session(db, faux.modeles, "enseignant");
    const form = new FormData();
    for (const [k, v] of Object.entries({
      titre: "Faits sociaux",
      type_document: "cours",
      matiere_id: m,
      auteur: "Durkheim",
      cours: c,
      [`theme_${c}`]: t,
    }))
      form.set(k, v);
    form.append("audience", "eleves");
    form.append("reponses", "1");
    form.set("fichier", new File([`<p>${citation}</p>`], "social.html"));
    assertEquals((await prof.requete("/prof/depot", { method: "POST", body: form })).status, 200);
    await traiter(db, revendiquer(db)!, faux.modeles);
    const id = db.prepare("SELECT id FROM sources").get()!.id as string;
    statuer(db, id, "certifiee", "Prof");
    const eleve = await session(db, faux.modeles, "eleve");
    const page = await (await eleve.requete(`/eleve?cours_id=${c}&theme_id=${t}`)).text();
    assertStringIncludes(page, "Faits sociaux");
    assertStringIncludes(page, '<span class="etiquette" id="etiquette-cours">Cours</span>');
    assert(/bouton-cours">\s*Théories, Auteurs/.test(page), "le choix ne montre pas le thème");
    const recherche = await (
      await eleve.requete(`/eleve/recherche?q=faits&cours_id=${c}&theme_id=${t}`)
    ).text();
    assertStringIncludes(recherche, `name="cours_id" value="${c}"`);
    assertStringIncludes(recherche, `name="theme_id" value="${t}"`);
    assertEquals(
      (
        await eleve.requete("/eleve/questions", {
          method: "POST",
          body: new URLSearchParams({ texte: "faits sociaux", cours_id: c, theme_id: t }),
        })
      ).status,
      303,
    );
    const message = db.prepare("SELECT * FROM messages").get()!;
    assertEquals(message.cours_id, c);
    assertEquals(message.theme_id, t);
    assertEquals(message.chapitre, "");
    const flux = await (await eleve.requete(`/eleve/messages/${message.id}/flux`)).text();
    assertStringIncludes(flux, "Durkheim");
    assertEquals(
      (
        await eleve.requete("/eleve/questions", {
          method: "POST",
          body: new URLSearchParams({ texte: "Question", theme_id: "absent" }),
        })
      ).status,
      400,
    );
    form.set(`theme_${c}`, "absent");
    form.set("fichier", new File(["<p>Un autre texte.</p>"], "autre.html"));
    const refus = await prof.requete("/prof/depot", { method: "POST", body: form });
    assertEquals(refus.status, 400);
    assertStringIncludes(await refus.text(), "Cours ou thème inconnu");
    assertEquals(db.prepare("SELECT count(*) n FROM sources").get()!.n, 1);
    assertEquals(readdirSync(join(dir, "content"), { withFileTypes: true }).length, 1);
    assertEquals((await eleve.requete("/administration/domaines")).status, 403);
    assertEquals((await prof.requete("/administration/domaines")).status, 403);
    // Le dépôt crée le cours et sa matière. Deux fichiers d'un lot rangent dans le même cours.
    const deposerDansNouveau = (nom: string, texte: string) => {
      const f = new FormData();
      for (const [k, v] of Object.entries({
        type_document: "cours",
        cours: "nouveau",
        nouveau_matiere: "nouvelle",
        nouvelle_matiere: "Acoustique",
        nouveau_cours: "Ondes",
      }))
        f.set(k, v);
      f.set("fichier", new File([`<p>${texte}</p>`], nom));
      return prof.requete("/prof/depot", {
        method: "POST",
        body: f,
        headers: { accept: "application/json" },
      });
    };
    const refuse = await deposerDansNouveau("onde.html", "Une onde transporte de l'énergie.");
    assertEquals(refuse.status, 400);
    assertStringIncludes(await refuse.text(), "Seul un administrateur crée un cours.");
    const compte = db.prepare("SELECT id FROM comptes WHERE role = 'enseignant'").get()!.id;
    db.prepare("UPDATE comptes SET administrateur = 1 WHERE id = ?").run(compte!);
    assertEquals((await prof.requete("/administration/domaines")).status, 200);
    // Créer une matière mène à son premier cours, créer un cours à ses membres.
    const creee = await prof.requete("/administration/domaines/matiere", {
      method: "POST",
      body: new URLSearchParams({ nom: "REAPER", profil: "general" }),
    });
    assertEquals(creee.status, 303);
    const reaper = db.prepare("SELECT id FROM matieres WHERE nom = 'REAPER'").get()!.id;
    assertEquals(
      creee.headers.get("location"),
      `/administration/domaines?ouvert=${reaper}&etape=cours`,
    );
    assertStringIncludes(
      await (await prof.requete(creee.headers.get("location")!)).text(),
      "Étape 2 sur 3 : créez le premier cours de",
    );
    const nouveau = await prof.requete("/administration/domaines/cours", {
      method: "POST",
      body: new URLSearchParams({ matiere_id: String(reaper), nom: "Mixage" }),
    });
    const mixage = db.prepare("SELECT id FROM cours WHERE nom = 'Mixage'").get()!.id;
    assertEquals(
      nouveau.headers.get("location"),
      `/administration/domaines?ouvert=${mixage}&etape=membres`,
    );
    const etape3 = await (await prof.requete(nouveau.headers.get("location")!)).text();
    assertStringIncludes(etape3, `<details class="cours" id="cours-${mixage}" open>`);
    assertStringIncludes(etape3, "Étape 3 sur 3 : ajoutez ses membres");
    for (const [nom, texte] of [
      ["onde.html", "Une onde transporte de l'énergie."],
      ["son.html", "Le son est une onde mécanique."],
    ]) {
      assertEquals((await deposerDansNouveau(nom, texte)).status, 200);
    }
    assertEquals(db.prepare("SELECT count(*) n FROM cours WHERE nom = 'Ondes'").get()!.n, 1);
    assertEquals(
      db
        .prepare(
          `SELECT count(*) n FROM sources s JOIN source_cours sc ON sc.source_id = s.id
           JOIN cours c ON c.id = sc.cours_id JOIN matieres m ON m.id = s.matiere_id
           WHERE c.nom = 'Ondes' AND m.nom = 'Acoustique' AND c.matiere_id = m.id`,
        )
        .get()!.n,
      2,
    );
    // Le lien « Déposer dans ce cours » coche ce cours au dépôt.
    assertStringIncludes(
      await (await prof.requete(`/prof/depot?matiere_id=${reaper}&cours=${mixage}`)).text(),
      `value="${mixage}" required checked`,
    );
    assertEquals(
      (
        await prof.requete("/administration/domaines/matiere", {
          method: "POST",
          body: new URLSearchParams({ nom: "Invalide", profil: "arbitraire" }),
        })
      ).status,
      400,
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

const GENERAL = {
  ...PROFILS.general,
  formes: { matiere: formes("Matière", "Matières", "f"), cours: formes("Cours", "Cours", "m") },
};

test("filtre : la grille des cours applique le choix par un lien qui garde les paramètres de la page", async () => {
  const sans = String(
    await filtre(
      { matieres: [], cours: [], themes: [] },
      { matiere_id: "", cours_id: "", theme_id: "" },
      "/prof",
      GENERAL,
    ),
  );
  assert(!sans.includes("grille-cours"));
  const matiere = { id: "m1", nom: "Développement", profil: "general" };
  const grille = String(
    await filtre(
      {
        matieres: [matiere],
        cours: [{ id: "c1", nom: "Docker", matiere_id: "m1", public: "", objectif: "" }],
        themes: [],
      } as never,
      { matiere_id: "", cours_id: "c1", theme_id: "" },
      "/prof",
      { ...GENERAL, cours: "Chapitre", cours_pluriel: "Chapitres" },
      { statut: "a_relire", vue: "" },
    ),
  );
  assertStringIncludes(grille, '<span class="etiquette" id="etiquette-cours">Chapitre</span>');
  assert(/bouton-cours">\s*Docker/.test(grille), "le choix ne montre pas le cours");
  assertStringIncludes(grille, 'aria-label="Chapitres"');
  assertStringIncludes(grille, 'href="/prof?statut=a_relire&amp;cours_id=c1" aria-current="true"');
  assertStringIncludes(grille, 'href="/prof?statut=a_relire&amp;cours_id="');
  // Une seule matière : pas de lien de matière, ni de liste des thèmes sans thème.
  assert(!grille.includes('class="matiere"') && !grille.includes('class="theme"'));
});

test("filtre : la page ouverte sans périmètre reprend le dernier cours choisi", async () => {
  const { db, dir } = await environnement();
  try {
    const c = cours(db, matiere(db, "Développement"), "Docker");
    const prof = await session(db, fauxModeles().modeles, "enseignant");
    const choix = await prof.requete(`/prof?cours_id=${c}`);
    const retenu = choix.headers.get("set-cookie")!.split(";")[0];
    assertEquals(retenu, `perimetre=${encodeURIComponent(`cours_id=${c}`)}`);
    const avec = { headers: { cookie: `${prof.cookie}; ${retenu}` } };
    const retour = await prof.requete("/prof?statut=a_relire", avec);
    assertEquals(retour.status, 302);
    assertEquals(retour.headers.get("location"), `/prof?statut=a_relire&cours_id=${c}`);
    assertEquals((await prof.requete("/prof?lot=x", avec)).status, 200);
    const tous = await prof.requete("/prof?cours_id=", avec);
    assertStringIncludes(tous.headers.get("set-cookie")!, "perimetre=; Max-Age=0");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});
