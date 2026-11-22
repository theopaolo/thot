import { type Context, Hono } from "hono";
import { compteSaisi, creerCompte } from "../comptes.ts";
import { config } from "../config.ts";
import { libelles, lireInstance } from "../instance.ts";
import { domainesDe } from "../vues/administration.ts";
import { renommerEntree } from "../ingestion.ts";
import * as Domaines from "../domaines.ts";
import * as DomaineVue from "../vues/domaines.ts";
import * as ProfEleves from "../vues/prof-eleves.ts";
import type { Env, Web } from "./web.ts";

export function routesDomaines(app: Hono<Env>, w: Web) {
  const { db, rendre } = w;
  const pageDomaines = (
    c: Context<Env>,
    erreur = "",
    ouvert = "",
    saisie?: DomaineVue.ChampsDepot["saisie"],
    etape?: DomaineVue.Inscriptions["etape"],
  ) => {
    const cat = Domaines.catalogue(db);
    return rendre(
      c,
      domainesDe(libelles(db)),
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
          etape,
          ressources: Domaines.nombreRessources(db),
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
        lireInstance(db).mode === "personal",
      ),
    );
  };
  app.get("/administration/domaines", (c) => {
    const etape = c.req.query("etape");
    return c.html(
      pageDomaines(
        c,
        "",
        c.req.query("ouvert"),
        undefined,
        etape === "cours" || etape === "membres" ? etape : undefined,
      ),
    );
  });
  app.post("/administration/domaines/:action", async (c) => {
    const b = await c.req.parseBody({ all: true });
    const action = c.req.param("action");
    // Le cours ou la matière modifié reste déplié après un changement. Une création mène à
    // l'étape suivante : le premier cours d'une matière, puis les membres d'un cours. Son adresse
    // n'a pas d'ancre : une ancre empêche le navigateur de placer le focus sur l'étape.
    let ouvert =
      action === "inscrire" || action === "desinscrire"
        ? String(b.cours_id ?? "")
        : action === "champs"
          ? String(b.matiere_id ?? "")
          : String(b.ouvert ?? "");
    let etape = "";
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
          ouvert = Domaines.matiere(
            db,
            String(b.nom ?? ""),
            b.profil ? String(b.profil) : undefined,
          );
          etape = "cours";
          break;
        case "cours":
          etape = "membres";
          ouvert = Domaines.cours(
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
        // Le mot de passe du nouveau compte s'affiche une seule fois, comme celui d'un élève.
        case "enseignant": {
          const saisi = compteSaisi(String(b.identifiant ?? ""), String(b.nom ?? ""));
          if (!saisi) {
            throw new Error(
              "Compte refusé : un identifiant de 3 à 40 caractères parmi a-z, 0-9, point, tiret et tiret bas, et un nom de 100 caractères au maximum.",
            );
          }
          const motDePasse = await creerCompte(db, saisi.identifiant, saisi.nom, "enseignant");
          c.header("Cache-Control", "no-store");
          return c.html(
            rendre(
              c,
              "Identifiants enseignant",
              ProfEleves.feuilleIdentifiants(
                [{ ...saisi, motDePasse }],
                config.origine || new URL(c.req.url).origin,
                [
                  "/administration/domaines",
                  `Retour aux ${libelles(db).formes.matiere.noms} et ${libelles(db).formes.cours.noms}`,
                ],
              ),
            ),
          );
        }
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
        : etape
          ? `/administration/domaines?ouvert=${id}&etape=${etape}`
          : ouvert
            ? `/administration/domaines?ouvert=${id}#cours-${id}`
            : "/administration/domaines",
      303,
    );
  });
}
