import { assert } from "@std/assert";
import { type Db } from "../src/app/db.ts";
import { type Audience, deposer, valider } from "../src/app/depot.ts";
import { lireInstance } from "../src/app/instance.ts";
import { revendiquer, statuer, traiter } from "../src/app/ingestion.ts";
import { type Modeles } from "../src/core/modeles.ts";
import { cours, inscrire, matiere } from "../src/app/domaines.ts";
import { environnement, fauxModeles, session } from "./outils.ts";

export const TEXTE =
  "La façade de la Casa Batlló est couverte de céramique irisée. " +
  "Gaudí refuse la ligne droite dans toute la façade.";

/** Une image PNG de 1 × 1 pixel : la lecture HTML écarte une image dont l'en-tête est faux. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
export const BONNE = JSON.stringify({
  affirmations: [
    {
      texte: "Gaudí refuse la ligne droite.",
      extrait: 1,
      citation: "Gaudí refuse la ligne droite dans toute la façade",
    },
  ],
});

export async function source(
  db: Db,
  titre: string,
  audience: Audience,
  proprietaireId: string,
  coursId?: string,
  texte = TEXTE,
) {
  const v = valider({ titre, type_document: "cours" });
  assert("meta" in v);
  const { source_id } = await deposer(db, {
    meta: v.meta,
    nomFichier: "cours.html",
    format: "html",
    schoolId: lireInstance(db).school_id,
    enseignant: "Prof",
    proprietaireId,
    audience,
    reponses: true,
    liens: coursId ? [{ cours_id: coursId, theme_id: null }] : undefined,
    octets: new TextEncoder().encode(
      `<html><h1>${titre}</h1><img src="data:image/png;base64,${PNG}"><p>${texte}</p></html>`,
    ),
  });
  await traiter(db, revendiquer(db)!, fauxModeles().modeles);
  statuer(db, source_id, "certifiee", "Test");
  return source_id;
}

/** Une session et l'identifiant de son compte, inscrit dans les cours demandés. */
export async function compte(
  db: Db,
  role: "enseignant" | "eleve",
  modeles = fauxModeles().modeles,
  coursIds: string[] = [],
) {
  const s = await session(db, modeles, role, false);
  const id = db.prepare("SELECT id FROM comptes ORDER BY rowid DESC LIMIT 1").get()!.id as string;
  for (const c of coursIds) inscrire(db, c, id);
  return { ...s, id };
}

export const image = (db: Db, sourceId: string) =>
  db.prepare("SELECT id FROM images WHERE source_id = ?").get(sourceId)!.id as string;
export const statut = async (r: Response | Promise<Response>) => (await r).status;

/** Deux cours d'une même matière, chacun avec son enseignant et son élève. */
export async function deuxCours(modeles?: Modeles) {
  const { db, dir } = await environnement();
  const m = matiere(db, "Arts appliqués");
  const c1 = cours(db, m, "Design"),
    c2 = cours(db, m, "Histoire de l'art");
  const profA = await compte(db, "enseignant", modeles, [c1]);
  const profB = await compte(db, "enseignant", modeles, [c2]);
  const profC = await compte(db, "enseignant", modeles, [c1]);
  const eleveA = await compte(db, "eleve", modeles, [c1]);
  const eleveB = await compte(db, "eleve", modeles, [c2]);
  const publie = await source(db, "Cours du design", "eleves", profA.id, c1);
  const partage = await source(db, "Corrigé du design", "collegues", profA.id, c1);
  const prive = await source(db, "Brouillon du design", "prive", profA.id, c1);
  const libre = await source(db, "Ressource sans cours", "eleves", profA.id);
  return { db, dir, m, c1, c2, profA, profB, profC, eleveA, eleveB, publie, partage, prive, libre };
}

export type Qui = Awaited<ReturnType<typeof compte>>;
export const envoyer = (qui: Qui, chemin: string, corps: Record<string, string> = {}) =>
  qui.requete(chemin, { method: "POST", body: new URLSearchParams(corps) });
export const texteDe = async (qui: Qui, chemin: string) => (await qui.requete(chemin)).text();

/** Le gabarit échappe l'apostrophe : `nom` se retrouve tel quel ou échappé. */
export const nomme = (page: string, nom: string) =>
  page.includes(nom) || page.includes(nom.replaceAll("'", "&#39;"));
export const commeEleve = (id: string) => ({ id, enseignant: false, administrateur: false });

export async function administrateur(db: Db) {
  const admin = await compte(db, "enseignant");
  db.prepare("UPDATE comptes SET administrateur = 1 WHERE id = ?").run(admin.id);
  return admin;
}
