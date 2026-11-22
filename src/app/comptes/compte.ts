import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lecteur } from "../../core/recherche.ts";
import { config } from "../config.ts";
import { type Db, maintenant } from "../db.ts";
import { libelles } from "../termes.ts";
import { inscrire } from "../domaines.ts";

export type Role = "enseignant" | "eleve";
export type Compte = {
  id: string;
  identifiant: string;
  nom: string;
  role: Role;
  session_version: number;
  administrateur: number;
  renouveler_mdp: number;
};

const ITERATIONS = 210_000;
export const hex = (b: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

export async function deriver(motDePasse: string, sel: string) {
  const cle = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(motDePasse),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(sel),
      iterations: ITERATIONS,
    },
    cle,
    256,
  );
  return hex(bits);
}

/**
 * Crée un compte avec un mot de passe tiré au hasard et l'inscrit aux cours donnés. Un cours
 * inconnu empêche la création. Le mot de passe n'est rendu qu'ici.
 */
export async function creerCompte(
  db: Db,
  identifiant: string,
  nom: string,
  role: Role,
  cours: string[] = [],
) {
  if (!identifiant.trim() || !nom.trim() || identifiant.length > 100 || nom.length > 100) {
    throw new Error("Identifiant et nom requis, 100 caractères au maximum.");
  }
  identifiant = identifiant.trim().toLowerCase();
  if (db.prepare("SELECT 1 FROM comptes WHERE identifiant = ?").get(identifiant)) {
    throw new Error(`Identifiant déjà utilisé : ${identifiant}.`);
  }
  // Vérifiés avant l'insertion : creerAdministrateur appelle cette fonction dans sa transaction.
  for (const coursId of cours) {
    if (!db.prepare("SELECT 1 FROM cours WHERE id = ?").get(coursId)) {
      throw new Error(`${libelles(db).cours} inconnu${libelles(db).formes.cours.e} : ${coursId}.`);
    }
  }
  const motDePasse = hex(crypto.getRandomValues(new Uint8Array(6)));
  const sel = hex(crypto.getRandomValues(new Uint8Array(16)));
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO comptes (id, identifiant, nom, role, sel, empreinte, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, identifiant, nom.trim(), role, sel, await deriver(motDePasse, sel), maintenant());
  for (const coursId of cours) inscrire(db, coursId, id);
  return motDePasse;
}

/** Les autres comptes enseignants de l'instance, pour composer l'équipe d'un cours. */
export const colleguesDe = (db: Db, id: string) =>
  db
    .prepare(
      "SELECT id, identifiant, nom FROM comptes WHERE role = 'enseignant' AND id != ? ORDER BY nom",
    )
    .all(id) as { id: string; identifiant: string; nom: string }[];

/** Vrai si le compte donné existe et porte le rôle enseignant. */
export const estEnseignant = (db: Db, id: string) =>
  db.prepare("SELECT 1 FROM comptes WHERE id = ? AND role = 'enseignant'").get(id) !== undefined;

/** Vrai si le compte est enseignant membre du cours donné. */
export const estEnseignantDuCours = (db: Db, coursId: string, compteId: string) =>
  db
    .prepare(
      `SELECT 1 FROM membres_cours m JOIN comptes a ON a.id = m.compte_id
       WHERE m.cours_id = ? AND m.compte_id = ? AND a.role = 'enseignant'`,
    )
    .get(coursId, compteId) !== undefined;

export const lireCompte = (db: Db, id: string) =>
  db
    .prepare(
      "SELECT id, identifiant, nom, role, session_version, administrateur, renouveler_mdp FROM comptes WHERE id = ?",
    )
    .get(id) as Compte | undefined;

export const lecteur = (c: Compte): Lecteur => ({
  id: c.id,
  enseignant: c.role === "enseignant",
  administrateur: c.administrateur === 1,
});

/** Secret de signature des cookies. Créé au premier lancement, conservé avec les données. */
export function secretSession(): string {
  const fromEnv = process.env["THOT_SECRET"];
  if (fromEnv) return fromEnv;
  const chemin = join(config.donnees, "secret");
  try {
    const secret = readFileSync(chemin, "utf8").trim();
    if (!secret) throw new Error("Secret de session vide. Restaurer le secret de l'instance.");
    return secret;
  } catch (e) {
    if (!((e as NodeJS.ErrnoException).code === "ENOENT")) throw e;
    mkdirSync(config.donnees, { recursive: true, mode: 0o700 });
    const s = hex(crypto.getRandomValues(new Uint8Array(32)));
    try {
      writeFileSync(chemin, s, { mode: 0o600, flag: "wx" });
    } catch (e) {
      if (!((e as NodeJS.ErrnoException).code === "EEXIST")) throw e;
      return secretSession();
    }
    return s;
  }
}
