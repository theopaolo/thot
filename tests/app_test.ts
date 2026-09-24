import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { PanneModele } from "../src/core/modeles.ts";
import { chercherFts } from "../src/core/recherche.ts";
import { demander } from "../src/core/reponse.ts";
import { migrer, purgerMessages } from "../src/app/db.ts";
import {
  authentifier,
  creerCompte,
  lireListe,
  reinitialiserMotDePasse,
} from "../src/app/comptes.ts";
import { detecterFormat, nomSur } from "../src/app/depot.ts";
import { relireLegende, revendiquer, statuer, traiter } from "../src/app/ingestion.ts";
import {
  faitAuHasard,
  genererSuggestions,
  sourceSansSuggestions,
  suggestionsParChapitre,
} from "../src/app/suggestions.ts";
import { config } from "../src/app/config.ts";
import { environnement, fauxModeles, session } from "./outils.ts";

const CHAMPS = {
  titre: "Art nouveau, panorama",
  type_document: "cours",
  matiere: "arts-appliques",
  classe: "2nde",
  sequence: "ATC Art Nouveau",
};

const formulaire = (
  champs: Record<string, string>,
  fichier: Uint8Array,
  nom = "fiche.pdf",
  publics = ["enseignants", "eleves", "thot"],
) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.append(k, v);
  for (const publicCible of publics) f.append("publics", publicCible);
  f.append("fichier", new File([fichier as Uint8Array<ArrayBuffer>], nom));
  return f;
};

const enc = (s: string) => new TextEncoder().encode(s);

// Une page HTML suffit à exercer extraction, légende, certification et recherche sans pdftotext.
const PAGE = enc(`<html><head><title>t</title></head><body><h1>Casa Batlló, Antoni Gaudí</h1>
<img src="data:image/jpeg;base64,/9j/4AAQ" />
<p>La façade de la Casa Batlló est couverte de céramique irisée et ses balcons évoquent des masques.</p>
<p>Gaudí refuse la ligne droite dans toute la façade.</p>
<p>Le toit en écailles de céramique rappelle le dos d'un dragon, et les cheminées torsadées prolongent le mouvement de la façade jusqu'au ciel de Barcelone.</p></body></html>`);

Deno.test("le format vient des octets, un nom reçu ne devient pas un chemin", () => {
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

Deno.test("dépôt complet: original écrit, source et travail créés", async () => {
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
  assertEquals(JSON.parse(s.metadonnees as string).publics, ["enseignants", "eleves", "thot"]);
  const original = await Deno.readTextFile(
    join(dir, "content", s.id as string, "original", "fiche.pdf"),
  );
  assertEquals(original, "%PDF-1.7 contenu");
  assertEquals(db.prepare("SELECT etat FROM ingestion_jobs").get()!.etat, "received");
});

Deno.test("champs manquants et format refusé: erreurs par champ, saisie conservée", async () => {
  const { db } = await environnement();
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  const r = await requete("/prof/depot", {
    method: "POST",
    body: formulaire({
      titre: "   ",
      type_document: "cours",
      matiere: "",
      classe: "2nde",
      seance: "S1",
    }, enc("MZ\x90 exe")),
  });
  assertEquals(r.status, 400);
  const page = await r.text();
  assertStringIncludes(page, 'id="titre-erreur">Champ obligatoire.');
  assertStringIncludes(page, 'id="matiere-erreur">Champ obligatoire.');
  assertStringIncludes(page, "Format non reconnu");
  assertStringIncludes(page, 'value="S1"');
  assertEquals(db.prepare("SELECT count(*) n FROM sources").get()!.n, 0);
});

Deno.test("les migrations se rejouent sans effet", async () => {
  const { db } = await environnement();
  assertEquals(migrer(db), []);
});

Deno.test("une session élève reçoit 403 sur chaque route enseignant", async () => {
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
  publics?: string[],
) {
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  await requete("/prof/depot", {
    method: "POST",
    body: formulaire(CHAMPS, PAGE, "casa.html", publics),
  });
  const job = revendiquer(db)!;
  await traiter(db, job, fauxModeles({ legende }).modeles);
  return db.prepare("SELECT id FROM sources").get()!.id as string;
}

Deno.test("un travail interrompu reprend après expiration du verrou, sans image en double", async () => {
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

Deno.test("une source non certifiée n'apparaît sur aucune route élève ni dans l'index", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  const { requete } = await session(db, fauxModeles().modeles, "eleve");
  assert(!(await (await requete("/eleve")).text()).includes("Art nouveau, panorama"));
  assertEquals((await requete(`/eleve/sources/${id}`)).status, 404);
  assertEquals((await requete(`/media/${id}-0`)).status, 404);
  assertEquals(chercherFts(db, "Casa Batlló façade", { schoolId: "pilote" }).length, 0);

  statuer(db, id, "certifiee", "test");
  assertStringIncludes(await (await requete("/eleve")).text(), "Art nouveau, panorama");
  assertEquals((await requete(`/eleve/sources/${id}`)).status, 200);
  assertEquals(chercherFts(db, "Casa Batlló façade", { schoolId: "pilote" }).length, 1);

  statuer(db, id, "rejetee", "test");
  assertEquals((await requete(`/eleve/sources/${id}`)).status, 404);
  assertEquals(chercherFts(db, "Casa Batlló façade", { schoolId: "pilote" }).length, 0);
});

Deno.test("sans public Élèves, une source certifiée reste invisible aux élèves et à Thot", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db, undefined, ["enseignants", "thot"]);
  statuer(db, id, "certifiee", "test");
  const prof = await session(db, fauxModeles().modeles, "enseignant");
  const eleve = await session(db, fauxModeles().modeles, "eleve");

  assertEquals((await prof.requete(`/prof/sources/${id}`)).status, 200);
  assertEquals((await prof.requete(`/media/${id}-0`)).status, 200);
  assert(!(await (await eleve.requete("/eleve")).text()).includes(CHAMPS.titre));
  for (
    const chemin of [
      `/eleve/chapitres/${encodeURIComponent(CHAMPS.sequence)}`,
      `/eleve/documents/${id}/apercu`,
      `/eleve/sources/${id}`,
      `/media/${id}-0`,
    ]
  ) assertEquals((await eleve.requete(chemin)).status, 404, chemin);
  assertEquals(
    (await eleve.requete("/eleve/questions", {
      method: "POST",
      body: new URLSearchParams({ texte: "Pourquoi ?", chapitre: CHAMPS.sequence }),
    })).status,
    400,
  );
  assertEquals(chercherFts(db, "Casa Batlló façade", { schoolId: "pilote" }).length, 0);
  assertEquals(faitAuHasard(db), undefined);
  assertEquals(sourceSansSuggestions(db), undefined);
});

Deno.test("sans public Thot, une source reste lisible mais ne sert pas aux réponses", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db, undefined, ["enseignants", "eleves"]);
  statuer(db, id, "certifiee", "test");
  const { requete } = await session(db, fauxModeles().modeles, "eleve");

  assertStringIncludes(await (await requete("/eleve")).text(), CHAMPS.titre);
  assertEquals((await requete(`/eleve/sources/${id}`)).status, 200);
  assertEquals((await requete(`/media/${id}-0`)).status, 200);
  assertEquals(chercherFts(db, "Casa Batlló façade", { schoolId: "pilote" }).length, 0);
  assertEquals(sourceSansSuggestions(db), undefined);
  assertEquals(
    (await demander(
      db,
      fauxModeles().modeles,
      "Pourquoi Gaudí refuse la ligne droite ?",
      { schoolId: "pilote" },
      0.023,
    )).resultat.etat,
    "out_of_corpus",
  );
});

Deno.test("une légende non relue aide la recherche mais n'atteint jamais le générateur", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db, "Carapace de dragon en écailles turquoise.");
  statuer(db, id, "certifiee", "test");
  // Le mot n'est que dans la légende: la recherche le trouve grâce à elle.
  assertEquals(chercherFts(db, "dragon turquoise", { schoolId: "pilote" }).length, 1);

  const f = fauxModeles({ sorties: ['{"refus": true}'] });
  await demander(db, f.modeles, "dragon turquoise", { schoolId: "pilote" }, 0.023);
  assert(!JSON.stringify(f.vus).includes("Carapace"), "légende non relue envoyée au générateur");

  relireLegende(db, `${id}-0`, "certified", "", "test");
  const g = fauxModeles({ sorties: ['{"refus": true}'] });
  await demander(db, g.modeles, "dragon turquoise", { schoolId: "pilote" }, 0.023);
  assertStringIncludes(JSON.stringify(g.vus), "Image : Carapace de dragon");
});

Deno.test("trois états de réponse distincts, et une citation fausse ne passe jamais", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  statuer(db, id, "certifiee", "test");
  const q = "Pourquoi la façade de la Casa Batlló n'a pas de ligne droite ?";
  const p = { schoolId: "pilote" };

  const bonne = JSON.stringify({
    affirmations: [{
      texte: "Gaudí refuse la ligne droite.",
      extrait: 1,
      citation: "Gaudí refuse la ligne droite dans toute la façade",
    }],
  });
  const ok = await demander(db, fauxModeles({ sorties: [bonne] }).modeles, q, p, 0.023);
  assertEquals(ok.resultat.etat, "answered");
  if (ok.resultat.etat === "answered") {
    const a = ok.resultat.affirmations[0];
    const texte = await Deno.readTextFile(
      `${(await import("../src/app/config.ts")).config.donnees}/content/${id}/document.txt`,
    );
    assertEquals(
      Array.from(texte).slice(a.debut, a.fin).join(""),
      "Gaudí refuse la ligne droite dans toute la façade",
    );
  }

  const bas = await demander(db, fauxModeles({ score: 0.01 }).modeles, q, p, 0.023);
  assertEquals(bas.resultat, { etat: "out_of_corpus", raison: "seuil" });

  const fausse = JSON.stringify({
    affirmations: [{
      texte: "Gaudí aimait le béton.",
      extrait: 1,
      citation: "Gaudí aimait profondément le béton armé",
    }],
  });
  const repare = await demander(db, fauxModeles({ sorties: [fausse, bonne] }).modeles, q, p, 0.023);
  assertEquals(repare.resultat.etat, "answered", "une réparation est permise");
  const refuse = await demander(
    db,
    fauxModeles({ sorties: [fausse, fausse] }).modeles,
    q,
    p,
    0.023,
  );
  assertEquals(refuse.resultat.etat, "failed");

  const vide = fauxModeles();
  vide.modeles.generer = () => {
    throw new PanneModele("Le générateur a rendu une sortie vide.", "MODEL_EMPTY_RESPONSE");
  };
  const panne = await demander(db, vide.modeles, q, p, 0.023);
  assertEquals(panne.resultat.etat, "failed", "une sortie vide est une panne, pas un refus");
  if (panne.resultat.etat === "failed") assertEquals(panne.resultat.code, "MODEL_EMPTY_RESPONSE");
});

Deno.test("le chat: question, flux SSE, réponse citée, panneau source", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  statuer(db, id, "certifiee", "test");
  const bonne = JSON.stringify({
    affirmations: [{
      texte: "Gaudí refuse la ligne droite.",
      extrait: 1,
      citation: "Gaudí refuse la ligne droite dans toute la façade",
    }],
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
  assertStringIncludes(flux, "event: etape");
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

Deno.test("une question proposée n'est gardée que si Thot y répond avec une citation vérifiée", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  statuer(db, id, "certifiee", "test");
  const bonne = JSON.stringify({
    affirmations: [{
      texte: "Gaudí refuse la ligne droite.",
      extrait: 1,
      citation: "Gaudí refuse la ligne droite dans toute la façade",
    }],
  });
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
    db.prepare("SELECT question FROM suggestions").all().map((l) => l.question),
    ["Pourquoi Gaudí refuse-t-il la ligne droite ?"],
  );
  assertEquals([...suggestionsParChapitre(db).values()].flat().length, 1);
  statuer(db, id, "rejetee", "test");
  assertEquals(suggestionsParChapitre(db).size, 0, "une source rejetée ne propose plus rien");
});

Deno.test("le saviez-vous recopie une phrase certifiée et pointe sa position exacte", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  assertEquals(faitAuHasard(db), undefined, "rien tant que la source n'est pas certifiée");
  statuer(db, id, "certifiee", "test");
  const fait = faitAuHasard(db)!;
  const texte = await Deno.readTextFile(`${config.donnees}/content/${id}/document.txt`);
  assertEquals(Array.from(texte).slice(fait.debut, fait.fin).join(""), fait.phrase);
});

Deno.test("CSV élèves: import imprimable, doublon refusé, reset invalide la session", async () => {
  const { db } = await environnement();
  assertEquals(lireListe('identifiant;nom\r\nlea;"Léa, Martin"\r\n'), [{
    identifiant: "lea",
    nom: "Léa, Martin",
  }]);
  assertThrows(() => lireListe('identifiant,nom\nlea,"Léa" Martin\n'));
  const { requete, app } = await session(db, fauxModeles().modeles, "enseignant");
  const fichier = new FormData();
  fichier.append(
    "fichier",
    new File(["identifiant,nom\nlea,Léa Martin\nnoe,Noé Petit\n"], "classe.csv"),
  );
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

Deno.test("un mot de passe enseignant se renouvelle sans ouvrir le reset élève", async () => {
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

Deno.test("chapitre, suivi, avis et revue enseignant restent liés à la question", async () => {
  const { db } = await environnement();
  const source = await sourceTraitee(db);
  statuer(db, source, "certifiee", "test");
  const bonne = JSON.stringify({
    affirmations: [{
      texte: "Gaudí refuse la ligne droite.",
      extrait: 1,
      citation: "Gaudí refuse la ligne droite dans toute la façade",
    }],
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
  const second = await eleve.requete("/eleve/questions", {
    method: "POST",
    headers: { "HX-Request": "true" },
    body: new URLSearchParams({ texte: "Et la façade ?", chapitre: "ATC Art Nouveau" }),
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
  const sansChapitre = await eleve.requete("/eleve/questions", {
    method: "POST",
    headers: { "HX-Request": "true" },
    body: new URLSearchParams({ texte: "Et Gaudí ?" }),
  });
  const id3 = (await sansChapitre.text()).match(/messages\/([\w-]+)\/flux/)![1];
  await eleve.requete(`/eleve/messages/${id3}/flux`);
  assertEquals(
    reformulation,
    "",
    "une question sans chapitre ne reprend pas le chapitre précédent",
  );
  assertEquals(
    (await eleve.requete("/eleve/questions", {
      method: "POST",
      body: new URLSearchParams({ texte: "Question", chapitre: "Chapitre absent" }),
    })).status,
    400,
  );
  assertEquals(
    (await eleve.requete(`/eleve/messages/${id2}/avis`, {
      method: "POST",
      body: new URLSearchParams({ avis: "faux" }),
    })).status,
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
  assertEquals(
    chercherFts(db, "Gaudí", { schoolId: "pilote", chapitre: "Chapitre absent" }).length,
    0,
  );
});

Deno.test("titre édité réindexé, image certifiée liée à la réponse et messages purgés", async () => {
  const { db } = await environnement();
  const id = await sourceTraitee(db);
  statuer(db, id, "certifiee", "test");
  const prof = await session(db, fauxModeles().modeles, "enseignant");
  const r = await prof.requete(`/prof/sources/${id}/modifier`, {
    method: "POST",
    body: new URLSearchParams({
      titre: "Casa Batlló corrigée",
      sequence: "Architecture",
      date: "1906",
      quiz_reponse: "Gaudí",
    }),
  });
  assertEquals(r.status, 303);
  assertStringIncludes(
    chercherFts(db, "corrigée", { schoolId: "pilote", chapitre: "Architecture" })[0].titre,
    "corrigée",
  );
  relireLegende(db, `${id}-0`, "certified", "", "test");
  const bonne = JSON.stringify({
    affirmations: [{
      texte: "Les balcons ressemblent à des masques.",
      extrait: 1,
      citation: "façade ondulée aux balcons en forme de masques",
    }],
  });
  const { resultat } = await demander(
    db,
    fauxModeles({ sorties: [bonne] }).modeles,
    "balcons masques",
    { schoolId: "pilote" },
    0.023,
  );
  assertEquals(resultat.etat, "answered");
  if (resultat.etat === "answered") assertEquals(resultat.affirmations[0].image_id, `${id}-0`);
  const texteCite = JSON.stringify({
    affirmations: [{
      texte: "Gaudí refuse la ligne droite.",
      extrait: 1,
      citation: "Gaudí refuse la ligne droite dans toute la façade",
    }],
  });
  const texteResultat = await demander(
    db,
    fauxModeles({ sorties: [texteCite] }).modeles,
    "ligne droite",
    { schoolId: "pilote" },
    0.023,
  );
  assertEquals(texteResultat.resultat.etat, "answered");
  if (texteResultat.resultat.etat === "answered") {
    assertEquals(texteResultat.resultat.affirmations[0].image_id, `${id}-0`);
  }
  const eleve = await session(db, fauxModeles().modeles, "eleve");
  const accueil = await (await eleve.requete("/eleve")).text();
  assertStringIncludes(accueil, "Casa Batlló corrigée");
  assertStringIncludes(await (await eleve.requete("/eleve/chapitres/Architecture")).text(), "1906");
  const compte =
    db.prepare("SELECT id FROM comptes WHERE role = 'eleve' ORDER BY rowid DESC LIMIT 1").get()!.id;
  db.prepare(
    "INSERT INTO messages (id, compte_id, question, etat, cree_le, maj_le) VALUES ('ancien', ?, 'question', 'en_attente', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
  ).run(compte);
  assertEquals(purgerMessages(db, 90, Date.UTC(2026, 8, 23)), 1);
});
