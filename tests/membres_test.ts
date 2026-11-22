import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { connexion } from "../src/app/db.ts";
import { cours, coursDuCompte, inscrire, matiere } from "../src/app/domaines.ts";
import { configurerInstance } from "../src/app/instance.ts";
import { environnement, fauxModeles, ORIGINE, session } from "./outils.ts";
import { administrateur } from "./domaines_outils.ts";

async function enseignantDe(db: ReturnType<typeof connexion>, cours_id: string[]) {
  const prof = await session(db, fauxModeles().modeles, "enseignant", false);
  const id = db.prepare("SELECT id FROM comptes ORDER BY rowid DESC LIMIT 1").get()!.id as string;
  for (const c of cours_id) inscrire(db, c, id);
  return { ...prof, id };
}

test("membres d'un cours : l'administrateur inscrit et retire, les autres comptes reçoivent 403", async () => {
  const { db, dir } = await environnement();
  try {
    const admin = await administrateur(db);
    const c = cours(db, matiere(db, "Physique"), "Optique");
    const eleve = await session(db, fauxModeles().modeles, "eleve", false);
    const prof = await session(db, fauxModeles().modeles, "enseignant", false);
    const eleveId = db.prepare("SELECT id FROM comptes WHERE role = 'eleve'").get()!.id as string;
    const champs = new URLSearchParams({ cours_id: c, compte_id: eleveId });
    for (const autre of [eleve, prof]) {
      assertEquals((await autre.requete("/administration/domaines")).status, 403);
      const refus = await autre.requete("/administration/domaines/inscrire", {
        method: "POST",
        body: champs,
      });
      assertEquals(refus.status, 403);
    }
    assertEquals(coursDuCompte(db, eleveId).size, 0);

    let page = await (await admin.requete("/administration/domaines")).text();
    assertStringIncludes(page, "Membres : 0");
    assertStringIncludes(page, "Aucun membre.");
    assertStringIncludes(page, `<option value="${eleveId}">Compte eleve`);
    const ajout = await admin.poster("inscrire", { cours_id: c, compte_id: eleveId });
    assertEquals(ajout.status, 303);
    assertStringIncludes(ajout.headers.get("location")!, `ouvert=${c}`);
    assert(coursDuCompte(db, eleveId).has(c));
    page = await (await admin.requete(`/administration/domaines?ouvert=${c}`)).text();
    assertStringIncludes(page, "Membres : 1");
    assertStringIncludes(page, `<details class="cours" id="cours-${c}" open>`);
    assertStringIncludes(page, "Compte eleve");
    assertStringIncludes(page, ", élève</span>");
    assert(!page.includes(`<option value="${eleveId}">`));

    // Un seul rang par compte et par cours.
    assertEquals((await admin.poster("inscrire", { cours_id: c, compte_id: eleveId })).status, 303);
    assertEquals(db.prepare("SELECT count(*) n FROM membres_cours").get()!.n, 1);
    for (const mauvais of [
      { cours_id: "absent", compte_id: eleveId },
      { cours_id: c, compte_id: "x" },
    ]) {
      const refus = await admin.poster("inscrire", mauvais);
      assertEquals(refus.status, 400);
      assertStringIncludes(await refus.text(), "inconnu");
    }

    assertEquals(
      (await admin.poster("desinscrire", { cours_id: c, compte_id: eleveId })).status,
      303,
    );
    assertEquals(coursDuCompte(db, eleveId).size, 0);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("comptes enseignants : l'administrateur en crée un et voit son mot de passe une fois, un enseignant reçoit 403", async () => {
  const { db, dir } = await environnement();
  try {
    const admin = await administrateur(db);
    const prof = await session(db, fauxModeles().modeles, "enseignant", false);
    const comptes = () => db.prepare("SELECT count(*) n FROM comptes").get()!.n as number;
    const avant = comptes();
    const jeanne = { identifiant: "Jeanne.Roy", nom: "Jeanne Roy" };
    const refus = await prof.requete("/administration/domaines/enseignant", {
      method: "POST",
      body: new URLSearchParams(jeanne),
    });
    assertEquals(refus.status, 403);
    assertEquals(comptes(), avant);

    const page = await (await admin.requete("/administration/domaines")).text();
    assertStringIncludes(page, 'action="/administration/domaines/enseignant"');
    const feuille = await admin.poster("enseignant", jeanne);
    assertEquals(feuille.status, 200);
    assertEquals(feuille.headers.get("cache-control"), "no-store");
    const texte = await feuille.text();
    assertStringIncludes(texte, '<a href="/administration/domaines">Retour aux matières et cours');
    const motDePasse = texte.match(/Mot de passe : <strong>([0-9a-f]+)</)![1];
    assertEquals(
      {
        ...db
          .prepare("SELECT role, administrateur FROM comptes WHERE identifiant = 'jeanne.roy'")
          .get(),
      },
      { role: "enseignant", administrateur: 0 },
    );
    const connexion = (mot_de_passe: string) =>
      admin.app.request("/connexion", {
        method: "POST",
        headers: { origin: ORIGINE },
        body: new URLSearchParams({ identifiant: "jeanne.roy", mot_de_passe }),
      });
    assertEquals((await connexion("mauvais")).status, 401);
    assertEquals((await connexion(motDePasse)).status, 302);

    // Un identifiant pris ou mal formé ne crée rien.
    for (const champs of [
      { identifiant: "jeanne.roy", nom: "Autre" },
      { identifiant: "J R", nom: "Jeanne" },
      { identifiant: "jr", nom: "Jeanne" },
    ]) {
      const r = await admin.poster("enseignant", champs);
      assertEquals(r.status, 400);
    }
    assertEquals(comptes(), avant + 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("CSV élèves : les nouveaux comptes rejoignent les cours cochés, jamais ceux d'un autre enseignant", async () => {
  const { db, dir } = await environnement();
  try {
    const m = matiere(db, "Physique");
    const [optique, mecanique] = [cours(db, m, "Optique"), cours(db, m, "Mécanique")];
    const prof = await enseignantDe(db, [optique]);
    const classe = (lignes: string, coches: string[]) => {
      const f = new FormData();
      f.append("fichier", new File([`identifiant,nom\n${lignes}\n`], "classe.csv"));
      for (const id of coches) f.append("cours", id);
      return f;
    };
    const eleves = () => db.prepare("SELECT count(*) n FROM comptes WHERE role = 'eleve'").get()!.n;

    const page = await (await prof.requete("/prof/eleves")).text();
    // Son seul cours est ouvert : les nouveaux comptes le rejoignent d'office.
    assertStringIncludes(page, `type="hidden" name="cours" value="${optique}"`);
    assert(!page.includes(mecanique));

    const refus = await prof.requete("/prof/eleves/importer", {
      method: "POST",
      body: classe("lea,Léa Martin", [optique, mecanique]),
    });
    assertEquals(refus.status, 400);
    assertStringIncludes(await refus.text(), "vos cours");
    assertEquals(eleves(), 0);

    const bon = await prof.requete("/prof/eleves/importer", {
      method: "POST",
      body: classe("lea,Léa Martin\nnoe,Noé Petit", [optique]),
    });
    assertEquals(bon.status, 200);
    const lea = db.prepare("SELECT id FROM comptes WHERE identifiant = 'lea'").get()!.id as string;
    assertEquals([...coursDuCompte(db, lea)], [optique]);

    // Sans cours coché, l'élève échapperait à l'enseignant qui l'a créé.
    const sans = await prof.requete("/prof/eleves/importer", {
      method: "POST",
      body: classe("max,Max Roux", []),
    });
    assertEquals(sans.status, 400);
    assertEquals(eleves(), 2);

    // Un administrateur choisit parmi tous les cours, un cours inconnu annule l'import.
    const admin = await administrateur(db);
    assertStringIncludes(await (await admin.requete("/prof/eleves")).text(), mecanique);
    const ajout = await admin.requete("/prof/eleves/importer", {
      method: "POST",
      body: classe("eva,Éva Roy", [mecanique]),
    });
    assertEquals(ajout.status, 200);
    const eva = db.prepare("SELECT id FROM comptes WHERE identifiant = 'eva'").get()!.id as string;
    assertEquals([...coursDuCompte(db, eva)], [mecanique]);
    const inconnu = await admin.requete("/prof/eleves/importer", {
      method: "POST",
      body: classe("zoe,Zoé Blanc", [optique, "absent"]),
    });
    assertEquals(inconnu.status, 400);
    assertEquals(
      db.prepare("SELECT count(*) n FROM comptes WHERE identifiant = 'zoe'").get()!.n,
      0,
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("élèves : un enseignant sans cours ne crée pas d'élève, un administrateur si", async () => {
  const { db, dir } = await environnement();
  try {
    const prof = await session(db, fauxModeles().modeles, "enseignant");
    const page = await (await prof.requete("/prof/eleves")).text();
    assertStringIncludes(page, "Vous n'avez pas encore de cours");
    assert(!page.includes("/prof/eleves/importer"));
    const f = new FormData();
    f.append("fichier", new File(["identifiant,nom\nlea,Léa Martin\n"], "classe.csv"));
    assertEquals(
      (await prof.requete("/prof/eleves/importer", { method: "POST", body: f })).status,
      400,
    );
    const admin = await administrateur(db);
    assert(!(await (await admin.requete("/prof/eleves")).text()).includes("Cours des nouveaux"));
    assertEquals(
      (await admin.requete("/prof/eleves/importer", { method: "POST", body: f })).status,
      200,
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("l'élève apprend qui lit ses questions, sauf en mode personnel", async () => {
  const { db, dir } = await environnement();
  try {
    cours(db, matiere(db, "Physique"), "Optique");
    const inscrit = await session(db, fauxModeles().modeles, "eleve");
    const libre = await session(db, fauxModeles().modeles, "eleve", false);
    for (const chemin of ["/eleve", "/eleve/chat"]) {
      assertStringIncludes(
        await (await inscrit.requete(chemin)).text(),
        "Les enseignants de tes cours lisent tes questions.",
      );
      const sans = await (await libre.requete(chemin)).text();
      assertStringIncludes(sans, "Les enseignants lisent tes questions.");
      assert(!sans.includes("de tes cours"));
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
  const perso = await environnement();
  try {
    configurerInstance(perso.db, "Mon étude", "personal");
    const moi = await session(perso.db, fauxModeles().modeles, "enseignant");
    for (const chemin of ["/eleve", "/eleve/chat"]) {
      const r = await moi.requete(chemin);
      assertEquals(r.status, 200);
      assert(!(await r.text()).includes("lisent tes questions"));
    }
  } finally {
    perso.db.close();
    await rm(perso.dir, { recursive: true });
  }
});
