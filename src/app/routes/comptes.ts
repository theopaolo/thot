import { type Context, Hono } from "hono";
import {
  authentifier,
  choisirMotDePasse,
  type Compte,
  consommerProvisoire,
  coursDuLien,
  eleveSaisi,
  IDENTIFIANT_REFUSE,
  inscrireParLien,
  lireCompte,
} from "../comptes.ts";
import { enregistrerReglages, libelles, lireInstance, type Reglages, TERMES } from "../instance.ts";
import {
  administration,
  connexion as formulaireConnexion,
  inscription,
  motDePasse,
} from "../vues/page.ts";
import * as Domaines from "../domaines.ts";
import type { Session } from "./session.ts";
import type { Env, Web } from "./web.ts";

export function routesComptes(app: Hono<Env>, w: Web, session: Session) {
  const { db, rendre } = w;
  /** L'adresse où revenir après la connexion : un lien d'inscription, sinon rien. */
  const retour = (r: unknown) =>
    typeof r === "string" && /^\/inscription\/[\w-]+$/.test(r) ? r : "";
  app.get("/connexion", (c) =>
    c.html(
      rendre(c, "Connexion", formulaireConnexion(undefined, "", retour(c.req.query("retour")))),
    ),
  );
  app.post("/connexion", async (c) => {
    const b = await c.req.parseBody();
    const compte = await authentifier(
      db,
      String(b.identifiant ?? ""),
      String(b.mot_de_passe ?? ""),
    );
    if (!compte || (compte.renouveler_mdp && !consommerProvisoire(db, compte))) {
      return c.html(
        rendre(
          c,
          "Connexion",
          formulaireConnexion(
            "Identifiant ou mot de passe incorrect.",
            String(b.identifiant ?? ""),
            retour(b.retour),
          ),
        ),
        401,
      );
    }
    await session.ouvrir(c, compte);
    return c.redirect(compte.renouveler_mdp ? "/mot-de-passe" : retour(b.retour) || "/");
  });
  app.post("/deconnexion", (c) => {
    // Invalide aussi les cookies copiés ou restés sur un autre appareil.
    db.prepare("UPDATE comptes SET session_version = session_version + 1 WHERE id = ?").run(
      c.get("compte").id,
    );
    session.fermer(c);
    return c.redirect("/connexion");
  });
  app.get("/", (c) =>
    c.redirect(
      lireInstance(db).mode === "personal" || c.get("compte").role === "eleve" ? "/eleve" : "/prof",
    ),
  );
  // Après un code provisoire, la page impose le choix. Sinon elle demande l'ancien mot de passe.
  const pageMotDePasse = (c: Context<Env>, erreur?: string) =>
    rendre(
      c,
      c.get("compte").renouveler_mdp ? "Choisir un mot de passe" : "Changer de mot de passe",
      motDePasse(c.get("compte"), erreur),
    );
  app.get("/mot-de-passe", (c) => c.html(pageMotDePasse(c)));
  app.post("/mot-de-passe", async (c) => {
    const b = await c.req.parseBody();
    try {
      if (b.mot_de_passe !== b.confirmation) throw new Error("Les mots de passe diffèrent.");
      await choisirMotDePasse(
        db,
        c.get("compte"),
        String(b.mot_de_passe ?? ""),
        String(b.ancien ?? ""),
      );
    } catch (e) {
      return c.html(pageMotDePasse(c, (e as Error).message), 400);
    }
    session.fermer(c);
    return c.redirect("/connexion");
  });
  const pageAdministration = (c: Context<Env>, etat: Parameters<typeof administration>[4] = {}) =>
    rendre(
      c,
      "Administration",
      administration(
        lireInstance(db),
        Domaines.profilInstance(db),
        !!db.prepare("SELECT 1 FROM sources").get(),
        libelles(db),
        etat,
      ),
    );
  app.get("/administration", (c) =>
    c.html(pageAdministration(c, { enregistre: c.req.query("enregistre") !== undefined })),
  );
  // Une version périmée n'enregistre rien et rend la saisie avec la version actuelle.
  app.post("/administration", async (c) => {
    const b = await c.req.parseBody();
    const champ = (n: string) => String(b[n] ?? "").trim();
    const saisie: Reglages = {
      nom: champ("nom"),
      ...(Object.fromEntries(TERMES.flat().map((t) => [t, champ(t)])) as Omit<
        Reglages,
        "nom" | "lecteurs"
      >),
      // Le mode personnel ne montre pas ce choix : un dépôt n'y a qu'un lecteur.
      lecteurs: String(b.lecteurs ?? lireInstance(db).lecteurs) as Reglages["lecteurs"],
    };
    const r = enregistrerReglages(db, saisie, Number(b.version));
    if (r === true) return c.redirect("/administration?enregistre", 303);
    return c.html(
      pageAdministration(c, r ? { saisie, erreurs: r } : { saisie, conflit: true }),
      r ? 400 : 409,
    );
  });

  // Le lien inscrit des élèves seulement. Un enseignant ou un administrateur qui l'ouvre lit une
  // explication. Une instance personnelle n'en crée pas.
  const pageInscription = (
    c: Context<Env>,
    statut: 200 | 400 | 403 = 200,
    erreur?: string,
    saisie = {},
  ) => {
    const jeton = c.req.param("jeton")!;
    const cours = coursDuLien(db, jeton);
    return c.html(
      rendre(c, "Rejoindre un cours", inscription(jeton, cours, c.get("compte"), erreur, saisie)),
      cours.length ? statut : 404,
    );
  };
  app.get("/inscription/:jeton", (c) => pageInscription(c));
  app.post("/inscription/:jeton", async (c) => {
    const compte = c.get("compte") as Compte | undefined;
    if (compte?.role === "enseignant") return pageInscription(c, 403);
    const b = await c.req.parseBody();
    let id;
    try {
      if (compte) id = await inscrireParLien(db, c.req.param("jeton"), compte.id);
      else {
        const eleve = eleveSaisi(String(b.identifiant ?? ""), String(b.nom ?? ""));
        if (!eleve) throw new Error(IDENTIFIANT_REFUSE);
        const motDePasse = String(b.mot_de_passe ?? "");
        id = await inscrireParLien(db, c.req.param("jeton"), { ...eleve, motDePasse });
      }
    } catch (e) {
      return pageInscription(c, 400, (e as Error).message, b);
    }
    if (!id) return pageInscription(c);
    if (!compte) await session.ouvrir(c, lireCompte(db, id)!);
    return c.redirect("/eleve", 303);
  });
}
