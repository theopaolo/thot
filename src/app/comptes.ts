import { join } from "@std/path";
import { config } from "./config.ts";
import { type Db, maintenant } from "./db.ts";

export type Role = "enseignant" | "eleve";
export type Compte = { id: string; identifiant: string; nom: string; role: Role };

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
  db.prepare("INSERT INTO comptes VALUES (?, ?, ?, ?, ?, ?, ?)").run(
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
  return diff === 0 ? { id: l.id, identifiant: l.identifiant, nom: l.nom, role: l.role } : null;
}

export const lireCompte = (db: Db, id: string) =>
  db.prepare("SELECT id, identifiant, nom, role FROM comptes WHERE id = ?").get(id) as
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
