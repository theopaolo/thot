import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  authentifier,
  creerCompte,
  lireListe,
  reinitialiserMotDePasse,
} from "../src/app/comptes.ts";
import { cours, matiere } from "../src/app/domaines.ts";
import { environnement, fauxModeles, session } from "./outils.ts";

test("CSV élèves: import imprimable, doublon refusé, reset invalide la session", async () => {
  const { db } = await environnement();
  const coursId = cours(db, matiere(db, "Design"), "Design graphique");
  assertEquals(lireListe('identifiant;nom\r\nlea;"Léa, Martin"\r\n'), [
    {
      identifiant: "lea",
      nom: "Léa, Martin",
    },
  ]);
  assertThrows(() => lireListe('identifiant,nom\nlea,"Léa" Martin\n'));
  const { requete, app } = await session(db, fauxModeles().modeles, "enseignant");
  const fichier = new FormData();
  fichier.append(
    "fichier",
    new File(["identifiant,nom\nlea,Léa Martin\nnoe,Noé Petit\n"], "classe.csv"),
  );
  fichier.append("cours", coursId);
  const reponse = await requete("/prof/eleves/importer", { method: "POST", body: fichier });
  assertEquals(reponse.status, 200);
  assertEquals(reponse.headers.get("cache-control"), "no-store");
  const feuille = await reponse.text();
  assertStringIncludes(feuille, "Léa Martin");
  assertEquals(db.prepare("SELECT count(*) n FROM comptes WHERE role = 'eleve'").get()!.n, 2);
  const ancien = feuille.match(
    /Identifiant : <strong>lea<\/strong>.*?Mot de passe : <strong>([a-f0-9]+)<\/strong>/s,
  )?.[1];
  assert(ancien);
  const connexion = await app.request("/connexion", {
    method: "POST",
    headers: { origin: "http://localhost" },
    body: new URLSearchParams({ identifiant: "lea", mot_de_passe: ancien }),
  });
  const cookie = connexion.headers.get("set-cookie")!.split(";")[0];
  const id = db.prepare("SELECT id FROM comptes WHERE identifiant = 'lea'").get()!.id as string;
  const reset = await requete(`/prof/eleves/${id}/reinitialiser`, { method: "POST" });
  assertEquals(reset.status, 200);
  assertEquals((await app.request("/eleve", { headers: { cookie } })).status, 302);
  assertEquals(await authentifier(db, "lea", ancien), null);
  assertEquals(
    (await requete("/prof/eleves/importer", { method: "POST", body: fichier })).status,
    400,
  );
  assertEquals(db.prepare("SELECT count(*) n FROM comptes WHERE role = 'eleve'").get()!.n, 2);
});

test("un mot de passe enseignant se renouvelle sans ouvrir le reset élève", async () => {
  const { db } = await environnement();
  const ancien = await creerCompte(db, "prof-test", "Prof", "enseignant");
  const id = db.prepare("SELECT id FROM comptes WHERE identifiant = 'prof-test'").get()!
    .id as string;
  assertEquals(await reinitialiserMotDePasse(db, id), undefined);
  const nouveau = await reinitialiserMotDePasse(db, id, "enseignant");
  assert(nouveau);
  assertEquals(await authentifier(db, "prof-test", ancien), null);
  assertEquals((await authentifier(db, "prof-test", nouveau))?.role, "enseignant");
  assertEquals(
    db.prepare("SELECT session_version FROM comptes WHERE id = ?").get(id)!.session_version,
    1,
  );
});

test("la durée de session est vérifiée côté serveur même pour un cookie copié", async () => {
  const { db } = await environnement();
  const now = Date.now;
  try {
    const eleve = await session(db, fauxModeles().modeles, "eleve");
    assertEquals((await eleve.requete("/eleve/chat")).status, 200);
    const futur = now() + 12 * 3600_000;
    Date.now = () => futur;
    assertEquals((await eleve.requete("/eleve/chat")).status, 302);
  } finally {
    Date.now = now;
    db.close();
  }
});
