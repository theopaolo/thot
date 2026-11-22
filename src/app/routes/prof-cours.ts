import { type Context, Hono } from "hono";
import { transaction } from "../../core/recherche.ts";
import { colleguesDe, estEnseignant, estEnseignantDuCours } from "../comptes.ts";
import * as Domaines from "../domaines.ts";
import { renommerEntree } from "../ingestion.ts";
import { libelles } from "../instance.ts";
import * as ProfCours from "../vues/prof-cours.ts";
import type { Env, Web } from "./web.ts";

export function routesProfCours(app: Hono<Env>, w: Web) {
  const { db, rendre } = w;
  const refusCours = () =>
    `Inscription refusée : cochez un ou plusieurs de vos ${libelles(db).formes.cours.noms}.`;
  const pageCours = (c: Context<Env>, erreur?: string) => {
    const moi = c.get("compte");
    const cat = Domaines.catalogueDe(db, moi);
    return rendre(
      c,
      `Mes ${libelles(db).formes.cours.noms}`,
      ProfCours.mesCours(
        cat,
        new Map(
          cat.cours.map((x) => [
            x.id,
            Domaines.membres(db, x.id).filter((m) => m.role === "enseignant"),
          ]),
        ),
        colleguesDe(db, moi.id),
        moi.id,
        libelles(db),
        erreur,
      ),
    );
  };
  const coursCoches = (c: Context<Env>, b: Record<string, unknown>) => {
    const cours = [...new Set([b.cours ?? []].flat().map(String))];
    if (c.get("compte").administrateur) return cours.length ? cours : undefined;
    const siens = Domaines.coursDuCompte(db, c.get("compte").id);
    return cours.length && cours.every((id) => siens.has(id)) ? cours : undefined;
  };
  app.get("/prof/cours", (c) => c.html(pageCours(c)));
  /**
   * Un enseignant agit sur ses cours seulement : un autre cours rend 404. Supprimer reste aux
   * administrateurs. Seul un compte enseignant rejoint un cours par ici, car inscrire un élève
   * existant donnerait la réinitialisation de son mot de passe, donc son compte.
   */
  app.post("/prof/cours/:action", async (c) => {
    const b = await c.req.parseBody({ all: true });
    const champ = (n: string) => String(b[n] ?? "");
    const mien = (id: string) =>
      !!Domaines.matiereDuCours(db, id) && !!coursCoches(c, { cours: id });
    let ancre = champ("cours_id");
    try {
      switch (c.req.param("action")) {
        case "creer":
          ancre = transaction(db, () => {
            const id = Domaines.cours(
              db,
              champ("matiere_id"),
              champ("nom"),
              champ("public"),
              champ("objectif"),
            );
            Domaines.inscrire(db, id, c.get("compte").id);
            return id;
          });
          break;
        case "theme":
          if (!mien(ancre)) return c.notFound();
          Domaines.theme(db, ancre, champ("nom"));
          break;
        case "renommer": {
          const genre = champ("genre");
          ancre =
            genre === "cours"
              ? champ("id")
              : genre === "theme"
                ? (Domaines.coursDuTheme(db, champ("id")) ?? "")
                : "";
          if (!mien(ancre)) return c.notFound();
          renommerEntree(db, genre, champ("id"), champ("nom"));
          break;
        }
        case "collegue": {
          const cours = coursCoches(c, b);
          if (!cours) return c.html(pageCours(c, refusCours()), 400);
          const collegue = champ("compte_id");
          if (!estEnseignant(db, collegue)) {
            throw new Error(
              `Seul un compte enseignant s'ajoute comme collègue. Un élève rejoint vos ${libelles(db).formes.cours.noms} par un lien d'inscription.`,
            );
          }
          transaction(db, () => {
            for (const id of cours) Domaines.inscrire(db, id, collegue);
          });
          break;
        }
        case "retirer": {
          if (!estEnseignantDuCours(db, ancre, champ("compte_id")) || !mien(ancre)) {
            return c.notFound();
          }
          Domaines.desinscrire(db, ancre, champ("compte_id"));
          break;
        }
        default:
          return c.notFound();
      }
    } catch (e) {
      return c.html(pageCours(c, (e as Error).message), 400);
    }
    return c.redirect(ancre ? `/prof/cours#cours-${ancre}` : "/prof/cours", 303);
  });
}
