import { readFile, writeFile, rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "node:path";
import { openrouter, PanneModele } from "../src/core/modeles.ts";
import { chercherFts } from "../src/core/recherche.ts";
import { demander, ranger } from "../src/core/reponse.ts";
import { cacheModeles, migrer, purgerMessages } from "../src/app/db.ts";
import {
  authentifier,
  creerCompte,
  lireListe,
  reinitialiserMotDePasse,
} from "../src/app/comptes.ts";
import { detecterFormat, MAX_LOT, MAX_OCTETS, nomSur } from "../src/app/depot.ts";
import { tranche } from "../src/core/texte.ts";
import {
  lireDocument,
  lireInformations,
  proposerInformations,
  reextraire,
  relireLegende,
  revendiquer,
  sourceSansInformations,
  statuer,
  traiter,
} from "../src/app/ingestion.ts";
import {
  faitAuHasard,
  genererSuggestions,
  sourceSansSuggestions,
  suggestionsDuPerimetre,
} from "../src/app/suggestions.ts";
import { config } from "../src/app/config.ts";
import { affiliations, cours, matiere, theme } from "../src/app/domaines.ts";
import { reponse } from "../src/app/vues/eleve.ts";
import { environnement, fauxModeles, session } from "./outils.ts";

const CHAMPS = {
  titre: "Art nouveau, panorama",
  type_document: "cours",
  matiere: "arts-appliques",
  classe: "2nde",
  sequence: "ATC Art Nouveau",
};

/** Suit la redirection d'une ancienne adresse de séquence vers la page de son thème. */
const suivre = async (
  s: { requete: (chemin: string) => Promise<Response> | Response },
  chemin: string,
) => {
  const r = await s.requete(chemin);
  return r.status === 302 ? s.requete(r.headers.get("location")!) : r;
};

type Acces = { audience: "prive" | "collegues" | "eleves"; reponses: boolean };

const formulaire = (
  champs: Record<string, string>,
  fichier: Uint8Array,
  nom = "fiche.pdf",
  acces: Acces = { audience: "eleves", reponses: true },
) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.append(k, v);
  f.append("audience", acces.audience);
  if (acces.reponses) f.append("reponses", "1");
  f.append("fichier", new File([fichier as Uint8Array<ArrayBuffer>], nom));
  return f;
};

const enc = (s: string) => new TextEncoder().encode(s);
/** Les mêmes octets feraient un doublon: chaque dépôt d'un test prend sa variante. */
const variante = (octets: Uint8Array, n: string) =>
  enc(`${new TextDecoder().decode(octets)}<!-- ${n} -->`);
/** Un administrateur : ces tests portent sur la sélection, pas sur les cours du lecteur. */
const ELEVE = { id: "", enseignant: false, administrateur: true };

// Une page HTML suffit à exercer extraction, légende, certification et recherche sans pdftotext.
const PAGE = enc(`<html><head><title>t</title></head><body><h1>Casa Batlló, Antoni Gaudí</h1>
<img src="data:image/jpeg;base64,/9j/4AAQ" />
<p>La façade de la Casa Batlló est couverte de céramique irisée et ses balcons évoquent des masques.</p>
<p>Gaudí refuse la ligne droite dans toute la façade.</p>
<p>Le toit en écailles de céramique rappelle le dos d'un dragon, et les cheminées torsadées prolongent le mouvement de la façade jusqu'au ciel de Barcelone.</p></body></html>`);

test("le format vient des octets, un nom reçu ne devient pas un chemin", () => {
  assertEquals(detecterFormat(enc("%PDF-1.7")), "pdf");
  assertEquals(detecterFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "jpg");
  assertEquals(
    detecterFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "png",
  );
  assertEquals(detecterFormat(enc("  <!doctype html><p>a")), "html");
  assertEquals(detecterFormat(enc("MZ binaire")), null);
  assertEquals(nomSur("../../etc/passwd"), "passwd");
  assertEquals(nomSur("Fiche Art Nouveau.pdf"), "Fiche-Art-Nouveau.pdf");
  assertEquals(nomSur("..."), "sans-nom");
});

test("dépôt complet: original écrit, source et travail créés", async () => {
  const { db, dir } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  const r = await requete("/prof/depot", {
    method: "POST",
    body: formulaire(CHAMPS, enc("%PDF-1.7 contenu")),
  });
  assertEquals(r.status, 200);
  assertStringIncludes(await r.text(), "est déposé");
  const s = db.prepare("SELECT id, metadonnees, format FROM sources").get()!;
  assertEquals(s.format, "pdf");
  assertEquals(JSON.parse(s.metadonnees as string).publics, undefined);
  const acces = db.prepare("SELECT audience, reponses, proprietaire_id FROM sources").get()!;
  assertEquals(acces.audience, "eleves");
  assertEquals(acces.reponses, 1);
  assertEquals(acces.proprietaire_id, db.prepare("SELECT id FROM comptes").get()!.id);
  const original = await readFile(
    join(dir, "content", s.id as string, "original", "fiche.pdf"),
    "utf8",
  );
  assertEquals(original, "%PDF-1.7 contenu");
  assertEquals(db.prepare("SELECT etat FROM ingestion_jobs").get()!.etat, "received");
});

test("champs manquants et format refusé: erreurs par champ, saisie conservée", async () => {
  const { db } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  const r = await requete("/prof/depot", {
    method: "POST",
    body: formulaire(
      {
        titre: "   ",
        type_document: "",
        matiere: "",
        classe: "2nde",
        seance: "S1",
      },
      enc("MZ\x90 exe"),
    ),
  });
  assertEquals(r.status, 400);
  const page = await r.text();
  assertStringIncludes(page, 'id="type_document-erreur">Champ obligatoire.');
  assert(!page.includes('id="titre-erreur"'));
  assert(!page.includes('id="matiere-erreur"'));
  assertStringIncludes(page, "Format non reconnu");
  assertStringIncludes(page, 'value="S1"');
  assertEquals(db.prepare("SELECT count(*) n FROM sources").get()!.n, 0);
});

test("les migrations se rejouent sans effet", async () => {
  const { db } = await environnement();
  assertEquals(migrer(db), []);
});

test("une session élève reçoit 403 sur chaque route enseignant", async () => {
  const { db } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "eleve");
  for (const chemin of ["/prof", "/prof/depot", "/prof/legendes", "/prof/sources/x"]) {
    assertEquals((await requete(chemin)).status, 403, chemin);
  }
  assertEquals(
    (await requete("/prof/sources/statut", { method: "POST", body: new FormData() })).status,
    403,
  );
  assertEquals((await requete("/eleve")).status, 200);
});

async function sourceTraitee(
  db: Parameters<typeof traiter>[0],
  legende = "Façade ondulée aux balcons en forme de masques.",
  acces?: Acces,
  // Le compte qui dépose possède la source: lui seul (ou un administrateur) peut ensuite la modifier.
  prof?: Awaited<ReturnType<typeof session>>,
) {
  const { requete } = prof ?? (await session(db, fauxModeles().modeles, "enseignant"));
  await requete("/prof/depot", {
    method: "POST",
    body: formulaire(CHAMPS, PAGE, "casa.html", acces),
  });
  const job = revendiquer(db)!;
  await traiter(db, job, fauxModeles({ legende }).modeles);
  return db.prepare("SELECT id FROM sources").get()!.id as string;
}

test("réextraire met à jour les sections en place, jamais le texte des citations", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  assertEquals(await reextraire(db, id), "identique");
  const blocs = join(config.donnees, "content", id, "blocs.jsonl");
  const avant = await readFile(blocs, "utf8");
  await writeFile(blocs, avant.replaceAll('"section":"', '"section":"ancienne '));
  assertEquals(await reextraire(db, id), "mise_a_jour");
  assertEquals(await readFile(blocs, "utf8"), avant);
  const doc = join(config.donnees, "content", id, "document.txt");
  const extrait = await readFile(doc, "utf8");
  await writeFile(doc, extrait + " modifié");
  await writeFile(blocs, "");
  assertEquals(await reextraire(db, id), "revision", "des offsets bougeraient");
  assertEquals(await readFile(blocs, "utf8"), "", "la révision servie reste telle quelle");
  assertEquals(
    await readFile(join(config.donnees, "content", id, "revisions/2/document.txt"), "utf8"),
    extrait,
  );
});

test("un travail interrompu reprend après expiration du verrou, sans image en double", async () => {
  const { db } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  await requete("/prof/depot", { method: "POST", body: formulaire(CHAMPS, PAGE, "casa.html") });
  const premier = revendiquer(db)!;
  assertEquals(revendiquer(db), undefined, "un travail verrouillé n'est pas repris");
  // Le worker meurt sans rien écrire. Six minutes plus tard, le verrou a expiré.
  const repris = revendiquer(db, Date.now() + 6 * 60_000)!;
  assertEquals(repris.id, premier.id);
  assertEquals(repris.tentatives, 2);
  await traiter(db, repris, fauxModeles().modeles);
  await traiter(db, repris, fauxModeles().modeles);
  assertEquals(db.prepare("SELECT count(*) n FROM images").get()!.n, 1);
  assertEquals(db.prepare("SELECT etat FROM ingestion_jobs").get()!.etat, "awaiting_review");
});

test("une source non certifiée n'apparaît sur aucune route élève ni dans l'index", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  const { requete } = await session(db, fauxModeles().modeles, "eleve");
  assert(!(await (await requete("/eleve")).text()).includes("Art nouveau, panorama"));
  assertEquals((await requete(`/eleve/sources/${id}`)).status, 404);
  assertEquals((await requete(`/media/${id}-0`)).status, 404);
  assertEquals(
    chercherFts(db, "Casa Batlló façade", { lecteur: null, schoolId: "pilote" }).length,
    0,
  );

  statuer(db, id, "certifiee", "test");
  assertStringIncludes(await (await requete("/eleve")).text(), "Art nouveau, panorama");
  assertEquals((await requete(`/eleve/sources/${id}`)).status, 200);
  assertEquals(
    chercherFts(db, "Casa Batlló façade", { lecteur: null, schoolId: "pilote" }).length,
    1,
  );

  statuer(db, id, "rejetee", "test");
  assertEquals((await requete(`/eleve/sources/${id}`)).status, 404);
  assertEquals(
    chercherFts(db, "Casa Batlló façade", { lecteur: null, schoolId: "pilote" }).length,
    0,
  );
});

test("une génération en cours conserve les légendes relues par un enseignant", async () => {
  const { db, dir } = await environnement();
  try {
    const { requete } = await session(db, fauxModeles().modeles, "enseignant");
    for (const action of ["certified", "rejected"] as const) {
      await requete("/prof/depot", {
        method: "POST",
        body: formulaire(CHAMPS, variante(PAGE, action), "casa.html"),
      });
      const job = revendiquer(db)!;
      const appele = Promise.withResolvers<void>();
      const termine = Promise.withResolvers<{ texte: string; modele: string }>();
      const { modeles } = fauxModeles();
      modeles.legender = () => {
        appele.resolve();
        return termine.promise;
      };
      const travail = traiter(db, job, modeles);
      await appele.promise;
      const texte = action === "certified" ? "Légende corrigée par le professeur." : "";
      relireLegende(db, `${job.source_id}-0`, action, texte, "Prof");
      const avant = db.prepare("SELECT * FROM images WHERE source_id = ?").get(job.source_id);
      termine.resolve({ texte: "Légende générée jamais relue.", modele: "faux-vl" });
      await travail;
      assertEquals(
        db.prepare("SELECT * FROM images WHERE source_id = ?").get(job.source_id),
        avant,
      );
      assertEquals(
        db.prepare("SELECT etat FROM ingestion_jobs WHERE id = ?").get(job.id)!.etat,
        "awaiting_review",
      );
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("pendant les légendes, la liste des sources compte les images déjà légendées", async () => {
  const { db, dir } = await environnement();
  try {
    const { requete } = await session(db, fauxModeles().modeles, "enseignant");
    await requete("/prof/depot", { method: "POST", body: formulaire(CHAMPS, PAGE, "casa.html") });
    const job = revendiquer(db)!;
    // Une page HTML ne garde que sa première image. La seconde est ajoutée à la main.
    db.prepare(
      `INSERT INTO images (id, source_id, position, fichier, mime, checksum)
       VALUES (?, ?, 1, 'image-0.jpg', 'image/jpeg', '')`,
    ).run(`${job.source_id}-1`, job.source_id);
    const enAttente = Promise.withResolvers<void>();
    const termine = Promise.withResolvers<{ texte: string; modele: string }>();
    const { modeles } = fauxModeles();
    let appels = 0;
    modeles.legender = () => {
      if (++appels === 1) return Promise.resolve({ texte: "Une image.", modele: "faux-vl" });
      enAttente.resolve();
      return termine.promise;
    };
    const travail = traiter(db, job, modeles);
    await enAttente.promise;
    assertStringIncludes(await (await requete("/prof/lignes")).text(), "légendes 1/2…");
    termine.resolve({ texte: "Une autre image.", modele: "faux-vl" });
    await travail;
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("une certification prématurée ne publie rien après le passage du worker", async () => {
  const { db, dir } = await environnement();
  try {
    const { requete } = await session(db, fauxModeles().modeles, "enseignant");
    await requete("/prof/depot", { method: "POST", body: formulaire(CHAMPS, PAGE, "casa.html") });
    const id = db.prepare("SELECT id FROM sources").get()!.id as string;
    for (const etat of ["received", "extracting", "enriching", "failed"]) {
      db.prepare("UPDATE ingestion_jobs SET etat = ? WHERE source_id = ?").run(etat, id);
      assertThrows(() => statuer(db, id, "certifiee", "Prof"), Error, "pas prête");
      const source = db
        .prepare("SELECT statut, statut_par, statut_le FROM sources WHERE id = ?")
        .get(id)!;
      assertEquals([source.statut, source.statut_par, source.statut_le], ["a_relire", null, null]);
    }
    db.prepare("UPDATE ingestion_jobs SET etat = 'received' WHERE source_id = ?").run(id);
    await traiter(db, revendiquer(db)!, fauxModeles().modeles);
    assertEquals(
      chercherFts(db, "Casa Batlló façade", { lecteur: null, schoolId: "pilote" }).length,
      0,
    );
    const eleve = await session(db, fauxModeles().modeles, "eleve");
    assertEquals((await eleve.requete(`/eleve/sources/${id}`)).status, 404);
    statuer(db, id, "certifiee", "Prof");
    assertEquals(
      chercherFts(db, "Casa Batlló façade", { lecteur: null, schoolId: "pilote" }).length,
      1,
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("un échec d'indexation annule aussi la certification", async () => {
  const { db, dir } = await environnement();
  try {
    const id = await sourceTraitee(db);
    db.exec(`CREATE TRIGGER index_indisponible BEFORE INSERT ON chunks
      BEGIN SELECT RAISE(ABORT, 'Index indisponible'); END`);
    assertThrows(() => statuer(db, id, "certifiee", "Prof"), Error, "Index indisponible");
    const source = db
      .prepare("SELECT statut, statut_par, statut_le FROM sources WHERE id = ?")
      .get(id)!;
    assertEquals([source.statut, source.statut_par, source.statut_le], ["a_relire", null, null]);
    assertEquals(db.prepare("SELECT count(*) n FROM chunks").get()!.n, 0);
    assertEquals(db.prepare("SELECT count(*) n FROM chunks_fts").get()!.n, 0);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("les documents sans thème ont leur propre route, distincte d'un thème homonyme", async () => {
  const { db, dir } = await environnement();
  try {
    cours(db, matiere(db, "Arts appliqués", "arts-appliques"), "Arts appliqués");
    const { requete } = await session(db, fauxModeles().modeles, "enseignant");
    const ids: string[] = [];
    for (const sequence of ["", "Sans séquence"]) {
      await requete("/prof/depot", {
        method: "POST",
        body: formulaire(
          { ...CHAMPS, titre: sequence ? "Cours nommé" : "Cours non classé", sequence },
          variante(PAGE, sequence),
          "casa.html",
        ),
      });
      const job = revendiquer(db)!;
      await traiter(db, job, fauxModeles().modeles);
      statuer(db, job.source_id, "certifiee", "Prof");
      ids.push(job.source_id);
    }
    const eleve = await session(db, fauxModeles().modeles, "eleve");
    const accueil = await (await eleve.requete("/eleve")).text();
    const theme = db
      .prepare("SELECT theme_id FROM source_cours WHERE source_id = ?")
      .get(ids[1])!.theme_id;
    // L'ancienne adresse de la séquence mène au thème du même nom.
    const ancienne = await eleve.requete(`/eleve/sequences/Sans%20s%C3%A9quence?doc=${ids[1]}`);
    assertEquals(ancienne.headers.get("location"), `/eleve/themes/${theme}?doc=${ids[1]}`);
    const chemins = ["/eleve/sans-sequence", `/eleve/themes/${theme}`];
    for (const [i, chemin] of chemins.entries()) {
      assertStringIncludes(accueil, `href="${chemin}"`);
      const r = await eleve.requete(`${chemin}?doc=${ids[i]}`);
      assertEquals(r.status, 200);
      const page = await r.text();
      assertStringIncludes(page, `href="/eleve/sources/${ids[i]}"`);
      assert(!page.includes(ids[1 - i]));
      assertStringIncludes(page, `hx-push-url="${chemin}?doc=${ids[i]}"`);
      const document = await (await eleve.requete(`/eleve/sources/${ids[i]}`)).text();
      assertStringIncludes(document, `href="${chemin}?doc=${ids[i]}"`);
    }
    statuer(db, ids[0], "rejetee", "Prof");
    assertEquals((await eleve.requete("/eleve/sans-sequence")).status, 404);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("sans public Élèves, une source certifiée reste invisible aux élèves et à Thot", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db, undefined, { audience: "collegues", reponses: true });
  statuer(db, id, "certifiee", "test");
  const prof = await session(db, fauxModeles().modeles, "enseignant");
  const eleve = await session(db, fauxModeles().modeles, "eleve");

  assertEquals((await prof.requete(`/prof/sources/${id}`)).status, 200);
  assertEquals((await prof.requete(`/media/${id}-0`)).status, 200);
  assert(!(await (await eleve.requete("/eleve")).text()).includes(CHAMPS.titre));
  for (const chemin of [
    `/eleve/sequences/${encodeURIComponent(CHAMPS.sequence)}`,
    `/eleve/documents/${id}/apercu`,
    `/eleve/sources/${id}`,
    `/media/${id}-0`,
  ])
    assertEquals((await suivre(eleve, chemin)).status, 404, chemin);
  assertEquals(
    (
      await eleve.requete("/eleve/questions", {
        method: "POST",
        body: new URLSearchParams({ texte: "Pourquoi ?", chapitre: CHAMPS.sequence }),
      })
    ).status,
    400,
  );
  assertEquals(
    chercherFts(db, "Casa Batlló façade", { lecteur: null, schoolId: "pilote" }).length,
    0,
  );
  assertEquals(faitAuHasard(db, ELEVE), undefined);
  assertEquals(sourceSansSuggestions(db), undefined);
});

test("sans public Thot, une source reste lisible mais ne sert pas aux réponses", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db, undefined, { audience: "eleves", reponses: false });
  statuer(db, id, "certifiee", "test");
  const { requete } = await session(db, fauxModeles().modeles, "eleve");

  assertStringIncludes(await (await requete("/eleve")).text(), CHAMPS.titre);
  assertEquals((await requete(`/eleve/sources/${id}`)).status, 200);
  assertEquals((await requete(`/media/${id}-0`)).status, 200);
  assertEquals(
    chercherFts(db, "Casa Batlló façade", { lecteur: null, schoolId: "pilote" }).length,
    0,
  );
  assertEquals(sourceSansSuggestions(db), undefined);
  assertEquals(
    (
      await demander(
        db,
        fauxModeles().modeles,
        "Pourquoi Gaudí refuse la ligne droite ?",
        { lecteur: null, schoolId: "pilote" },
        0.023,
      )
    ).resultat.etat,
    "out_of_corpus",
  );
});

test("une légende non relue aide la recherche mais n'atteint jamais le générateur", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db, "Carapace de dragon en écailles turquoise.");
  statuer(db, id, "certifiee", "test");
  // Le mot n'est que dans la légende: la recherche le trouve grâce à elle.
  assertEquals(
    chercherFts(db, "dragon turquoise", { lecteur: null, schoolId: "pilote" }).length,
    1,
  );

  const f = fauxModeles({ sorties: ['{"refus": true}'] });
  await demander(db, f.modeles, "dragon turquoise", { lecteur: null, schoolId: "pilote" }, 0.023);
  assert(!JSON.stringify(f.vus).includes("Carapace"), "légende non relue envoyée au générateur");

  relireLegende(db, `${id}-0`, "certified", "", "test");
  const g = fauxModeles({ sorties: ['{"refus": true}'] });
  await demander(db, g.modeles, "dragon turquoise", { lecteur: null, schoolId: "pilote" }, 0.023);
  assertStringIncludes(JSON.stringify(g.vus), "Image : Carapace de dragon");
});

test("la recherche trouve une image par sa légende non relue sans la montrer", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db, "Carapace de dragon en écailles turquoise.", {
    audience: "eleves",
    reponses: false,
  });
  statuer(db, id, "certifiee", "test");
  const { requete } = await session(db, fauxModeles().modeles, "eleve");

  const page = await (await requete("/eleve/recherche?q=dragon%20turquoise")).text();
  assertStringIncludes(page, `/media/${id}-0`);
  assertStringIncludes(page, CHAMPS.titre);
  assert(!page.includes("Carapace"), "légende non relue montrée à l'élève");
  // Sous le seuil, la page ne montre rien.
  const { requete: bas } = await session(db, fauxModeles({ score: 0.01 }).modeles, "eleve");
  assert(!(await (await bas("/eleve/recherche?q=dragon")).text()).includes(`/media/${id}-0`));
  // Reclasseur en panne: les résultats suivent l'ordre de FTS5.
  const sans = fauxModeles();
  sans.modeles.reclasser = () => Promise.reject(new PanneModele("reclasseur 503"));
  const { requete: repli } = await session(db, sans.modeles, "eleve");
  assertStringIncludes(
    await (await repli("/eleve/recherche?q=dragon%20turquoise")).text(),
    `/media/${id}-0`,
  );
});

test("sans reclasseur, la réponse suit l'ordre de FTS5 et le journal le dit", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  statuer(db, id, "certifiee", "test");
  const q = "Pourquoi la façade de la Casa Batlló n'a pas de ligne droite ?";
  const p = { lecteur: null, schoolId: "pilote" };
  const panne = (f: ReturnType<typeof fauxModeles>, erreur: Error) => {
    f.modeles.reclasser = () => Promise.reject(erreur);
    return f.modeles;
  };

  const ok = await demander(
    db,
    panne(fauxModeles({ sorties: [REPONSE_CITEE] }), new PanneModele("reclasseur 503")),
    q,
    p,
    0.023,
  );
  assertEquals(ok.resultat.etat, "answered");
  assertEquals(ok.journal.reclasseur_indisponible, "reclasseur 503");
  assertEquals((ok.journal.candidats as { rang_fts: number }[])[0].rang_fts, 1);

  const refus = await demander(
    db,
    panne(fauxModeles({ sorties: ['{"refus": true}'] }), new PanneModele("reclasseur 503")),
    q,
    p,
    0.023,
  );
  assertEquals(
    refus.resultat,
    { etat: "failed", code: "MODEL_UNAVAILABLE", message: "reclasseur 503" },
    "un refus sans reclasseur n'est pas une limite du cours",
  );

  const bug = await demander(db, panne(fauxModeles(), new TypeError("bug")), q, p, 0.023);
  assertEquals(bug.resultat.etat === "failed" && bug.resultat.code, "INTERNAL_ERROR");

  const questions = JSON.stringify({ questions: ["Pourquoi Gaudí refuse-t-il la ligne droite ?"] });
  await assertRejects(
    () =>
      genererSuggestions(
        db,
        panne(
          fauxModeles({ sorties: [questions, REPONSE_CITEE] }),
          new PanneModele("reclasseur 503"),
        ),
        id,
      ),
    PanneModele,
  );
  assertEquals(db.prepare("SELECT count(*) n FROM suggestions").get()!.n, 0);
});

test("trois états de réponse distincts, et une citation fausse ne passe jamais", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  statuer(db, id, "certifiee", "test");
  const q = "Pourquoi la façade de la Casa Batlló n'a pas de ligne droite ?";
  const p = { lecteur: null, schoolId: "pilote" };

  const bonne = JSON.stringify({
    affirmations: [
      {
        texte: "Gaudí refuse la ligne droite.",
        extrait: 1,
        citation: "Gaudí refuse la ligne droite dans toute la façade",
      },
    ],
  });
  const ok = await demander(db, fauxModeles({ sorties: [bonne] }).modeles, q, p, 0.023);
  assertEquals(ok.resultat.etat, "answered");
  if (ok.resultat.etat === "answered") {
    const a = ok.resultat.affirmations[0];
    const texte = await readFile(
      `${(await import("../src/app/config.ts")).config.donnees}/content/${id}/document.txt`,
      "utf8",
    );
    assertEquals(
      Array.from(texte).slice(a.debut, a.fin).join(""),
      "Gaudí refuse la ligne droite dans toute la façade",
    );
  }

  const bas = await demander(db, fauxModeles({ score: 0.01 }).modeles, q, p, 0.023);
  assertEquals(bas.resultat, { etat: "out_of_corpus", raison: "seuil" });

  const fausse = JSON.stringify({
    affirmations: [
      {
        texte: "Gaudí utilisait du plutonium.",
        extrait: 1,
        citation: "Gaudí refuse la ligne droite … plutonium radioactif",
      },
    ],
  });
  const repare = await demander(db, fauxModeles({ sorties: [fausse, bonne] }).modeles, q, p, 0.023);
  assertEquals(repare.resultat.etat, "answered", "une réparation est permise");
  const malformee = '{"affirmations": [{"texte": 3, "citation": null}, null]}';
  const forme = await demander(
    db,
    fauxModeles({ sorties: [malformee, bonne] }).modeles,
    q,
    p,
    0.023,
  );
  assertEquals(forme.resultat.etat, "answered", "une sortie mal formée se répare aussi");
  const melange = JSON.stringify({
    affirmations: [JSON.parse(bonne).affirmations[0], JSON.parse(fausse).affirmations[0]],
  });
  const partielle = await demander(
    db,
    fauxModeles({ sorties: [melange, fausse] }).modeles,
    q,
    p,
    0.023,
  );
  assertEquals(partielle.resultat.etat, "answered");
  if (partielle.resultat.etat === "answered") {
    assertEquals(partielle.resultat.affirmations.length, 1);
    assertEquals(partielle.resultat.affirmations[0].texte, "Gaudí refuse la ligne droite.");
    assertEquals(partielle.resultat.partielle, true);
    assertStringIncludes(String(reponse("test", partielle.resultat)), "Réponse partielle");
  }
  const refuse = await demander(
    db,
    fauxModeles({ sorties: [fausse, fausse] }).modeles,
    q,
    p,
    0.023,
  );
  assertEquals(refuse.resultat.etat, "failed");
  if (refuse.resultat.etat === "failed") {
    assertEquals(refuse.resultat.code, "CITATION_UNVERIFIED");
    assertStringIncludes(String(reponse("test", refuse.resultat)), "vérifier les citations");
  }

  // Une citation réelle qui ne prouve pas sa phrase: le juge la refuse, le générateur la répare.
  const excessive = JSON.stringify({
    affirmations: [
      {
        texte: "Gaudí refuse la ligne droite dans toutes ses œuvres.",
        extrait: 1,
        citation: "Gaudí refuse la ligne droite dans toute la façade",
      },
    ],
  });
  const juge = (texte: string) => (texte.includes("toutes ses œuvres") ? 0.1 : 0.9);
  const corrige = fauxModeles({ sorties: [excessive, bonne], soutien: juge });
  const juge1 = await demander(db, corrige.modeles, q, p, 0.023);
  assertEquals(juge1.resultat.etat, "answered", "le juge renvoie en réparation");
  assertStringIncludes(corrige.vus[1].at(-1)!.content, "dit plus que sa citation");
  const avecExces = JSON.stringify({
    affirmations: [JSON.parse(bonne).affirmations[0], JSON.parse(excessive).affirmations[0]],
  });
  const juge2 = await demander(
    db,
    fauxModeles({ sorties: [avecExces, avecExces], soutien: juge }).modeles,
    q,
    p,
    0.023,
  );
  assertEquals(juge2.resultat.etat, "answered");
  if (juge2.resultat.etat === "answered") {
    assertEquals(
      juge2.resultat.affirmations.map((a) => a.texte),
      ["Gaudí refuse la ligne droite."],
    );
    assertEquals(juge2.resultat.partielle, true, "l'affirmation refusée deux fois disparaît");
  }
  const juge3 = await demander(
    db,
    fauxModeles({ sorties: [excessive, excessive], soutien: juge }).modeles,
    q,
    p,
    0.023,
  );
  assertEquals(juge3.resultat.etat, "failed");
  if (juge3.resultat.etat === "failed") assertEquals(juge3.resultat.code, "CITATION_UNVERIFIED");
  const sansJuge = fauxModeles({ sorties: [bonne] });
  sansJuge.modeles.soutenir = () => Promise.reject(new PanneModele("juge injoignable"));
  const juge4 = await demander(db, sansJuge.modeles, q, p, 0.023);
  assertEquals(juge4.resultat.etat, "answered", "un juge en panne ne bloque pas la réponse");
  assertEquals(juge4.journal.juge_indisponible, "juge injoignable");
  assertEquals(juge4.resultat.etat === "answered" && juge4.resultat.juge_indisponible, true);
  assert(ok.resultat.etat === "answered" && !ok.resultat.juge_indisponible);

  // Les consignes d'arts appliqués ne demandent pas de blocs : une réponse d'arts reste plate.
  const avecBlocs = JSON.stringify({
    ...JSON.parse(bonne),
    blocs: [{ type: "etapes", affirmations: [1] }],
  });
  const arts = await demander(db, fauxModeles({ sorties: [avecBlocs] }).modeles, q, p, 0.023);
  assert(arts.resultat.etat === "answered" && !arts.resultat.blocs);

  const vide = fauxModeles();
  vide.modeles.generer = () => {
    throw new PanneModele("Le générateur a rendu une sortie vide.", "MODEL_EMPTY_RESPONSE");
  };
  const panne = await demander(db, vide.modeles, q, p, 0.023);
  assertEquals(panne.resultat.etat, "failed", "une sortie vide est une panne, pas un refus");
  if (panne.resultat.etat === "failed") assertEquals(panne.resultat.code, "MODEL_EMPTY_RESPONSE");
});

test("les blocs rangent les affirmations retenues dans l'ordre de lecture, une structure invalide donne un paragraphe", () => {
  const [un, deux, trois, quatre] = ["Un", "Deux", "Trois", "Quatre"].map((texte) => ({
    texte,
    citation: texte,
    source_id: "s",
    chunk_id: "c",
    titre: "T",
  }));
  // La troisième affirmation du modèle a été refusée.
  const parRang = [un, deux, undefined, trois, quatre];
  assertEquals(
    ranger(
      [
        { type: "etapes", titre: " Dans l'ordre ", affirmations: [2, 1] },
        { type: "liste", affirmations: [3] },
        {
          type: "tableau",
          colonnes: ["A", "B"],
          lignes: [
            { titre: "Rôle", affirmations: [null, 4] },
            { titre: "Vide", affirmations: [] },
          ],
        },
      ],
      parRang,
    ),
    {
      affirmations: [deux, un, trois, quatre],
      blocs: [
        { type: "etapes", titre: "Dans l'ordre", affirmations: [0, 1] },
        {
          type: "tableau",
          colonnes: ["A", "B"],
          lignes: [{ titre: "Rôle", affirmations: [null, 2] }],
        },
        { type: "paragraphe", affirmations: [3] },
      ],
    },
  );
  for (const blocs of [
    undefined,
    "etapes",
    [{ type: "schema", affirmations: [1] }],
    Array(5).fill({ type: "liste", affirmations: [] }),
    [{ type: "liste", titre: "x".repeat(61), affirmations: [1] }],
    [{ type: "liste", affirmations: [1, 1] }],
    [{ type: "liste", affirmations: [6] }],
    [{ type: "liste", affirmations: [1.5] }],
    [{ type: "tableau", colonnes: ["A"], lignes: [{ titre: "x", affirmations: [1, 2] }] }],
    [{ type: "tableau", colonnes: Array(5).fill("A"), lignes: [] }],
    [{ type: "tableau", colonnes: ["A"], lignes: [{ titre: "", affirmations: [1] }] }],
  ]) {
    assertEquals(ranger(blocs, parRang), { affirmations: [un, deux, trois, quatre] });
  }
});

test("un schéma ne garde que des relations prouvées, une structure hors bornes donne un paragraphe", () => {
  const [un, deux, trois, quatre] = ["Un", "Deux", "Trois", "Quatre"].map((texte) => ({
    texte,
    citation: texte,
    source_id: "s",
    chunk_id: "c",
    titre: "T",
  }));
  // La troisième affirmation du modèle a été refusée.
  const parRang = [un, deux, undefined, trois, quatre];
  const noeuds = [{ titre: "A", affirmation: 1 }, { titre: "B" }, { titre: "C" }, { titre: "D" }];
  // La relation de C à D cite l'affirmation refusée : elle part, et C et D avec elle.
  const relations = [
    { de: 1, vers: 2, lien: "cause", affirmation: 2 },
    { de: 3, vers: 4, lien: "suite", affirmation: 3 },
  ];
  assertEquals(ranger([{ type: "schema", titre: "Chaîne", noeuds, relations }], parRang), {
    affirmations: [un, deux, trois, quatre],
    blocs: [
      {
        type: "schema",
        titre: "Chaîne",
        noeuds: [{ titre: "A", affirmation: 0 }, { titre: "B" }],
        relations: [{ de: 0, vers: 1, lien: "cause", affirmation: 1 }],
      },
      { type: "paragraphe", affirmations: [2, 3] },
    ],
  });
  // Un schéma dont aucune preuve ne reste disparaît.
  assertEquals(
    ranger(
      [
        {
          type: "schema",
          noeuds: noeuds.slice(1),
          relations: [{ ...relations[1], de: 1, vers: 2 }],
        },
      ],
      parRang,
    ),
    {
      affirmations: [un, deux, trois, quatre],
      blocs: [{ type: "paragraphe", affirmations: [0, 1, 2, 3] }],
    },
  );
  // La preuve d'une relation que le modèle donne aussi à un nœud reste à la relation.
  assertEquals(
    ranger([{ type: "schema", noeuds, relations: [{ ...relations[0], affirmation: 1 }] }], parRang),
    {
      affirmations: [un, deux, trois, quatre],
      blocs: [
        {
          type: "schema",
          noeuds: [{ titre: "A" }, { titre: "B" }],
          relations: [{ de: 0, vers: 1, lien: "cause", affirmation: 0 }],
        },
        { type: "paragraphe", affirmations: [1, 2, 3] },
      ],
    },
  );
  const avec = (modif: Record<string, unknown>) => [
    { type: "schema", noeuds, relations, ...modif },
  ];
  for (const blocs of [
    avec({ noeuds: noeuds.slice(0, 1), relations: [] }),
    avec({ noeuds: Array(9).fill({ titre: "N" }) }),
    avec({ noeuds: "A, B" }),
    avec({ noeuds: [...noeuds.slice(0, 3), { titre: "x".repeat(61) }] }),
    avec({ noeuds: [...noeuds.slice(0, 3), { titre: " " }] }),
    avec({ relations: [] }),
    avec({ relations: Array(9).fill(relations[0]) }),
    avec({ relations: [{ ...relations[0], affirmation: undefined }] }),
    avec({ relations: [{ ...relations[0], lien: "oppose" }] }),
    avec({ relations: [{ ...relations[0], lien: "toString" }] }),
    avec({ relations: [{ ...relations[0], vers: 1 }] }),
    avec({ relations: [{ ...relations[0], vers: 5 }] }),
    avec({ relations: [{ ...relations[0], de: "1" }] }),
    // Une preuve sert une seule relation.
    avec({ relations: [relations[0], { ...relations[1], affirmation: 2 }] }),
    avec({ relations: [{ ...relations[0], affirmation: 6 }] }),
  ]) {
    assertEquals(ranger(blocs, parRang), { affirmations: [un, deux, trois, quatre] });
  }
});

test("le chat: question, flux SSE, réponse citée, panneau source", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  statuer(db, id, "certifiee", "test");
  const bonne = JSON.stringify({
    affirmations: [
      {
        texte: "Gaudí refuse la ligne droite.",
        extrait: 1,
        citation: "Gaudí refuse la ligne droite dans toute la façade",
      },
    ],
  });
  const { requete } = await session(db, fauxModeles({ sorties: [bonne] }).modeles, "eleve");
  const q = await requete("/eleve/questions", {
    method: "POST",
    headers: { "HX-Request": "true" },
    body: new URLSearchParams({ texte: "Pourquoi pas de ligne droite ?" }),
  });
  const fragment = await q.text();
  const mid = fragment.match(/messages\/([\w-]+)\/flux/)![1];
  const flux = await (await requete(`/eleve/messages/${mid}/flux`)).text();
  assertStringIncludes(flux, "event: reponse");
  assertStringIncludes(flux, "Gaudí refuse la ligne droite.");
  // Une reconnexion relit la réponse enregistrée sans rappeler le générateur, qui n'a plus de sortie.
  assertStringIncludes(
    await (await requete(`/eleve/messages/${mid}/flux`)).text(),
    "event: reponse",
  );
  const panneau = await (await requete(`/eleve/messages/${mid}/citations/0`)).text();
  assertStringIncludes(panneau, "<mark>Gaudí refuse la ligne droite dans toute la façade</mark>");
  assertStringIncludes(panneau, `/eleve/sources/${id}?debut=`);
});

test("une question proposée n'est gardée que si Thot y répond avec une citation vérifiée", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  statuer(db, id, "certifiee", "test");
  const bonne = JSON.stringify({
    affirmations: [
      {
        texte: "Gaudí refuse la ligne droite.",
        extrait: 1,
        citation: "Gaudí refuse la ligne droite dans toute la façade",
      },
    ],
  });
  const malformee = fauxModeles({ sorties: ['{"questions": "Pourquoi ?"}'] });
  assertEquals(await genererSuggestions(db, malformee.modeles, id), 0);
  const f = fauxModeles({
    sorties: [
      JSON.stringify({
        questions: [
          "Pourquoi le motif alterne-t-il le vert et le bleu ?",
          "Que montre cette œuvre ?",
          "Pourquoi Gaudí refuse-t-il la ligne droite ?",
          "Quel âge avait Gaudí ?",
        ],
      }),
      bonne,
      '{"refus": true}',
    ],
  });
  assertEquals(await genererSuggestions(db, f.modeles, id), 1);
  assertEquals(
    db
      .prepare("SELECT question FROM suggestions")
      .all()
      .map((l) => l.question),
    ["Pourquoi Gaudí refuse-t-il la ligne droite ?"],
  );
  assertEquals(suggestionsDuPerimetre(db, ELEVE, new Set([id])).length, 1);
  statuer(db, id, "rejetee", "test");
  assertEquals(
    suggestionsDuPerimetre(db, ELEVE, new Set([id])).length,
    0,
    "une source rejetée ne propose plus rien",
  );
});

test("le saviez-vous recopie une phrase certifiée et pointe sa position exacte", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  assertEquals(faitAuHasard(db, ELEVE), undefined, "rien tant que la source n'est pas certifiée");
  statuer(db, id, "certifiee", "test");
  const fait = faitAuHasard(db, ELEVE)!;
  const texte = await readFile(`${config.donnees}/content/${id}/document.txt`, "utf8");
  assertEquals(Array.from(texte).slice(fait.debut, fait.fin).join(""), fait.phrase);
});

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

test("chapitre, suivi, avis et revue enseignant restent liés à la question", async () => {
  const { db } = await environnement();
  const source = await sourceTraitee(db);
  statuer(db, source, "certifiee", "test");
  // L'ancien chapitre « ATC Art Nouveau » est le thème de même nom de la source.
  const c = cours(db, db.prepare("SELECT id FROM matieres").get()!.id as string, "Design");
  const t = theme(db, c, CHAMPS.sequence);
  affiliations(db, source, [{ cours_id: c, theme_id: t }]);
  const bonne = JSON.stringify({
    affirmations: [
      {
        texte: "Gaudí refuse la ligne droite.",
        extrait: 1,
        citation: "Gaudí refuse la ligne droite dans toute la façade",
      },
    ],
  });
  const f = fauxModeles({ sorties: [bonne, bonne, bonne] });
  let reformulation = "";
  f.modeles.reformuler = (precedente, question) => {
    reformulation = `${precedente} / ${question}`;
    return Promise.resolve("Casa Batlló façade ligne droite");
  };
  const eleve = await session(db, f.modeles, "eleve");
  const premier = await eleve.requete("/eleve/questions", {
    method: "POST",
    headers: { "HX-Request": "true" },
    body: new URLSearchParams({
      texte: "Pourquoi Gaudí refuse la ligne droite ?",
      chapitre: "ATC Art Nouveau",
    }),
  });
  const id1 = (await premier.text()).match(/messages\/([\w-]+)\/flux/)![1];
  assertStringIncludes(
    await (await eleve.requete(`/eleve/messages/${id1}/flux`)).text(),
    "Gaudí refuse",
  );
  // Une page d'avant les thèmes envoie un chapitre : la question part dans son thème.
  const conversation = db.prepare("SELECT conversation_id FROM messages WHERE id = ?").get(id1)!
    .conversation_id as string;
  const portee = db
    .prepare(
      `SELECT m.theme_id || ' ' || v.theme_id AS t FROM messages m
       JOIN conversations v ON v.id = m.conversation_id WHERE m.id = ?`,
    )
    .get(id1)!.t;
  assertEquals(portee, `${t} ${t}`);
  const second = await eleve.requete("/eleve/questions", {
    method: "POST",
    headers: { "HX-Request": "true" },
    body: new URLSearchParams({ texte: "Et la façade ?", conversation }),
  });
  const id2 = (await second.text()).match(/messages\/([\w-]+)\/flux/)![1];
  assertStringIncludes(
    await (await eleve.requete(`/eleve/messages/${id2}/flux`)).text(),
    "Gaudí refuse",
  );
  assertStringIncludes(reformulation, "Pourquoi Gaudí refuse la ligne droite ? / Et la façade ?");
  const demande = f.vus.at(-1)![1].content as string;
  assertStringIncludes(demande, "Question précédente : Pourquoi Gaudí refuse la ligne droite ?");
  assertStringIncludes(demande, "Question de l'eleve : Et la façade ?");
  assert(!demande.includes("Casa Batlló façade ligne droite"));
  assertEquals(
    JSON.parse(db.prepare("SELECT journal FROM messages WHERE id = ?").get(id2)!.journal as string)
      .question_recherche,
    "Casa Batlló façade ligne droite",
  );
  reformulation = "";
  assertEquals(
    (
      await eleve.requete(`/eleve/chat/${conversation}/perimetre`, {
        method: "POST",
        body: new URLSearchParams({ matiere_id: "", cours_id: "", theme_id: "" }),
      })
    ).status,
    303,
  );
  const sansChapitre = await eleve.requete("/eleve/questions", {
    method: "POST",
    headers: { "HX-Request": "true" },
    body: new URLSearchParams({ texte: "Et Gaudí ?", conversation }),
  });
  const id3 = (await sansChapitre.text()).match(/messages\/([\w-]+)\/flux/)![1];
  await eleve.requete(`/eleve/messages/${id3}/flux`);
  assertEquals(
    reformulation,
    "",
    "après un changement de périmètre, la question ne reprend pas la précédente",
  );
  assertStringIncludes(
    await (await eleve.requete(`/eleve/chat/${conversation}`)).text(),
    "Périmètre changé : toutes tes ressources",
  );
  assertEquals(
    (
      await eleve.requete("/eleve/questions", {
        method: "POST",
        body: new URLSearchParams({ texte: "Question", chapitre: "Chapitre absent" }),
      })
    ).status,
    400,
  );
  assertEquals(
    (
      await eleve.requete(`/eleve/messages/${id2}/avis`, {
        method: "POST",
        body: new URLSearchParams({ avis: "faux" }),
      })
    ).status,
    200,
  );
  // hono/html rend `true` en attribut vide: l'avis choisi doit rester marqué au rechargement.
  assertStringIncludes(
    await (await eleve.requete("/eleve/chat")).text(),
    'aria-pressed="true" name="avis" value="faux"',
  );
  const prof = await session(db, fauxModeles().modeles, "enseignant");
  const revue = await (await prof.requete("/prof/questions")).text();
  assertStringIncludes(revue, "ATC Art Nouveau");
  assertStringIncludes(revue, "Fausse");
  db.prepare("UPDATE messages SET etat = 'failed', resultat = ? WHERE id = ?").run(
    JSON.stringify({ etat: "failed", code: "CITATION_UNVERIFIED", message: "" }),
    id3,
  );
  assertStringIncludes(
    await (await prof.requete("/prof/questions")).text(),
    "Citation non vérifiée",
  );
  db.prepare("UPDATE messages SET resultat = NULL WHERE id = ?").run(id3);
  assertEquals(
    (await eleve.requete(`/eleve/messages/${id3}/relancer`, { method: "POST" })).status,
    200,
    "une panne sans résultat enregistré reste relançable",
  );
});

test("Thot propose date, artiste et mouvement, l'enseignant les valide", async () => {
  const { db } = await environnement();
  const prof = await session(db, fauxModeles().modeles, "enseignant");
  const id = await sourceTraitee(db, undefined, undefined, prof);
  statuer(db, id, "certifiee", "test");
  assertEquals(
    lireInformations(
      '{"artiste": "Gaudí, Picasso", "mouvement": "Art nouveau"}',
      "Gaudí Art-Nouveau",
    ),
    { date: "", artiste: "", mouvement: "Art nouveau" },
  );
  assertEquals(sourceSansInformations(db), id);
  const sortie = JSON.stringify({
    date: "1906",
    artiste: "Antoni Gaudí",
    mouvement: "Art nouveau",
  });
  await proposerInformations(db, fauxModeles({ sorties: [sortie] }).modeles, id);
  assertEquals(sourceSansInformations(db), undefined);

  const fiche = await (await prof.requete(`/prof/sources/${id}`)).text();
  assertStringIncludes(fiche, 'value="Antoni Gaudí"');
  assertStringIncludes(fiche, "Proposé par Thot");
  assert(!fiche.includes('value="1906"'), "une date absente de la fiche n'est pas proposée");
  const eleve = await session(db, fauxModeles().modeles, "eleve");
  const chapitre = `/eleve/sequences/${encodeURIComponent(CHAMPS.sequence)}`;
  assert(!(await (await suivre(eleve, chapitre)).text()).includes("data-verifier-quiz"));

  await prof.requete(`/prof/sources/${id}/modifier`, {
    method: "POST",
    body: new URLSearchParams({
      titre: CHAMPS.titre,
      sequence: CHAMPS.sequence,
      date: "",
      artiste: "Antoni Gaudí",
      mouvement: "Art nouveau",
    }),
  });
  assert(!(await (await prof.requete(`/prof/sources/${id}`)).text()).includes("Proposé par Thot"));
  assertStringIncludes(
    await (await suivre(eleve, chapitre)).text(),
    'data-answer="Antoni Gaudí|Art nouveau"',
  );
  assertEquals(sourceSansInformations(db), undefined);
});

test("titre édité réindexé, image certifiée liée à la réponse et messages purgés", async () => {
  const { db } = await environnement();
  const prof = await session(db, fauxModeles().modeles, "enseignant");
  const id = await sourceTraitee(db, undefined, undefined, prof);
  statuer(db, id, "certifiee", "test");
  const r = await prof.requete(`/prof/sources/${id}/modifier`, {
    method: "POST",
    body: new URLSearchParams({ titre: "Casa Batlló corrigée", date: "1906", artiste: "Gaudí" }),
  });
  assertEquals(r.status, 303);
  assertStringIncludes(
    chercherFts(db, "corrigée", { lecteur: null, schoolId: "pilote" })[0].titre,
    "corrigée",
  );
  relireLegende(db, `${id}-0`, "certified", "", "test");
  const bonne = JSON.stringify({
    affirmations: [
      {
        texte: "Les balcons ressemblent à des masques.",
        extrait: 1,
        citation: "façade ondulée aux balcons en forme de masques",
      },
    ],
  });
  const { resultat } = await demander(
    db,
    fauxModeles({ sorties: [bonne] }).modeles,
    "balcons masques",
    { lecteur: null, schoolId: "pilote" },
    0.023,
  );
  assertEquals(resultat.etat, "answered");
  if (resultat.etat === "answered") assertEquals(resultat.affirmations[0].image_id, `${id}-0`);
  const texteCite = JSON.stringify({
    affirmations: [
      {
        texte: "Gaudí refuse la ligne droite.",
        extrait: 1,
        citation: "Gaudí refuse la ligne droite dans toute la façade",
      },
    ],
  });
  const texteResultat = await demander(
    db,
    fauxModeles({ sorties: [texteCite] }).modeles,
    "ligne droite",
    { lecteur: null, schoolId: "pilote" },
    0.023,
  );
  assertEquals(texteResultat.resultat.etat, "answered");
  if (texteResultat.resultat.etat === "answered") {
    assertEquals(texteResultat.resultat.affirmations[0].image_id, `${id}-0`);
  }
  const eleve = await session(db, fauxModeles().modeles, "eleve");
  const accueil = await (await eleve.requete("/eleve")).text();
  assertStringIncludes(accueil, "Casa Batlló corrigée");
  assertStringIncludes(
    await (await suivre(eleve, `/eleve/sequences/${encodeURIComponent(CHAMPS.sequence)}`)).text(),
    "1906",
  );
  const compte = db
    .prepare("SELECT id FROM comptes WHERE role = 'eleve' ORDER BY rowid DESC LIMIT 1")
    .get()!.id;
  db.prepare(
    "INSERT INTO messages (id, compte_id, question, etat, cree_le, maj_le) VALUES ('ancien', ?, 'question', 'en_attente', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
  ).run(compte);
  assertEquals(purgerMessages(db, 90, Date.UTC(2026, 8, 23)), 1);
});

const REPONSE_CITEE = JSON.stringify({
  affirmations: [
    {
      texte: "Gaudí refuse la ligne droite.",
      extrait: 1,
      citation: "Gaudí refuse la ligne droite dans toute la façade",
    },
  ],
});

async function poserQuestion(
  requete: Awaited<ReturnType<typeof session>>["requete"],
  texte = "ligne droite",
) {
  const r = await requete("/eleve/questions", {
    method: "POST",
    headers: { "HX-Request": "true" },
    body: new URLSearchParams({ texte }),
  });
  return (await r.text()).match(/messages\/([\w-]+)\/flux/)![1];
}

test("une panne d'indexation annule aussi les éditions de légende et de métadonnées", async () => {
  const { db } = await environnement();
  try {
    const prof = await session(db, fauxModeles().modeles, "enseignant");
    const id = await sourceTraitee(db, undefined, undefined, prof);
    statuer(db, id, "certifiee", "Prof");
    relireLegende(db, `${id}-0`, "certified", "", "Prof");
    const image = db.prepare("SELECT * FROM images WHERE source_id = ?").get(id);
    const source = db.prepare("SELECT * FROM sources WHERE id = ?").get(id);
    const chunks = db.prepare("SELECT * FROM chunks WHERE source_id = ?").all(id);
    db.exec(
      "CREATE TRIGGER index_indisponible BEFORE INSERT ON chunks BEGIN SELECT RAISE(ABORT, 'Index indisponible'); END",
    );
    for (const action of ["rejected", "certified"] as const) {
      assertThrows(() => relireLegende(db, `${id}-0`, action, "Une légende corrigée.", "Prof"));
      assertEquals(db.prepare("SELECT * FROM images WHERE source_id = ?").get(id), image);
      assertEquals(db.prepare("SELECT * FROM chunks WHERE source_id = ?").all(id), chunks);
    }
    const r = await prof.requete(`/prof/sources/${id}/modifier`, {
      method: "POST",
      body: new URLSearchParams({ titre: "Titre corrigé", sequence: "Architecture" }),
    });
    assertEquals(r.status, 500);
    assertEquals(db.prepare("SELECT * FROM sources WHERE id = ?").get(id), source);
    assertEquals(db.prepare("SELECT * FROM chunks WHERE source_id = ?").all(id), chunks);
  } finally {
    db.close();
  }
});

test("un retrait pendant la génération ou le reclassement n'est pas publié", async () => {
  const { db } = await environnement();
  try {
    const id = await sourceTraitee(db);
    statuer(db, id, "certifiee", "Prof");
    const fake = fauxModeles({ sorties: [REPONSE_CITEE] });
    const generer = fake.modeles.generer;
    fake.modeles.generer = (messages) => {
      statuer(db, id, "rejetee", "Prof");
      return generer(messages);
    };
    const eleve = await session(db, fake.modeles, "eleve");
    const mid = await poserQuestion(eleve.requete);
    const flux = await (await eleve.requete(`/eleve/messages/${mid}/flux`)).text();
    assert(!flux.includes("Gaudí refuse la ligne droite."));
    assertEquals(
      JSON.parse(
        db.prepare("SELECT resultat FROM messages WHERE id = ?").get(mid)!.resultat as string,
      ).code,
      "EVIDENCE_WITHDRAWN",
    );
    statuer(db, id, "certifiee", "Prof");
    const reclasser = fake.modeles.reclasser;
    fake.modeles.reclasser = (q, docs) => {
      statuer(db, id, "rejetee", "Prof");
      return reclasser(q, docs);
    };
    const recherche = await (await eleve.requete("/eleve/recherche?q=ligne")).text();
    assert(!recherche.includes(CHAMPS.titre));
    assert(!recherche.includes("Gaudí refuse la ligne droite"));
  } finally {
    db.close();
  }
});

test("les réponses conservées et leurs panneaux revérifient la preuve actuelle", async () => {
  for (const retrait of ["legende", "source", "public", "titre"] as const) {
    const { db } = await environnement();
    try {
      const prof = await session(db, fauxModeles().modeles, "enseignant");
      const id = await sourceTraitee(db, undefined, undefined, prof);
      statuer(db, id, "certifiee", "Prof");
      relireLegende(db, `${id}-0`, "certified", "", "Prof");
      const sortie =
        retrait === "legende"
          ? JSON.stringify({
              affirmations: [
                {
                  texte: "Les balcons ressemblent à des masques.",
                  extrait: 1,
                  citation: "Façade ondulée aux balcons en forme de masques",
                },
              ],
            })
          : REPONSE_CITEE;
      const eleve = await session(db, fauxModeles({ sorties: [sortie] }).modeles, "eleve");
      const mid = await poserQuestion(eleve.requete, "ligne droite balcons masques");
      await (await eleve.requete(`/eleve/messages/${mid}/flux`)).text();
      assertStringIncludes(
        await (await eleve.requete(`/eleve/messages/${mid}/citations/0`)).text(),
        "<mark>",
      );
      if (retrait === "legende") relireLegende(db, `${id}-0`, "rejected", "", "Prof");
      if (retrait === "source") statuer(db, id, "rejetee", "Prof");
      if (retrait === "public") {
        db.prepare("UPDATE sources SET reponses = 0 WHERE id = ?").run(id);
      }
      if (retrait === "titre") {
        await prof.requete(`/prof/sources/${id}/modifier`, {
          method: "POST",
          body: new URLSearchParams({ titre: "Autre œuvre" }),
        });
      }
      for (const route of ["/eleve/chat", `/eleve/messages/${mid}/flux`]) {
        const vue = await (await eleve.requete(route)).text();
        assertStringIncludes(vue, "Une source de cette réponse a été retirée ou modifiée.");
        assert(!vue.includes(JSON.parse(sortie).affirmations[0].texte));
      }
      assert(
        !(await (await eleve.requete(`/eleve/messages/${mid}/citations/0`)).text()).includes(
          "<mark>",
        ),
      );
      assertEquals(
        (await eleve.requete(`/eleve/messages/${mid}/relancer`, { method: "POST" })).status,
        200,
      );
    } finally {
      db.close();
    }
  }
});

/** Réécrit l'original HTML de la source, comme le lirait un extracteur corrigé. */
async function changerOriginal(id: string, avant: string, apres: string) {
  const original = join(config.donnees, "content", id, "original", "casa.html");
  await writeFile(original, (await readFile(original, "utf8")).replace(avant, apres));
}

const revisions = (db: Parameters<typeof traiter>[0], id: string) => ({
  servie: db.prepare("SELECT revision FROM sources WHERE id = ?").get(id)!.revision,
  index: db
    .prepare("SELECT DISTINCT revision FROM chunks WHERE source_id = ?")
    .all(id)
    .map((c) => c.revision),
  enregistrees: db
    .prepare("SELECT n FROM revisions WHERE source_id = ? ORDER BY n")
    .all(id)
    .map((r) => r.n),
});

test("un texte réextrait attend sa certification, une ancienne réponse garde son passage", async () => {
  const { db, dir } = await environnement();
  try {
    const prof = await session(db, fauxModeles().modeles, "enseignant");
    const id = await sourceTraitee(db, undefined, undefined, prof);
    statuer(db, id, "certifiee", "Prof");
    const sorties = [REPONSE_CITEE, REPONSE_CITEE];
    const eleve = await session(db, fauxModeles({ sorties }).modeles, "eleve");
    const ancien = await poserQuestion(eleve.requete);
    await (await eleve.requete(`/eleve/messages/${ancien}/flux`)).text();

    // Une phrase de plus avant le passage cité déplace ses offsets.
    await changerOriginal(id, "<p>Gaudí", "<p>Une phrase ajoutée.</p><p>Gaudí");
    assertEquals(await reextraire(db, id), "revision");
    assertEquals(await reextraire(db, id), "identique", "la version en attente est déjà là");
    assertEquals(revisions(db, id), { servie: 1, index: [1], enregistrees: [1, 2] });
    assertStringIncludes(
      await (await prof.requete(`/prof/sources/${id}`)).text(),
      "Nouvelle version à relire",
    );
    assertEquals((await eleve.requete(`/eleve/sources/${id}?revision=2`)).status, 404);
    const aRelire = await (await prof.requete("/prof?statut=a_relire")).text();
    assertStringIncludes(aRelire, "Nouvelle version à relire");
    assertStringIncludes(aRelire, `/prof/sources/${id}"`);
    assert(
      !(await (await prof.requete("/prof?statut=certifiee")).text()).includes(
        `/prof/sources/${id}"`,
      ),
    );

    const certifier = await prof.requete(`/prof/sources/${id}/revisions/2/certifiee`, {
      method: "POST",
    });
    assertEquals(certifier.status, 303);
    assertEquals(revisions(db, id), { servie: 2, index: [2], enregistrees: [1, 2] });
    assert(!(await (await prof.requete("/prof")).text()).includes("Nouvelle version à relire"));

    assertStringIncludes(
      await (await eleve.requete("/eleve/chat")).text(),
      "Gaudí refuse la ligne droite.",
    );
    const panneau = await (await eleve.requete(`/eleve/messages/${ancien}/citations/0`)).text();
    assertStringIncludes(panneau, "<mark>Gaudí refuse la ligne droite dans toute la façade</mark>");
    const lien = panneau.match(/href="(\/eleve\/sources\/[^"#]+)/)![1].replaceAll("&amp;", "&");
    assertStringIncludes(lien, "revision=1");
    const lecture = await (await eleve.requete(lien)).text();
    assertStringIncludes(lecture, "Version citée par une réponse précédente");
    assert(!lecture.includes("Une phrase ajoutée."));

    const nouveau = await poserQuestion(eleve.requete);
    await (await eleve.requete(`/eleve/messages/${nouveau}/flux`)).text();
    const [a, b] = [ancien, nouveau].map(
      (m) =>
        JSON.parse(
          db.prepare("SELECT resultat FROM messages WHERE id = ?").get(m)!.resultat as string,
        ).affirmations[0],
    );
    assertEquals([a.revision, b.revision], [1, 2]);
    assert(b.debut > a.debut, "la nouvelle réponse cite la nouvelle version");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("un échec d'extraction ou d'indexation laisse servir la révision certifiée", async () => {
  const { db, dir } = await environnement();
  try {
    const prof = await session(db, fauxModeles().modeles, "enseignant");
    const id = await sourceTraitee(db, undefined, undefined, prof);
    statuer(db, id, "certifiee", "Prof");
    const racine = join(config.donnees, "content", id);
    const page = await readFile(join(racine, "original", "casa.html"));
    await rm(join(racine, "original", "casa.html"));
    await assertRejects(() => reextraire(db, id));
    assertEquals(revisions(db, id), { servie: 1, index: [1], enregistrees: [1] });

    await writeFile(join(racine, "original", "casa.html"), page);
    await changerOriginal(id, "ligne droite", "ligne sinueuse");
    assertEquals(await reextraire(db, id), "revision");
    db.exec(`CREATE TRIGGER index_indisponible BEFORE INSERT ON chunks
      BEGIN SELECT RAISE(ABORT, 'Index indisponible'); END`);
    assertThrows(() => statuer(db, id, "certifiee", "Prof", 2), Error, "Index indisponible");
    db.exec("DROP TRIGGER index_indisponible");
    assertEquals(revisions(db, id), { servie: 1, index: [1], enregistrees: [1, 2] });
    const cherche = (q: string) => chercherFts(db, q, { lecteur: null, schoolId: "pilote" }).length;
    assertEquals([cherche("droite"), cherche("sinueuse")], [1, 0]);

    // Rejeter la version en attente la supprime. Une page restée ouverte ne la certifie plus.
    const rejeter = await prof.requete(`/prof/sources/${id}/revisions/2/rejetee`, {
      method: "POST",
    });
    assertEquals(rejeter.status, 303);
    assertEquals(revisions(db, id), { servie: 1, index: [1], enregistrees: [1] });
    await assertRejects(() => readFile(join(racine, "revisions", "2", "document.txt")));
    assertStringIncludes(await readFile(join(racine, "document.txt"), "utf8"), "ligne droite");
    const tard = await prof.requete(`/prof/sources/${id}/revisions/2/certifiee`, {
      method: "POST",
    });
    assertEquals(tard.status, 409);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("le crédit se saisit à la relecture, s'affiche échappé et ne sort ni de la recherche ni du générateur", async () => {
  const { db, dir } = await environnement();
  try {
    const prof = await session(db, fauxModeles().modeles, "enseignant");
    const acces = { audience: "eleves", reponses: false } as const;
    const texte = "Carapace de dragon en écailles turquoise.";
    const id = await sourceTraitee(db, texte, acces, prof);
    statuer(db, id, "certifiee", "Prof");
    const credit = "<script>alert(1)</script> Musée";
    const corps = new URLSearchParams({ image: `${id}-0`, texte, credit });
    assertEquals(
      (await prof.requete("/prof/legendes/certified", { method: "POST", body: corps })).status,
      200,
    );
    assertEquals(
      db.prepare("SELECT credit FROM images WHERE id = ?").get(`${id}-0`)!.credit,
      credit,
    );

    const { requete } = await session(db, fauxModeles().modeles, "eleve");
    const page = await (await requete(`/eleve/sources/${id}`)).text();
    assertStringIncludes(page, '<span class="credit">&lt;script&gt;alert(1)&lt;/script&gt; Musée');
    assert(!page.includes("<script>alert(1)"), "crédit non échappé");

    assertEquals(chercherFts(db, "Musée", { lecteur: null, schoolId: "pilote" }).length, 0);
    const f = fauxModeles({ sorties: ['{"refus": true}'] });
    await demander(db, f.modeles, "dragon turquoise", { lecteur: null, schoolId: "pilote" }, 0.023);
    assert(!JSON.stringify(f.vus).includes("Musée"), "crédit envoyé au générateur");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("une légende relue ne reste pas sur une autre image à la même place", async () => {
  const { db, dir } = await environnement();
  try {
    const id = await sourceTraitee(db, "Façade aux balcons en masques.");
    relireLegende(db, `${id}-0`, "certified", "", "Prof");
    await changerOriginal(id, "/9j/4AAQ", "/9j/4AAR");
    db.prepare("UPDATE ingestion_jobs SET etat = 'received' WHERE source_id = ?").run(id);
    await traiter(db, revendiquer(db)!, fauxModeles({ legende: "Autre image." }).modeles);
    assertEquals(
      { ...db.prepare("SELECT legende, legende_statut FROM images WHERE id = ?").get(`${id}-0`) },
      { legende: "Autre image.", legende_statut: "unreviewed" },
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
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

test("les dépôts trop grands sont refusés avant lecture du fichier", async () => {
  const { db } = await environnement();
  const arrayBuffer = File.prototype.arrayBuffer;
  try {
    const prof = await session(db, fauxModeles().modeles, "enseignant");
    let lectures = 0;
    File.prototype.arrayBuffer = function () {
      lectures++;
      return arrayBuffer.call(this);
    };
    const proche = await prof.requete("/prof/depot", {
      method: "POST",
      body: formulaire(CHAMPS, new Uint8Array(MAX_OCTETS + 1)),
    });
    assertEquals(proche.status, 400);
    assertEquals(lectures, 0);
    let lus = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        lus++;
        c.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const trop = await prof.requete("/prof/depot", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      body,
      duplex: "half",
    });
    assertEquals(trop.status, 413);
    assert(lus <= 53, "le flux est arrêté sans lire tout le corps");
    assertEquals(lectures, 0);
    assertEquals(db.prepare("SELECT count(*) n FROM sources").get()!.n, 0);
  } finally {
    File.prototype.arrayBuffer = arrayBuffer;
    db.close();
  }
});

test("la migration efface les jugements anciens et ne se rejoue pas", async () => {
  const { db } = await environnement();
  try {
    db.exec("ALTER TABLE messages DROP COLUMN generation_id");
    db.prepare("DELETE FROM migrations WHERE nom = '0005_coherence.sql'").run();
    cacheModeles(db).ecrire("ancien", JSON.stringify({ reasoning: "PrivateName" }));
    assertEquals(migrer(db), ["0005_coherence.sql"]);
    assertEquals(db.prepare("SELECT count(*) n FROM cache_modeles").get()!.n, 0);
    cacheModeles(db).ecrire("legende", "image");
    assertEquals(migrer(db), []);
    assertEquals(cacheModeles(db).lire("legende"), "image");
  } finally {
    db.close();
  }
});

test("une sortie vide du reclasseur déclenche le repli, celle du générateur reste une panne", async () => {
  const { db } = await environnement();
  const fetch = globalThis.fetch;
  try {
    const id = await sourceTraitee(db);
    statuer(db, id, "certifiee", "Prof");
    globalThis.fetch = () => Promise.resolve(Response.json({ results: [] }));
    const modeles = openrouter({ ...config.modeles, cle: "test" });
    const { resultat, journal } = await demander(
      db,
      modeles,
      "ligne droite",
      {
        lecteur: null,
        schoolId: "pilote",
      },
      0.023,
    );
    assertEquals(journal.reclasseur_indisponible, "Résultat du reclasseur invalide.");
    assertEquals(resultat.etat, "failed");
    if (resultat.etat === "failed") assertEquals(resultat.code, "MODEL_EMPTY_RESPONSE");
  } finally {
    globalThis.fetch = fetch;
    db.close();
  }
});

test("le délai du juge annule son signal avant de laisser passer la citation", async () => {
  const { db } = await environnement();
  const timeout = globalThis.setTimeout;
  try {
    const id = await sourceTraitee(db);
    statuer(db, id, "certifiee", "Prof");
    globalThis.setTimeout = ((callback: () => void, delai?: number) =>
      timeout(callback, delai === 4000 ? 10 : delai)) as typeof setTimeout;
    let annule = false;
    const fake = fauxModeles({ sorties: [REPONSE_CITEE] });
    fake.modeles.soutenir = (_texte, _citation, _titre, signal) =>
      new Promise((_oui, non) => {
        signal!.addEventListener(
          "abort",
          () => {
            annule = true;
            non(signal!.reason);
          },
          { once: true },
        );
      });
    const r = await demander(
      db,
      fake.modeles,
      "ligne droite",
      {
        lecteur: null,
        schoolId: "pilote",
      },
      0.023,
    );
    assertEquals(r.resultat.etat, "answered");
    assertEquals(annule, true);
    assertStringIncludes(String(r.journal.juge_indisponible), "délai");
  } finally {
    globalThis.setTimeout = timeout;
    db.close();
  }
});

const COURS_MD = enc(
  "---\ntitle: Docker\n---\n\n# Docker\n\nUne **image** décrit le conteneur.\n\n## Construire\n\n```dockerfile\n# Image de base\nFROM node:26\n```\n\n- `docker build` crée l'image\n",
);

test("le Markdown se reconnaît à l'extension et à l'UTF-8, pas au type annoncé", () => {
  assertEquals(detecterFormat(enc("# Titre\n"), "cours.MD"), "md");
  assertEquals(detecterFormat(enc("<details>a</details>"), "cours.markdown"), "md");
  assertEquals(detecterFormat(enc("# Titre\n"), "cours.txt"), null);
  assertEquals(detecterFormat(new Uint8Array([0x23, 0x20, 0xe9, 0x0a]), "cours.md"), null);
  assertEquals(detecterFormat(enc("# a\0b"), "cours.md"), null);
});

test("Markdown non UTF-8 refusé au dépôt", async () => {
  const { db } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  const r = await requete("/prof/depot", {
    method: "POST",
    body: formulaire(CHAMPS, new Uint8Array([0x23, 0x20, 0xe9, 0x0a]), "latin1.md"),
  });
  assertEquals(r.status, 400);
  assertStringIncludes(await r.text(), "Format non reconnu");
  assertEquals(db.prepare("SELECT count(*) n FROM sources").get()!.n, 0);
});

test("Markdown: dépôt, extraction aux offsets exacts, original servi, réextraction identique", async () => {
  const { db } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  const r = await requete("/prof/depot", {
    method: "POST",
    body: formulaire(CHAMPS, COURS_MD, "docker.md"),
  });
  assertEquals(r.status, 200);
  const s = db.prepare("SELECT id, format FROM sources").get()!;
  assertEquals(s.format, "md");
  await traiter(db, revendiquer(db)!, fauxModeles().modeles);

  const { texte, blocs } = lireDocument(s.id as string, 1);
  assertEquals(
    blocs.map((b) => b.section),
    ["Docker", "Docker", "Construire", "Construire", "Construire"],
  );
  for (const b of blocs) assertEquals(tranche(texte, b.debut, b.fin), b.texte);
  assertStringIncludes(texte, "# Image de base\nFROM node:26");
  assert(!texte.includes("**") && !texte.includes("title:"));

  const original = await requete(`/prof/sources/${s.id}/original`);
  assertEquals(original.headers.get("content-type"), "text/markdown; charset=utf-8");
  assertEquals(await reextraire(db, s.id as string), "identique");
});

test("Markdown: réextraire pose l'indicateur de code sur une source déjà importée, sans révision", async () => {
  const { db } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  await requete("/prof/depot", { method: "POST", body: formulaire(CHAMPS, COURS_MD, "docker.md") });
  const id = db.prepare("SELECT id FROM sources").get()!.id as string;
  await traiter(db, revendiquer(db)!, fauxModeles().modeles);
  const fichier = join(config.donnees, "content", id, "blocs.jsonl");
  const actuel = await readFile(fichier, "utf8");
  assertEquals(lireDocument(id, 1).blocs.filter((b) => b.code).length, 1);
  // Les blocs d'avant l'indicateur: même texte, mêmes offsets, pas de `code`.
  const ancien = actuel
    .split("\n")
    .map((l) => JSON.stringify({ ...JSON.parse(l), code: undefined }))
    .join("\n");
  await writeFile(fichier, ancien);
  assert(!lireDocument(id, 1).blocs.some((b) => b.code));
  assertEquals(await reextraire(db, id), "mise_a_jour");
  assertEquals(await readFile(fichier, "utf8"), actuel);
  assertEquals(db.prepare("SELECT count(*) n FROM revisions").get()!.n, 1);
});

/** Un envoi de fichiers sous les champs de `CHAMPS`, sans le titre commun. */
const envoi = (
  fichiers: [string, string | Uint8Array<ArrayBuffer>][],
  acces: Acces = { audience: "eleves", reponses: true },
) => {
  const f = formulaire({ ...CHAMPS, titre: "" }, new Uint8Array(), "vide", acces);
  f.delete("fichier");
  for (const [nom, contenu] of fichiers) f.append("fichier", new File([contenu], nom));
  return f;
};

test("plusieurs fichiers sans JavaScript: chacun se dépose seul dans un même lot", async () => {
  const { db } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  const formulaireDepot = await (await requete("/prof/depot")).text();
  assertStringIncludes(formulaireDepot, "multiple");
  assertStringIncludes(formulaireDepot, 'name="lot"');

  const r = await requete("/prof/depot", {
    method: "POST",
    body: envoi([
      ["un.md", "---\ntitle: Premier chapitre\n---\n# Un\nTexte."],
      ["deux.md", "# Deux\nTexte."],
      ["casse.md", new Uint8Array([0x23, 0x20, 0xe9, 0x0a])],
    ]),
  });
  assertEquals(r.status, 200);
  const page = await r.text();
  assertStringIncludes(page, "2 déposés, 1 erreur");
  assertStringIncludes(page, "« Premier chapitre » est déposé");
  assertStringIncludes(page, "« deux » est déposé");
  assertStringIncludes(page, "casse.md : Format non reconnu");
  const sources = db.prepare("SELECT titre, lot_id FROM sources").all();
  assertEquals(new Set(sources.map((s) => s.titre)), new Set(["Premier chapitre", "deux"]));
  const lot = sources[0].lot_id as string;
  assertEquals(sources[1].lot_id, lot);
  assertEquals(db.prepare("SELECT count(*) n FROM ingestion_jobs").get()!.n, 2);

  await requete("/prof/depot", { method: "POST", body: envoi([["trois.md", "# Trois\n"]]) });
  assertEquals(db.prepare("SELECT count(DISTINCT lot_id) n FROM sources").get()!.n, 2);
  const biblio = await (await requete(`/prof?lot=${lot}`)).text();
  assertStringIncludes(biblio, "Lot déposé : 2 fichiers");
  assertStringIncludes(biblio, "Premier chapitre");
  assert(!biblio.includes("trois"));
});

test("une clé rejouée rend la source créée, un fichier déjà lisible est un doublon", async () => {
  const { db } = await environnement();
  const prof = await session(db, fauxModeles().modeles, "enseignant");
  const autre = await session(db, fauxModeles().modeles, "enseignant");
  const envoyer = async (qui: typeof prof, contenu: string, cle: string, acces?: Acces) => {
    const f = envoi([["a.md", contenu]], acces);
    f.set("titre", "A");
    f.set("cle", cle);
    const r = await qui.requete("/prof/depot", {
      method: "POST",
      headers: { accept: "application/json" },
      body: f,
    });
    return (await r.json()) as Record<string, string>;
  };
  const sources = () => db.prepare("SELECT count(*) n FROM sources").get()!.n;

  const premier = await envoyer(prof, "# A\n", "cle-aaaaaaaa");
  assertEquals(premier.etat, "recu");
  const rejoue = await envoyer(prof, "# A\n", "cle-aaaaaaaa");
  assertEquals(rejoue, { ...premier, nom: "a.md", titre: "A", format: "md" });
  assertEquals([sources(), db.prepare("SELECT count(*) n FROM ingestion_jobs").get()!.n], [1, 1]);

  const doublon = await envoyer(prof, "# A\n", "cle-bbbbbbbb");
  assertEquals([doublon.etat, doublon.id, sources()], ["doublon", premier.id, 1]);

  // Une source privée d'un autre compte n'existe pas pour lui: aucun doublon ne la révèle.
  const prive = { audience: "prive", reponses: false } as const;
  assertEquals((await envoyer(prof, "# Secret\n", "cle-cccccccc", prive)).etat, "recu");
  const recu = await envoyer(autre, "# Secret\n", "cle-dddddddd");
  assertEquals(recu.etat, "recu");
  assertEquals(sources(), 3);
  assertEquals((await envoyer(prof, "# Secret\n", "cle-eeeeeeee")).etat, "doublon");
});

test("un lot compte au plus MAX_LOT fichiers", async () => {
  const { db } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  const fichiers = Array.from({ length: MAX_LOT + 1 }, (_, i): [string, string] => [
    `c${i}.md`,
    `# Chapitre ${i}\n`,
  ]);
  const r = await requete("/prof/depot", { method: "POST", body: envoi(fichiers) });
  assertEquals(r.status, 200);
  assertStringIncludes(await r.text(), `Un lot compte ${MAX_LOT} fichiers au maximum.`);
  assertEquals(db.prepare("SELECT count(*) n FROM sources").get()!.n, MAX_LOT);
});

test("un refus propose les questions proches de la question, et rien si aucune ne l'est", async () => {
  const { db } = await environnement();
  const source = await sourceTraitee(db);
  statuer(db, source, "certifiee", "test");
  db.prepare("INSERT INTO suggestions VALUES ('sg', ?, 'Qui est Gaudí ?', 'faux', 'test')").run(
    source,
  );
  const f = fauxModeles();
  // Les passages restent sous le seuil, donc les deux questions sont refusées. Seule la suggestion
  // est proche, et seulement de la question qui parle de Gaudí.
  let appels = 0;
  f.modeles.reclasser = (q, docs) => {
    if (docs.includes("Qui est Gaudí ?")) appels++;
    return Promise.resolve(
      docs.map((d, index) => ({
        index,
        score: q.includes("Gaudí") && d.startsWith("Qui") ? 0.9 : 0.001,
      })),
    );
  };
  const eleve = await session(db, f.modeles, "eleve");
  const refus = async (texte: string) => {
    const r = await eleve.requete("/eleve/questions", {
      method: "POST",
      headers: { "HX-Request": "true" },
      body: new URLSearchParams({ texte }),
    });
    const id = (await r.text()).match(/messages\/([\w-]+)\/flux/)![1];
    return { id, html: await (await eleve.requete(`/eleve/messages/${id}/flux`)).text() };
  };
  const { id, html: proche } = await refus("Où Gaudí a-t-il vécu ?");
  assertStringIncludes(proche, "Ce que ton cours couvre");
  assertStringIncludes(proche, "Qui est Gaudí ?");
  // Relire le refus ne rappelle pas le reclasseur.
  assertStringIncludes(
    await (await eleve.requete(`/eleve/messages/${id}/flux`)).text(),
    "Qui est Gaudí ?",
  );
  assertEquals(appels, 1);
  const { html: loin } = await refus("Quelle est la capitale du Pérou ?");
  assertStringIncludes(loin, "Je ne trouve pas la réponse");
  assert(!loin.includes("Ce que ton cours couvre"));
});
