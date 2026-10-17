import { type Context, Hono } from "hono";
import {
  authentifier,
  choisirMotDePasse,
  type Compte,
  consommerProvisoire,
  coursDuLien,
  eleveSaisi,
  inscrireParLien,
  lireCompte,
} from "../comptes.ts";
import { enregistrerReglages, lireInstance, type Reglages } from "../instance.ts";
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
  app.get("/mot-de-passe", (c) => c.html(rendre(c, "Choisir un mot de passe", motDePasse())));
  app.post("/mot-de-passe", async (c) => {
    const b = await c.req.parseBody();
    try {
      if (b.mot_de_passe !== b.confirmation) throw new Error("Les mots de passe diffèrent.");
      await choisirMotDePasse(db, c.get("compte"), String(b.mot_de_passe ?? ""));
    } catch (e) {
      return c.html(rendre(c, "Choisir un mot de passe", motDePasse((e as Error).message)), 400);
    }
    session.fermer(c);
    return c.redirect("/connexion");
  });
  const pageAdministration = (c: Context<Env>, etat: Parameters<typeof administration>[3] = {}) =>
    rendre(
      c,
      "Administration",
      administration(
        lireInstance(db),
        Domaines.profilInstance(db),
        !!db.prepare("SELECT 1 FROM sources").get(),
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
      niveau: champ("niveau"),
      regroupement: champ("regroupement"),
      regroupements: champ("regroupements"),
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
        if (!eleve) {
          throw new Error(
            "Choisis un identifiant de 3 à 40 caractères parmi a-z, 0-9, point, tiret et tiret bas, et un nom de 100 caractères au maximum.",
          );
        }
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
