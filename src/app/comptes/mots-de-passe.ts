import type { Db } from "../db.ts";
import { type Compte, creerCompte, deriver, hex, type Role } from "./compte.ts";
import { authentifier, cleIdentifiant } from "./connexion.ts";

/**
 * Remplace le mot de passe par un code provisoire, ferme les sessions du compte et efface ses
 * échecs de connexion. Qui remet le code ne garde pas l'accès : la première connexion le consomme
 * et impose d'en choisir un autre.
 */
export async function reinitialiserMotDePasse(db: Db, id: string, role: Role = "eleve") {
  const compte = db.prepare("SELECT role, identifiant FROM comptes WHERE id = ?").get(id);
  if (compte?.role !== role) return undefined;
  db.prepare("DELETE FROM connexions WHERE cle = ?").run(
    cleIdentifiant(String(compte.identifiant)),
  );
  const motDePasse = hex(crypto.getRandomValues(new Uint8Array(6)));
  const sel = hex(crypto.getRandomValues(new Uint8Array(16)));
  db.prepare(
    `UPDATE comptes SET sel = ?, empreinte = ?, session_version = session_version + 1,
      renouveler_mdp = 1 WHERE id = ?`,
  ).run(sel, await deriver(motDePasse, sel), id);
  return motDePasse;
}

export async function creerAdministrateur(db: Db, identifiant: string, nom: string) {
  if (db.prepare("SELECT id FROM comptes WHERE administrateur = 1").get()) {
    throw new Error(
      "Administrateur déjà provisionné. Utiliser reinitialiser pour la récupération.",
    );
  }
  identifiant = identifiant.trim().toLowerCase();
  const existant = db
    .prepare("SELECT id, role FROM comptes WHERE identifiant = ?")
    .get(identifiant);
  if (existant && existant.role !== "enseignant") {
    throw new Error(
      "Ce compte est un élève. Choisir un compte enseignant ou un nouvel identifiant.",
    );
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    // Le verrou couvre aussi deux commandes de provisionnement lancées ensemble.
    if (db.prepare("SELECT id FROM comptes WHERE administrateur = 1").get()) {
      throw new Error("Administrateur déjà provisionné.");
    }
    const motDePasse = existant
      ? await reinitialiserMotDePasse(db, existant.id as string, "enseignant")
      : await creerCompte(db, identifiant, nom, "enseignant");
    db.prepare(
      "UPDATE comptes SET administrateur = 1, renouveler_mdp = 1 WHERE identifiant = ?",
    ).run(identifiant);
    db.exec("COMMIT");
    return motDePasse!;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function consommerProvisoire(db: Db, compte: Compte) {
  const { changes } = db
    .prepare(
      `UPDATE comptes SET empreinte = '', session_version = session_version + 1
     WHERE id = ? AND session_version = ? AND renouveler_mdp = 1`,
    )
    .run(compte.id, compte.session_version);
  if (changes) compte.session_version++;
  return !!changes;
}

export function verifierMotDePasse(motDePasse: string) {
  if (motDePasse.length < 12 || motDePasse.length > 200) {
    throw new Error("Choisir un mot de passe de 12 à 200 caractères.");
  }
}

/**
 * Enregistre le mot de passe que le compte choisit et ferme toutes ses sessions. Un code
 * provisoire a déjà été vérifié et consommé à la connexion. Sinon l'ancien mot de passe est exigé.
 */
export async function choisirMotDePasse(db: Db, compte: Compte, motDePasse: string, ancien = "") {
  verifierMotDePasse(motDePasse);
  if (!compte.renouveler_mdp && !(await authentifier(db, compte.identifiant, ancien))) {
    throw new Error("Mot de passe actuel incorrect.");
  }
  const sel = hex(crypto.getRandomValues(new Uint8Array(16)));
  const { changes } = db
    .prepare(
      `UPDATE comptes SET sel = ?, empreinte = ?, renouveler_mdp = 0,
       session_version = session_version + 1
     WHERE id = ? AND session_version = ?`,
    )
    .run(sel, await deriver(motDePasse, sel), compte.id, compte.session_version);
  if (!changes) throw new Error("Session expirée : le mot de passe n'a pas changé.");
}
