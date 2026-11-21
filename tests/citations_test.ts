import { test } from "vite-plus/test";
import { assert, assertEquals } from "@std/assert";
import { formules } from "../src/core/notation.ts";
import type { ChunkIndexe } from "../src/core/recherche.ts";
import { ancrer } from "../src/core/activite.ts";
import { actualiserResultat, demander, juger, verifier } from "../src/core/reponse.ts";
import { longueur, tranche } from "../src/core/texte.ts";
import { environnement, fauxModeles, publier } from "./outils.ts";

const chunk = (texte: string, debut = 0): ChunkIndexe => ({
  id: "c1",
  source_id: "s1",
  school_id: "pilote",
  titre: "Titre",
  debut,
  fin: debut + longueur(texte),
  texte,
  rappel: texte,
  preuve: texte,
  revision: 1,
});
const citer = (c: ChunkIndexe, citation: string, texte = "Une phrase.") =>
  verifier({ affirmations: [{ texte, extrait: 1, citation }] }, [c]);

const PREUVE = "Monet ne signe pas ce tableau. Renoir est mortel et signe la toile en 1876.";

test("une citation à trous ou coupée dans un mot est refusée", () => {
  for (const citation of [
    "Monet … signe la toile en 1876",
    "Monet ... signe la toile en 1876",
    "Monet […] signe la toile en 1876",
    "Renoir est mort",
    "noir est mortel",
    "signe la toile en 187",
    "M … e … t",
  ]) {
    const v = citer(chunk(PREUVE), citation);
    assertEquals(v.affirmations, [], citation);
    assertEquals(v.erreurs.length, 1, citation);
  }
  const [a] = citer(chunk(PREUVE), "Renoir est mortel").affirmations;
  assertEquals(tranche(PREUVE, a.debut!, a.fin!), "Renoir est mortel");
  // Les points de suspension du document se citent comme ses autres signes.
  const hesite = "Il hésite… puis il signe la toile.";
  assertEquals(citer(chunk(hesite), "Il hésite… puis il signe").affirmations.length, 1);
});

test("le juge lit le texte du document, pas la citation écrite par le modèle", async () => {
  const texte = "Avant.\n\nLa Façade est\nbleue et blanche.";
  const c = chunk(texte, 100);
  const [a] = citer(c, "la façade est bleue et blanche").affirmations;
  assertEquals(tranche(texte, a.debut! - 100, a.fin! - 100), "La Façade est\nbleue et blanche");
  const f = fauxModeles();
  const lus: string[] = [];
  f.modeles.soutenir = (_texte, citation) => {
    lus.push(citation);
    return Promise.resolve({ probabilite: 1, modele: "faux-juge" });
  };
  await juger(f.modeles, [a], {}, "general");
  assertEquals(lus, ["La Façade est bleue et blanche"]);
});

test("une formule ne se rend que si le document l'écrit, casse comprise", () => {
  const c = chunk("On note $\\delta x$ l'écart mesuré entre deux points.");
  const phrase = "L'écart se note $\\Delta X$.";
  const [majuscule] = citer(c, "On note $\\Delta X$ l'écart mesuré", phrase).affirmations;
  assertEquals(formules(phrase, majuscule.citation), [phrase]);
  const fidele = "L'écart se note $\\delta x$.";
  const [a] = citer(c, "On note $\\delta x$ l'écart mesuré", fidele).affirmations;
  assert(formules(fidele, a.citation).some((m) => typeof m !== "string"));
});

test("la vérification ne garde que le nombre d'affirmations demandé au modèle", () => {
  const v = verifier(
    {
      affirmations: Array.from({ length: 12 }, (_, i) => ({
        texte: `Phrase ${i + 1}.`,
        extrait: 1,
        citation: "Renoir est mortel",
      })),
    },
    [chunk(PREUVE)],
  );
  assertEquals(v.erreurs, []);
  assertEquals(v.affirmations.length, 8);
  assertEquals(v.parRang.length, 8);
});

test("un passage d'activité s'ancre dans une source de plus de huit extraits", () => {
  const chunks = Array.from({ length: 12 }, (_, i) => ({
    ...chunk(i === 11 ? PREUVE : `Extrait numéro ${i + 1} sans rapport.`, i * 100),
    id: `c${i + 1}`,
  }));
  assertEquals(ancrer("Renoir est mortel", chunks)?.chunk_id, "c12");
  assertEquals(ancrer("Monet … signe la toile en 1876", chunks), undefined);
});

test("une réponse relue affiche le passage du document, pas la copie du modèle", async () => {
  const { db } = await environnement();
  try {
    await publier(db, "Casa Batlló");
    const p = { lecteur: null, schoolId: "pilote" };
    const sortie = JSON.stringify({
      affirmations: [
        {
          texte: "Gaudí refuse la ligne droite.",
          extrait: 1,
          citation: "gaudí refuse la ligne  droite dans toute la façade",
        },
      ],
    });
    const f = fauxModeles({ sorties: [sortie] });
    const { resultat } = await demander(db, f.modeles, "Gaudí et la ligne droite ?", p, 0.023);
    assert(resultat.etat === "answered");
    const ecrit = "Gaudí refuse la ligne droite dans toute la façade";
    assertEquals(resultat.affirmations[0].citation, ecrit);
    // Une réponse conservée avant ce contrôle garde la copie du modèle : la relecture la remplace.
    const ancienne = structuredClone(resultat);
    ancienne.affirmations[0].citation = ecrit.toUpperCase();
    const relue = actualiserResultat(db, ancienne, p, () => []);
    assert(relue.etat === "answered");
    assertEquals(relue.affirmations[0].citation, ecrit);
  } finally {
    db.close();
  }
});
