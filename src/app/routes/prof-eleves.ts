import { type Context, Hono } from "hono";
import {
  creerEleves,
  creerLien,
  eleveSaisi,
  importerEleves,
  reinitialiserMotDePasse,
} from "../comptes.ts";
import { lireInstance } from "../instance.ts";
import { maintenant } from "../db.ts";
import * as Prof from "../vues/prof.ts";
import * as Domaines from "../domaines.ts";
import type { Env, Web } from "./web.ts";

export function routesProfEleves(app: Hono<Env>, w: Web) {
  const { db, rendre, lu } = w;
  // Réinitialiser ouvre le compte : seuls les administrateurs gèrent les élèves sans cours.
  const ELEVES_GERES = `role = 'eleve' AND (? OR EXISTS (SELECT 1 FROM membres_cours lui
      JOIN membres_cours moi ON moi.cours_id = lui.cours_id
      WHERE lui.compte_id = comptes.id AND moi.compte_id = ?))`;
  const elevesGeres = (c: Context<Env>) => [lu(c).administrateur ? 1 : 0, lu(c).id];
  // Un enseignant voit et révoque les liens qui ouvrent un de ses cours.
  const LIENS_GERES = `(? OR EXISTS (SELECT 1 FROM liens_cours x
      JOIN membres_cours m ON m.cours_id = x.cours_id
      WHERE x.jeton = liens.jeton AND m.compte_id = ?))`;
  // Les élèves de chaque cours de l'enseignant. Ceux sans cours ne se montrent qu'aux
  // administrateurs, seuls à les gérer.
  const pageEleves = (c: Context<Env>, erreur?: string) => {
    const cat = Domaines.catalogueDe(db, c.get("compte"));
    const groupes = cat.cours.map((cours) => ({
      cours,
      eleves: Domaines.membres(db, cours.id).filter((m) => m.role === "eleve"),
    }));
    const sansCours = lu(c).administrateur
      ? (db
          .prepare(
            `SELECT id, identifiant, nom FROM comptes WHERE role = 'eleve'
             AND NOT EXISTS (SELECT 1 FROM membres_cours WHERE compte_id = comptes.id) ORDER BY nom`,
          )
          .all() as Prof.Eleve[])
      : undefined;
    const liens =
      lireInstance(db).mode === "personal"
        ? undefined
        : (
            db
              .prepare(
                `SELECT liens.jeton, places, expire_le, a.nom AS createur,
                   json_group_array(lc.cours_id) AS cours
                 FROM liens JOIN comptes a ON a.id = liens.createur_id
                 JOIN liens_cours lc ON lc.jeton = liens.jeton
                 WHERE revoque_le IS NULL AND expire_le > ? AND ${LIENS_GERES}
                 GROUP BY liens.jeton ORDER BY liens.cree_le DESC`,
              )
              .all(maintenant(), ...elevesGeres(c)) as (Omit<Prof.Lien, "cours"> & {
              cours: string;
            })[]
          ).map((l) => ({ ...l, cours: JSON.parse(l.cours) as string[] }));
    return rendre(
      c,
      "Élèves",
      Prof.eleves(cat, groupes, sansCours, liens, new URL(c.req.url).origin, erreur),
    );
  };
  /**
   * Les cours cochés, ou `undefined` si un enseignant n'en coche aucun ou coche un cours qui n'est
   * pas le sien. Un élève sans cours échappe à l'enseignant qui l'a créé.
   */
  const coursCoches = (c: Context<Env>, b: Record<string, unknown>) => {
    const cours = [...new Set([b.cours ?? []].flat().map(String))];
    if (c.get("compte").administrateur) return cours;
    const siens = Domaines.coursDuCompte(db, c.get("compte").id);
    return cours.length && cours.every((id) => siens.has(id)) ? cours : undefined;
  };
  const REFUS_COURS = "Inscription refusée : cochez un ou plusieurs de vos cours.";
  /** Crée les élèves et montre une seule fois leurs identifiants à remettre. */
  const remettre = async (c: Context<Env>, creer: () => ReturnType<typeof creerEleves>) => {
    try {
      const comptes = await creer();
      c.header("Cache-Control", "no-store");
      return c.html(
        rendre(
          c,
          "Identifiants élèves",
          Prof.feuilleIdentifiants(comptes, new URL(c.req.url).origin),
        ),
      );
    } catch (e) {
      return c.html(pageEleves(c, (e as Error).message), 400);
    }
  };
  app.get("/prof/eleves", (c) => c.html(pageEleves(c)));
  app.post("/prof/eleves/importer", async (c) => {
    const b = await c.req.parseBody({ all: true });
    const fichier = b.fichier;
    if (!(fichier instanceof File) || fichier.size > 100_000) {
      return c.text("Fichier CSV invalide (100 Ko maximum).", 400);
    }
    const cours = coursCoches(c, b);
    if (!cours) return c.html(pageEleves(c, REFUS_COURS), 400);
    const csv = await fichier.text();
    return remettre(c, () => importerEleves(db, csv, cours));
  });
  app.post("/prof/eleves/ajouter", async (c) => {
    const b = await c.req.parseBody({ all: true });
    const cours = coursCoches(c, b);
    if (!cours) return c.html(pageEleves(c, REFUS_COURS), 400);
    const eleve = eleveSaisi(String(b.identifiant ?? ""), String(b.nom ?? ""));
    if (!eleve) {
      return c.html(
        pageEleves(
          c,
          "Élève refusé : un identifiant de 3 à 40 caractères parmi a-z, 0-9, point, tiret et tiret bas, et un nom de 100 caractères au maximum.",
        ),
        400,
      );
    }
    return remettre(c, () => creerEleves(db, [eleve], cours));
  });
  app.post("/prof/eleves/liens", async (c) => {
    if (lireInstance(db).mode === "personal") return c.notFound();
    const b = await c.req.parseBody({ all: true });
    const cours = coursCoches(c, b);
    if (!cours?.length) return c.html(pageEleves(c, REFUS_COURS), 400);
    try {
      creerLien(db, c.get("compte").id, cours, Number(b.jours), Number(b.places));
    } catch (e) {
      return c.html(pageEleves(c, (e as Error).message), 400);
    }
    return c.redirect("/prof/eleves#liens", 303);
  });
  // Révoquer garde les élèves que le lien a inscrits.
  app.post("/prof/eleves/liens/:jeton/revoquer", (c) => {
    const { changes } = db
      .prepare(
        `UPDATE liens SET revoque_le = ? WHERE jeton = ? AND revoque_le IS NULL AND ${LIENS_GERES}`,
      )
      .run(maintenant(), c.req.param("jeton"), ...elevesGeres(c));
    return changes ? c.redirect("/prof/eleves#liens", 303) : c.notFound();
  });
  // Retirer d'un cours laisse le compte. Un enseignant ne retire que des élèves de ses cours.
  app.post("/prof/eleves/:id/retirer", async (c) => {
    const id = c.req.param("id");
    const coursId = String((await c.req.parseBody()).cours_id ?? "");
    const eleve = db
      .prepare(
        `SELECT 1 FROM membres_cours m JOIN comptes a ON a.id = m.compte_id
         WHERE m.cours_id = ? AND m.compte_id = ? AND a.role = 'eleve'`,
      )
      .get(coursId, id);
    if (!eleve || !coursCoches(c, { cours: coursId })) return c.notFound();
    Domaines.desinscrire(db, coursId, id);
    return c.redirect(`/prof/eleves#cours-${coursId}`, 303);
  });
  app.post("/prof/eleves/:id/reinitialiser", async (c) => {
    const id = c.req.param("id");
    const eleve = db
      .prepare(`SELECT identifiant, nom FROM comptes WHERE id = ? AND ${ELEVES_GERES}`)
      .get(id, ...elevesGeres(c)) as { identifiant: string; nom: string } | undefined;
    if (!eleve) return c.notFound();
    const motDePasse = await reinitialiserMotDePasse(db, id);
    c.header("Cache-Control", "no-store");
    return c.html(
      rendre(
        c,
        "Nouveau mot de passe",
        Prof.feuilleIdentifiants(
          [{ ...eleve, motDePasse: motDePasse! }],
          new URL(c.req.url).origin,
        ),
      ),
    );
  });
}
