import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FILTRE_ACCES, type Lecteur, parametresAcces, transaction } from "../core/recherche.ts";
import { config } from "./config.ts";
import { type Db, maintenant } from "./db.ts";
import { inscrire } from "./domaines.ts";

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
const hex = (b: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

async function deriver(motDePasse: string, sel: string) {
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
  // Vérifiés avant l'insertion : creerAdministrateur appelle cette fonction dans sa transaction.
  for (const coursId of cours) {
    if (!db.prepare("SELECT 1 FROM cours WHERE id = ?").get(coursId)) {
      throw new Error(`Cours inconnu : ${coursId}.`);
    }
  }
  const motDePasse = hex(crypto.getRandomValues(new Uint8Array(6)));
  const sel = hex(crypto.getRandomValues(new Uint8Array(16)));
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO comptes (id, identifiant, nom, role, sel, empreinte, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    identifiant.trim().toLowerCase(),
    nom.trim(),
    role,
    sel,
    await deriver(motDePasse, sel),
    maintenant(),
  );
  for (const coursId of cours) inscrire(db, coursId, id);
  return motDePasse;
}

/** Un élève saisi par un enseignant, au format du CSV, ou `undefined` s'il est invalide. */
export function eleveSaisi(identifiant = "", nom = "") {
  identifiant = identifiant.trim().toLowerCase();
  nom = nom.trim();
  if (!/^[a-z0-9._-]{3,40}$/.test(identifiant) || !nom || nom.length > 100) return undefined;
  return { identifiant, nom };
}

/** CSV UTF-8 avec colonnes identifiant,nom. Les guillemets et retours de ligne sont permis. */
export function lireListe(csv: string): { identifiant: string; nom: string }[] {
  const lignes: string[][] = [];
  let ligne: string[] = [],
    valeur = "",
    cite = false,
    ferme = false;
  csv = csv.replace(/^\uFEFF/, "");
  const separateur =
    (csv.split(/\r?\n/, 1)[0].match(/;/g)?.length ?? 0) >
    (csv.split(/\r?\n/, 1)[0].match(/,/g)?.length ?? 0)
      ? ";"
      : ",";
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (ferme && c !== separateur && c !== "\n" && c !== "\r") {
      throw new Error("Guillemets CSV invalides.");
    }
    if (c === '"') {
      if (cite && csv[i + 1] === '"') {
        valeur += '"';
        i++;
      } else if (!cite && valeur) throw new Error("Guillemets CSV invalides.");
      else {
        cite = !cite;
        ferme = !cite;
      }
    } else if (c === separateur && !cite) {
      ligne.push(valeur);
      valeur = "";
      ferme = false;
    } else if ((c === "\n" || c === "\r") && !cite) {
      if (c === "\r" && csv[i + 1] === "\n") i++;
      ligne.push(valeur);
      valeur = "";
      if (ligne.some((x) => x.trim())) lignes.push(ligne);
      ligne = [];
      ferme = false;
    } else valeur += c;
  }
  if (cite) throw new Error("Guillemets CSV non fermés.");
  ligne.push(valeur);
  if (ligne.some((x) => x.trim())) lignes.push(ligne);
  const entetes = lignes.shift()?.map((x) => x.trim().toLowerCase());
  if (!entetes || entetes.length !== 2 || entetes[0] !== "identifiant" || entetes[1] !== "nom") {
    throw new Error("Le CSV doit commencer par identifiant,nom.");
  }
  if (!lignes.length || lignes.length > 100) {
    throw new Error("Le CSV doit contenir de 1 à 100 élèves.");
  }
  const comptes = lignes.map(([identifiant, nom], i) => {
    const eleve = lignes[i].length === 2 ? eleveSaisi(identifiant, nom) : undefined;
    if (!eleve) throw new Error(`Ligne ${i + 2}: identifiant ou nom invalide.`);
    return eleve;
  });
  if (new Set(comptes.map((c) => c.identifiant)).size !== comptes.length) {
    throw new Error("Le CSV contient un identifiant en double.");
  }
  return comptes;
}

export const importerEleves = (db: Db, csv: string, cours: string[] = []) =>
  creerEleves(db, lireListe(csv), cours);

/**
 * Crée les comptes élèves et les inscrit aux cours donnés, dans la même transaction. Un compte
 * existant ne s'inscrit pas par son identifiant : les enseignants d'un cours réinitialisent le mot
 * de passe de ses élèves, et inscrire un compte existant leur ouvrirait ce compte.
 */
export async function creerEleves(
  db: Db,
  comptes: { identifiant: string; nom: string }[],
  cours: string[] = [],
) {
  const existants = db.prepare("SELECT identifiant FROM comptes WHERE identifiant = ?");
  for (const c of comptes) {
    if (existants.get(c.identifiant)) {
      throw new Error(
        `Identifiant déjà utilisé : ${c.identifiant}. Un élève qui a déjà un compte rejoint vos cours par un administrateur.`,
      );
    }
  }
  const resultats: ((typeof comptes)[number] & {
    motDePasse: string;
    id: string;
    sel: string;
    empreinte: string;
  })[] = [];
  for (const c of comptes) {
    const motDePasse = hex(crypto.getRandomValues(new Uint8Array(6)));
    const sel = hex(crypto.getRandomValues(new Uint8Array(16)));
    resultats.push({
      ...c,
      motDePasse,
      id: crypto.randomUUID(),
      sel,
      empreinte: await deriver(motDePasse, sel),
    });
  }
  transaction(db, () => {
    const insert = db.prepare(
      "INSERT INTO comptes (id, identifiant, nom, role, sel, empreinte, cree_le) VALUES (?, ?, ?, 'eleve', ?, ?, ?)",
    );
    for (const c of resultats) {
      insert.run(c.id, c.identifiant, c.nom, c.sel, c.empreinte, maintenant());
      for (const coursId of cours) inscrire(db, coursId, c.id);
    }
  });
  return resultats.map(({ identifiant, nom, motDePasse }) => ({ identifiant, nom, motDePasse }));
}

export async function reinitialiserMotDePasse(db: Db, id: string, role: Role = "eleve") {
  const compte = db.prepare("SELECT role FROM comptes WHERE id = ?").get(id);
  if (compte?.role !== role) return undefined;
  const motDePasse = hex(crypto.getRandomValues(new Uint8Array(6)));
  const sel = hex(crypto.getRandomValues(new Uint8Array(16)));
  db.prepare(
    `UPDATE comptes SET sel = ?, empreinte = ?, session_version = session_version + 1,
      renouveler_mdp = administrateur WHERE id = ?`,
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

export async function choisirMotDePasse(db: Db, compte: Compte, motDePasse: string) {
  if (motDePasse.length < 12 || motDePasse.length > 200) {
    throw new Error("Choisir un mot de passe de 12 à 200 caractères.");
  }
  const sel = hex(crypto.getRandomValues(new Uint8Array(16)));
  const { changes } = db
    .prepare(
      `UPDATE comptes SET sel = ?, empreinte = ?, renouveler_mdp = 0,
       session_version = session_version + 1
     WHERE id = ? AND session_version = ? AND renouveler_mdp = 1`,
    )
    .run(sel, await deriver(motDePasse, sel), compte.id, compte.session_version);
  if (!changes) throw new Error("Session expirée. Demander une récupération à l'opérateur.");
}

export async function authentifier(db: Db, identifiant: string, motDePasse: string) {
  const l = db
    .prepare("SELECT * FROM comptes WHERE identifiant = ?")
    .get(identifiant.trim().toLowerCase()) as
    | (Compte & { sel: string; empreinte: string })
    | undefined;
  // Une dérivation a lieu même sans compte: la durée ne révèle pas quels identifiants existent.
  const empreinte = await deriver(motDePasse, l?.sel ?? "absent");
  if (!l || empreinte.length !== l.empreinte.length) return null;
  let diff = 0;
  for (let i = 0; i < empreinte.length; i++) {
    diff |= empreinte.charCodeAt(i) ^ l.empreinte.charCodeAt(i);
  }
  // Le contournement en développement exclut les administrateurs.
  return diff === 0 || (config.dev && !l.administrateur)
    ? {
        id: l.id,
        identifiant: l.identifiant,
        nom: l.nom,
        role: l.role,
        session_version: l.session_version,
        administrateur: l.administrateur,
        renouveler_mdp: l.renouveler_mdp,
      }
    : null;
}

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
export const peutLire = (db: Db, c: Compte, sourceId: string) =>
  db
    .prepare(`SELECT 1 FROM sources s WHERE s.id = ? AND ${FILTRE_ACCES}`)
    .get(sourceId, ...parametresAcces(lecteur(c))) !== undefined;
/**
 * Modifient, certifient et relisent une source : son propriétaire, les administrateurs, et les
 * enseignants de ses cours quand elle n'est pas privée.
 */
export const filtreModification = (s = "s") =>
  `(? OR ${s}.proprietaire_id = ? OR (? AND ${s}.audience != 'prive'
    AND EXISTS (SELECT 1 FROM source_cours sc JOIN membres_cours mc ON mc.cours_id = sc.cours_id
      WHERE sc.source_id = ${s}.id AND mc.compte_id = ?)))`;
export const parametresModification = (c: Compte) => [
  c.administrateur === 1 ? 1 : 0,
  c.id,
  c.role === "enseignant" ? 1 : 0,
  c.id,
];
export const peutModifier = (db: Db, c: Compte, sourceId: string) =>
  db
    .prepare(`SELECT 1 FROM sources s WHERE s.id = ? AND ${filtreModification()}`)
    .get(sourceId, ...parametresModification(c)) !== undefined;

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
