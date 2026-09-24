import { Hono } from "hono";
import { html } from "hono/html";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { serveStatic } from "hono/deno";
import { streamSSE } from "hono/streaming";
import type { Modeles } from "../core/modeles.ts";
import { type Affirmation, demander, type Resultat } from "../core/reponse.ts";
import { contexte } from "../core/texte.ts";
import {
  authentifier,
  type Compte,
  importerEleves,
  lireCompte,
  reinitialiserMotDePasse,
  secretSession,
} from "./comptes.ts";
import { config, contenu } from "./config.ts";
import { type Db, maintenant } from "./db.ts";
import { controlerFichier, deposer, valider } from "./depot.ts";
import { indexer, lireDocument, relireLegende, statuer } from "./ingestion.ts";
import { faitAuHasard, suggestionsParChapitre } from "./suggestions.ts";
import * as V from "./vues.ts";

type Env = { Variables: { compte: Compte } };

const SESSION = "thot_session";
const PERIMETRE_MS = 3 * 60_000;

export function creerApp(db: Db, modeles: Modeles) {
  const app = new Hono<Env>();
  const secret = secretSession();

  app.use("/static/*", serveStatic({ root: "./" }));
  app.use("*", csrf());

  // Session: un cookie signé qui porte l'identifiant du compte, relu en base à chaque requête.
  app.use("*", async (c, next) => {
    const id = await getSignedCookie(c, secret, SESSION);
    const [compteId, version] = typeof id === "string" ? id.split(":") : [];
    const trouve = compteId ? lireCompte(db, compteId) : undefined;
    const compte = trouve && String(trouve.session_version) === version ? trouve : undefined;
    if (compte) c.set("compte", compte);
    const p = c.req.path;
    if (!p.startsWith("/static/") && !p.startsWith("/media/")) {
      c.header("Cache-Control", "no-store");
    }
    if (p === "/connexion" || p.startsWith("/static/")) return next();
    if (!compte) return c.redirect("/connexion");
    if (p.startsWith("/prof") && compte.role !== "enseignant") {
      return c.text("Accès réservé aux enseignants.", 403);
    }
    return next();
  });

  const rendre = (
    c: { get(k: "compte"): Compte; req: { path: string } },
    titre: string,
    corps: unknown,
    classe = "",
  ) => V.page(titre, c.get("compte") ?? null, corps, classe, c.req.path);

  // ------------------------------------------------------------ connexion
  app.get("/connexion", (c) => c.html(V.page("Connexion", null, V.connexion())));
  app.post("/connexion", async (c) => {
    const b = await c.req.parseBody();
    const compte = await authentifier(
      db,
      String(b.identifiant ?? ""),
      String(b.mot_de_passe ?? ""),
    );
    if (!compte) {
      return c.html(
        V.page(
          "Connexion",
          null,
          V.connexion("Identifiant ou mot de passe incorrect.", String(b.identifiant ?? "")),
        ),
        401,
      );
    }
    await setSignedCookie(c, SESSION, `${compte.id}:${compte.session_version}`, secret, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 12 * 3600,
      // Derrière un proxy (Coolify, Traefik), le TLS s'arrête avant l'application.
      secure: new URL(c.req.url).protocol === "https:" ||
        c.req.header("x-forwarded-proto") === "https",
    });
    return c.redirect("/");
  });
  app.post("/deconnexion", (c) => {
    // Invalide aussi les cookies copiés ou restés sur un autre appareil.
    db.prepare("UPDATE comptes SET session_version = session_version + 1 WHERE id = ?")
      .run(c.get("compte").id);
    deleteCookie(c, SESSION, { path: "/" });
    return c.redirect("/connexion");
  });
  app.get("/", (c) => c.redirect(c.get("compte").role === "enseignant" ? "/prof" : "/eleve"));

  // ------------------------------------------------------------ images
  app.get("/media/:id", async (c) => {
    const i = db.prepare(
      `SELECT i.fichier, i.mime, i.source_id, s.statut,
         EXISTS (SELECT 1 FROM json_each(s.metadonnees, '$.publics') WHERE value = 'eleves') AS visible
       FROM images i JOIN sources s ON s.id = i.source_id WHERE i.id = ? AND s.school_id = ?`,
    ).get(c.req.param("id"), config.schoolId) as
      | { fichier: string; mime: string; source_id: string; statut: string; visible: number }
      | undefined;
    if (
      !i || (c.get("compte").role !== "enseignant" &&
        (i.statut !== "certifiee" || !i.visible))
    ) {
      return c.notFound();
    }
    const octets = await Deno.readFile(contenu(i.source_id, "assets", i.fichier));
    return c.body(octets, 200, {
      "content-type": i.mime,
      "cache-control": "private, max-age=3600",
    });
  });

  // ------------------------------------------------------------ enseignant
  const lignes = (statut: string, chapitre: string) =>
    db.prepare(
      `SELECT s.id, s.titre, json_extract(s.metadonnees, '$.sequence') AS sequence, s.format, s.statut,
         j.etat, j.erreur,
         (SELECT count(*) FROM images i WHERE i.source_id = s.id AND i.legende_statut = 'unreviewed') AS images_a_relire
       FROM sources s JOIN ingestion_jobs j ON j.source_id = s.id
       WHERE s.school_id = ? AND (? = '' OR s.statut = ?) AND (? = '' OR sequence = ?)
       ORDER BY sequence, s.titre`,
    ).all(config.schoolId, statut, statut, chapitre, chapitre) as unknown as V.LigneSource[];
  const filtres = (c: { req: { query(k: string): string | undefined } }) => ({
    statut: c.req.query("statut") ?? "",
    chapitre: c.req.query("chapitre") ?? "",
  });

  app.get("/prof", (c) => {
    const f = filtres(c);
    const repartition = db.prepare(
      `SELECT coalesce(json_extract(metadonnees, '$.sequence'), '') AS chapitre, statut, count(*) AS n
       FROM sources WHERE school_id = ? GROUP BY 1, 2`,
    ).all(config.schoolId) as { chapitre: string; statut: string; n: number }[];
    return c.html(
      rendre(c, "Sources", V.sources(lignes(f.statut, f.chapitre), f, repartition)),
    );
  });
  app.get("/prof/eleves", (c) => {
    const eleves = db.prepare(
      "SELECT id, identifiant, nom FROM comptes WHERE role = 'eleve' ORDER BY nom",
    )
      .all() as { id: string; identifiant: string; nom: string }[];
    return c.html(rendre(c, "Élèves", V.eleves(eleves)));
  });
  app.post("/prof/eleves/importer", async (c) => {
    const fichier = (await c.req.parseBody()).fichier;
    if (!(fichier instanceof File) || fichier.size > 100_000) {
      return c.text("Fichier CSV invalide (100 Ko maximum).", 400);
    }
    try {
      const comptes = await importerEleves(db, await fichier.text());
      c.header("Cache-Control", "no-store");
      return c.html(
        rendre(c, "Identifiants élèves", V.feuilleIdentifiants(comptes, new URL(c.req.url).origin)),
      );
    } catch (e) {
      return c.html(rendre(c, "Élèves", V.eleves([], (e as Error).message)), 400);
    }
  });
  app.post("/prof/eleves/:id/reinitialiser", async (c) => {
    const id = c.req.param("id");
    const eleve = db.prepare("SELECT identifiant, nom FROM comptes WHERE id = ? AND role = 'eleve'")
      .get(id) as { identifiant: string; nom: string } | undefined;
    if (!eleve) return c.notFound();
    const motDePasse = await reinitialiserMotDePasse(db, id);
    c.header("Cache-Control", "no-store");
    return c.html(
      rendre(
        c,
        "Nouveau mot de passe",
        V.feuilleIdentifiants([{ ...eleve, motDePasse: motDePasse! }], new URL(c.req.url).origin),
      ),
    );
  });
  app.get("/prof/questions", (c) => {
    const messages = db.prepare(
      `SELECT m.id, m.question, m.etat, m.avis, m.cree_le, c.nom,
         json_extract(m.resultat, '$.code') AS code,
         coalesce(nullif(m.chapitre, ''), json_extract(s.metadonnees, '$.sequence'),
           json_extract(s2.metadonnees, '$.sequence'), '') AS chapitre
       FROM messages m JOIN comptes c ON c.id = m.compte_id
       LEFT JOIN sources s ON s.id = json_extract(m.resultat, '$.affirmations[0].source_id')
       LEFT JOIN sources s2 ON s2.id = json_extract(m.journal, '$.candidats[0].source_id')
       WHERE c.role = 'eleve'
       ORDER BY (m.etat = 'out_of_corpus') DESC, (m.avis = 'faux') DESC, m.cree_le DESC`,
    ).all() as V.QuestionProf[];
    return c.html(rendre(c, "Questions des élèves", V.questionsProf(messages)));
  });
  app.get("/prof/lignes", (c) => {
    const f = filtres(c);
    return c.html(V.lignesSources(lignes(f.statut, f.chapitre), new URLSearchParams(f).toString()));
  });
  app.post("/prof/sources/statut", async (c) => {
    const b = await c.req.parseBody({ all: true });
    const statut = b.statut === "certifiee" ? "certifiee" : "rejetee";
    const ids = [b.ids ?? []].flat().map(String);
    for (const id of ids) statuer(db, id, statut, c.get("compte").nom);
    return c.redirect(`/prof?${new URLSearchParams(filtres(c))}`, 303);
  });

  app.get("/prof/depot", (c) => c.html(rendre(c, "Déposer", V.depot({}))));
  app.post("/prof/depot", async (c) => {
    const b = await c.req.parseBody({ all: true });
    const champs = Object.fromEntries(
      Object.entries(b).filter(([k, v]) =>
        k !== "fichier" && k !== "publics" && typeof v === "string"
      ),
    ) as Record<string, string>;
    const publics = [b.publics ?? []].flat().map(String);
    const refus = (erreurs: Record<string, string>) =>
      c.html(rendre(c, "Déposer", V.depot({ champs, publics, erreurs })), 400);

    const v = valider(champs, publics);
    const fichier = b.fichier;
    const octets = fichier instanceof File
      ? new Uint8Array(await fichier.arrayBuffer())
      : new Uint8Array();
    const controle = controlerFichier(octets);
    const erreurs = {
      ...("erreurs" in v ? v.erreurs : {}),
      ...("erreur" in controle ? { fichier: controle.erreur } : {}),
    };
    if ("erreurs" in v || "erreur" in controle) return refus(erreurs);

    await deposer(db, {
      meta: v.meta,
      nomFichier: (fichier as File).name,
      octets,
      format: controle.format,
      schoolId: config.schoolId,
      enseignant: c.get("compte").nom,
    });
    return c.html(
      rendre(
        c,
        "Déposer",
        V.depot({
          ok:
            `« ${v.meta.titre} » est déposé. Son extraction a commencé, il apparaît dans les sources.`,
        }),
      ),
    );
  });

  const detail = (id: string): V.Detail | undefined => {
    const source = db.prepare("SELECT * FROM sources WHERE id = ? AND school_id = ?").get(
      id,
      config.schoolId,
    ) as
      | V.Detail["source"] & { metadonnees: string }
      | undefined;
    if (!source) return undefined;
    const job = db.prepare(
      "SELECT etat, erreur, avertissements FROM ingestion_jobs WHERE source_id = ?",
    ).get(id) as
      | { etat: string; erreur: string | null; avertissements: string }
      | undefined;
    let blocs: V.Detail["blocs"] = [];
    try {
      blocs = lireDocument(id).blocs;
    } catch { /* pas encore extrait */ }
    return {
      source,
      meta: JSON.parse(source.metadonnees),
      job: job && { ...job, avertissements: JSON.parse(job.avertissements) },
      images: db.prepare("SELECT * FROM images WHERE source_id = ? ORDER BY position").all(
        id,
      ) as unknown as V.ImageVue[],
      blocs,
    };
  };

  app.get("/prof/sources/:id", (c) => {
    const d = detail(c.req.param("id"));
    return d ? c.html(rendre(c, d.source.titre, V.detailSource(d))) : c.notFound();
  });
  app.post("/prof/sources/:id/modifier", async (c) => {
    const d = detail(c.req.param("id"));
    if (!d) return c.notFound();
    const b = await c.req.parseBody();
    const titre = String(b.titre ?? "").trim();
    const sequence = String(b.sequence ?? "").trim();
    const date = String(b.date ?? "").trim();
    const quiz = String(b.quiz_reponse ?? "").trim();
    if (
      !titre || titre.length > 200 || sequence.length > 120 || date.length > 40 || quiz.length > 120
    ) {
      return c.text("Titre ou chapitre invalide.", 400);
    }
    const meta = { ...d.meta, titre, sequence, date, quiz_reponse: quiz };
    db.prepare(
      "UPDATE sources SET titre = ?, metadonnees = ?, suggestions_le = NULL WHERE id = ? AND school_id = ?",
    )
      .run(titre, JSON.stringify(meta), d.source.id, config.schoolId);
    if (d.source.statut === "certifiee") indexer(db, d.source.id);
    return c.redirect(`/prof/sources/${d.source.id}`, 303);
  });
  app.post("/prof/sources/:id/:statut{certifiee|rejetee}", (c) => {
    const id = c.req.param("id");
    if (!detail(id)) return c.notFound();
    statuer(db, id, c.req.param("statut") as "certifiee" | "rejetee", c.get("compte").nom);
    return c.html(V.statutSource(detail(id)!.source));
  });

  const aLegender = (imageId?: string) => {
    const restantes = db.prepare(
      `SELECT count(*) n FROM images i JOIN sources s ON s.id = i.source_id
       WHERE i.legende_statut = 'unreviewed' AND s.statut != 'rejetee' AND s.school_id = ?`,
    ).get(config.schoolId)!.n as number;
    const i = db.prepare(
      `SELECT i.*, s.titre FROM images i JOIN sources s ON s.id = i.source_id
       WHERE i.legende_statut = 'unreviewed' AND s.statut != 'rejetee' AND s.school_id = ?
       ORDER BY (i.id = ?) DESC, json_extract(s.metadonnees, '$.sequence'), s.titre, i.position LIMIT 1`,
    ).get(config.schoolId, imageId ?? "") as V.ALegender | undefined;
    return i && { ...i, restantes };
  };
  // Les douze prochaines images de la file, dans l'ordre où elles seront proposées.
  const fileLegendes = () =>
    db.prepare(
      `SELECT i.id, s.titre FROM images i JOIN sources s ON s.id = i.source_id
       WHERE i.legende_statut = 'unreviewed' AND s.statut != 'rejetee' AND s.school_id = ?
       ORDER BY json_extract(s.metadonnees, '$.sequence'), s.titre, i.position LIMIT 12`,
    ).all(config.schoolId) as { id: string; titre: string }[];
  app.get("/prof/legendes", (c) =>
    c.html(rendre(
      c,
      "Légendes",
      html`
        <h1>Relire les légendes</h1>
        <p class="raccourcis discret">
          <kbd>V</kbd> valider, <kbd>E</kbd> éditer, <kbd>R</kbd> rejeter, <kbd>↑</kbd> <kbd
          >↓</kbd> image précédente ou suivante
        </p>
        ${V.legende(aLegender(c.req.query("image")), fileLegendes())}${V.raccourciEdition}
      `,
    )));
  app.post("/prof/legendes/:action{certified|rejected}", async (c) => {
    const b = await c.req.parseBody();
    relireLegende(
      db,
      String(b.image),
      c.req.param("action") as "certified" | "rejected",
      String(b.texte ?? ""),
      c.get("compte").nom,
    );
    return c.html(V.legende(aLegender(), fileLegendes()));
  });

  // ------------------------------------------------------------ élève
  const sourceCertifiee = (id: string) =>
    db.prepare(
      `SELECT id, titre, enseignant, coalesce(json_extract(metadonnees, '$.sequence'), '') AS sequence,
         coalesce(json_extract(metadonnees, '$.seance'), '') AS seance,
         coalesce(json_extract(metadonnees, '$.date'), '') AS date
       FROM sources s WHERE id = ? AND statut = 'certifiee' AND school_id = ?
         AND EXISTS (SELECT 1 FROM json_each(s.metadonnees, '$.publics') WHERE value = 'eleves')`,
    ).get(id, config.schoolId) as V.SourceLue | undefined;

  app.get("/eleve", (c) => {
    const rangs = db.prepare(
      `SELECT id, titre, coalesce(json_extract(metadonnees, '$.sequence'), '') AS sequence,
         coalesce(json_extract(metadonnees, '$.seance'), '') AS seance,
         coalesce(json_extract(metadonnees, '$.date'), '') AS date,
         coalesce(json_extract(metadonnees, '$.quiz_reponse'), '') AS quiz_reponse,
         (SELECT id FROM images WHERE source_id = s.id ORDER BY position LIMIT 1) AS image_id
       FROM sources s WHERE statut = 'certifiee' AND school_id = ?
         AND EXISTS (SELECT 1 FROM json_each(s.metadonnees, '$.publics') WHERE value = 'eleves')
       ORDER BY sequence, seance, titre`,
    ).all(config.schoolId) as V.SourceChapitre[];
    const chapitres: V.ChapitreVue[] = [];
    for (const r of rangs) {
      const nom = r.sequence || "Sans chapitre";
      if (chapitres.at(-1)?.nom !== nom) chapitres.push({ nom, sources: [], questions: [] });
      chapitres.at(-1)!.sources.push(r);
    }
    const questions = suggestionsParChapitre(db);
    for (const ch of chapitres) {
      ch.questions = questions.get(ch.nom === "Sans chapitre" ? "" : ch.nom) ?? [];
    }
    const prenom = c.get("compte").nom.split(" ")[0];
    // Une vignette de vidéo n'est pas une œuvre: elle reste dans son chapitre, pas dans « Le saviez-vous ».
    const oeuvres = rangs.filter((s) =>
      s.image_id && !/vid[ée]o|\d+ ?mn\b/i.test(`${s.titre} ${s.seance}`)
    );
    const fait = faitAuHasard(db);
    const oeuvre = (!fait || Math.random() < 0.5) && oeuvres.length
      ? oeuvres[Math.floor(Math.random() * oeuvres.length)]
      : undefined;
    return c.html(
      rendre(
        c,
        "Accueil",
        V.accueilEleve(prenom, chapitres, oeuvre ? undefined : fait, oeuvre),
        "accueil",
      ),
    );
  });

  app.get("/eleve/chapitres/:nom", (c) => {
    const nom = c.req.param("nom");
    const sources = db.prepare(
      `SELECT s.id, s.titre, coalesce(json_extract(s.metadonnees, '$.seance'), '') AS seance,
         coalesce(json_extract(s.metadonnees, '$.date'), '') AS date,
         coalesce(json_extract(s.metadonnees, '$.quiz_reponse'), '') AS quiz_reponse,
         (SELECT id FROM images WHERE source_id = s.id ORDER BY position LIMIT 1) AS image_id
       FROM sources s WHERE s.school_id = ? AND s.statut = 'certifiee'
         AND EXISTS (SELECT 1 FROM json_each(s.metadonnees, '$.publics') WHERE value = 'eleves')
         AND coalesce(json_extract(s.metadonnees, '$.sequence'), '') = ?
       ORDER BY seance = '', seance, s.titre`,
    ).all(config.schoolId, nom) as V.SourceChapitre[];
    if (!sources.length) return c.notFound();
    // Le lecteur s'ouvre sur le document demandé, sinon sur la première œuvre du mur.
    const doc = sources.find((s) => s.id === c.req.query("doc")) ??
      sources.find((s) => s.image_id) ?? sources[0];
    return c.html(
      rendre(
        c,
        nom,
        V.pageChapitre(nom, sources, suggestionsParChapitre(db).get(nom) ?? [], apercu(doc.id)),
      ),
    );
  });

  const apercu = (id: string): V.Apercu | undefined => {
    const s = db.prepare(
      `SELECT id, titre, enseignant, coalesce(json_extract(metadonnees, '$.sequence'), '') AS chapitre,
         coalesce(json_extract(metadonnees, '$.seance'), '') AS seance,
         coalesce(json_extract(metadonnees, '$.date'), '') AS date
       FROM sources s WHERE id = ? AND statut = 'certifiee' AND school_id = ?
         AND EXISTS (SELECT 1 FROM json_each(s.metadonnees, '$.publics') WHERE value = 'eleves')`,
    ).get(id, config.schoolId) as Omit<V.Apercu, "image_id" | "legende" | "images" | "extrait">;
    if (!s) return undefined;
    const images = db.prepare(
      `SELECT id, CASE WHEN legende_statut = 'certified' THEN legende END AS legende
       FROM images WHERE source_id = ? ORDER BY position`,
    ).all(id) as { id: string; legende: string | null }[];
    let extrait = "";
    try {
      const texte = lireDocument(id).blocs.filter((b) =>
        b.texte !== s.titre && b.texte !== b.section && !V.COMPTEUR_DIAPO.test(b.texte)
      )
        .map((b) => b.texte).join(" ");
      extrait = texte.length > 320 ? texte.slice(0, 320).replace(/\s+\S*$/, "") + " …" : texte;
    } catch { /* document sans texte extrait */ }
    return {
      ...s,
      image_id: images[0]?.id ?? null,
      legende: images[0]?.legende ?? null,
      images: images.length,
      extrait,
    };
  };

  app.get("/eleve/documents/:id/apercu", (c) => {
    const a = apercu(c.req.param("id"));
    return a ? c.html(V.lecteur(a)) : c.notFound();
  });

  app.get("/eleve/sources/:id", (c) => {
    const s = sourceCertifiee(c.req.param("id"));
    if (!s) return c.notFound();
    const images = db.prepare(
      `SELECT id, CASE WHEN legende_statut = 'certified' THEN legende END AS legende
       FROM images WHERE source_id = ? ORDER BY position`,
    ).all(s.id) as { id: string; legende: string | null }[];
    const debut = Number(c.req.query("debut"));
    const fin = Number(c.req.query("fin"));
    const marque = Number.isInteger(debut) && Number.isInteger(fin) && fin > debut
      ? [debut, fin] as [number, number]
      : undefined;
    return c.html(
      rendre(
        c,
        s.titre,
        V.lectureSource(
          s,
          images,
          lireDocument(s.id).blocs.filter((b) => !V.COMPTEUR_DIAPO.test(b.texte)),
          marque,
        ),
        "lecture",
      ),
    );
  });

  const messagesDe = (compteId: string) =>
    db.prepare(
      "SELECT id, question, etat, resultat, avis FROM messages WHERE compte_id = ? ORDER BY cree_le, rowid",
    )
      .all(compteId) as V.MessageVue[];

  const ideesPour = (r: Resultat, question = "", messageId = "") => {
    // Hors cours: les questions que couvre le chapitre du passage le plus proche, ou du chapitre posé.
    if (r.etat === "out_of_corpus") {
      const m = db.prepare(
        `SELECT coalesce(nullif(m.chapitre, ''), json_extract(s.metadonnees, '$.sequence'), '') AS nom
         FROM messages m LEFT JOIN sources s ON s.id = json_extract(m.journal, '$.candidats[0].source_id')
         WHERE m.id = ?`,
      ).get(messageId) as { nom: string } | undefined;
      return m?.nom ? (suggestionsParChapitre(db).get(m.nom) ?? []).slice(0, 3) : [];
    }
    if (r.etat !== "answered") return [];
    const ids = [...new Set(r.affirmations.map((a) => a.source_id))];
    if (!ids.length) return [];
    const memesSources = db.prepare(
      `SELECT sg.question FROM suggestions sg JOIN sources s ON s.id = sg.source_id
       WHERE sg.source_id IN (${ids.map(() => "?").join(",")}) AND s.statut = 'certifiee'
         AND s.school_id = ? AND sg.question != ?
         AND EXISTS (SELECT 1 FROM json_each(s.metadonnees, '$.publics') WHERE value = 'eleves')
         AND EXISTS (SELECT 1 FROM json_each(s.metadonnees, '$.publics') WHERE value = 'thot')
       ORDER BY random() LIMIT 3`,
    ).all(...ids, config.schoolId, question).map((x) => x.question as string);
    if (memesSources.length) return memesSources;
    const chapitre = db.prepare(
      "SELECT json_extract(metadonnees, '$.sequence') AS nom FROM sources WHERE id = ? AND school_id = ?",
    ).get(ids[0], config.schoolId)?.nom as string | undefined;
    return chapitre
      ? (suggestionsParChapitre(db).get(chapitre) ?? []).filter((q) => q !== question)
      : [];
  };

  app.get(
    "/eleve/chat",
    (c) => {
      const messages = messagesDe(c.get("compte").id);
      const dernier = [...messages].reverse().find((m) => m.resultat);
      const idees = dernier
        ? ideesPour(JSON.parse(dernier.resultat!), dernier.question, dernier.id)
        : [];
      return c.html(rendre(c, "Question", V.chat(messages, idees), "page-chat"));
    },
  );

  app.post("/eleve/questions", async (c) => {
    const b = await c.req.parseBody();
    const texte = String(b.texte ?? "").trim().slice(0, 1000);
    if (!texte) return c.text("Question vide.", 400);
    const chapitre = String(b.chapitre ?? "");
    if (
      chapitre && !db.prepare(
        `SELECT id FROM sources s WHERE school_id = ? AND statut = 'certifiee'
           AND json_extract(metadonnees, '$.sequence') = ?
           AND EXISTS (SELECT 1 FROM json_each(s.metadonnees, '$.publics') WHERE value = 'eleves')
         LIMIT 1`,
      ).get(config.schoolId, chapitre)
    ) return c.text("Chapitre indisponible.", 400);
    const id = crypto.randomUUID();
    const t = maintenant();
    db.prepare(
      "INSERT INTO messages (id, compte_id, question, chapitre, etat, cree_le, maj_le) VALUES (?, ?, ?, ?, 'en_attente', ?, ?)",
    )
      .run(id, c.get("compte").id, texte, chapitre, t, t);
    // Hors HTMX (accueil, idée proposée), la conversation s'ouvre et le flux démarre là-bas.
    if (!c.req.header("HX-Request")) return c.redirect("/eleve/chat", 303);
    return c.html(html`
      ${V.question(texte)}${V.attente(id)}
    `);
  });

  app.post("/eleve/messages/:id/relancer", (c) => {
    const r = db.prepare(
      "UPDATE messages SET etat = 'en_attente', resultat = NULL, maj_le = ? WHERE id = ? AND compte_id = ? AND etat = 'failed'",
    ).run(maintenant(), c.req.param("id"), c.get("compte").id);
    return r.changes ? c.html(V.attente(c.req.param("id"))) : c.notFound();
  });

  /**
   * Le flux calcule la réponse une seule fois. Une reconnexion SSE, ou un second onglet,
   * attend le résultat enregistré au lieu de relancer la génération.
   */
  app.get("/eleve/messages/:id/flux", (c) => {
    const id = c.req.param("id");
    const compte = c.get("compte");
    return streamSSE(c, async (flux) => {
      const perime = new Date(Date.now() - PERIMETRE_MS).toISOString().slice(0, 19) + "Z";
      const pris = db.prepare(
        `UPDATE messages SET etat = 'en_cours', maj_le = ?
         WHERE id = ? AND compte_id = ? AND (etat = 'en_attente' OR (etat = 'en_cours' AND maj_le < ?))`,
      ).run(maintenant(), id, compte.id, perime).changes;
      if (pris) {
        const m = db.prepare("SELECT question, chapitre FROM messages WHERE id = ?").get(id) as {
          question: string;
          chapitre: string;
        };
        const precedente = db.prepare(
          `SELECT question FROM messages WHERE compte_id = ? AND rowid < (SELECT rowid FROM messages WHERE id = ?)
           AND chapitre = ? ORDER BY rowid DESC LIMIT 1`,
        ).get(compte.id, id, m.chapitre)?.question as string | undefined;
        const { resultat, journal } = await demander(
          db,
          modeles,
          m.question,
          { schoolId: config.schoolId, chapitre: m.chapitre || undefined },
          config.seuil,
          (etape) => void flux.writeSSE({ event: "etape", data: etape }).catch(() => {}),
          precedente,
        );
        db.prepare(
          "UPDATE messages SET etat = ?, resultat = ?, journal = ?, maj_le = ? WHERE id = ?",
        )
          .run(resultat.etat, JSON.stringify(resultat), JSON.stringify(journal), maintenant(), id);
      }
      for (let i = 0; i < 240; i++) {
        const m = db.prepare(
          "SELECT question, resultat FROM messages WHERE id = ? AND compte_id = ?",
        ).get(
          id,
          compte.id,
        ) as
          | { question: string; resultat: string | null }
          | undefined;
        if (!m) return;
        if (m.resultat) {
          const r = JSON.parse(m.resultat) as Resultat;
          await flux.writeSSE({
            event: "reponse",
            data: String(await V.reponse(id, r, null, ideesPour(r, m.question, id), true)).replace(
              /\n/g,
              " ",
            ),
          });
          return;
        }
        await flux.sleep(500);
      }
    });
  });

  app.post("/eleve/messages/:id/avis", async (c) => {
    const avis = String((await c.req.parseBody()).avis ?? "");
    if (!["utile", "confus", "faux"].includes(avis)) return c.text("Avis invalide.", 400);
    const r = db.prepare(
      "UPDATE messages SET avis = ? WHERE id = ? AND compte_id = ? AND etat = 'answered'",
    ).run(avis, c.req.param("id"), c.get("compte").id);
    return r.changes ? c.html(V.avis(c.req.param("id"), avis)) : c.notFound();
  });

  app.get("/eleve/messages/:id/citations/:n", (c) => {
    const m = db.prepare("SELECT resultat FROM messages WHERE id = ? AND compte_id = ?")
      .get(c.req.param("id"), c.get("compte").id) as { resultat: string | null } | undefined;
    const r = m?.resultat ? JSON.parse(m.resultat) as Resultat : undefined;
    const a: Affirmation | undefined = r?.etat === "answered"
      ? r.affirmations[Number(c.req.param("n"))]
      : undefined;
    const source = a && sourceCertifiee(a.source_id);
    if (!a || !source) return c.html(V.panneauSource());
    const suite = {
      id: c.req.param("id"),
      n: Number(c.req.param("n")),
      total: r?.etat === "answered" ? r.affirmations.length : 0,
    };
    if (a.debut === undefined || a.fin === undefined) {
      return c.html(V.panneauSource({ ...a, enseignant: source.enseignant }, suite));
    }
    const texte = lireDocument(a.source_id).texte;
    return c.html(V.panneauSource({
      ...a,
      enseignant: source.enseignant,
      ...contexte(texte, a.debut, a.fin),
    }, suite));
  });

  app.onError((e, c) => {
    if (e instanceof HTTPException) return e.getResponse();
    console.error(e);
    return c.text("Erreur interne.", 500);
  });

  return app;
}
