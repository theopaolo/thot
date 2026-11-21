import { mkdtemp } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { assert, assertEquals } from "@std/assert";
import {
  activiteEleve,
  activitesEleve,
  activiteProf,
  ajouterCours,
  aReprendre,
  corrigee,
  enregistrerReponses,
  essayer,
  inserer,
  ancrerPassage,
  preuvesValides,
  publier,
  recommencer,
  retirerCours,
  relire,
  tentative,
  tentativesLues,
} from "../src/app/activites.ts";
import { creerCompte, lireCompte, type Role } from "../src/app/comptes.ts";
import { config, RACINE } from "../src/app/config.ts";
import { connexion, type Db, migrer } from "../src/app/db.ts";
import { cours, matiere } from "../src/app/domaines.ts";
import { rattacher } from "../src/app/ingestion.ts";
import type { Champ, Contenu, Question } from "../src/core/activite.ts";
import { environnement, publier as publierSource } from "./outils.ts";

const libre = (texte: string): Champ => ({ texte, citations: [] });

async function compte(db: Db, role: Role, ...coursIds: string[]) {
  const identifiant = `${role}-${crypto.randomUUID().slice(0, 6)}`;
  await creerCompte(db, identifiant, identifiant, role);
  const id = db.prepare("SELECT id FROM comptes WHERE identifiant = ?").get(identifiant)!
    .id as string;
  for (const c of coursIds) db.prepare("INSERT INTO membres_cours VALUES (?, ?)").run(c, id);
  return lireCompte(db, id)!;
}

/** Deux cours, une source rattachée au premier, un enseignant des deux et un élève par cours. */
async function cadre() {
  const { db } = await environnement();
  const m = matiere(db, "Arts appliqués");
  const c1 = cours(db, m, "Design");
  const c2 = cours(db, m, "Histoire de l'art");
  const source = await publierSource(db, "Casa Batlló", c1);
  const prof = await compte(db, "enseignant", c1, c2);
  const prof2 = await compte(db, "enseignant", c2);
  const e1 = await compte(db, "eleve", c1);
  const e2 = await compte(db, "eleve", c2);
  const dehors = await compte(db, "eleve");
  return { db, c1, c2, source, prof, prof2, e1, e2, dehors };
}

const choix: Question = {
  id: "q1",
  type: "choix",
  consigne: libre("Que refuse Gaudí ?"),
  retour: libre("La ligne droite."),
  options: [
    { id: "A", texte: libre("La ligne droite"), juste: true },
    { id: "B", texte: libre("La couleur"), juste: false },
    { id: "C", texte: libre("La céramique"), juste: false },
  ],
};
const redigee: Question = {
  id: "q2",
  type: "redigee",
  consigne: libre("Décris la façade."),
  attendu: libre("Céramique irisée."),
  criteres: [libre("Nomme la céramique.")],
  retour: libre(""),
};

function exercice(db: Db, prof: Awaited<ReturnType<typeof compte>>, coursId: string, c: Contenu) {
  const id = inserer(db, prof, {
    type: "exercice",
    coursId,
    objectifId: "",
    intitule: "Lire une façade",
    reference: "",
    contenu: c,
  });
  return activiteProf(db, prof, id)!;
}

function publie(db: Db, prof: Awaited<ReturnType<typeof compte>>, id: string) {
  const a = activiteProf(db, prof, id)!;
  assert(relire(db, prof, a, a.revision));
  assertEquals(publier(db, prof, id, a.revision), "publiee");
}

test("migration 0026 : un exercice devient une série d'une question, sa tentative une réponse rendue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thot-"));
  config.donnees = dir;
  const db = connexion(join(dir, "state.sqlite3"));
  try {
    db.exec("CREATE TABLE migrations (nom TEXT PRIMARY KEY, applique_le TEXT NOT NULL)");
    for (const nom of readdirSync(join(RACINE, "migrations")).sort()) {
      if (!nom.endsWith(".sql") || nom >= "0026") continue;
      db.exec(readFileSync(join(RACINE, "migrations", nom), "utf8"));
      db.prepare("INSERT INTO migrations VALUES (?, 'fixture')").run(nom);
    }
    const ancien = {
      consigne: libre("Q ?"),
      attendu: libre("R."),
      criteres: [libre("C1"), libre("C2")],
      retour: libre("F."),
    };
    db.exec(`INSERT INTO matieres (id, nom, profil) VALUES ('m', 'Arts appliqués', 'arts-appliques');
      INSERT INTO cours (id, matiere_id, nom) VALUES ('c', 'm', 'Design');
      INSERT INTO comptes (id, identifiant, nom, role, sel, empreinte, cree_le)
        VALUES ('p', 'p', 'Prof', 'enseignant', '', '', 'x'), ('e', 'e', 'Élève', 'eleve', '', '', 'x');
      INSERT INTO objectifs VALUES ('o', 'c', 'Lire une façade', '', 'x');`);
    db.prepare(
      `INSERT INTO activites (id, cours_id, objectif_id, auteur_id, audience, contenu, cree_le, maj_le)
       VALUES ('a', 'c', 'o', 'p', 'cours', ?, 'x', 'x')`,
    ).run(JSON.stringify(ancien));
    db.exec(`INSERT INTO tentatives (id, activite_id, compte_id, revision, reponse, criteres, cree_le)
      VALUES ('t', 'a', 'e', 1, 'Ma réponse', '[1]', '2026-11-01T10:00:00Z')`);
    assertEquals(migrer(db), [
      "0026_series.sql",
      "0027_lectures.sql",
      "0028_connexions.sql",
      "0029_images_revision.sql",
    ]);
    const a = db.prepare("SELECT contenu, titre FROM activites").get()!;
    assertEquals(JSON.parse(a.contenu as string), {
      correction: "serie",
      questions: [{ ...ancien, id: "q1", type: "redigee" }],
    });
    assertEquals(a.titre, "Lire une façade");
    assertEquals(db.prepare("SELECT * FROM activite_cours").all(), [
      { activite_id: "a", cours_id: "c" },
    ]);
    const t = db.prepare("SELECT reponses, rendue_le, retours FROM tentatives").get()!;
    assertEquals(JSON.parse(t.reponses as string), {
      q1: { essais: ["Ma réponse"], finie: true, criteres: [1] },
    });
    assertEquals(t.rendue_le, "2026-11-01T10:00:00Z");
    assertEquals(t.retours, "{}");
  } finally {
    db.close();
  }
});

test("plusieurs cours : un cours s'ajoute quand ses sources tiennent, chaque enseignant lit ses élèves", async () => {
  const { db, c1, c2, source, prof, prof2, e1, e2, dehors } = await cadre();
  const cible = { cours_id: c1, audience: "cours" as const, auteur_id: prof.id };
  const cite: Question = {
    ...redigee,
    attendu: {
      texte: "Gaudí refuse la ligne droite.",
      citations: [
        ancrerPassage(db, cible, source, "Gaudí refuse la ligne droite dans toute la façade", "x"),
      ],
    },
  };
  const a = exercice(db, prof, c1, { correction: "serie", questions: [choix, cite] });
  assertEquals(
    ajouterCours(db, prof, a, c2),
    ["Casa Batlló"],
    "la source n'est pas dans le cours 2",
  );
  rattacher(db, source, [
    { cours_id: c1, theme_id: null },
    { cours_id: c2, theme_id: null },
  ]);
  assertEquals(ajouterCours(db, prof, a, c2), []);
  assert(preuvesValides(db, a));
  publie(db, prof, a.id);

  assertEquals(
    activitesEleve(db, e2).map((x) => [x.id, x.cours_id]),
    [[a.id, c2]],
  );
  assertEquals(activiteEleve(db, e1, a.id)?.cours_id, c1);
  assertEquals(activiteEleve(db, dehors, a.id), undefined);

  const servie = activiteProf(db, prof, a.id)!;
  enregistrerReponses(db, e1, servie, { q1: "A" }, true);
  enregistrerReponses(db, e2, servie, { q1: "B" }, true);
  assertEquals(tentativesLues(db, prof, servie)?.length, 2);
  assertEquals(
    tentativesLues(db, prof2, activiteProf(db, prof2, a.id)!)?.map((t) => t.compte_id),
    [e2.id],
    "l'enseignant du cours 2 ne lit que ses élèves",
  );

  // Retirer la source du cours 2 signale l'activité à revoir : l'élève du cours 2 ne la reçoit plus.
  rattacher(db, source, [{ cours_id: c1, theme_id: null }]);
  assertEquals(activiteProf(db, prof, a.id)!.etat, "a_revoir");
  assertEquals(activiteEleve(db, e2, a.id), undefined);
  // Retirer le cours fautif rend un brouillon à relire, sans changer la version.
  retirerCours(db, prof, activiteProf(db, prof, a.id)!, c2);
  assertEquals(activiteProf(db, prof, a.id)!.etat, "brouillon");
});

test("tentatives : une série s'enregistre puis se remet, une question se corrige essai par essai", async () => {
  const { db, c1, prof, e1 } = await cadre();
  const serie = exercice(db, prof, c1, { correction: "serie", questions: [choix, redigee] });
  publie(db, prof, serie.id);
  const a = activiteProf(db, prof, serie.id)!;
  const contenu = JSON.parse(a.contenu) as Contenu;

  assertEquals(enregistrerReponses(db, e1, a, { q1: "B", q2: "Brouillon" }, false), "enregistree");
  assertEquals(tentative(db, e1, a)!.reponses.q1.essais, ["B"]);
  assert(!corrigee(contenu, tentative(db, e1, a), "q1"), "pas de corrigé avant la remise");
  assertEquals(enregistrerReponses(db, e1, a, { q1: "A", q2: "Céramique" }, true), "rendue");
  assert(corrigee(contenu, tentative(db, e1, a), "q1"));
  assertEquals(
    enregistrerReponses(db, e1, a, { q1: "B" }, true),
    "refus",
    "rendue, elle ne change plus",
  );
  assertEquals(
    essayer(db, e1, a, "q1", "A"),
    "refus",
    "une série ne se corrige pas question par question",
  );

  assert(!recommencer(db, e1, a), "pas sans l'accord de l'enseignant");
  assert(aReprendre(db, prof, a, tentative(db, e1, a)!.id, true));
  assert(recommencer(db, e1, a));
  assertEquals(tentative(db, e1, a)!.rendue_le, null);

  const pas = exercice(db, prof, c1, { correction: "question", questions: [choix, redigee] });
  publie(db, prof, pas.id);
  const b = activiteProf(db, prof, pas.id)!;
  assertEquals(essayer(db, e1, b, "q1", "Z"), "invalide");
  assertEquals(essayer(db, e1, b, "q1", "B"), { juste: false, finie: false });
  assert(!corrigee(JSON.parse(b.contenu), tentative(db, e1, b), "q1"));
  assertEquals(essayer(db, e1, b, "q1", "A"), { juste: true, finie: true });
  assertEquals(essayer(db, e1, b, "q1", "A"), "refus");
  assert(!tentative(db, e1, b)!.rendue_le, "une question reste");
  assertEquals(essayer(db, e1, b, "q2", "Céramique irisée"), { juste: false, finie: true });
  assert(tentative(db, e1, b)!.rendue_le, "toutes les questions finies");
});
