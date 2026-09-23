import { join } from "@std/path";
import type { Message, Modeles } from "../src/core/modeles.ts";
import { creerCompte, type Role } from "../src/app/comptes.ts";
import { config } from "../src/app/config.ts";
import { connexion, type Db, migrer } from "../src/app/db.ts";
import { creerApp } from "../src/app/routes.ts";

/** Un répertoire de données neuf et une base migrée. */
export async function environnement() {
  const dir = await Deno.makeTempDir({ prefix: "thot-test-" });
  config.donnees = dir;
  const db = connexion(join(dir, "state.sqlite3"));
  migrer(db);
  return { db, dir };
}

/** Faux modèles: le reclasseur rend le score demandé, le générateur rejoue ses sorties. */
export function fauxModeles(o: { score?: number; sorties?: string[]; legende?: string } = {}) {
  const vus: Message[][] = [];
  const sorties = [...(o.sorties ?? [])];
  const modeles: Modeles = {
    legender: () => Promise.resolve({ texte: o.legende ?? "Une image.", modele: "faux-vl" }),
    reclasser: (_q, docs) =>
      Promise.resolve(docs.map((_, index) => ({ index, score: (o.score ?? 0.9) - index / 100 }))),
    generer: (messages) => {
      vus.push(messages);
      const texte = sorties.shift();
      if (texte === undefined) throw new Error("plus de sortie prévue");
      return Promise.resolve({ texte, modele: "faux-llm" });
    },
    reformuler: (_precedente, question) => Promise.resolve(question),
  };
  return { modeles, vus };
}

export const ORIGINE = "http://localhost";

/** Une application et un cookie de session pour le rôle demandé. */
export async function session(db: Db, modeles: Modeles, role: Role) {
  const app = creerApp(db, modeles);
  const identifiant = `${role}-${crypto.randomUUID().slice(0, 6)}`;
  const mot_de_passe = await creerCompte(db, identifiant, `Compte ${role}`, role);
  const r = await app.request("/connexion", {
    method: "POST",
    headers: { origin: ORIGINE },
    body: new URLSearchParams({ identifiant, mot_de_passe }),
  });
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const requete = (chemin: string, init: RequestInit = {}) =>
    app.request(chemin, {
      ...init,
      headers: { cookie, origin: ORIGINE, ...(init.headers ?? {}) },
    });
  return { app, requete };
}
