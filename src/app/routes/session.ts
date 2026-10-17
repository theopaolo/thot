import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { type Compte, lireCompte, secretSession } from "../comptes.ts";
import { lireInstance } from "../instance.ts";
import { config } from "../config.ts";
import type { Db } from "../db.ts";
import type { Env } from "./web.ts";

const SESSION_MS = 12 * 3600_000;

/**
 * La session : un cookie signé qui porte l'identifiant du compte, relu en base à chaque requête.
 * `verifier` garde aussi l'accès aux pages d'administration et d'enseignant.
 */
export function sessions(db: Db) {
  const secret = secretSession();
  const instance = lireInstance(db);
  const SESSION = `${
    config.origine.startsWith("https:") ? "__Host-" : ""
  }thot_session_${instance.id}`;
  const verifier: MiddlewareHandler<Env> = async (c, next) => {
    const id = await getSignedCookie(c, secret, SESSION);
    const [compteId, version, instanceId, expiration] = typeof id === "string" ? id.split(":") : [];
    const trouve = compteId ? lireCompte(db, compteId) : undefined;
    const compte =
      trouve &&
      String(trouve.session_version) === version &&
      instanceId === instance.id &&
      Number.isSafeInteger(Number(expiration)) &&
      Number(expiration) > Date.now()
        ? trouve
        : undefined;
    if (compte) c.set("compte", compte);
    const p = c.req.path;
    if (!p.startsWith("/static/") && !p.startsWith("/media/")) {
      c.header("Cache-Control", "no-store");
    }
    if (p === "/connexion" || p.startsWith("/static/") || p.startsWith("/inscription/")) {
      return next();
    }
    if (!compte) return c.redirect("/connexion");
    if (compte.renouveler_mdp && p !== "/mot-de-passe" && p !== "/deconnexion") {
      return c.redirect("/mot-de-passe");
    }
    if (p.startsWith("/administration") && !compte.administrateur) {
      return c.text("Accès réservé à l'administrateur.", 403);
    }
    if (p.startsWith("/prof") && compte.role !== "enseignant") {
      return c.text("Accès réservé aux enseignants.", 403);
    }
    return next();
  };
  const ouvrir = (c: Context<Env>, compte: Compte) =>
    setSignedCookie(
      c,
      SESSION,
      `${compte.id}:${compte.session_version}:${instance.id}:${Date.now() + SESSION_MS}`,
      secret,
      {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: SESSION_MS / 1000,
        // Derrière un proxy (Coolify, Traefik), le TLS s'arrête avant l'application.
        secure:
          config.origine.startsWith("https:") ||
          new URL(c.req.url).protocol === "https:" ||
          c.req.header("x-forwarded-proto") === "https",
      },
    );
  const fermer = (c: Context<Env>) =>
    deleteCookie(c, SESSION, { path: "/", secure: config.origine.startsWith("https:") });
  return { verifier, ouvrir, fermer };
}
export type Session = ReturnType<typeof sessions>;
