import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer as serveurHttp } from "node:http";
import { createServer } from "node:net";
import { test } from "vite-plus/test";
import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { creerCompte } from "../src/app/comptes.ts";
import { RACINE } from "../src/app/config.ts";
import { boucleReponses, revendiquerReponse } from "../src/app/reponses.ts";
import { creerApp } from "../src/app/routes.ts";
import { BONNE, environnement, fauxModeles, ORIGINE, publier, session } from "./outils.ts";
import { CHAMPS, formulaire, PAGE } from "./source_outils.ts";

test("arrêt du serveur : une réponse en cours retourne en file sans attendre son verrou", async () => {
  const { db, dir } = await environnement();
  try {
    await publier(db, "Casa Batlló");
    // Le générateur du serveur qui s'arrête ne répond jamais.
    const f = fauxModeles({ sorties: [BONNE] });
    const generer = f.modeles.generer;
    const signaux: AbortSignal[] = [];
    f.modeles.generer = (_messages, signal) => {
      signaux.push(signal!);
      return new Promise(() => {});
    };
    const boucle = boucleReponses(db, f.modeles);
    const app = creerApp(db, f.modeles, boucle);
    const mot_de_passe = await creerCompte(db, "lea", "Léa Martin", "eleve");
    const envoyer = (chemin: string, corps: Record<string, string>, cookie = "") =>
      app.request(chemin, {
        method: "POST",
        headers: { origin: ORIGINE, cookie, "HX-Request": "true" },
        body: new URLSearchParams(corps),
      });
    const entree = await envoyer("/connexion", { identifiant: "lea", mot_de_passe });
    const cookie = entree.headers.get("set-cookie")!.split(";")[0];
    await envoyer("/eleve/questions", { texte: "Pourquoi pas de ligne droite ?" }, cookie);
    const ligne = () =>
      db.prepare("SELECT etat, tentatives, generation_id, verrou_expire_le FROM messages").get()!;
    const attendre = async (condition: () => unknown) => {
      for (let i = 0; i < 400 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
      assert(condition());
    };
    await attendre(() => signaux.length);
    assertEquals([ligne().etat, ligne().tentatives], ["en_cours", 1]);

    boucle.arreter();
    assert(signaux[0].aborted, "l'appel au modèle continue");
    assertEquals(
      { ...ligne() },
      { etat: "en_attente", tentatives: 0, generation_id: null, verrou_expire_le: null },
    );
    boucle.reveiller();
    assertEquals(ligne().etat, "en_attente", "la boucle arrêtée a repris la question");

    // Le serveur suivant la reprend aussitôt, sans tentative comptée pour l'arrêt.
    f.modeles.generer = generer;
    boucleReponses(db, f.modeles).reveiller();
    await attendre(() => ligne().etat === "answered");
    assertEquals(ligne().tentatives, 1);
    assertEquals(revendiquerReponse(db), undefined);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("arrêt du serveur : SIGTERM ferme la base et sort en 0", async () => {
  const { db, dir } = await environnement();
  db.close();
  const ecoute = createServer().listen(0, "127.0.0.1");
  await once(ecoute, "listening");
  const { port } = ecoute.address() as { port: number };
  ecoute.close();
  const serveur = spawn(process.execPath, ["src/server.ts"], {
    cwd: RACINE,
    stdio: "ignore",
    env: {
      ...process.env,
      THOT_DATA_DIR: dir,
      THOT_HOST: "127.0.0.1",
      THOT_PORT: String(port),
      THOT_ORIGIN: "",
      THOT_DEV: "0",
      THOT_OPENROUTER_ENABLED: "0",
      THOT_MISTRAL_ENABLED: "0",
    },
  });
  try {
    let pret = false;
    for (let i = 0; i < 100 && !pret; i++) {
      pret = await fetch(`http://127.0.0.1:${port}/connexion`).then(
        (r) => r.ok,
        () => false,
      );
      if (!pret) await new Promise((r) => setTimeout(r, 50));
    }
    assert(pret, "le serveur ne démarre pas");
    assert(existsSync(join(dir, "state.sqlite3-wal")), "la base du serveur n'est pas ouverte");
    const fin = once(serveur, "exit");
    serveur.kill("SIGTERM");
    assertEquals(await fin, [0, null]);
    // La dernière connexion fermée, SQLite replie son journal dans la base.
    assert(!existsSync(join(dir, "state.sqlite3-wal")), "la base est restée ouverte");
  } finally {
    serveur.kill("SIGKILL");
    await rm(dir, { recursive: true });
  }
});

test("arrêt du worker : SIGTERM remet en file le travail en cours et sort en 0", async () => {
  const { db, dir } = await environnement();
  // Le fournisseur ne répond jamais : le worker reste dans sa première légende.
  const muet = serveurHttp(() => {}).listen(0, "127.0.0.1");
  await once(muet, "listening");
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  await requete("/prof/depot", { method: "POST", body: formulaire(CHAMPS, PAGE, "casa.html") });
  const worker = spawn(process.execPath, ["src/worker.ts"], {
    cwd: RACINE,
    stdio: "ignore",
    env: {
      ...process.env,
      THOT_DATA_DIR: dir,
      THOT_ORIGIN: "",
      THOT_DEV: "0",
      THOT_OPENROUTER_ENABLED: "1",
      THOT_OPENROUTER_URL: `http://127.0.0.1:${(muet.address() as { port: number }).port}`,
      OPENROUTER_API_KEY: "test",
      THOT_MISTRAL_ENABLED: "0",
    },
  });
  try {
    const ligne = () =>
      db.prepare("SELECT etat, tentatives, verrou_expire_le FROM ingestion_jobs").get()!;
    for (let i = 0; i < 200 && ligne().etat !== "enriching"; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assertEquals(ligne().etat, "enriching", "le worker n'a pas atteint les légendes");
    const fin = once(worker, "exit");
    worker.kill("SIGTERM");
    assertEquals(await fin, [0, null]);
    assertEquals({ ...ligne() }, { etat: "received", tentatives: 0, verrou_expire_le: null });
  } finally {
    worker.kill("SIGKILL");
    muet.closeAllConnections();
    muet.close();
    db.close();
    await rm(dir, { recursive: true });
  }
});
