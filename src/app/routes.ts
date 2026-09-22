import { Hono } from "hono";
import { html } from "hono/html";
import { csrf } from "hono/csrf";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { serveStatic } from "hono/deno";
import { streamSSE } from "hono/streaming";
import type { Modeles } from "../core/modeles.ts";
import { type Affirmation, demander, type Resultat } from "../core/reponse.ts";
import { tranche } from "../core/texte.ts";
import { authentifier, type Compte, lireCompte, secretSession } from "./comptes.ts";
import { config, contenu } from "./config.ts";
import { type Db, maintenant } from "./db.ts";
import { controlerFichier, deposer, valider } from "./depot.ts";
import { lireDocument, relireLegende, statuer } from "./ingestion.ts";
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
    const compte = id ? lireCompte(db, id) : undefined;
    if (compte) c.set("compte", compte);
    const p = c.req.path;
    if (p === "/connexion" || p.startsWith("/static/")) return next();
    if (!compte) return c.redirect("/connexion");
    if (p.startsWith("/prof") && compte.role !== "enseignant") {
      return c.text("Accès réservé aux enseignants.", 403);
    }
    return next();
  });

  const rendre = (c: { get(k: "compte"): Compte }, titre: string, corps: unknown, classe = "") =>
    V.page(titre, c.get("compte") ?? null, corps, classe);

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
    await setSignedCookie(c, SESSION, compte.id, secret, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 12 * 3600,
      secure: new URL(c.req.url).protocol === "https:",
    });
    return c.redirect("/");
  });
  app.post("/deconnexion", (c) => {
    deleteCookie(c, SESSION, { path: "/" });
    return c.redirect("/connexion");
  });
  app.get("/", (c) => c.redirect(c.get("compte").role === "enseignant" ? "/prof" : "/eleve"));

  // ------------------------------------------------------------ images
  app.get("/media/:id", async (c) => {
    const i = db.prepare(
      "SELECT i.fichier, i.mime, i.source_id, s.statut FROM images i JOIN sources s ON s.id = i.source_id WHERE i.id = ?",
    ).get(c.req.param("id")) as
      | { fichier: string; mime: string; source_id: string; statut: string }
      | undefined;
    if (!i || (c.get("compte").role !== "enseignant" && i.statut !== "certifiee")) {
      return c.notFound();
    }
    const octets = await Deno.readFile(contenu(i.source_id, "assets", i.fichier));
    return c.body(octets, 200, {
      "content-type": i.mime,
      "cache-control": "private, max-age=3600",
    });
  });

  // ------------------------------------------------------------ enseignant
  const lignes = (statut: string) =>
    db.prepare(
      `SELECT s.id, s.titre, json_extract(s.metadonnees, '$.sequence') AS sequence, s.format, s.statut,
         j.etat, j.erreur,
         (SELECT count(*) FROM images i WHERE i.source_id = s.id AND i.legende_statut = 'unreviewed') AS images_a_relire
       FROM sources s JOIN ingestion_jobs j ON j.source_id = s.id
       WHERE s.school_id = ? AND (? = '' OR s.statut = ?)
       ORDER BY sequence, s.titre`,
    ).all(config.schoolId, statut, statut) as unknown as V.LigneSource[];

  app.get("/prof", (c) => {
    const statut = c.req.query("statut") ?? "";
    const compteurs: Record<string, number> = { "": 0 };
    for (
      const l of db.prepare(
        "SELECT statut, count(*) n FROM sources WHERE school_id = ? GROUP BY statut",
      ).all(config.schoolId)
    ) {
      compteurs[l.statut as string] = l.n as number;
      compteurs[""] += l.n as number;
    }
    return c.html(rendre(c, "Sources", V.sources(lignes(statut), statut, compteurs)));
  });
  app.get("/prof/lignes", (c) => {
    const statut = c.req.query("statut") ?? "";
    return c.html(V.lignesSources(lignes(statut), statut ? `statut=${statut}` : ""));
  });
  app.post("/prof/sources/statut", async (c) => {
    const b = await c.req.parseBody({ all: true });
    const statut = b.statut === "certifiee" ? "certifiee" : "rejetee";
    const ids = [b.ids ?? []].flat().map(String);
    for (const id of ids) statuer(db, id, statut, c.get("compte").nom);
    return c.redirect("/prof");
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
  app.get("/prof/legendes", (c) =>
    c.html(rendre(
      c,
      "Légendes",
      html`
        <h1>Relire les légendes</h1>${V.legende(aLegender(c.req.query("image")))}${V
          .raccourciEdition}
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
    return c.html(V.legende(aLegender()));
  });

  // ------------------------------------------------------------ élève
  const sourceCertifiee = (id: string) =>
    db.prepare(
      "SELECT id, titre, json_extract(metadonnees, '$.sequence') AS sequence FROM sources WHERE id = ? AND statut = 'certifiee' AND school_id = ?",
    ).get(id, config.schoolId) as { id: string; titre: string; sequence: string } | undefined;

  app.get("/eleve", (c) => {
    const rangs = db.prepare(
      `SELECT id, titre, coalesce(json_extract(metadonnees, '$.sequence'), '') AS sequence,
         coalesce(json_extract(metadonnees, '$.seance'), '') AS seance
       FROM sources WHERE statut = 'certifiee' AND school_id = ? ORDER BY sequence, seance, titre`,
    ).all(config.schoolId) as { id: string; titre: string; sequence: string; seance: string }[];
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
    return c.html(rendre(c, "Accueil", V.accueilEleve(prenom, chapitres, faitAuHasard(db))));
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
      rendre(c, s.titre, V.lectureSource(s, images, lireDocument(s.id).blocs, marque), "lecture"),
    );
  });

  const messagesDe = (compteId: string) =>
    db.prepare(
      "SELECT id, question, etat, resultat FROM messages WHERE compte_id = ? ORDER BY cree_le, rowid",
    )
      .all(compteId) as { id: string; question: string; etat: string; resultat: string | null }[];

  app.get(
    "/eleve/chat",
    (c) => {
      const idees = [...suggestionsParChapitre(db, 2).values()].flat()
        .sort(() => Math.random() - 0.5).slice(0, 4);
      return c.html(rendre(c, "Question", V.chat(messagesDe(c.get("compte").id), idees)));
    },
  );

  app.post("/eleve/questions", async (c) => {
    const texte = String((await c.req.parseBody()).texte ?? "").trim().slice(0, 1000);
    if (!texte) return c.text("Question vide.", 400);
    const id = crypto.randomUUID();
    const t = maintenant();
    db.prepare(
      "INSERT INTO messages (id, compte_id, question, etat, cree_le, maj_le) VALUES (?, ?, ?, 'en_attente', ?, ?)",
    )
      .run(id, c.get("compte").id, texte, t, t);
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
        const m = db.prepare("SELECT question FROM messages WHERE id = ?").get(id) as {
          question: string;
        };
        const { resultat, journal } = await demander(
          db,
          modeles,
          m.question,
          { schoolId: config.schoolId },
          config.seuil,
          (etape) => void flux.writeSSE({ event: "etape", data: etape }).catch(() => {}),
        );
        db.prepare(
          "UPDATE messages SET etat = ?, resultat = ?, journal = ?, maj_le = ? WHERE id = ?",
        )
          .run(resultat.etat, JSON.stringify(resultat), JSON.stringify(journal), maintenant(), id);
      }
      for (let i = 0; i < 240; i++) {
        const m = db.prepare("SELECT resultat FROM messages WHERE id = ? AND compte_id = ?").get(
          id,
          compte.id,
        ) as
          | { resultat: string | null }
          | undefined;
        if (!m) return;
        if (m.resultat) {
          const r = JSON.parse(m.resultat) as Resultat;
          await flux.writeSSE({
            event: "reponse",
            data: String(await V.reponse(id, r)).replace(/\n/g, " "),
          });
          return;
        }
        await flux.sleep(500);
      }
    });
  });

  app.get("/eleve/messages/:id/citations/:n", (c) => {
    const m = db.prepare("SELECT resultat FROM messages WHERE id = ? AND compte_id = ?")
      .get(c.req.param("id"), c.get("compte").id) as { resultat: string | null } | undefined;
    const r = m?.resultat ? JSON.parse(m.resultat) as Resultat : undefined;
    const a: Affirmation | undefined = r?.etat === "answered"
      ? r.affirmations[Number(c.req.param("n"))]
      : undefined;
    if (!a || !sourceCertifiee(a.source_id)) return c.html(V.panneauSource());
    if (a.debut === undefined || a.fin === undefined) return c.html(V.panneauSource(a));
    const texte = lireDocument(a.source_id).texte;
    return c.html(V.panneauSource({
      ...a,
      avant: tranche(texte, Math.max(0, a.debut - 300), a.debut),
      milieu: tranche(texte, a.debut, a.fin),
      apres: tranche(texte, a.fin, a.fin + 300),
    }));
  });

  app.onError((e, c) => {
    console.error(e);
    return c.text("Erreur interne.", 500);
  });

  return app;
}
