import { type Context, Hono } from "hono";
import { libelles } from "../instance.ts";
import { renommerEntree } from "../ingestion.ts";
import * as Domaines from "../domaines.ts";
import * as DomaineVue from "../vues/domaines.ts";
import type { Env, Web } from "./web.ts";

export function routesDomaines(app: Hono<Env>, w: Web) {
  const { db, rendre } = w;
  const pageDomaines = (
    c: Context<Env>,
    erreur = "",
    ouvert = "",
    saisie?: DomaineVue.ChampsDepot["saisie"],
  ) => {
    const cat = Domaines.catalogue(db);
    return rendre(
      c,
      "Matières et cours",
      DomaineVue.gestion(
        cat,
        erreur,
        !!db.prepare("SELECT 1 FROM sources").get(),
        {
          membres: new Map(cat.cours.map((x) => [x.id, Domaines.membres(db, x.id)])),
          comptes: db
            .prepare("SELECT id, identifiant, nom, role FROM comptes ORDER BY nom")
            .all() as DomaineVue.Inscrit[],
          ouvert,
        },
        {
          // Seul un champ personnalisé montre combien de ressources le remplissent.
          catalogue: Domaines.catalogueChamps(db).map((x) => ({
            ...x,
            ressources: x.cle.startsWith("perso_") ? Domaines.ressourcesAvec(db, x.cle) : 0,
          })),
          listes: new Map(
            cat.matieres.map((m) => [
              m.id,
              Domaines.champsMatiere(db, m.id, m.profil).map((x) => x.cle),
            ]),
          ),
          saisie,
          enregistre: c.req.query("enregistre") !== undefined,
        },
        libelles(db),
      ),
    );
  };
  app.get("/administration/domaines", (c) => c.html(pageDomaines(c, "", c.req.query("ouvert"))));
  app.post("/administration/domaines/:action", async (c) => {
    const b = await c.req.parseBody({ all: true });
    const action = c.req.param("action");
    // Les membres d'un cours et les champs d'une matière restent affichés après un changement.
    const ouvert =
      action === "inscrire" || action === "desinscrire"
        ? String(b.cours_id ?? "")
        : action === "champs"
          ? String(b.matiere_id ?? "")
          : "";
    try {
      switch (action) {
        case "champs": {
          const cles = [b.champs ?? []].flat().map(String);
          if (!Domaines.enregistrerChamps(db, ouvert, cles, Number(b.version))) {
            return c.html(pageDomaines(c, "", ouvert, { id: ouvert, cles }), 409);
          }
          break;
        }
        case "champ":
          Domaines.champPersonnalise(db, String(b.nom ?? ""), String(b.type ?? ""));
          break;
        case "matiere":
          Domaines.matiere(db, String(b.nom ?? ""), b.profil ? String(b.profil) : undefined);
          break;
        case "cours":
          Domaines.cours(
            db,
            String(b.matiere_id ?? ""),
            String(b.nom ?? ""),
            String(b.public ?? ""),
            String(b.objectif ?? ""),
          );
          break;
        case "theme":
          Domaines.theme(db, String(b.cours_id ?? ""), String(b.nom ?? ""));
          break;
        case "profil":
          Domaines.changerProfil(db, String(b.profil ?? ""));
          break;
        case "renommer":
          renommerEntree(db, String(b.genre ?? ""), String(b.id ?? ""), String(b.nom ?? ""));
          break;
        case "supprimer":
          Domaines.supprimer(db, String(b.genre ?? ""), String(b.id ?? ""));
          break;
        case "inscrire":
          Domaines.inscrire(db, String(b.cours_id ?? ""), String(b.compte_id ?? ""));
          break;
        case "desinscrire":
          Domaines.desinscrire(db, String(b.cours_id ?? ""), String(b.compte_id ?? ""));
          break;
        default:
          return c.notFound();
      }
    } catch (e) {
      return c.html(pageDomaines(c, (e as Error).message, ouvert), 400);
    }
    const id = encodeURIComponent(ouvert);
    return c.redirect(
      action === "champs"
        ? `/administration/domaines?ouvert=${id}&enregistre#champs-${id}`
        : ouvert
          ? `/administration/domaines?ouvert=${id}#membres-${id}`
          : "/administration/domaines",
      303,
    );
  });
}
