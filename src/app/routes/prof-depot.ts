import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Compte } from "../comptes.ts";
import { libelles, lireInstance } from "../instance.ts";
import {
  audience,
  controlerFichier,
  deposer,
  MAX_LOT,
  MAX_OCTETS,
  sha256,
  sourceIdentique,
  titreParDefaut,
  valider,
} from "../depot.ts";
import * as Prof from "../vues/prof.ts";
import * as Domaines from "../domaines.ts";
import type { Env, Web } from "./web.ts";

export function routesDepot(app: Hono<Env>, w: Web) {
  const { db, instance, rendre } = w;
  const optionsDepot = (
    c: Context<Env>,
    champs: Record<string, string> = {},
    b: Record<string, unknown> = {},
  ) => {
    const cat = Domaines.catalogueDe(db, c.get("compte"));
    // Une seule matière: le dépôt la prend d'office. « Non classée » reste un choix explicite.
    if (cat.matieres.length === 1 && champs.matiere_id === undefined && !champs.matiere) {
      champs = { ...champs, matiere_id: cat.matieres[0].id };
    }
    const m = cat.matieres.find((m) =>
      champs.matiere_id ? m.id === champs.matiere_id : m.nom === champs.matiere,
    );
    // Le profil que le dépôt donnera à la source : ses champs sont ceux qu'il validera.
    const profil =
      m?.profil ??
      Domaines.profilInstance(db) ??
      (champs.matiere === "arts-appliques" ? ("arts-appliques" as const) : ("general" as const));
    const instance = lireInstance(db);
    return {
      personnel: instance.mode === "personal",
      champs,
      catalogue: cat,
      profil,
      informations: Domaines.champsMatiere(db, m?.id ?? null, profil),
      libelles: libelles(db),
      lecteurs: instance.lecteurs,
      liens: Domaines.liensFormulaire(b),
      lot: crypto.randomUUID(),
    };
  };
  app.get("/prof/depot", (c) =>
    c.html(rendre(c, "Déposer", Prof.depot(optionsDepot(c, c.req.query())))),
  );
  const parCle = (compte: Compte, cle: string) =>
    db
      .prepare("SELECT id, titre, format FROM sources WHERE proprietaire_id = ? AND cle_depot = ?")
      .get(compte.id, cle) as { id: string; titre: string; format: string } | undefined;
  /**
   * Dépose un fichier seul: l'échec de l'un ne touche pas les autres. La clé identifie la
   * tentative, un renvoi rend la source déjà créée. Un fichier que le compte lit déjà n'est pas
   * déposé deux fois.
   */
  const deposerFichier = async (
    c: Context<Env>,
    champs: Record<string, string>,
    b: Record<string, unknown>,
    fichier: File | undefined,
    seul: boolean,
    lotId: string,
    cle: string,
  ): Promise<Prof.ResultatDepot> => {
    const compte = c.get("compte");
    const nom = fichier?.name ?? "";
    const erreur = (erreurs: Record<string, string>): Prof.ResultatDepot => ({
      etat: "erreur",
      nom,
      erreurs,
    });
    const deja = parCle(compte, cle);
    if (deja) return { etat: "recu", nom, ...deja };
    const dansLot = db
      .prepare("SELECT count(*) n FROM sources WHERE lot_id = ? AND proprietaire_id = ?")
      .get(lotId, compte.id)!.n as number;
    if (dansLot >= MAX_LOT) {
      return erreur({ fichier: `Un lot compte ${MAX_LOT} fichiers au maximum.` });
    }
    if (fichier && fichier.size > MAX_OCTETS) {
      return erreur({ fichier: "Fichier trop lourd, 25 Mo au maximum." });
    }
    const octets = fichier ? new Uint8Array(await fichier.arrayBuffer()) : new Uint8Array();
    const controle = controlerFichier(octets, nom);
    const format = "format" in controle ? controle.format : null;
    // Le nom saisi ne vaut que pour un fichier seul, sinon chaque fichier garde son titre.
    const titre = (seul && champs.titre?.trim()) || titreParDefaut(octets, nom, format);
    const v = valider(
      { ...champs, titre },
      Domaines.catalogueChamps(db).map((x) => x.cle),
    );
    if ("erreurs" in v || !format) {
      return erreur({
        ...("erreurs" in v ? v.erreurs : {}),
        ...("erreur" in controle ? { fichier: controle.erreur } : {}),
      });
    }
    const identique = sourceIdentique(db, compte, instance.school_id, await sha256(octets));
    if (identique) return { etat: "doublon", nom, ...identique };
    try {
      const { source_id } = await deposer(db, {
        meta: v.meta,
        nomFichier: nom,
        octets,
        format,
        schoolId: instance.school_id,
        enseignant: compte.nom,
        proprietaireId: compte.id,
        par: compte,
        // Sans le choix des lecteurs, la ressource va aux lecteurs par défaut et sert aux réponses.
        audience: audience(b.audience ?? lireInstance(db).lecteurs),
        reponses: b.audience === undefined || Boolean(b.reponses),
        liens:
          b.cours !== undefined
            ? Domaines.liensAutorises(db, compte, Domaines.liensFormulaire(b))
            : undefined,
        lotId,
        cle,
      });
      return { etat: "recu", nom, id: source_id, titre: v.meta.titre, format };
    } catch (e) {
      // Deux requêtes de même clé arrivées ensemble: la seconde retrouve la source de la première.
      const creee = parCle(compte, cle);
      return creee ? { etat: "recu", nom, ...creee } : erreur({ domaine: (e as Error).message });
    }
  };
  // Un identifiant de lot ou de clé venu du navigateur ne sert que s'il a la forme d'un jeton.
  const jeton = (v: unknown) => (typeof v === "string" && /^[\w-]{8,64}$/.test(v) ? v : undefined);
  app.post(
    "/prof/depot",
    bodyLimit({
      // Sans JavaScript, une requête porte plusieurs fichiers.
      maxSize: 2 * MAX_OCTETS + 128 * 1024,
      onError: (c) => c.text("Envoi trop volumineux, 25 Mo par fichier et 50 Mo en tout.", 413),
    }),
    async (c) => {
      const b = await c.req.parseBody({ all: true });
      const fichiers = [b.fichier ?? []].flat().filter((f) => f instanceof File);
      const champs = Object.fromEntries(
        Object.entries(b).filter(
          ([k, v]) => !["fichier", "lot", "cle"].includes(k) && typeof v === "string",
        ),
      ) as Record<string, string>;
      const lot = jeton(b.lot) ?? crypto.randomUUID();
      const resultats: Prof.ResultatDepot[] = [];
      for (const [i, f] of (fichiers.length ? fichiers : [undefined]).entries()) {
        resultats.push(
          await deposerFichier(
            c,
            champs,
            b,
            f,
            fichiers.length <= 1,
            lot,
            `${jeton(b.cle) ?? lot}-${i}`,
          ),
        );
      }
      if (c.req.header("accept")?.includes("application/json")) {
        return c.json(resultats[0], resultats[0].etat === "erreur" ? 400 : 200);
      }
      if (fichiers.length <= 1 && resultats[0].etat === "erreur") {
        return c.html(
          rendre(
            c,
            "Déposer",
            Prof.depot({ ...optionsDepot(c, champs, b), erreurs: resultats[0].erreurs }),
          ),
          400,
        );
      }
      return c.html(
        rendre(
          c,
          "Déposer",
          Prof.depot({ ...optionsDepot(c, champs), depose: { lot, resultats } }),
        ),
      );
    },
  );
}
