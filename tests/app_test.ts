import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { PanneModele } from "../src/core/modeles.ts";
import { chercherFts } from "../src/core/recherche.ts";
import { demander } from "../src/core/reponse.ts";
import { migrer } from "../src/app/db.ts";
import { detecterFormat, nomSur } from "../src/app/depot.ts";
import { relireLegende, revendiquer, statuer, traiter } from "../src/app/ingestion.ts";
import {
  faitAuHasard,
  genererSuggestions,
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

const formulaire = (champs: Record<string, string>, fichier: Uint8Array, nom = "fiche.pdf") => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.append(k, v);
  f.append("publics", "enseignants");
  f.append("publics", "eleves");
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
  assertEquals(JSON.parse(s.metadonnees as string).publics, ["enseignants", "eleves"]);
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
) {
  const { requete } = await session(db, fauxModeles().modeles, "enseignant");
  await requete("/prof/depot", { method: "POST", body: formulaire(CHAMPS, PAGE, "casa.html") });
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
        questions: ["Pourquoi Gaudí refuse-t-il la ligne droite ?", "Quel âge avait Gaudí ?"],
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
