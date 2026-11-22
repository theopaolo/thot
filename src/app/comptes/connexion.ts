import { config } from "../config.ts";
import { type Db, maintenant } from "../db.ts";
import { type Compte, deriver } from "./compte.ts";

/**
 * Essais de connexion ratés permis par fenêtre, pour un identifiant et pour une adresse. Les
 * élèves d'un établissement sortent souvent par une seule adresse : son seuil est plus haut.
 */
export const ECHECS_IDENTIFIANT = 10;
export const ECHECS_ADRESSE = 100;
export const FENETRE_ECHECS_MS = 15 * 60_000;

/** `authentifier` refuse sans vérifier le mot de passe : trop d'échecs dans la fenêtre. */
export class TropDEssais extends Error {
  secondes: number;
  constructor(secondes: number) {
    super(
      `Trop d'essais de connexion. Un nouvel essai sera possible dans ${Math.ceil(secondes / 60)} min.`,
    );
    this.secondes = secondes;
  }
}

// Un identifiant inconnu se compte comme un autre : le refus ne dit pas quels comptes existent.
export const cleIdentifiant = (identifiant: string) =>
  `identifiant:${identifiant.trim().toLowerCase().slice(0, 100)}`;

/**
 * Contrôle les seuils avant toute dérivation, puis compte un essai pour chaque clé. Vérifier avant
 * d'incrémenter évite qu'un compte déjà bloqué n'épuise le quota de l'adresse partagée (NAT
 * d'établissement), ou qu'une adresse bloquée ne bloque les comptes visés. Une connexion réussie
 * retire ensuite son essai.
 */
function compterEssai(db: Db, cles: [cle: string, seuil: number][], ms = Date.now()) {
  db.prepare("DELETE FROM connexions WHERE debut_le <= ?").run(maintenant(ms - FENETRE_ECHECS_MS));
  let attente = 0;
  const lire = db.prepare("SELECT echecs, debut_le FROM connexions WHERE cle = ?");
  for (const [cle, seuil] of cles) {
    const l = lire.get(cle) as { echecs: number; debut_le: string } | undefined;
    if (l && l.echecs >= seuil) {
      attente = Math.max(attente, 1, Date.parse(l.debut_le) + FENETRE_ECHECS_MS - ms);
    }
  }
  if (attente) throw new TropDEssais(Math.ceil(attente / 1000));
  const compter = db.prepare(
    `INSERT INTO connexions (cle, echecs, debut_le) VALUES (?, 1, ?)
     ON CONFLICT (cle) DO UPDATE SET echecs = echecs + 1`,
  );
  for (const [cle] of cles) compter.run(cle, maintenant(ms));
}

/**
 * Rend le compte si le mot de passe est juste, `null` sinon. Lève `TropDEssais` quand
 * l'identifiant ou l'adresse a dépassé son nombre d'échecs. `adresse` est vide quand l'appelant
 * ne la connaît pas : seul l'identifiant compte alors.
 */
export async function authentifier(db: Db, identifiant: string, motDePasse: string, adresse = "") {
  // ponytail: une adresse IPv6 se compte seule. Regrouper par préfixe /64 si un attaquant en change.
  const cles: [string, number][] = [
    [cleIdentifiant(identifiant), ECHECS_IDENTIFIANT],
    ...(adresse ? ([[`adresse:${adresse}`, ECHECS_ADRESSE]] as [string, number][]) : []),
  ];
  // En développement, aucun mot de passe n'est vérifié, administrateur compris : rien ne se compte.
  if (!config.dev) compterEssai(db, cles);
  const l = db
    .prepare("SELECT * FROM comptes WHERE identifiant = ?")
    .get(identifiant.trim().toLowerCase()) as
    | (Compte & { sel: string; empreinte: string })
    | undefined;
  // Une dérivation a lieu même sans compte: la durée ne révèle pas quels identifiants existent.
  const empreinte = await deriver(motDePasse, l?.sel ?? "absent");
  if (!l) return null;
  if (!config.dev) {
    if (empreinte.length !== l.empreinte.length) return null;
    let diff = 0;
    for (let i = 0; i < empreinte.length; i++) {
      diff |= empreinte.charCodeAt(i) ^ l.empreinte.charCodeAt(i);
    }
    if (diff !== 0) return null;
    db.prepare("DELETE FROM connexions WHERE cle = ?").run(cles[0][0]);
    if (cles[1]) {
      db.prepare("UPDATE connexions SET echecs = echecs - 1 WHERE cle = ?").run(cles[1][0]);
      db.prepare("DELETE FROM connexions WHERE cle = ? AND echecs <= 0").run(cles[1][0]);
    }
  }
  return {
    id: l.id,
    identifiant: l.identifiant,
    nom: l.nom,
    role: l.role,
    session_version: l.session_version,
    administrateur: l.administrateur,
    renouveler_mdp: l.renouveler_mdp,
  };
}
