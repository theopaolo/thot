import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, test, vi } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  creerCompte,
  creerLien,
  ECHECS_ADRESSE,
  ECHECS_IDENTIFIANT,
  FENETRE_ECHECS_MS,
  reinitialiserMotDePasse,
} from "../src/app/comptes.ts";
import { config } from "../src/app/config.ts";
import { type Db, maintenant } from "../src/app/db.ts";
import { cours, matiere } from "../src/app/domaines.ts";
import { SCRIPT_RECHARGEMENT } from "../src/app/rechargement.ts";
import { creerApp } from "../src/app/routes.ts";
import { page } from "../src/app/vues/page.ts";
import { environnement, fauxModeles, ORIGINE } from "./outils.ts";

afterEach(() => void vi.restoreAllMocks());

/** Une instance avec le compte `lea`, et de quoi tenter une connexion. */
async function instance() {
  const { db, dir } = await environnement();
  const motDePasse = await creerCompte(db, "lea", "Léa Martin", "eleve");
  const app = creerApp(db, fauxModeles().modeles);
  const entrer = (mot_de_passe: string, identifiant = "lea", entetes = {}) =>
    app.request("/connexion", {
      method: "POST",
      headers: { origin: ORIGINE, ...entetes },
      body: new URLSearchParams({ identifiant, mot_de_passe }),
    });
  return { db, dir, app, motDePasse, entrer };
}
const essais = (db: Db, cle: string) =>
  db.prepare("SELECT echecs FROM connexions WHERE cle = ?").get(cle)?.echecs;

test("connexion : la onzième connexion fausse de suite est refusée sans dérivation", async () => {
  const { db, dir, motDePasse, entrer } = await instance();
  try {
    const derivations = vi.spyOn(crypto.subtle, "deriveBits");
    for (let i = 0; i < ECHECS_IDENTIFIANT; i++) assertEquals((await entrer("faux")).status, 401);
    assertEquals(derivations.mock.calls.length, ECHECS_IDENTIFIANT);
    const refus = await entrer("faux");
    assertEquals(refus.status, 429);
    assert(Number(refus.headers.get("retry-after")) > 0);
    assertStringIncludes(await refus.text(), "Trop d&#39;essais de connexion");
    // Le bon mot de passe attend aussi : le refus ne dit pas s'il était juste.
    assertEquals((await entrer(motDePasse)).status, 429);
    assertEquals(derivations.mock.calls.length, ECHECS_IDENTIFIANT);
    // Un identifiant inconnu se bloque de la même façon, un autre compte reste libre.
    for (let i = 0; i < ECHECS_IDENTIFIANT; i++) await entrer("faux", "inconnu");
    assertEquals((await entrer("faux", "inconnu")).status, 429);
    assertEquals((await entrer("faux", "noe")).status, 401);

    // La fenêtre passée, le compte se connecte et repart de zéro.
    db.prepare("UPDATE connexions SET debut_le = ?").run(
      maintenant(Date.now() - FENETRE_ECHECS_MS - 1000),
    );
    assertEquals((await entrer(motDePasse)).status, 302);
    assertEquals(db.prepare("SELECT count(*) n FROM connexions").get()!.n, 0);

    // Renouveler le mot de passe débloque le compte sans attendre.
    for (let i = 0; i <= ECHECS_IDENTIFIANT; i++) await entrer("faux");
    assertEquals((await entrer(motDePasse)).status, 429);
    const id = db.prepare("SELECT id FROM comptes WHERE identifiant = 'lea'").get()!.id as string;
    const code = await reinitialiserMotDePasse(db, id);
    assertEquals((await entrer(code!)).headers.get("location"), "/mot-de-passe");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("connexion : les échecs se comptent aussi par adresse, celle que donne le proxy déclaré", async () => {
  const { db, dir, motDePasse, entrer } = await instance();
  const avant = config.proxies;
  try {
    config.proxies = 1;
    const depuis = (adresses: string) => ({ "x-forwarded-for": adresses });
    db.prepare("INSERT INTO connexions VALUES ('adresse:203.0.113.9', ?, ?)").run(
      ECHECS_ADRESSE,
      maintenant(),
    );
    // Le proxy ajoute l'adresse qu'il a vue à la fin. Ce qui précède vient du client.
    assertEquals(
      (await entrer(motDePasse, "lea", depuis("198.51.100.1, 203.0.113.9"))).status,
      429,
    );
    assertEquals(
      (await entrer(motDePasse, "lea", depuis("203.0.113.9, 198.51.100.7"))).status,
      302,
    );
    // Un échec compte pour l'adresse, une réussite ne lui coûte rien.
    assertEquals((await entrer("faux", "noe", depuis("198.51.100.7"))).status, 401);
    assertEquals(essais(db, "adresse:198.51.100.7"), 1);
    assertEquals((await entrer(motDePasse, "lea", depuis("198.51.100.7"))).status, 302);
    assertEquals(essais(db, "adresse:198.51.100.7"), 1);

    // Sans proxy déclaré, l'en-tête ne compte pas : n'importe quel client peut l'écrire.
    config.proxies = 0;
    assertEquals((await entrer(motDePasse, "lea", depuis("203.0.113.9"))).status, 302);
  } finally {
    config.proxies = avant;
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("connexion : en développement, aucun échec ne se compte", async () => {
  const { db, dir, entrer } = await instance();
  const dev = config.dev;
  try {
    config.dev = true;
    for (let i = 0; i <= ECHECS_IDENTIFIANT; i++) {
      assertEquals((await entrer("", "inconnu")).status, 401);
    }
    assertEquals((await entrer("")).status, 302);
    assertEquals(db.prepare("SELECT count(*) n FROM connexions").get()!.n, 0);
  } finally {
    config.dev = dev;
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("inscription : un lien inconnu est refusé avant de dériver le mot de passe", async () => {
  const { db, dir, app } = await instance();
  try {
    const id = db.prepare("SELECT id FROM comptes").get()!.id as string;
    db.prepare("UPDATE comptes SET role = 'enseignant' WHERE id = ?").run(id);
    const c = cours(db, matiere(db, "Arts appliqués"), "Design");
    db.prepare("INSERT INTO membres_cours VALUES (?, ?)").run(c, id);
    const inscrire = (jeton: string) =>
      app.request(`/inscription/${jeton}`, {
        method: "POST",
        headers: { origin: ORIGINE },
        body: new URLSearchParams({
          nom: "Noé Petit",
          identifiant: "noe.petit",
          mot_de_passe: "un mot de passe sûr",
        }),
      });
    const derivations = vi.spyOn(crypto.subtle, "deriveBits");
    assertEquals((await inscrire("n-importe-quoi")).status, 404);
    assertEquals(derivations.mock.calls.length, 0);
    assertEquals((await inscrire(creerLien(db, id, [c], 14, 40))).status, 303);
    assertEquals(derivations.mock.calls.length, 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("taille des requêtes : 1 Mo par défaut, le dépôt garde son propre plafond", async () => {
  const { db, dir, app } = await instance();
  try {
    const envoyer = (chemin: string) =>
      app.request(chemin, {
        method: "POST",
        headers: { origin: ORIGINE },
        body: new URLSearchParams({
          identifiant: "lea",
          mot_de_passe: "x".repeat(2 * 1024 * 1024),
        }),
      });
    const derivations = vi.spyOn(crypto.subtle, "deriveBits");
    assertEquals((await envoyer("/connexion")).status, 413);
    assertEquals((await envoyer("/prof/eleves/importer")).status, 413);
    assertEquals(derivations.mock.calls.length, 0);
    // Le dépôt et les activités reçoivent des fichiers : sans session, ils renvoient à la connexion.
    assertEquals((await envoyer("/prof/depot")).status, 302);
    assertEquals((await envoyer("/prof/activites/importer")).status, 302);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("en-têtes de sécurité : une CSP limitée à l'instance sur chaque réponse", async () => {
  const { db, dir, app } = await instance();
  const dev = config.dev;
  try {
    for (const chemin of ["/connexion", "/static/favicon.svg", "/introuvable"]) {
      const r = await app.request(chemin);
      const csp = r.headers.get("content-security-policy")!;
      assertStringIncludes(csp, "default-src 'self'", chemin);
      assertStringIncludes(csp, "frame-ancestors 'none'");
      assertStringIncludes(csp, "object-src 'none'");
      assertStringIncludes(csp, "font-src 'self' data:");
      assert(!/unsafe-eval|https?:|\*/.test(csp), csp);
      assert(!/script-src[^;]*unsafe-inline/.test(csp), csp);
      assertEquals(r.headers.get("x-content-type-options"), "nosniff");
      // `no-referrer` viderait l'en-tête Origin des formulaires, que le contrôle CSRF exige.
      assertEquals(r.headers.get("referrer-policy"), "same-origin");
      assertEquals(r.headers.get("strict-transport-security"), null);
    }
    // Sous pnpm dev, la CSP admet le script de rechargement, et lui seul, par son empreinte.
    config.dev = true;
    const script = String(page("Titre", null, "")).match(/<script>(.*?)<\/script>/s)![1];
    assertEquals(script, SCRIPT_RECHARGEMENT);
    assertStringIncludes(
      (await creerApp(db, fauxModeles().modeles).request("/connexion")).headers.get(
        "content-security-policy",
      )!,
      `script-src 'self' 'sha256-${createHash("sha256").update(script).digest("base64")}'`,
    );
  } finally {
    config.dev = dev;
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("en-têtes de sécurité : HSTS quand l'origine configurée est en HTTPS", async () => {
  const { db, dir } = await environnement();
  const avant = config.origine;
  try {
    config.origine = "https://thot.example.org";
    const r = await creerApp(db, fauxModeles().modeles).request(
      "http://thot.example.org/connexion",
    );
    assertStringIncludes(r.headers.get("strict-transport-security")!, "max-age=");
  } finally {
    config.origine = avant;
    db.close();
    await rm(dir, { recursive: true });
  }
});
