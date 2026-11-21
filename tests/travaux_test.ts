import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { RACINE } from "../src/app/config.ts";
import { type Db, maintenant } from "../src/app/db.ts";
import { deposer, valider } from "../src/app/depot.ts";
import {
  proposerInformations,
  reextraire,
  revendiquer,
  sourceSansInformations,
  statuer,
  supprimerSource,
  traiter,
} from "../src/app/ingestion.ts";
import { lireInstance } from "../src/app/instance.ts";
import { environnement, fauxModeles } from "./outils.ts";

/** Une page du profil arts appliqués, avec une image à légender, déposée et pas encore extraite. */
async function deposee(db: Db, titre = "Casa Batlló") {
  const v = valider({ titre, type_document: "cours", matiere: "arts-appliques" });
  assert("meta" in v);
  const { source_id } = await deposer(db, {
    meta: v.meta,
    nomFichier: "casa.html",
    format: "html",
    schoolId: lireInstance(db).school_id,
    enseignant: "Prof",
    audience: "eleves",
    reponses: true,
    octets: new TextEncoder().encode(
      `<html><head><title>t</title></head><body><h1>${titre}</h1>
<img src="data:image/jpeg;base64,/9j/4AAQ" />
<p>La façade de la Casa Batlló est couverte de céramique irisée.</p></body></html>`,
    ),
  });
  return source_id;
}

const travail = (db: Db, sourceId: string) => ({
  ...db
    .prepare("SELECT etat, tentatives, erreur FROM ingestion_jobs WHERE source_id = ?")
    .get(sourceId),
});

const ENV = {
  ...process.env,
  THOT_ORIGIN: "",
  THOT_OPENROUTER_ENABLED: "0",
  THOT_MISTRAL_ENABLED: "0",
};

test("un document.txt supprimé à la main ne fait pas sortir la boucle du worker", async () => {
  const { db, dir } = await environnement();
  const abimee = await deposee(db);
  await traiter(db, revendiquer(db)!, fauxModeles().modeles);
  const intacte = await deposee(db, "Sagrada Família");
  await traiter(db, revendiquer(db)!, fauxModeles().modeles);
  rmSync(join(dir, "content", abimee, "document.txt"));

  // La fonction que la boucle appelle : elle note la cause et rend la main.
  await proposerInformations(db, fauxModeles().modeles, abimee);
  const { etat, erreur } = travail(db, abimee);
  assertEquals(etat, "failed");
  assertStringIncludes(erreur as string, "document.txt");
  assertEquals(sourceSansInformations(db), intacte, "la source abîmée n'est plus proposée");

  // Le worker lui-même, sur la même source remise dans la file.
  db.prepare(
    "UPDATE ingestion_jobs SET etat = 'awaiting_review', erreur = NULL WHERE source_id = ?",
  ).run(abimee);
  const worker = spawn(process.execPath, ["src/worker.ts"], {
    cwd: RACINE,
    stdio: "ignore",
    env: { ...ENV, THOT_DATA_DIR: dir },
  });
  try {
    const traitees = () =>
      travail(db, abimee).etat === "failed" &&
      db
        .prepare("SELECT json_type(metadonnees, '$.propositions') t FROM sources WHERE id = ?")
        .get(intacte)!.t !== null;
    for (let i = 0; i < 200 && worker.exitCode === null && !traitees(); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assertEquals(worker.exitCode, null, "le worker s'est arrêté");
    assert(traitees(), "le worker n'est pas passé à la source suivante");
    const fin = once(worker, "exit");
    worker.kill("SIGTERM");
    assertEquals(await fin, [0, null]);
  } finally {
    worker.kill("SIGKILL");
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("un travail dont le verrou a été repris n'écrit plus rien", async () => {
  const { db, dir } = await environnement();
  try {
    const id = await deposee(db);
    const job = revendiquer(db)!;
    const { modeles } = fauxModeles();
    let reprise: ReturnType<typeof revendiquer>;
    modeles.legender = () => {
      // Pendant la légende, le verrou expire et un autre worker reprend le travail.
      reprise = revendiquer(db, Date.now() + 6 * 60_000);
      return Promise.resolve({ texte: "Une légende arrivée trop tard.", modele: "faux-vl" });
    };
    await traiter(db, job, modeles);
    assertEquals(reprise!.tentatives, 2);
    assertEquals(travail(db, id), { etat: "extracting", tentatives: 2, erreur: null });
    assertEquals(db.prepare("SELECT legende FROM images").get()!.legende, null);

    // La reprise a fini le travail : l'ancienne tentative ne le remet pas en échec non plus.
    await traiter(db, reprise!, fauxModeles().modeles);
    modeles.legender = () => Promise.reject(new Error("panne"));
    await traiter(db, job, modeles);
    assertEquals(travail(db, id), { etat: "awaiting_review", tentatives: 2, erreur: null });
    assertEquals(db.prepare("SELECT legende FROM images").get()!.legende, "Une image.");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("le worker renouvelle son verrou : la suppression reste refusée pendant un long travail", async () => {
  const { db, dir } = await environnement();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  try {
    const id = await deposee(db);
    const job = revendiquer(db)!;
    const { modeles } = fauxModeles();
    let suppression = "";
    let reprise: unknown = "non tentée";
    modeles.legender = async () => {
      // La légende dure six minutes, une de plus que le verrou.
      vi.advanceTimersByTime(6 * 60_000);
      suppression = await supprimerSource(db, id).then(
        () => "supprimée",
        (e: Error) => e.message,
      );
      reprise = revendiquer(db);
      return { texte: "Une image.", modele: "faux-vl" };
    };
    await traiter(db, job, modeles);
    assertStringIncludes(suppression, "Extraction en cours");
    assertEquals(reprise, undefined, "un autre worker ne reprend pas un travail en cours");
    assertEquals(travail(db, id), { etat: "awaiting_review", tentatives: 1, erreur: null });
  } finally {
    vi.useRealTimers();
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("réextraire pendant qu'un enseignant certifie la version en attente ne réécrit pas le dossier servi", async () => {
  const { db, dir } = await environnement();
  try {
    const id = await deposee(db);
    await traiter(db, revendiquer(db)!, fauxModeles().modeles);
    // Le texte servi diffère de l'extraction : la réextraction donne la révision 2, en attente.
    writeFileSync(join(dir, "content", id, "document.txt"), "Un ancien texte.");
    assertEquals(await reextraire(db, id), "revision");
    const temoin = join(dir, "content", id, "revisions/2/temoin");
    writeFileSync(temoin, "");

    // La certification arrive pendant que la seconde réextraction lit l'original.
    const encours = reextraire(db, id);
    statuer(db, id, "certifiee", "Test", 2);
    assertEquals(await encours, "identique", "le texte extrait est celui de la révision servie");
    assert(existsSync(temoin), "le dossier de la révision servie a été effacé");
    assertEquals(
      db.prepare("SELECT n FROM revisions WHERE source_id = ? ORDER BY n").all(id).length,
      2,
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("CLI : orphelins liste les dossiers sans source et les .partiel anciens, et ne supprime qu'avec --supprimer", async () => {
  const { db, dir } = await environnement();
  try {
    const id = await deposee(db);
    const occupee = await deposee(db, "Sagrada Família");
    const hier = new Date(Date.now() - 24 * 3_600_000);
    const fichier = (chemin: string, date?: Date) => {
      const complet = join(dir, "content", chemin);
      mkdirSync(join(complet, ".."), { recursive: true });
      writeFileSync(complet, "reste");
      if (date) utimesSync(complet, date, date);
      return complet;
    };
    const dossier = (nom: string, date?: Date) => {
      fichier(`${nom}/original/cours.html`);
      if (date) utimesSync(join(dir, "content", nom), date, date);
      return join(dir, "content", nom);
    };
    const ancien = dossier("sans-ligne-ancien", hier);
    // Un dépôt en cours écrit son original avant sa ligne.
    const recent = dossier("sans-ligne-recent");
    const partiel = fichier(`${id}/document.txt.partiel`, hier);
    const partielRecent = fichier(`${id}/blocs.jsonl.partiel`);
    const partielOccupe = fichier(`${occupee}/document.txt.partiel`, hier);
    db.prepare(
      "UPDATE ingestion_jobs SET etat = 'extracting', verrou_expire_le = ? WHERE source_id = ?",
    ).run(maintenant(Date.now() + 60_000), occupee);

    const lancer = (...args: string[]) => {
      const r = spawnSync(process.execPath, ["src/cli.ts", "orphelins", ...args], {
        cwd: RACINE,
        encoding: "utf8",
        env: { ...ENV, THOT_DATA_DIR: dir },
      });
      assertEquals(r.status, 0, r.stderr);
      return r.stdout;
    };
    const tous = [ancien, recent, partiel, partielRecent, partielOccupe];
    const liste = lancer();
    assertStringIncludes(liste, "sans-ligne-ancien");
    assertStringIncludes(liste, `${id}/document.txt.partiel`);
    assert(!liste.includes("sans-ligne-recent"), liste);
    assert(!liste.includes("blocs.jsonl.partiel"), liste);
    assert(!liste.includes(`${id}\n`), "le dossier d'une source n'est pas un orphelin");
    assertEquals(tous.map(existsSync), [true, true, true, true, true], "sans --supprimer");

    lancer("--supprimer");
    assertEquals(tous.map(existsSync), [false, true, false, true, true]);
    assert(existsSync(join(dir, "content", id, "original/casa.html")), "la source reste entière");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});
