import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Modeles } from "../src/core/modeles.ts";
import { assert } from "@std/assert";
import { creerCompte, type Role } from "../src/app/comptes.ts";
import { config } from "../src/app/config.ts";
import { connexion, type Db, migrer } from "../src/app/db.ts";
import { deposer, valider } from "../src/app/depot.ts";
import { revendiquer, statuer, traiter } from "../src/app/ingestion.ts";
import { lireInstance } from "../src/app/instance.ts";
import { creerApp } from "../src/app/routes.ts";

/** Un répertoire de données neuf et une base migrée. */
export async function environnement() {
  const dir = await mkdtemp(join(tmpdir(), "thot-test-"));
  config.donnees = dir;
  const db = connexion(join(dir, "state.sqlite3"));
  migrer(db);
  return { db, dir };
}

/**
 * Faux modèles: le reclasseur rend le score demandé, le générateur rejoue ses sorties, le juge
 * soutient tout sauf ce que `soutien` note plus bas.
 */
export function fauxModeles(
  o: {
    score?: number;
    sorties?: string[];
    legende?: string;
    soutien?: (texte: string) => number;
  } = {},
) {
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
    traduire: (question) => Promise.resolve(question),
    soutenir: (texte) =>
      Promise.resolve({ probabilite: o.soutien?.(texte) ?? 1, modele: "faux-juge" }),
  };
  return { modeles, vus };
}

/** Une sortie du générateur qui cite la source de `publier`. */
export const BONNE = JSON.stringify({
  affirmations: [
    {
      texte: "Gaudí refuse la ligne droite.",
      extrait: 1,
      citation: "Gaudí refuse la ligne droite dans toute la façade",
    },
  ],
});

/** Une source publiée aux élèves, rattachée au cours demandé. */
export async function publier(db: Db, titre: string, coursId?: string) {
  const v = valider({ titre, type_document: "cours" });
  assert("meta" in v);
  const { source_id } = await deposer(db, {
    meta: v.meta,
    nomFichier: "cours.html",
    format: "html",
    schoolId: lireInstance(db).school_id,
    enseignant: "Prof",
    audience: "eleves",
    reponses: true,
    liens: coursId ? [{ cours_id: coursId, theme_id: null }] : undefined,
    octets: new TextEncoder().encode(
      `<html><h1>${titre}</h1><p>La façade de la Casa Batlló est couverte de céramique irisée. Gaudí refuse la ligne droite dans toute la façade.</p></html>`,
    ),
  });
  await traiter(db, revendiquer(db)!, fauxModeles().modeles);
  statuer(db, source_id, "certifiee", "Test");
  return source_id;
}

export const ORIGINE = "http://localhost";

/**
 * Une application et un cookie de session pour le rôle demandé. Le compte rejoint les cours
 * existants, comme la migration 0009 l'a fait pour les comptes du pilote, sauf `inscrit: false`.
 */
export async function session(db: Db, modeles: Modeles, role: Role, inscrit = true) {
  const app = creerApp(db, modeles);
  const identifiant = `${role}-${crypto.randomUUID().slice(0, 6)}`;
  const mot_de_passe = await creerCompte(db, identifiant, `Compte ${role}`, role);
  if (inscrit) {
    db.prepare(
      "INSERT INTO membres_cours SELECT c.id, a.id FROM cours c, comptes a WHERE a.identifiant = ?",
    ).run(identifiant);
  }
  const r = await app.request("/connexion", {
    method: "POST",
    headers: { origin: ORIGINE },
    body: new URLSearchParams({ identifiant, mot_de_passe }),
  });
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const requete = (chemin: string, init: RequestInit = {}) =>
    app.request(chemin, {
      ...init,
      headers: { cookie, origin: ORIGINE, ...(init.headers as Record<string, string> | undefined) },
    });
  return { app, requete };
}
