import { join } from "@std/path";
import { config } from "./config.ts";
import { type Db, maintenant } from "./db.ts";

export type Role = "enseignant" | "eleve";
export type Compte = {
  id: string;
  identifiant: string;
  nom: string;
  role: Role;
  session_version: number;
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

/** Crée un compte avec un mot de passe tiré au hasard. Le mot de passe n'est rendu qu'ici. */
export async function creerCompte(db: Db, identifiant: string, nom: string, role: Role) {
  const motDePasse = hex(crypto.getRandomValues(new Uint8Array(6)));
  const sel = hex(crypto.getRandomValues(new Uint8Array(16)));
  db.prepare(
    "INSERT INTO comptes (id, identifiant, nom, role, sel, empreinte, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    crypto.randomUUID(),
    identifiant.trim().toLowerCase(),
    nom.trim(),
    role,
    sel,
    await deriver(motDePasse, sel),
    maintenant(),
  );
  return motDePasse;
}

/** CSV UTF-8 avec colonnes identifiant,nom. Les guillemets et retours de ligne sont permis. */
export function lireListe(csv: string): { identifiant: string; nom: string }[] {
  const lignes: string[][] = [];
  let ligne: string[] = [], valeur = "", cite = false, ferme = false;
  csv = csv.replace(/^\uFEFF/, "");
  const separateur = (csv.split(/\r?\n/, 1)[0].match(/;/g)?.length ?? 0) >
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
    identifiant = identifiant?.trim().toLowerCase();
    nom = nom?.trim();
    if (
      lignes[i].length !== 2 || !/^[a-z0-9._-]{3,40}$/.test(identifiant) || !nom || nom.length > 100
    ) {
      throw new Error(`Ligne ${i + 2}: identifiant ou nom invalide.`);
    }
    return { identifiant, nom };
  });
  if (new Set(comptes.map((c) => c.identifiant)).size !== comptes.length) {
    throw new Error("Le CSV contient un identifiant en double.");
  }
  return comptes;
}

export async function importerEleves(db: Db, csv: string) {
  const comptes = lireListe(csv);
  const existants = db.prepare("SELECT identifiant FROM comptes WHERE identifiant = ?");
  for (const c of comptes) {
    if (existants.get(c.identifiant)) {
      throw new Error(`Identifiant déjà utilisé : ${c.identifiant}.`);
    }
  }
  const resultats = [];
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
  db.exec("BEGIN IMMEDIATE");
  try {
    const insert = db.prepare(
      "INSERT INTO comptes (id, identifiant, nom, role, sel, empreinte, cree_le) VALUES (?, ?, ?, 'eleve', ?, ?, ?)",
    );
    for (const c of resultats) {
      insert.run(c.id, c.identifiant, c.nom, c.sel, c.empreinte, maintenant());
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return resultats.map(({ identifiant, nom, motDePasse }) => ({ identifiant, nom, motDePasse }));
}

export async function reinitialiserMotDePasse(db: Db, id: string, role: Role = "eleve") {
  const compte = db.prepare("SELECT role FROM comptes WHERE id = ?").get(id);
  if (compte?.role !== role) return undefined;
  const motDePasse = hex(crypto.getRandomValues(new Uint8Array(6)));
  const sel = hex(crypto.getRandomValues(new Uint8Array(16)));
  db.prepare(
    "UPDATE comptes SET sel = ?, empreinte = ?, session_version = session_version + 1 WHERE id = ?",
  )
    .run(sel, await deriver(motDePasse, sel), id);
  return motDePasse;
}

export async function authentifier(db: Db, identifiant: string, motDePasse: string) {
  const l = db.prepare("SELECT * FROM comptes WHERE identifiant = ?")
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
  return diff === 0
    ? {
      id: l.id,
      identifiant: l.identifiant,
      nom: l.nom,
      role: l.role,
      session_version: l.session_version,
    }
    : null;
}

export const lireCompte = (db: Db, id: string) =>
  db.prepare("SELECT id, identifiant, nom, role, session_version FROM comptes WHERE id = ?").get(
    id,
  ) as
    | Compte
    | undefined;

/** Secret de signature des cookies. Créé au premier lancement, conservé avec les données. */
export function secretSession(): string {
  const fromEnv = Deno.env.get("THOT_SECRET");
  if (fromEnv) return fromEnv;
  const chemin = join(config.donnees, "secret");
  try {
    return Deno.readTextFileSync(chemin).trim();
  } catch {
    Deno.mkdirSync(config.donnees, { recursive: true });
    const s = hex(crypto.getRandomValues(new Uint8Array(32)));
    Deno.writeTextFileSync(chemin, s, { mode: 0o600 });
    return s;
  }
}
