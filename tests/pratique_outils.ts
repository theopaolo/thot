import { rm } from "node:fs/promises";
import { assert, assertEquals } from "@std/assert";
import { activiteProf, ancrerPassage, inserer, publier, relire } from "../src/app/activites.ts";
import { type Compte, lireCompte, type Role } from "../src/app/comptes.ts";
import type { Db } from "../src/app/db.ts";
import { cours, matiere } from "../src/app/domaines.ts";
import { configurerInstance } from "../src/app/instance.ts";
import type { Champ, Contenu } from "../src/core/activite.ts";
import { environnement, fauxModeles, publier as publierSource, session } from "./outils.ts";

export const libre = (texte: string): Champ => ({ texte, citations: [] });

export type Session = Awaited<ReturnType<typeof session>> & { id: string; compte: Compte };

export async function compte(db: Db, role: Role, inscrit = true): Promise<Session> {
  const s = await session(db, fauxModeles().modeles, role, inscrit);
  const id = db.prepare("SELECT id FROM comptes ORDER BY rowid DESC LIMIT 1").get()!.id as string;
  return { ...s, id, compte: lireCompte(db, id)! };
}

/** Un formulaire de réponse de l'élève porte la version lue : la version 1, sauf si `corps` en dit une autre. */
export const envoyer = (s: Session, url: string, corps: Record<string, string | string[]> = {}) => {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(corps)) for (const x of [v].flat()) f.append(k, x);
  if (/^\/eleve\/activites\/[^/]+\/(reponses|questions\/)/.test(url) && !("revision" in corps)) {
    f.append("revision", "1");
  }
  return s.requete(url, { method: "POST", body: f });
};
export const page = async (s: Session, url: string) => (await s.requete(url)).text();
export const statut = async (r: Response | Promise<Response>) => (await r).status;

/** Un cours, sa source publiée aux élèves, un enseignant et un élève du cours. */
export async function cadre(personnel = false) {
  const { db, dir } = await environnement();
  if (personnel) configurerInstance(db, "Mon étude", "personal");
  const coursId = cours(db, matiere(db, "Arts appliqués"), "Design");
  const source = await publierSource(db, "Casa Batlló", coursId);
  const prof = await compte(db, "enseignant");
  const eleve = await compte(db, "eleve");
  // Un passage de la source, tel qu'un champ rédigé par Thot le cite.
  const passage = ancrerPassage(
    db,
    { cours_id: coursId, audience: personnel ? "prive" : "cours", auteur_id: prof.id },
    source,
    "Gaudí refuse la ligne droite dans toute la façade",
    "Passage",
  );
  return { db, dir, coursId, source, prof, eleve, passage };
}

export const fermer = async (db: Db, dir: string) => {
  db.close();
  await rm(dir, { recursive: true });
};

export function exercice(
  db: Db,
  prof: Compte,
  coursId: string,
  contenu: Contenu,
  titre = "Lire une façade",
) {
  return inserer(db, prof, {
    type: "exercice",
    coursId,
    objectifId: "",
    intitule: "Lire la façade de la Casa Batlló",
    reference: "",
    titre,
    contenu,
  });
}

export function publie(db: Db, prof: Compte, id: string) {
  const a = activiteProf(db, prof, id)!;
  assert(relire(db, prof, a, a.revision));
  assertEquals(publier(db, prof, id, a.revision), "publiee");
  return activiteProf(db, prof, id)!;
}
