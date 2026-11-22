import { createHash } from "node:crypto";
import { transaction } from "../../core/recherche.ts";
import { type Db, maintenant } from "../db.ts";
import { coursDuCompte, inscrire } from "../domaines.ts";
import { type Compte, deriver, hex } from "./compte.ts";
import { parametresGeres } from "./eleves.ts";
import { verifierMotDePasse } from "./mots-de-passe.ts";

/**
 * Le refus d'un identifiant à l'inscription par lien. Un identifiant pris reçoit le même message
 * qu'un identifiant invalide : la page ne dit pas quels comptes existent.
 */
export const IDENTIFIANT_REFUSE =
  "Identifiant ou nom refusé. Choisis un autre identifiant, de 3 à 40 caractères parmi a-z, 0-9, point, tiret et tiret bas, et un nom de 100 caractères au maximum. Si tu as déjà un compte, connecte-toi d'abord.";

/**
 * Crée un lien d'inscription aux cours donnés et rend son jeton, 128 bits tirés au hasard. La route
 * vérifie que ces cours sont ceux du créateur.
 */
export function creerLien(
  db: Db,
  createurId: string,
  cours: string[],
  jours: number,
  places: number,
) {
  if (
    ![jours, places].every(Number.isInteger) ||
    jours < 1 ||
    jours > 365 ||
    places < 1 ||
    places > 1000
  ) {
    throw new Error("Lien refusé : de 1 à 365 jours et de 1 à 1000 places.");
  }
  const jeton = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  const expire = new Date(Date.now() + jours * 86_400_000).toISOString().slice(0, 19) + "Z";
  transaction(db, () => {
    db.prepare(
      "INSERT INTO liens (jeton, createur_id, places, expire_le, cree_le) VALUES (?, ?, ?, ?, ?)",
    ).run(jeton, createurId, places, expire, maintenant());
    for (const id of cours) db.prepare("INSERT INTO liens_cours VALUES (?, ?)").run(jeton, id);
  });
  return jeton;
}

/**
 * Les cours où un lien inscrit encore, avec le nom de son créateur. Un cours dont le créateur
 * n'est plus membre en sort, sauf s'il est administrateur. Aucun cours si le lien a expiré, a été
 * révoqué ou n'a plus de place.
 */
export const coursDuLien = (db: Db, jeton: string) =>
  db
    .prepare(
      `SELECT c.id, c.nom, m.nom AS matiere, a.nom AS createur FROM liens l
       JOIN comptes a ON a.id = l.createur_id
       JOIN liens_cours lc ON lc.jeton = l.jeton
       JOIN cours c ON c.id = lc.cours_id JOIN matieres m ON m.id = c.matiere_id
       WHERE l.jeton = ? AND l.revoque_le IS NULL AND l.expire_le > ? AND l.places > 0
         AND (a.administrateur = 1 OR EXISTS (SELECT 1 FROM membres_cours mc
           WHERE mc.cours_id = c.id AND mc.compte_id = a.id))
       ORDER BY m.nom, c.nom`,
    )
    .all(jeton, maintenant()) as { id: string; nom: string; matiere: string; createur: string }[];

/**
 * Inscrit un élève aux cours d'un lien et prend une place, dans une transaction. Un visiteur
 * arrive avec l'identifiant, le nom et le mot de passe qu'il a choisis, et son compte est créé
 * dans la même transaction. Un élève déjà membre de tous ces cours ne prend pas de place. Rend
 * l'identifiant du compte, ou `undefined` si le lien n'inscrit plus.
 */
export async function inscrireParLien(
  db: Db,
  jeton: string,
  eleve: string | { identifiant: string; nom: string; motDePasse: string },
) {
  const nouveau = typeof eleve === "string" ? undefined : eleve;
  const id = typeof eleve === "string" ? eleve : crypto.randomUUID();
  const sel = hex(crypto.getRandomValues(new Uint8Array(16)));
  // Un lien qui n'inscrit plus s'arrête ici : une requête anonyme ne coûte pas une dérivation.
  if (!coursDuLien(db, jeton).length) return undefined;
  if (nouveau) verifierMotDePasse(nouveau.motDePasse);
  const empreinte = nouveau ? await deriver(nouveau.motDePasse, sel) : "";
  return transaction(db, () => {
    const cours = coursDuLien(db, jeton).map((c) => c.id);
    if (!cours.length) return undefined;
    if (
      nouveau &&
      db.prepare("SELECT 1 FROM comptes WHERE identifiant = ?").get(nouveau.identifiant)
    ) {
      throw new Error(IDENTIFIANT_REFUSE);
    }
    const siens = coursDuCompte(db, id);
    const manquants = cours.filter((c) => !siens.has(c));
    if (!manquants.length) return id;
    db.prepare("UPDATE liens SET places = places - 1 WHERE jeton = ?").run(jeton);
    if (nouveau) {
      db.prepare(
        "INSERT INTO comptes (id, identifiant, nom, role, sel, empreinte, cree_le) VALUES (?, ?, ?, 'eleve', ?, ?, ?)",
      ).run(id, nouveau.identifiant, nouveau.nom, sel, empreinte, maintenant());
    }
    for (const c of manquants) inscrire(db, c, id);
    return id;
  });
}

// Un enseignant voit et révoque les liens qui ouvrent un de ses cours.
const LIENS_GERES = `($administrateur OR EXISTS (SELECT 1 FROM liens_cours x
      JOIN membres_cours m ON m.cours_id = x.cours_id
      WHERE x.jeton = liens.jeton AND m.compte_id = $lecteur))`;

/** Désigne un lien dans une page sans donner son jeton, qui suffit à s'inscrire. */
const cleLien = (jeton: string) => createHash("sha256").update(jeton).digest("hex").slice(0, 32);

/**
 * Les liens actifs que le compte gère, avec leurs cours décodés. Le jeton, donc l'adresse du lien
 * et la page qui nomme ses cours, ne va qu'aux membres de tous ses cours et aux administrateurs.
 * Les autres désignent le lien par sa clé.
 */
export function liensGeres(db: Db, compte: Compte) {
  const liens = db
    .prepare(
      `SELECT liens.jeton, places, expire_le, a.nom AS createur,
         json_group_array(lc.cours_id) AS cours,
         $administrateur OR NOT EXISTS (SELECT 1 FROM liens_cours x WHERE x.jeton = liens.jeton
           AND x.cours_id NOT IN (SELECT cours_id FROM membres_cours WHERE compte_id = $lecteur))
           AS entier
       FROM liens JOIN comptes a ON a.id = liens.createur_id
       JOIN liens_cours lc ON lc.jeton = liens.jeton
       WHERE revoque_le IS NULL AND expire_le > ? AND ${LIENS_GERES}
       GROUP BY liens.jeton ORDER BY liens.cree_le DESC`,
    )
    .all(parametresGeres(compte), maintenant()) as {
    jeton: string;
    places: number;
    expire_le: string;
    createur: string;
    cours: string;
    entier: number;
  }[];
  return liens.map(({ jeton, entier, ...l }) => ({
    ...l,
    cle: cleLien(jeton),
    jeton: entier ? jeton : undefined,
    cours: JSON.parse(l.cours) as string[],
  }));
}

/** Révoque le lien de cette clé si le compte le gère. Rend `false` si aucun lien ne correspond. */
export function revoquerLien(db: Db, compte: Compte, cle: string) {
  const lien = db
    .prepare(`SELECT jeton FROM liens WHERE revoque_le IS NULL AND ${LIENS_GERES}`)
    .all(parametresGeres(compte))
    .find((l) => cleLien(l.jeton as string) === cle);
  if (!lien) return false;
  db.prepare("UPDATE liens SET revoque_le = ? WHERE jeton = ?").run(maintenant(), lien.jeton);
  return true;
}
