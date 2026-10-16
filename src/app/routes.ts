import { readFile } from "node:fs/promises";
import { type Context, Hono } from "hono";
import { html } from "hono/html";
import { csrf } from "hono/csrf";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { deleteCookie, getCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import type { Modeles } from "../core/modeles.ts";
import { actualiserResultat, type Affirmation, type Resultat } from "../core/reponse.ts";
import {
  type Candidat,
  chercher,
  FILTRE_ACCES,
  filtreAcces,
  indexerSource,
  type Lecteur,
  MAX_MATIERES,
  parametresAcces,
  transaction,
} from "../core/recherche.ts";
import { contexte } from "../core/texte.ts";
import {
  authentifier,
  choisirMotDePasse,
  type Compte,
  consommerProvisoire,
  coursDuLien,
  creerEleves,
  creerLien,
  eleveSaisi,
  filtreModification,
  importerEleves,
  inscrireParLien,
  lecteur,
  lireCompte,
  parametresModification,
  peutLire,
  peutModifier,
  reinitialiserMotDePasse,
  secretSession,
} from "./comptes.ts";
import { enregistrerReglages, libelles, lireInstance, type Reglages } from "./instance.ts";
import { config, contenu } from "./config.ts";
import { type Db, maintenant } from "./db.ts";
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
} from "./depot.ts";
import {
  chunksSource,
  ecarterRevision,
  lireDocument,
  relireLegende,
  revisionEnAttente,
  statuer,
  supprimerSource,
} from "./ingestion.ts";
import { ARRETEE, attendreChangement, boucleReponses, memePerimetre } from "./reponses.ts";
import { faitAuHasard, suggestionsDuPerimetre, suggestionsParChapitre } from "./suggestions.ts";
import {
  administration,
  connexion as formulaireConnexion,
  inscription,
  motDePasse,
  page,
} from "./vues/page.ts";
import * as Prof from "./vues/prof.ts";
import * as Eleve from "./vues/eleve.ts";
import * as Domaines from "./domaines.ts";
import * as DomaineVue from "./vues/domaines.ts";
import { validerInformations } from "../core/profils.ts";

type Env = { Variables: { compte: Compte } };

const SESSION_MS = 12 * 3600_000;
/** Réponses admises au quiz: artiste et mouvement enregistrés, séparés par `|`. */
const QUIZ = `CASE WHEN s.profil = 'arts-appliques' THEN trim(coalesce(json_extract(s.metadonnees, '$.artiste'), '') || '|' ||
  coalesce(json_extract(s.metadonnees, '$.mouvement'), ''), '|') ELSE '' END AS quiz_reponse`;

export function creerApp(db: Db, modeles: Modeles, reponses = boucleReponses(db, modeles)) {
  const app = new Hono<Env>();
  const secret = secretSession();
  const instance = lireInstance(db);
  const SESSION = `${
    config.origine.startsWith("https:") ? "__Host-" : ""
  }thot_session_${instance.id}`;

  app.use("*", async (c, next) => {
    if (config.origine && new URL(c.req.url).host !== new URL(config.origine).host) {
      return c.text("Origine incorrecte.", 421);
    }
    await next();
  });

  app.use("/static/dist/*", async (c, next) => {
    c.header("Cache-Control", "no-cache");
    await next();
  });
  app.use("/static/*", serveStatic({ root: "./" }));
  app.use("*", csrf(config.origine ? { origin: config.origine } : undefined));

  // Session: un cookie signé qui porte l'identifiant du compte, relu en base à chaque requête.
  app.use("*", async (c, next) => {
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
  });

  const rendre = (c: Context<Env>, titre: string, corps: unknown, classe = "") =>
    page(
      titre,
      c.get("compte") ?? null,
      corps,
      classe,
      c.req.path,
      getCookie(c, "rail") === "replie",
      lireInstance(db),
    );

  const lu = (c: Context<Env>) => lecteur(c.get("compte"));
  // Qui lit les questions d'un élève : les enseignants de ses cours, ou tous s'il n'en a aucun.
  const mentionLecteurs = (c: Context<Env>) =>
    lireInstance(db).mode === "personal"
      ? ""
      : Domaines.coursDuCompte(db, c.get("compte").id).size
        ? "Les enseignants de tes cours lisent tes questions."
        : "Les enseignants lisent tes questions.";
  const MODIFICATION_REFUSEE =
    "Seuls son propriétaire, les administrateurs et les enseignants de ses cours modifient cette source.";

  // ------------------------------------------------------------ connexion
  const ouvrirSession = (c: Context<Env>, compte: Compte) =>
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
    await ouvrirSession(c, compte);
    return c.redirect(compte.renouveler_mdp ? "/mot-de-passe" : retour(b.retour) || "/");
  });
  app.post("/deconnexion", (c) => {
    // Invalide aussi les cookies copiés ou restés sur un autre appareil.
    db.prepare("UPDATE comptes SET session_version = session_version + 1 WHERE id = ?").run(
      c.get("compte").id,
    );
    deleteCookie(c, SESSION, { path: "/", secure: config.origine.startsWith("https:") });
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
    deleteCookie(c, SESSION, { path: "/", secure: config.origine.startsWith("https:") });
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

  // ------------------------------------------------------------ inscription par lien
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
    if (!compte) await ouvrirSession(c, lireCompte(db, id)!);
    return c.redirect("/eleve", 303);
  });

  const scope = (c: Context<Env>) =>
    Domaines.lireScope({ ...c.req.query(), matieres: c.req.queries("matieres") });
  const idsScope = (c: Context<Env>) => Domaines.sourcesPerimetre(db, scope(c));
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
          Domaines.renommer(db, String(b.genre ?? ""), String(b.id ?? ""), String(b.nom ?? ""));
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

  // ------------------------------------------------------------ images
  app.get("/media/:id", async (c) => {
    const i = db
      .prepare(
        `SELECT i.fichier, i.mime, i.source_id, i.checksum FROM images i JOIN sources s ON s.id = i.source_id
       WHERE i.id = ? AND s.school_id = ? AND ${FILTRE_ACCES} AND (s.statut = 'certifiee' OR ?)`,
      )
      .get(
        c.req.param("id"),
        instance.school_id,
        ...parametresAcces(lu(c)),
        lu(c).enseignant ? 1 : 0,
      ) as { fichier: string; mime: string; source_id: string; checksum: string } | undefined;
    if (!i) return c.notFound();
    // Le navigateur revalide à chaque affichage : une source devenue privée cesse aussitôt de servir.
    const entetes = { "cache-control": "private, no-cache", etag: `"${i.checksum}"` };
    if (c.req.header("if-none-match") === entetes.etag) return c.body(null, 304, entetes);
    const octets = await readFile(contenu(i.source_id, "assets", i.fichier));
    return c.body(octets, 200, { ...entetes, "content-type": i.mime });
  });

  // ------------------------------------------------------------ enseignant
  const lignes = (c: Context<Env>, statut: string, sequence: string) =>
    db
      .prepare(
        `SELECT s.id, s.titre, s.profil, json_extract(s.metadonnees, '$.sequence') AS sequence, s.format, s.statut,
         s.audience, coalesce(${filtreModification()}, 0) AS modifiable,
         j.etat, j.erreur,
         (SELECT count(*) FROM images i WHERE i.source_id = s.id AND i.legende_statut = 'unreviewed') AS images_a_relire,
         EXISTS (SELECT 1 FROM revisions r WHERE r.source_id = s.id AND r.n > s.revision) AS revision_en_attente,
         (SELECT count(*) FROM images i WHERE i.source_id = s.id) AS images,
         (SELECT count(legende) FROM images i WHERE i.source_id = s.id) AS legendes,
         (SELECT id FROM images WHERE source_id = s.id ORDER BY position LIMIT 1) AS image_id
       FROM sources s JOIN ingestion_jobs j ON j.source_id = s.id
       WHERE s.school_id = ? AND ${FILTRE_ACCES} AND (? = '' OR s.statut = ?)
         AND (? = '' OR sequence = ?) AND (? = '' OR s.lot_id = ?)
       ORDER BY sequence, s.titre`,
      )
      .all(
        ...parametresModification(c.get("compte")),
        instance.school_id,
        ...parametresAcces(lu(c)),
        statut,
        statut,
        sequence,
        sequence,
        c.req.query("lot") ?? "",
        c.req.query("lot") ?? "",
      ) as unknown as Prof.LigneSource[];
  const filtres = (c: Context<Env>) => ({
    statut: c.req.query("statut") ?? "",
    sequence: c.req.query("sequence") ?? "",
    lot: c.req.query("lot") ?? "",
    vue: c.req.query("vue") === "grille" ? "grille" : "",
    ...Domaines.lireScope(c.req.query()),
  });

  app.get("/prof", (c) => {
    const f = filtres(c);
    const selection = idsScope(c);
    const ressources = lignes(c, "", "").filter((s) => selection.has(s.id));
    // Une nouvelle version à relire compte avec les sources à relire.
    const statut = (s: Prof.LigneSource) => (s.revision_en_attente ? "a_relire" : s.statut);
    const repartition = [
      ...Map.groupBy(ressources, (s) => `${s.sequence ?? ""}\0${statut(s)}`).values(),
    ].map((liste) => ({
      sequence: liste[0].sequence ?? "",
      statut: statut(liste[0]),
      n: liste.length,
    }));
    return c.html(
      rendre(
        c,
        "Bibliothèque",
        html`${DomaineVue.filtre(
          Domaines.catalogueDe(db, c.get("compte")),
          scope(c),
          "/prof",
          "",
          "",
          libelles(db).regroupement,
        )}${Prof.sources(
          ressources.filter(
            (s) =>
              (!f.statut || statut(s) === f.statut) && (!f.sequence || s.sequence === f.sequence),
          ),
          f,
          repartition,
          libelles(db),
          ressources.some((s) => s.profil === "general"),
          c.req.query("supprimee") !== undefined,
        )}`,
      ),
    );
  });
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
  // Un enseignant lit les questions posées dans ses cours. Sans cours choisi, celles des élèves
  // avec qui il partage un cours, ou de tout élève qui n'a aucun cours. Un administrateur lit tout.
  app.get("/prof/questions", (c) => {
    const l = lu(c);
    const messages = db
      .prepare(
        `SELECT m.id, m.question, m.etat, m.avis, m.cree_le, c.nom,
         json_extract(m.resultat, '$.code') AS code,
         coalesce(
           CASE WHEN EXISTS (SELECT 1 FROM sources s3
             WHERE json_extract(s3.metadonnees, '$.sequence') = m.chapitre AND ${filtreAcces("s3")})
           THEN nullif(m.chapitre, '') END,
           json_extract(s.metadonnees, '$.sequence'),
           json_extract(s2.metadonnees, '$.sequence'), '') AS chapitre
       FROM messages m JOIN comptes c ON c.id = m.compte_id
       LEFT JOIN sources s ON s.id = json_extract(m.resultat, '$.affirmations[0].source_id')
         AND ${FILTRE_ACCES}
       LEFT JOIN sources s2 ON s2.id = json_extract(m.journal, '$.candidats[0].source_id')
         AND ${filtreAcces("s2")}
       WHERE c.role = 'eleve' AND (? OR CASE
         WHEN m.cours_id != '' THEN m.cours_id IN (SELECT cours_id FROM membres_cours WHERE compte_id = ?)
         WHEN m.theme_id != '' THEN EXISTS (SELECT 1 FROM themes t JOIN membres_cours mc
           ON mc.cours_id = t.cours_id WHERE t.id = m.theme_id AND mc.compte_id = ?)
         WHEN m.matiere_id != '' THEN EXISTS (SELECT 1 FROM cours co JOIN membres_cours mc
           ON mc.cours_id = co.id WHERE co.matiere_id = m.matiere_id AND mc.compte_id = ?)
         WHEN m.matieres != '' THEN EXISTS (SELECT 1 FROM cours co JOIN membres_cours mc
           ON mc.cours_id = co.id WHERE instr(',' || m.matieres || ',', ',' || co.matiere_id || ',')
           AND mc.compte_id = ?)
         ELSE NOT EXISTS (SELECT 1 FROM membres_cours WHERE compte_id = m.compte_id)
           OR EXISTS (SELECT 1 FROM membres_cours moi JOIN membres_cours lui
             ON lui.cours_id = moi.cours_id WHERE moi.compte_id = ? AND lui.compte_id = m.compte_id)
         END)
       ORDER BY (m.etat = 'out_of_corpus') DESC, (m.avis = 'faux') DESC, m.cree_le DESC`,
      )
      .all(
        ...parametresAcces(l),
        ...parametresAcces(l),
        ...parametresAcces(l),
        l.administrateur ? 1 : 0,
        l.id,
        l.id,
        l.id,
        l.id,
        l.id,
      ) as Prof.QuestionProf[];
    return c.html(rendre(c, "Questions des élèves", Prof.questionsProf(messages)));
  });
  app.get("/prof/lignes", (c) => {
    const f = filtres(c);
    const selection = idsScope(c);
    return c.html(
      Prof.lignesSources(
        lignes(c, f.statut, f.sequence).filter((s) => selection.has(s.id)),
        new URLSearchParams(f).toString(),
        f.vue === "grille",
      ),
    );
  });
  app.post("/prof/sources/statut", async (c) => {
    const b = await c.req.parseBody({ all: true });
    const ids = [b.ids ?? []]
      .flat()
      .map(String)
      .filter((id) => peutModifier(db, c.get("compte"), id));
    if (b.statut === "lecteurs") {
      let lecteurs;
      try {
        lecteurs = audience(b.audience);
      } catch (e) {
        return c.text((e as Error).message, 400);
      }
      for (const id of ids) {
        db.prepare("UPDATE sources SET audience = ? WHERE id = ?").run(lecteurs, id);
      }
    } else {
      const statut = b.statut === "certifiee" ? "certifiee" : "rejetee";
      for (const id of ids) statuer(db, id, statut, c.get("compte").nom);
    }
    return c.redirect(`/prof?${new URLSearchParams(filtres(c))}`, 303);
  });

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

  const detail = (id: string, compte: Compte): Prof.Detail | undefined => {
    const source = db
      .prepare("SELECT * FROM sources WHERE id = ? AND school_id = ?")
      .get(id, instance.school_id) as
      | (Prof.Detail["source"] & {
          metadonnees: string;
          revision: number;
          proprietaire_id: string | null;
        })
      | undefined;
    if (!source || !peutLire(db, compte, id)) return undefined;
    const job = db
      .prepare("SELECT etat, erreur, avertissements FROM ingestion_jobs WHERE source_id = ?")
      .get(id) as { etat: string; erreur: string | null; avertissements: string } | undefined;
    let blocs: Prof.Detail["blocs"] = [];
    try {
      blocs = lireDocument(id, source.revision).blocs;
    } catch {
      /* pas encore extrait */
    }
    const attente = revisionEnAttente(db, id);
    return {
      attente: attente && {
        ...attente,
        avertissements: JSON.parse(attente.avertissements),
        blocs: lireDocument(id, attente.n).blocs,
      },
      source,
      modifiable: peutModifier(db, compte, id),
      // Supprimer efface l'original : les enseignants de ses cours ne le font pas.
      supprimable: compte.administrateur === 1 || source.proprietaire_id === compte.id,
      catalogue: Domaines.catalogueDe(db, compte),
      affiliations: db
        .prepare("SELECT cours_id, theme_id FROM source_cours WHERE source_id = ?")
        .all(id) as Domaines.Affiliation[],
      meta: JSON.parse(source.metadonnees),
      informations: Domaines.champsMatiere(db, source.matiere_id, source.profil ?? "general"),
      libelles: libelles(db),
      job: job && { ...job, avertissements: JSON.parse(job.avertissements) },
      images: db
        .prepare("SELECT * FROM images WHERE source_id = ? ORDER BY position")
        .all(id) as unknown as Prof.ImageVue[],
      blocs,
    };
  };

  app.get("/prof/sources/:id", (c) => {
    const d = detail(c.req.param("id"), c.get("compte"));
    return d ? c.html(rendre(c, d.source.titre, Prof.detailSource(d))) : c.notFound();
  });
  // Un original HTML ne s'ouvre pas: il lancerait ses scripts sur l'origine de Thot.
  const TYPES_ORIGINAL: Record<string, string> = {
    pdf: "application/pdf",
    md: "text/markdown; charset=utf-8",
  };
  app.get("/prof/sources/:id/original", async (c) => {
    const d = detail(c.req.param("id"), c.get("compte"));
    const type = d && TYPES_ORIGINAL[d.source.format];
    if (!d || !type) return c.notFound();
    return c.body(await readFile(contenu(d.source.id, "original", d.source.fichier)), 200, {
      "content-type": type,
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
    });
  });
  app.post("/prof/sources/:id/modifier", async (c) => {
    const d = detail(c.req.param("id"), c.get("compte"));
    if (!d) return c.notFound();
    if (!d.modifiable) return c.text(MODIFICATION_REFUSEE, 403);
    const b = await c.req.parseBody({ all: true });
    const titre = String(b.titre ?? "").trim();
    const sequence = String(b.sequence ?? "").trim();
    const date = String(b.date ?? "").trim();
    const artiste = String(b.artiste ?? "").trim();
    const mouvement = String(b.mouvement ?? "").trim();
    if (
      !titre ||
      titre.length > 200 ||
      sequence.length > 120 ||
      date.length > 40 ||
      artiste.length > 120 ||
      mouvement.length > 120
    ) {
      return c.text("Titre ou séquence invalide.", 400);
    }
    // Enregistrer valide ce que Thot proposait: la proposition n'a plus d'objet.
    let informations: Record<string, string>;
    let langue: string;
    let lecteurs = d.source.audience;
    try {
      langue = Domaines.langueSource(String(b.langue ?? d.source.langue ?? "fr"));
      if (b.audience !== undefined) lecteurs = audience(b.audience);
      // Un champ retiré de la matière garde sa valeur : il n'est ni montré ni validé.
      informations = validerInformations(
        Object.fromEntries(Object.entries({ ...d.meta, ...b }).map(([k, v]) => [k, String(v)])),
        d.informations,
      );
    } catch (e) {
      return c.text((e as Error).message, 400);
    }
    const meta: Record<string, unknown> = { ...d.meta, ...informations, titre, sequence, langue };
    delete meta.propositions;
    delete meta.quiz_reponse;
    try {
      transaction(db, () => {
        if (b.affiliations_presentes) {
          Domaines.affiliations(
            db,
            d.source.id,
            Domaines.liensAutorises(db, c.get("compte"), Domaines.liensFormulaire(b), d.source.id),
          );
        } else if (sequence !== d.meta.sequence) {
          Domaines.rangerLegacy(
            db,
            d.source.id,
            db.prepare("SELECT matiere_id FROM sources WHERE id = ?").get(d.source.id)!
              .matiere_id as string | null,
            sequence,
            c.get("compte"),
          );
        }
        db.prepare(
          `UPDATE sources SET titre = ?, metadonnees = ?, langue = ?, audience = ?, reponses = ?,
           suggestions_le = NULL WHERE id = ? AND school_id = ?`,
        ).run(
          titre,
          JSON.stringify(meta),
          langue,
          lecteurs,
          b.audience === undefined ? d.source.reponses : b.reponses ? 1 : 0,
          d.source.id,
          instance.school_id,
        );
        const statut = db
          .prepare("SELECT statut FROM sources WHERE id = ?")
          .get(d.source.id)!.statut;
        indexerSource(db, d.source.id, statut === "certifiee" ? chunksSource(db, d.source.id) : []);
      });
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_SQLITE_ERROR") throw e;
      return c.text((e as Error).message, 400);
    }
    return c.redirect(`/prof/sources/${d.source.id}`, 303);
  });
  // Hono ne groupe pas l'alternative d'un motif : sans `(?:…)`, ce chemin prendrait toute
  // adresse qui finit par « rejetee », celle d'une révision comprise.
  app.post("/prof/sources/:id/:statut{(?:certifiee|rejetee)}", (c) => {
    const id = c.req.param("id");
    const d = detail(id, c.get("compte"));
    if (!d) return c.notFound();
    if (!d.modifiable) return c.text(MODIFICATION_REFUSEE, 403);
    statuer(db, id, c.req.param("statut") as "certifiee" | "rejetee", c.get("compte").nom);
    return c.html(Prof.statutSource(detail(id, c.get("compte"))!.source));
  });
  app.post("/prof/sources/:id/supprimer", async (c) => {
    const d = detail(c.req.param("id"), c.get("compte"));
    if (!d) return c.notFound();
    if (!d.supprimable) {
      return c.text("Seuls son propriétaire et les administrateurs suppriment cette source.", 403);
    }
    try {
      await supprimerSource(db, d.source.id);
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_SQLITE_ERROR") throw e;
      return c.text((e as Error).message, 409);
    }
    return c.redirect("/prof?supprimee", 303);
  });
  // Certifier la version en attente la fait servir, la rejeter la supprime.
  app.post("/prof/sources/:id/revisions/:n{[0-9]+}/:statut{(?:certifiee|rejetee)}", async (c) => {
    const id = c.req.param("id");
    const d = detail(id, c.get("compte"));
    if (!d) return c.notFound();
    if (!d.modifiable) return c.text(MODIFICATION_REFUSEE, 403);
    const n = Number(c.req.param("n"));
    try {
      if (c.req.param("statut") === "certifiee") {
        statuer(db, id, "certifiee", c.get("compte").nom, n);
      } else await ecarterRevision(db, id, n);
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_SQLITE_ERROR") throw e;
      return c.text((e as Error).message, 409);
    }
    return c.redirect(`/prof/sources/${id}`, 303);
  });

  // La file ne propose que les images des sources que le compte peut relire.
  const FILE = `i.legende_statut = 'unreviewed' AND s.statut != 'rejetee' AND s.school_id = ?
    AND ${filtreModification()}`;
  const file = (c: Context<Env>) => [
    instance.school_id,
    ...parametresModification(c.get("compte")),
  ];
  const aLegender = (c: Context<Env>, imageId?: string) => {
    const restantes = db
      .prepare(`SELECT count(*) n FROM images i JOIN sources s ON s.id = i.source_id WHERE ${FILE}`)
      .get(...file(c))!.n as number;
    const i = db
      .prepare(
        `SELECT i.*, s.titre FROM images i JOIN sources s ON s.id = i.source_id WHERE ${FILE}
       ORDER BY (i.id = ?) DESC, json_extract(s.metadonnees, '$.sequence'), s.titre, i.position LIMIT 1`,
      )
      .get(...file(c), imageId ?? "") as Prof.ALegender | undefined;
    return i && { ...i, restantes };
  };
  // Les douze prochaines images de la file, dans l'ordre où elles seront proposées.
  const fileLegendes = (c: Context<Env>) =>
    db
      .prepare(
        `SELECT i.id, s.titre FROM images i JOIN sources s ON s.id = i.source_id WHERE ${FILE}
       ORDER BY json_extract(s.metadonnees, '$.sequence'), s.titre, i.position LIMIT 12`,
      )
      .all(...file(c)) as { id: string; titre: string }[];
  app.get("/prof/legendes", (c) =>
    c.html(
      rendre(c, "Légendes", Prof.pageLegendes(aLegender(c, c.req.query("image")), fileLegendes(c))),
    ),
  );
  app.post("/prof/legendes/:action{(?:certified|rejected)}", async (c) => {
    const b = await c.req.parseBody();
    const source = db.prepare("SELECT source_id FROM images WHERE id = ?").get(String(b.image))
      ?.source_id as string | undefined;
    if (!source || !peutModifier(db, c.get("compte"), source)) {
      return c.text(MODIFICATION_REFUSEE, 403);
    }
    relireLegende(
      db,
      String(b.image),
      c.req.param("action") as "certified" | "rejected",
      String(b.texte ?? ""),
      c.get("compte").nom,
    );
    return c.html(Prof.legende(aLegender(c), fileLegendes(c)));
  });

  // ------------------------------------------------------------ élève
  type Perimetre = Eleve.Perimetre;
  const sourceCertifiee = (id: string, l: Lecteur) =>
    db
      .prepare(
        `SELECT id, titre, enseignant, profil, matiere_id, langue, metadonnees, revision, coalesce(json_extract(metadonnees, '$.sequence'), '') AS sequence,
         coalesce(json_extract(metadonnees, '$.seance'), '') AS seance,
         coalesce(json_extract(metadonnees, '$.date'), '') AS date
       FROM sources s WHERE id = ? AND statut = 'certifiee' AND school_id = ? AND ${FILTRE_ACCES}`,
      )
      .get(id, instance.school_id, ...parametresAcces(l)) as Eleve.SourceLue | undefined;

  app.get("/eleve", (c) => {
    const rangs = db
      .prepare(
        `SELECT id, titre, profil, coalesce(json_extract(metadonnees, '$.sequence'), '') AS sequence,
         coalesce(json_extract(metadonnees, '$.seance'), '') AS seance,
         coalesce(json_extract(metadonnees, '$.date'), '') AS date,
         ${QUIZ},
         (SELECT id FROM images WHERE source_id = s.id ORDER BY position LIMIT 1) AS image_id
       FROM sources s WHERE statut = 'certifiee' AND school_id = ? AND ${FILTRE_ACCES}
       ORDER BY sequence, seance, titre`,
      )
      .all(instance.school_id, ...parametresAcces(lu(c))) as Eleve.SourceChapitre[];
    const selection = idsScope(c);
    const visibles = rangs.filter((r) => selection.has(r.id));
    const chapitres: Eleve.ChapitreVue[] = [];
    const rattachements = db
      .prepare(
        `SELECT sc.*, c.nom AS cours, t.nom AS theme FROM source_cours sc
      JOIN cours c ON c.id = sc.cours_id LEFT JOIN themes t ON t.id = sc.theme_id
      WHERE ${Domaines.MES_COURS}`,
      )
      .all(...Domaines.mesCours(lu(c)));
    for (const r of visibles) {
      const liens = rattachements.filter((l) => l.source_id === r.id);
      for (const lien of liens.length ? liens : [undefined]) {
        const themeId = lien?.theme_id as string | undefined;
        const coursId = lien?.cours_id as string | undefined;
        const nom = (lien?.theme ?? r.sequence ?? "") as string;
        let ch = chapitres.find(
          (ch) => ch.themeId === themeId && ch.coursId === coursId && ch.nom === nom,
        );
        if (!ch) {
          ch = {
            nom,
            themeId,
            coursId,
            sources: [],
            questions: [],
            cours: lien?.cours as string | undefined,
          };
          chapitres.push(ch);
        }
        ch.sources.push(r);
      }
    }
    for (const ch of chapitres) {
      const ids = Domaines.sourcesPerimetre(db, {
        matiere_id: "",
        cours_id: ch.coursId ?? "",
        theme_id: ch.themeId ?? "",
      });
      ch.questions = ch.coursId
        ? suggestionsDuPerimetre(db, lu(c), ids)
        : (suggestionsParChapitre(db, lu(c)).get(ch.nom) ?? []);
    }
    const prenom = c.get("compte").nom.split(" ")[0];
    const cat = Domaines.catalogueVisible(db, lu(c));
    const filtresDomaines = DomaineVue.filtre(
      cat,
      scope(c),
      "/eleve",
      "",
      c.req.query("vue"),
      libelles(db).regroupement,
    );
    const generique =
      visibles.every((r) => r.profil === "general") || Object.values(scope(c)).some(Boolean);
    const mention = mentionLecteurs(c);
    if (generique) {
      return c.html(
        rendre(
          c,
          "Ressources",
          html`<h1>Ressources</h1>${filtresDomaines}
          <form method="post" action="/eleve/questions" class="question-rapide">
            ${DomaineVue.champsScope(scope(c))}${Eleve.cleEnvoi()}
            <label for="texte">Une question dans ce périmètre ?</label>
            <div class="saisie"><input type="text" id="texte" name="texte" required maxlength="1000"><button>Demander</button></div>
            ${mention ? html`<small>${mention}</small>` : ""}
          </form>
          <ul class="${c.req.query("vue") === "grille" ? "tuiles" : ""}">${visibles.map(
            (r) =>
              html`<li><a class="${
                c.req.query("vue") === "grille" ? "tuile" : ""
              }" href="/eleve/sources/${r.id}">${
                c.req.query("vue") === "grille" && r.image_id
                  ? html`<span class="passe-partout"><img src="/media/${r.image_id}" alt="" loading="lazy"></span>`
                  : ""
              }${r.titre}</a></li>`,
          )}</ul>
          ${!visibles.length ? html`<p>Aucune ressource dans ce périmètre.</p>` : ""}`,
        ),
      );
    }
    // Une vignette de vidéo n'est pas une œuvre: elle reste dans son chapitre, pas dans « Le saviez-vous ».
    const oeuvres = visibles.filter(
      (s) => s.image_id && !/vid[ée]o|\d+ ?mn\b/i.test(`${s.titre} ${s.seance}`),
    );
    const fait = faitAuHasard(db, lu(c));
    const oeuvre =
      (!fait || Math.random() < 0.5) && oeuvres.length
        ? oeuvres[Math.floor(Math.random() * oeuvres.length)]
        : undefined;
    return c.html(
      rendre(
        c,
        "Accueil",
        html`${filtresDomaines}${Eleve.accueilEleve(
          prenom,
          chapitres,
          oeuvre ? undefined : fait,
          oeuvre,
          lireInstance(db).mode === "personal",
          mention,
          libelles(db),
        )}`,
        "accueil",
      ),
    );
  });

  app.on("GET", ["/eleve/sans-sequence", "/eleve/sequences/:nom", "/eleve/themes/:theme"], (c) => {
    const themeId = c.req.param("theme");
    const cat = Domaines.catalogueVisible(db, lu(c));
    const theme = themeId ? cat.themes.find((t) => t.id === themeId) : undefined;
    if (themeId && !theme) return c.notFound();
    const nom = theme?.nom ?? c.req.param("nom") ?? "";
    const cours = cat.cours.find((c) => c.id === theme?.cours_id);
    const matiere = cat.matieres.find((m) => m.id === cours?.matiere_id);
    const sources = db
      .prepare(
        `SELECT s.id, s.titre, s.profil, coalesce(json_extract(s.metadonnees, '$.seance'), '') AS seance,
         coalesce(json_extract(s.metadonnees, '$.date'), '') AS date,
         ${QUIZ},
         (SELECT id FROM images WHERE source_id = s.id ORDER BY position LIMIT 1) AS image_id
       FROM sources s WHERE s.school_id = ? AND s.statut = 'certifiee' AND ${FILTRE_ACCES}
         AND (? OR coalesce(json_extract(s.metadonnees, '$.sequence'), '') = ?)
         AND (? = '' OR EXISTS (SELECT 1 FROM source_cours sc WHERE sc.source_id = s.id AND sc.theme_id = ?))
       ORDER BY seance = '', seance, s.titre`,
      )
      .all(
        instance.school_id,
        ...parametresAcces(lu(c)),
        themeId ? 1 : 0,
        nom,
        themeId ?? "",
        themeId ?? "",
      ) as Eleve.SourceChapitre[];
    if (!sources.length) return c.notFound();
    // Le lecteur s'ouvre sur le document demandé, sinon sur la première œuvre du mur.
    const doc =
      sources.find((s) => s.id === c.req.query("doc")) ??
      sources.find((s) => s.image_id) ??
      sources[0];
    return c.html(
      rendre(
        c,
        nom || "Autres documents",
        Eleve.pageChapitre(
          nom,
          sources,
          themeId
            ? suggestionsDuPerimetre(
                db,
                lu(c),
                Domaines.sourcesPerimetre(db, { matiere_id: "", cours_id: "", theme_id: themeId }),
              )
            : (suggestionsParChapitre(db, lu(c)).get(nom) ?? []),
          apercu(doc.id, lu(c)),
          themeId,
          theme ? `${matiere?.nom} / ${cours?.nom} / ${nom}` : "",
          mentionLecteurs(c),
          libelles(db),
        ),
      ),
    );
  });

  const apercu = (id: string, l: Lecteur): Eleve.Apercu | undefined => {
    const s = db
      .prepare(
        `SELECT id, titre, enseignant, revision, coalesce(json_extract(metadonnees, '$.sequence'), '') AS chapitre,
         coalesce(json_extract(metadonnees, '$.seance'), '') AS seance,
         coalesce(json_extract(metadonnees, '$.date'), '') AS date
       FROM sources s WHERE id = ? AND statut = 'certifiee' AND school_id = ? AND ${FILTRE_ACCES}`,
      )
      .get(id, instance.school_id, ...parametresAcces(l)) as
      | (Omit<Eleve.Apercu, "image_id" | "legende" | "images" | "extrait"> & { revision: number })
      | undefined;
    if (!s) return undefined;
    const images = db
      .prepare(
        `SELECT id, CASE WHEN legende_statut = 'certified' THEN legende END AS legende
       FROM images WHERE source_id = ? ORDER BY position`,
      )
      .all(id) as { id: string; legende: string | null }[];
    let extrait = "";
    try {
      const texte = lireDocument(id, s.revision)
        .blocs.filter(
          (b) =>
            b.texte !== s.titre && b.texte !== b.section && !Eleve.COMPTEUR_DIAPO.test(b.texte),
        )
        .map((b) => b.texte)
        .join(" ");
      extrait = texte.length > 320 ? texte.slice(0, 320).replace(/\s+\S*$/, "") + " …" : texte;
    } catch {
      /* document sans texte extrait */
    }
    return {
      ...s,
      image_id: images[0]?.id ?? null,
      legende: images[0]?.legende ?? null,
      images: images.length,
      extrait,
    };
  };

  app.get("/eleve/documents/:id/apercu", (c) => {
    const a = apercu(c.req.param("id"), lu(c));
    return a ? c.html(Eleve.lecteur(a, libelles(db))) : c.notFound();
  });

  app.get("/eleve/sources/:id", (c) => {
    const s = sourceCertifiee(c.req.param("id"), lu(c));
    if (!s) return c.notFound();
    const images = db
      .prepare(
        `SELECT id, CASE WHEN legende_statut = 'certified' THEN legende END AS legende
       FROM images WHERE source_id = ? ORDER BY position`,
      )
      .all(s.id) as { id: string; legende: string | null }[];
    const debut = Number(c.req.query("debut"));
    const fin = Number(c.req.query("fin"));
    const marque =
      Number.isInteger(debut) && Number.isInteger(fin) && fin > debut
        ? ([debut, fin] as [number, number])
        : undefined;
    // Une ancienne réponse ouvre la révision qu'elle cite. Une révision en attente ne se lit pas.
    const revision = Number(c.req.query("revision") ?? s.revision);
    if (!Number.isInteger(revision) || revision < 1 || revision > s.revision) return c.notFound();
    return c.html(
      rendre(
        c,
        s.titre,
        Eleve.lectureSource(
          s,
          images,
          lireDocument(s.id, revision).blocs.filter((b) => !Eleve.COMPTEUR_DIAPO.test(b.texte)),
          Domaines.champsMatiere(db, s.matiere_id, s.profil ?? "general"),
          libelles(db),
          marque,
          revision < s.revision,
        ),
        "lecture",
      ),
    );
  });

  // Recherche sans rédaction: les documents les plus proches, au-dessus du seuil des réponses.
  // Une légende non relue aide à trouver l'image mais n'est pas montrée.
  app.get("/eleve/recherche", async (c) => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 300);
    if (!q) {
      return c.html(
        rendre(
          c,
          "Chercher",
          html`${DomaineVue.filtre(
            Domaines.catalogueVisible(db, lu(c)),
            scope(c),
            "/eleve/recherche",
            "",
            "",
            libelles(db).regroupement,
          )}${Eleve.recherche("", [], scope(c))}`,
        ),
      );
    }
    const p = {
      schoolId: instance.school_id,
      lecteur: lu(c),
      bibliotheque: true,
      matiereId: scope(c).matiere_id,
      coursId: scope(c).cours_id,
      themeId: scope(c).theme_id,
    };
    const r = await chercher(db, modeles, q, p, config.seuil);
    // ponytail: seuil relatif fixé à l'œil sur quatre recherches. À mesurer sur les familles E et F.
    // Sans reclasseur, l'ordre de FTS5 reste tel quel.
    const proches: Candidat[] = r.panneReclasseur
      ? r.candidats
      : r.candidats
          .filter((x) => x.score! >= Math.max(config.seuil, r.score / 4))
          .sort((a, b) => b.score! - a.score!);
    const ids = [...new Set(proches.map((x) => x.source_id))].slice(0, 12);
    const sources = new Map(
      db
        .prepare(
          `SELECT s.id, s.titre, s.profil, (SELECT theme_id FROM source_cours WHERE source_id = s.id AND theme_id IS NOT NULL LIMIT 1) AS theme_id, coalesce(json_extract(s.metadonnees, '$.sequence'), '') AS sequence,
           coalesce(json_extract(s.metadonnees, '$.date'), '') AS date,
           (SELECT id FROM images WHERE source_id = s.id ORDER BY position LIMIT 1) AS image_id
         FROM sources s WHERE s.id IN (${ids.map(() => "?").join(",")})
           AND s.statut = 'certifiee' AND s.school_id = ? AND ${FILTRE_ACCES}`,
        )
        .all(...ids, instance.school_id, ...parametresAcces(lu(c)))
        .map((s) => [s.id as string, s as unknown as Eleve.Trouve]),
    );
    const trouves = ids
      .filter((id) => sources.has(id))
      .map((id) => {
        const texte = proches
          .find((x) => x.source_id === id)!
          .texte.replace(/\s+/g, " ")
          .trim();
        const s = sources.get(id)!;
        const reste = texte.startsWith(s.titre) ? texte.slice(s.titre.length).trim() : texte;
        return {
          ...s,
          extrait: reste.length > 180 ? reste.slice(0, 180).replace(/\s+\S*$/, "") + " …" : reste,
        };
      });
    return c.html(
      rendre(
        c,
        "Chercher",
        html`${DomaineVue.filtre(
          Domaines.catalogueVisible(db, lu(c)),
          scope(c),
          "/eleve/recherche",
          q,
          "",
          libelles(db).regroupement,
        )}${Eleve.recherche(q, trouves, scope(c))}`,
      ),
    );
  });

  // La relecture d'une réponse revérifie ses preuves avec les droits actuels du lecteur, dans la
  // révision qu'elle cite.
  // ponytail: une révision qui ne sert plus se relit et se redécoupe à chaque affichage. Garder ses
  // chunks en mémoire si le chat ralentit.
  const resultatActuel = (texte: string, l: Lecteur) =>
    actualiserResultat(
      db,
      JSON.parse(texte),
      { schoolId: instance.school_id, lecteur: l },
      (id, n) => chunksSource(db, id, n),
    );

  const messagesDe = (compte: Compte, conversationId: string, nomme: (p: Perimetre) => string) => {
    const lignes = db
      .prepare(
        `SELECT id, question, etat, etape, resultat, avis, chapitre, matiere_id, cours_id, theme_id, matieres
         FROM messages WHERE conversation_id = ? AND compte_id = ? ORDER BY rang`,
      )
      .all(conversationId, compte.id) as (Eleve.MessageVue & Perimetre)[];
    return lignes.map((m, i): Eleve.MessageVue => {
      const vue = {
        ...m,
        perimetre: i && !memePerimetre(lignes[i - 1], m) ? nomme(m) : undefined,
      };
      if (!m.resultat) return vue;
      const r = resultatActuel(m.resultat, lecteur(compte));
      return { ...vue, etat: r.etat, resultat: JSON.stringify(r) };
    });
  };

  const ideesPour = (l: Lecteur, r: Resultat, question = "", messageId = "") => {
    const m = messageId
      ? db
          .prepare("SELECT matiere_id, cours_id, theme_id, matieres FROM messages WHERE id = ?")
          .get(messageId)
      : undefined;
    if (m && Object.values(m).some(Boolean)) {
      return suggestionsDuPerimetre(
        db,
        l,
        Domaines.sourcesPerimetre(db, Domaines.lireScope(m)),
        question,
      );
    }
    // Hors cours: les questions que couvre le chapitre du passage le plus proche, ou du chapitre posé.
    if (r.etat === "out_of_corpus") {
      const m = db
        .prepare(
          `SELECT coalesce(nullif(m.chapitre, ''), json_extract(s.metadonnees, '$.sequence'), '') AS nom
         FROM messages m LEFT JOIN sources s ON s.id = json_extract(m.journal, '$.candidats[0].source_id')
         WHERE m.id = ?`,
        )
        .get(messageId) as { nom: string } | undefined;
      return m?.nom ? (suggestionsParChapitre(db, l).get(m.nom) ?? []).slice(0, 3) : [];
    }
    if (r.etat !== "answered") return [];
    const ids = [...new Set(r.affirmations.map((a) => a.source_id))];
    if (!ids.length) return [];
    const memesSources = db
      .prepare(
        `SELECT sg.question FROM suggestions sg JOIN sources s ON s.id = sg.source_id
       WHERE sg.source_id IN (${ids.map(() => "?").join(",")}) AND s.statut = 'certifiee'
         AND s.school_id = ? AND sg.question != ? AND s.audience = 'eleves' AND s.reponses = 1
         AND ${FILTRE_ACCES}
       ORDER BY random() LIMIT 3`,
      )
      .all(...ids, instance.school_id, question, ...parametresAcces(l))
      .map((x) => x.question as string);
    if (memesSources.length) return memesSources;
    const chapitre = db
      .prepare(
        "SELECT json_extract(metadonnees, '$.sequence') AS nom FROM sources WHERE id = ? AND school_id = ?",
      )
      .get(ids[0], instance.school_id)?.nom as string | undefined;
    return chapitre
      ? (suggestionsParChapitre(db, l).get(chapitre) ?? []).filter((q) => q !== question)
      : [];
  };

  // ------------------------------------------------------------ conversations
  // Une conversation appartient à son compte : un identifiant d'un autre compte reçoit le même 404
  // qu'un identifiant inconnu.
  type Conversation = Perimetre & { id: string; titre: string; archivee_le: string | null };
  const conversationDe = (c: Context<Env>, id: string) =>
    db
      .prepare("SELECT * FROM conversations WHERE id = ? AND compte_id = ?")
      .get(id, c.get("compte").id) as Conversation | undefined;
  /** Une question attend la boucle de réponses, ou sa réponse tourne : une réponse à la fois. */
  const reponseEnCours = (conversationId: string) =>
    !!db
      .prepare(
        "SELECT 1 FROM messages WHERE conversation_id = ? AND etat IN ('en_attente', 'en_cours')",
      )
      .get(conversationId);
  const libelleTheme = () => libelles(db).regroupement;

  /** Pourquoi le compte ne peut pas poser de question dans ce périmètre, sinon rien. */
  const perimetreRefuse = (c: Context<Env>, { chapitre, ...reste }: Perimetre) => {
    const p = Domaines.lireScope(reste);
    const comparees = Domaines.idsMatieres(p.matieres);
    if (comparees.length > MAX_MATIERES) return `Compare ${MAX_MATIERES} matières au plus.`;
    if (Object.values(p).some(Boolean)) {
      const lisibles = db
        .prepare(
          `SELECT id FROM sources s WHERE statut = 'certifiee' AND school_id = ? AND ${FILTRE_ACCES}`,
        )
        .all(instance.school_id, ...parametresAcces(lu(c)));
      const visible = (q: Domaines.Scope) => {
        const disponibles = Domaines.sourcesPerimetre(db, q);
        return lisibles.some((s) => disponibles.has(s.id as string));
      };
      // Chaque matière comparée offre une source lisible, comme une matière seule.
      const matieres = comparees.map((m) => ({ matiere_id: m, cours_id: "", theme_id: "" }));
      if (![p, ...matieres].every(visible)) return "Périmètre indisponible.";
      // Un élève ne pose une question dans un cours que s'il en est membre.
      const coursId =
        p.cours_id ||
        String(
          db.prepare("SELECT cours_id FROM themes WHERE id = ?").get(p.theme_id)?.cours_id ?? "",
        );
      if (
        (p.cours_id || p.theme_id) &&
        !lu(c).administrateur &&
        !Domaines.coursDuCompte(db, lu(c).id).has(coursId)
      )
        return "Périmètre indisponible.";
    }
    if (
      chapitre &&
      !db
        .prepare(
          `SELECT id FROM sources s WHERE school_id = ? AND statut = 'certifiee'
           AND json_extract(metadonnees, '$.sequence') = ? AND ${FILTRE_ACCES}
         LIMIT 1`,
        )
        .get(instance.school_id, chapitre, ...parametresAcces(lu(c)))
    )
      return "Séquence indisponible.";
  };

  // L'état du dernier échange, et une réponse terminée que l'élève n'a pas encore ouverte.
  const ETAT_CONVERSATION = `(SELECT etat FROM messages WHERE conversation_id = v.id ORDER BY rang DESC LIMIT 1) AS etat,
    EXISTS (SELECT 1 FROM messages WHERE conversation_id = v.id AND nouvelle) AS nouvelle`;
  const conversations = (c: Context<Env>, archivees: boolean, toutes: boolean) => {
    const cat = Domaines.catalogueVisible(db, lu(c));
    const theme = libelleTheme();
    const lignes = db
      .prepare(
        `SELECT id, titre, chapitre, matiere_id, cours_id, theme_id, matieres, active_le, ${ETAT_CONVERSATION}
         FROM conversations v WHERE compte_id = ? AND (archivee_le IS NOT NULL) = ?
         ORDER BY active_le DESC, rowid DESC LIMIT ?`,
      )
      .all(c.get("compte").id, archivees ? 1 : 0, toutes ? -1 : 51) as (Eleve.ConversationVue &
      Perimetre)[];
    return {
      liste: (toutes ? lignes : lignes.slice(0, 50)).map((l) => ({
        ...l,
        perimetre: Eleve.nomPerimetre(cat, l, theme),
      })),
      plus: !toutes && lignes.length > 50,
    };
  };
  const nombreArchivees = (c: Context<Env>) =>
    db
      .prepare(
        "SELECT count(*) AS n FROM conversations WHERE compte_id = ? AND archivee_le IS NOT NULL",
      )
      .get(c.get("compte").id)!.n as number;

  const pageChat = (c: Context<Env>, conv?: Conversation) => {
    const compte = c.get("compte");
    if (conv) db.prepare("UPDATE messages SET nouvelle = 0 WHERE conversation_id = ?").run(conv.id);
    const cat = Domaines.catalogueVisible(db, lu(c));
    const theme = libelleTheme();
    // Une nouvelle conversation part du périmètre choisi, sinon de celui de la dernière.
    const p: Perimetre = conv ??
      (Object.hasOwn(c.req.query(), "matiere_id") || Object.hasOwn(c.req.query(), "matieres")
        ? { ...scope(c), chapitre: "" }
        : (db
            .prepare(
              `SELECT chapitre, matiere_id, cours_id, theme_id, matieres FROM conversations
               WHERE compte_id = ? ORDER BY active_le DESC, rowid DESC LIMIT 1`,
            )
            .get(compte.id) as Perimetre | undefined)) ?? {
        chapitre: "",
        matiere_id: "",
        cours_id: "",
        theme_id: "",
      };
    const messages = conv
      ? messagesDe(compte, conv.id, (m) => Eleve.nomPerimetre(cat, m, theme))
      : [];
    const dernier = messages.findLast((m) => m.resultat);
    const { liste, plus } = conversations(c, false, false);
    return c.html(
      rendre(
        c,
        conv?.titre ?? "Nouvelle conversation",
        Eleve.chat({
          compte: compte.id,
          conversation: conv && { id: conv.id, titre: conv.titre, archivee: !!conv.archivee_le },
          messages,
          idees: !conv
            ? suggestionsDuPerimetre(
                db,
                lu(c),
                Domaines.sourcesPerimetre(db, Domaines.lireScope(p)),
              )
            : dernier
              ? ideesPour(lu(c), JSON.parse(dernier.resultat!), dernier.question, dernier.id)
              : [],
          liste,
          archivees: nombreArchivees(c),
          suite: plus ? "/eleve/conversations?toutes=1" : "",
          perimetre: {
            chapitre: p.chapitre,
            matiere_id: p.matiere_id,
            cours_id: p.cours_id,
            theme_id: p.theme_id,
            matieres: p.matieres ?? "",
          },
          catalogue: cat,
          theme,
          indisponible: !!perimetreRefuse(c, p),
          statut: c.req.query("archivee") ? "Conversation archivée." : undefined,
          personnel: lireInstance(db).mode === "personal",
          mention: mentionLecteurs(c),
        }),
        "page-chat",
      ),
    );
  };

  app.get("/eleve/chat", (c) => {
    const id = db
      .prepare(
        `SELECT id FROM conversations WHERE compte_id = ? AND archivee_le IS NULL
         ORDER BY active_le DESC, rowid DESC LIMIT 1`,
      )
      .get(c.get("compte").id)?.id as string | undefined;
    return pageChat(c, id ? conversationDe(c, id) : undefined);
  });
  app.get("/eleve/chat/nouvelle", (c) => pageChat(c));
  app.get("/eleve/chat/:id", (c) => {
    const conv = conversationDe(c, c.req.param("id"));
    return conv ? pageChat(c, conv) : c.notFound();
  });
  app.on("GET", ["/eleve/conversations", "/eleve/conversations/archivees"], (c) => {
    const archive = c.req.path.endsWith("/archivees");
    const { liste, plus } = conversations(c, archive, c.req.query("toutes") === "1");
    return c.html(
      rendre(
        c,
        archive ? "Conversations archivées" : "Conversations",
        Eleve.pageConversations(
          archive,
          liste,
          archive ? 0 : nombreArchivees(c),
          plus ? `${c.req.path}?toutes=1` : "",
        ),
      ),
    );
  });
  // La liste suit une réponse qui tourne dans une autre conversation, sans toucher au focus.
  app.get("/eleve/conversations/:id/etat", (c) => {
    const conv = db
      .prepare(
        `SELECT id, ${ETAT_CONVERSATION} FROM conversations v WHERE id = ? AND compte_id = ?`,
      )
      .get(c.req.param("id"), c.get("compte").id) as Eleve.ConversationVue | undefined;
    return conv
      ? c.html(Eleve.statutConversation(conv, c.req.query("ouverte") === "1"))
      : c.notFound();
  });
  // Le dernier titre enregistré l'emporte : un titre ne justifie pas un conflit.
  app.post("/eleve/chat/:id/renommer", async (c) => {
    const titre = String((await c.req.parseBody()).titre ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!titre || titre.length > 120) return c.text("Titre attendu : 1 à 120 caractères.", 400);
    const r = db
      .prepare("UPDATE conversations SET titre = ? WHERE id = ? AND compte_id = ?")
      .run(titre, c.req.param("id"), c.get("compte").id);
    return r.changes ? c.redirect(`/eleve/chat/${c.req.param("id")}`, 303) : c.notFound();
  });
  // Archiver ouvre la conversation la plus récente qui reste, ou une nouvelle.
  app.post("/eleve/chat/:id/:action{(?:archiver|desarchiver)}", (c) => {
    const archiver = c.req.param("action") === "archiver";
    const r = db
      .prepare("UPDATE conversations SET archivee_le = ? WHERE id = ? AND compte_id = ?")
      .run(archiver ? maintenant() : null, c.req.param("id"), c.get("compte").id);
    if (!r.changes) return c.notFound();
    return c.redirect(
      archiver ? "/eleve/chat?archivee=1" : `/eleve/chat/${c.req.param("id")}`,
      303,
    );
  });
  // Le nouveau périmètre vaut pour les questions suivantes. Les échanges passés gardent le leur.
  app.post("/eleve/chat/:id/perimetre", async (c) => {
    const conv = conversationDe(c, c.req.param("id"));
    if (!conv) return c.notFound();
    if (conv.archivee_le) return c.text("Cette conversation est archivée.", 409);
    const b = await c.req.parseBody({ all: true });
    // Le formulaire de comparaison n'envoie que ses cases : vide, il ne vaut pas « tout ».
    if (!Object.hasOwn(b, "matiere_id") && !Object.hasOwn(b, "matieres")) {
      return c.text("Coche les matières à comparer.", 400);
    }
    const p = { ...Domaines.lireScope(b), chapitre: "" };
    const refus = perimetreRefuse(c, p);
    if (refus) return c.text(refus, 400);
    db.prepare(
      "UPDATE conversations SET chapitre = '', matiere_id = ?, cours_id = ?, theme_id = ?, matieres = ? WHERE id = ?",
    ).run(p.matiere_id, p.cours_id, p.theme_id, p.matieres ?? "", conv.id);
    return c.redirect(`/eleve/chat/${conv.id}`, 303);
  });

  /**
   * Sans conversation, la question en ouvre une avec le périmètre de la page d'où elle part.
   * Avec une conversation, elle prend son périmètre actuel, revérifié à chaque envoi.
   */
  app.post("/eleve/questions", async (c) => {
    const b = await c.req.parseBody();
    const texte = String(b.texte ?? "")
      .trim()
      .slice(0, 1000);
    if (!texte) return c.text("Question vide.", 400);
    const compte = c.get("compte");
    const cle = String(b.cle ?? "").slice(0, 100) || null;
    // Hors HTMX (accueil, idée proposée, première question), la conversation s'ouvre et le flux
    // démarre là-bas.
    const envoye = (conversationId: string, id: string, question: string) =>
      !c.req.header("HX-Request") || c.req.header("HX-Boosted")
        ? c.redirect(`/eleve/chat/${conversationId}`, 303)
        : c.html(html`
            ${Eleve.question(question)}${Eleve.attente(id)}
          `);
    const deja = cle
      ? (db
          .prepare(
            "SELECT id, conversation_id, question FROM messages WHERE compte_id = ? AND cle = ?",
          )
          .get(compte.id, cle) as
          | { id: string; conversation_id: string; question: string }
          | undefined)
      : undefined;
    if (deja) return envoye(deja.conversation_id, deja.id, deja.question);
    let conv: Conversation | undefined;
    if (b.conversation) {
      conv = conversationDe(c, String(b.conversation));
      if (!conv) return c.notFound();
      if (conv.archivee_le) {
        return c.text(
          "Cette conversation a été archivée dans un autre onglet. Ta question est conservée.",
          409,
        );
      }
      if (reponseEnCours(conv.id)) {
        return c.text("Une réponse est déjà en cours dans cette conversation.", 409);
      }
    }
    const p: Perimetre = conv ?? { ...Domaines.lireScope(b), chapitre: String(b.chapitre ?? "") };
    const refus = perimetreRefuse(c, p);
    if (refus) return c.text(refus, 400);
    const id = crypto.randomUUID();
    const conversationId = conv?.id ?? crypto.randomUUID();
    const t = maintenant();
    transaction(db, () => {
      if (conv) {
        db.prepare("UPDATE conversations SET active_le = ? WHERE id = ?").run(t, conv.id);
      } else {
        // Le titre reprend la question, coupée à 80 caractères sur une fin de mot.
        const ligne = texte.replace(/\s+/g, " ");
        const titre =
          ligne.length > 80
            ? ligne
                .slice(0, 81)
                .replace(/\s+\S*$/, "")
                .slice(0, 80)
            : ligne;
        db.prepare(
          `INSERT INTO conversations (id, compte_id, titre, chapitre, matiere_id, cours_id, theme_id,
           matieres, active_le, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          conversationId,
          compte.id,
          titre,
          p.chapitre,
          p.matiere_id,
          p.cours_id,
          p.theme_id,
          p.matieres ?? "",
          t,
          t,
        );
      }
      // Le journal garde l'heure de la demande : la boucle en tire le temps d'attente.
      db.prepare(
        `INSERT INTO messages (id, compte_id, conversation_id, rang, cle, question, chapitre,
         matiere_id, cours_id, theme_id, matieres, etat, journal, cree_le, maj_le)
         VALUES (?, ?, ?, (SELECT coalesce(max(rang), 0) + 1 FROM messages WHERE conversation_id = ?),
         ?, ?, ?, ?, ?, ?, ?, 'en_attente', json_object('demande_ms', ?), ?, ?)`,
      ).run(
        id,
        compte.id,
        conversationId,
        conversationId,
        cle,
        texte,
        p.chapitre,
        p.matiere_id,
        p.cours_id,
        p.theme_id,
        p.matieres ?? "",
        Date.now(),
        t,
        t,
      );
    });
    reponses.reveiller();
    return envoye(conversationId, id, texte);
  });

  app.post("/eleve/messages/:id/relancer", (c) => {
    const m = db
      .prepare(
        `SELECT m.etat, m.resultat, m.conversation_id, v.archivee_le FROM messages m
         LEFT JOIN conversations v ON v.id = m.conversation_id WHERE m.id = ? AND m.compte_id = ?`,
      )
      .get(c.req.param("id"), c.get("compte").id);
    if (
      !m ||
      (m.etat !== "failed" &&
        (!m.resultat || resultatActuel(m.resultat as string, lu(c)).etat !== "failed"))
    )
      return c.notFound();
    if (m.archivee_le) return c.text("Cette conversation est archivée.", 409);
    if (reponseEnCours(m.conversation_id as string)) {
      return c.text("Une réponse est déjà en cours dans cette conversation.", 409);
    }
    const r = db
      .prepare(
        `UPDATE messages SET etat = 'en_attente', resultat = NULL, generation_id = NULL,
         tentatives = 0, journal = json_object('demande_ms', ?), maj_le = ?
         WHERE id = ? AND compte_id = ? AND etat IN ('failed', 'answered', 'annule')`,
      )
      .run(Date.now(), maintenant(), c.req.param("id"), c.get("compte").id);
    if (!r.changes) return c.notFound();
    reponses.reveiller();
    return c.html(Eleve.attente(c.req.param("id")));
  });

  // « Arrêter » : la question reste, sa réponse ne sera pas publiée et peut se relancer.
  app.post("/eleve/messages/:id/arreter", (c) => {
    const id = c.req.param("id");
    const compte = c.get("compte");
    const r = db
      .prepare(
        `UPDATE messages SET etat = 'annule', resultat = ?, etape = NULL, verrou_expire_le = NULL,
         generation_id = NULL, maj_le = ?
         WHERE id = ? AND compte_id = ? AND etat IN ('en_attente', 'en_cours')`,
      )
      .run(JSON.stringify(ARRETEE), maintenant(), id, compte.id);
    if (r.changes) reponses.annuler(id);
    // Une réponse publiée juste avant l'arrêt s'affiche telle quelle.
    const m = db
      .prepare("SELECT resultat, avis FROM messages WHERE id = ? AND compte_id = ?")
      .get(id, compte.id) as { resultat: string | null; avis: string | null } | undefined;
    return m?.resultat
      ? c.html(Eleve.reponse(id, resultatActuel(m.resultat, lu(c)), m.avis))
      : c.notFound();
  });

  /**
   * Le flux lit l'état enregistré : l'étape annoncée, puis la réponse. Le fermer n'arrête ni ne
   * relance le calcul, et une reconnexion repart de l'état actuel.
   */
  app.get("/eleve/messages/:id/flux", (c) => {
    const id = c.req.param("id");
    const compte = c.get("compte");
    return streamSSE(c, async (flux) => {
      let annoncee = "";
      // Au bout de dix minutes, le flux se ferme et le navigateur se reconnecte.
      for (let i = 0; i < 600 && !flux.aborted; i++) {
        const m = db
          .prepare("SELECT question, etape, resultat FROM messages WHERE id = ? AND compte_id = ?")
          .get(id, compte.id) as
          | { question: string; etape: string | null; resultat: string | null }
          | undefined;
        if (!m) return;
        if (m.resultat) {
          db.prepare("UPDATE messages SET nouvelle = 0 WHERE id = ?").run(id);
          const r = resultatActuel(m.resultat, lecteur(compte));
          await flux.writeSSE({
            event: "reponse",
            data: String(
              await Eleve.reponse(id, r, null, ideesPour(lecteur(compte), r, m.question, id), true),
            ).replace(/\n/g, " "),
          });
          return;
        }
        const etape = m.etape ?? "En attente";
        if (etape !== annoncee) {
          await flux.writeSSE({ event: "etape", data: etape });
          annoncee = etape;
        }
        await attendreChangement(id, 1000);
      }
    });
  });

  app.post("/eleve/messages/:id/avis", async (c) => {
    const avis = String((await c.req.parseBody()).avis ?? "");
    if (!["utile", "confus", "faux"].includes(avis)) return c.text("Avis invalide.", 400);
    const r = db
      .prepare("UPDATE messages SET avis = ? WHERE id = ? AND compte_id = ? AND etat = 'answered'")
      .run(avis, c.req.param("id"), c.get("compte").id);
    return r.changes ? c.html(Eleve.avis(c.req.param("id"), avis)) : c.notFound();
  });

  app.get("/eleve/messages/:id/citations/:n", (c) => {
    const m = db
      .prepare("SELECT resultat FROM messages WHERE id = ? AND compte_id = ?")
      .get(c.req.param("id"), c.get("compte").id) as { resultat: string | null } | undefined;
    const r = m?.resultat ? resultatActuel(m.resultat, lu(c)) : undefined;
    const a: Affirmation | undefined =
      r?.etat === "answered" ? r.affirmations[Number(c.req.param("n"))] : undefined;
    const source = a && sourceCertifiee(a.source_id, lu(c));
    if (!a || !source) return c.html(Eleve.panneauSource());
    const suite = {
      id: c.req.param("id"),
      n: Number(c.req.param("n")),
      total: r?.etat === "answered" ? r.affirmations.length : 0,
    };
    if (a.debut === undefined || a.fin === undefined) {
      return c.html(Eleve.panneauSource({ ...a, enseignant: source.enseignant }, suite));
    }
    const revision = a.revision ?? 1;
    const texte = lireDocument(a.source_id, revision).texte;
    return c.html(
      Eleve.panneauSource(
        {
          ...a,
          revision,
          enseignant: source.enseignant,
          ...contexte(texte, a.debut, a.fin),
        },
        suite,
      ),
    );
  });

  app.onError((e, c) => {
    if (e instanceof HTTPException) return e.getResponse();
    console.error(e);
    return c.text("Erreur interne.", 500);
  });

  return app;
}
