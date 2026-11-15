import type { Context, Hono } from "hono";
import {
  citationsDe,
  type Contenu,
  type Explication,
  type Question,
  sourcesMontrees,
  TYPES_QUESTION,
} from "../../core/activite.ts";
import { transaction } from "../../core/recherche.ts";
import * as Activites from "../activites.ts";
import { catalogueDe } from "../domaines.ts";
import { lireQuestion, nouvelId, reancrer, saisie, saisieDe } from "../edition.ts";
import { libelles } from "../instance.ts";
import * as Vue from "../vues/activites.ts";
import type { Env, Web } from "./web.ts";

const CONFLIT = "Cette activité a changé pendant votre saisie. Relisez sa version actuelle.";

/** Le message d'une saisie refusée. Une erreur de la base n'en est pas une. */
const message = (e: unknown) => {
  if ((e as { code?: string }).code === "ERR_SQLITE_ERROR") throw e;
  return (e as Error).message;
};

type Corps = Record<string, string | File | (string | File)[]>;
const valeur = (b: Corps, k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");

export function routesActivites(app: Hono<Env>, w: Web) {
  const { db, modeles, rendre } = w;

  app.get("/prof/activites", (c) => {
    const compte = c.get("compte");
    const cours = catalogueDe(db, compte).cours;
    const coursId = c.req.query("cours_id") ?? "";
    const etat = c.req.query("etat") ?? "";
    const filtre = {
      coursId: cours.some((x) => x.id === coursId) ? coursId : "",
      etat: Vue.ETATS_FILTRE.includes(etat) ? etat : "",
    };
    return c.html(
      rendre(
        c,
        "Activités",
        Vue.listeProf({
          liste: Activites.activitesProf(db, compte, filtre),
          cours,
          filtre,
          libelles: libelles(db),
        }),
      ),
    );
  });

  const pageObjectifs = (c: Context<Env>, erreur?: string) =>
    rendre(
      c,
      "Objectifs",
      Vue.objectifs(Activites.suiviObjectifs(db, c.get("compte")), libelles(db), erreur),
    );
  app.get("/prof/objectifs", (c) => c.html(pageObjectifs(c)));
  app.post("/prof/objectifs/:id/:action{(?:renommer|fusionner)}", async (c) => {
    const b = await c.req.parseBody();
    const compte = c.get("compte");
    const id = c.req.param("id");
    try {
      if (c.req.param("action") === "renommer") {
        Activites.renommerObjectif(db, compte, id, valeur(b, "intitule"));
      } else {
        Activites.fusionnerObjectifs(db, compte, id, valeur(b, "vers"));
      }
    } catch (e) {
      return c.html(pageObjectifs(c, message(e)), 400);
    }
    return c.redirect("/prof/objectifs", 303);
  });

  const activiteProf = (c: Context<Env>) =>
    Activites.activiteProf(db, c.get("compte"), c.req.param("id")!);
  const detail = (
    c: Context<Env>,
    a: Activites.Activite,
    extra: { erreur?: string; edition?: Vue.Edition } = {},
  ) => {
    const compte = c.get("compte");
    const contenu = JSON.parse(a.contenu) as Contenu | Explication;
    const sources = Activites.sourcesCitables(db, a);
    const montrees = "questions" in contenu ? sourcesMontrees(contenu) : [];
    const ids = [...new Set([...citationsDe(contenu).map((x) => x.source_id), ...montrees])];
    const lus = db
      .prepare("SELECT id, titre FROM sources WHERE id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(ids)) as { id: string; titre: string }[];
    const cours = Activites.coursDe(db, a.id).map((x) => ({
      ...x,
      bloquantes: Activites.bloquantes(db, a, x.id),
    }));
    const relectures = Activites.relectures(db, a.id);
    const lues = Activites.tentativesLues(db, compte, a);
    return rendre(
      c,
      a.titre,
      Vue.detailProf({
        a,
        contenu,
        relectures,
        servies: Activites.servies(db, a),
        libelles: libelles(db),
        cours,
        autres: catalogueDe(db, compte).cours.filter((x) => !cours.some((y) => y.id === x.id)),
        objectifs: Activites.objectifs(db, a.cours_id),
        sources,
        images: Activites.imagesCitables(db, a),
        titres: new Map([...lus, ...sources].map((s) => [s.id, s.titre])),
        suivi: lues && {
          eleves: Activites.elevesSuivis(db, compte, a).length,
          remis: new Set(lues.filter((t) => t.rendue_le).map((t) => t.compte_id)).size,
        },
        supprimable:
          !relectures.some((r) => r.action === "publiee") &&
          !db.prepare("SELECT 1 FROM tentatives WHERE activite_id = ? LIMIT 1").get(a.id),
        ...extra,
      }),
    );
  };

  // `?modifier=` ouvre le formulaire d'une question, ou d'une nouvelle question du type demandé.
  app.get("/prof/activites/:id", (c) => {
    const a = activiteProf(c);
    if (!a) return c.notFound();
    const contenu = JSON.parse(a.contenu) as Contenu | Explication;
    const modifier = c.req.query("modifier");
    let edition: Vue.Edition | undefined;
    if (modifier && "questions" in contenu) {
      const q = contenu.questions.find((x) => x.id === modifier);
      if (q) edition = { id: q.id, type: q.type, saisie: saisieDe(q) };
      else if (modifier === "nouvelle") {
        const type = TYPES_QUESTION.find((t) => t === c.req.query("type")) ?? "redigee";
        edition = { id: "nouvelle", type, saisie: {} };
      }
    }
    return c.html(detail(c, a, { erreur: c.req.query("erreur"), edition }));
  });

  /** Une nouvelle version de l'exercice, ou la page qui dit pourquoi elle est refusée. */
  const nouvelleVersion = async (
    c: Context<Env>,
    a: Activites.Activite,
    revision: number,
    neuf: () => Contenu | Promise<Contenu>,
    ancre = "",
    edition?: Vue.Edition,
  ) => {
    if (revision !== a.revision) return c.html(detail(c, a, { erreur: CONFLIT, edition }), 409);
    try {
      const r = await Activites.enregistrer(
        db,
        modeles,
        c.get("compte"),
        a,
        revision,
        await neuf(),
      );
      if (r === "conflit") {
        return c.html(detail(c, activiteProf(c)!, { erreur: CONFLIT, edition }), 409);
      }
    } catch (e) {
      return c.html(detail(c, a, { erreur: message(e), edition }), 400);
    }
    return c.redirect(`/prof/activites/${a.id}${ancre && `#q-${encodeURIComponent(ancre)}`}`, 303);
  };

  const exercice = (c: Context<Env>) => {
    const a = activiteProf(c);
    return a?.type === "exercice" ? { a, contenu: JSON.parse(a.contenu) as Contenu } : undefined;
  };
  const idLibre = (contenu: Contenu) => {
    let id = nouvelId();
    while (contenu.questions.some((q) => q.id === id)) id = nouvelId();
    return id;
  };

  /** Enregistre le formulaire d'une question existante (`qid`) ou nouvelle. */
  const enregistrerQuestion = async (c: Context<Env>, qid?: string) => {
    const x = exercice(c);
    if (!x) return c.notFound();
    const { a, contenu } = x;
    const rang = qid === undefined ? -1 : contenu.questions.findIndex((q) => q.id === qid);
    if (qid !== undefined && rang < 0) return c.notFound();
    const avant: Question | undefined = contenu.questions[rang];
    const b = await c.req.parseBody({ all: true });
    const type = avant?.type ?? TYPES_QUESTION.find((t) => t === b.type) ?? "redigee";
    const edition = { id: avant?.id ?? "nouvelle", type, saisie: saisie(b) };
    const id = avant?.id ?? idLibre(contenu);
    return nouvelleVersion(
      c,
      a,
      Number(valeur(b, "revision")),
      async () => {
        const q = await lireQuestion(db, a, b, id, avant);
        const liste = [...contenu.questions];
        if (avant) liste[rang] = q;
        else liste.push(q);
        return { ...contenu, questions: liste };
      },
      id,
      edition,
    );
  };
  app.post("/prof/activites/:id/questions", (c) => enregistrerQuestion(c));
  app.post(
    "/prof/activites/:id/questions/:q/:op{(?:enregistrer|dupliquer|monter|descendre|supprimer)}",
    async (c) => {
      const op = c.req.param("op");
      const qid = c.req.param("q");
      if (op === "enregistrer") return enregistrerQuestion(c, qid);
      const x = exercice(c);
      if (!x) return c.notFound();
      const { a, contenu } = x;
      const rang = contenu.questions.findIndex((q) => q.id === qid);
      if (rang < 0) return c.notFound();
      const b = await c.req.parseBody();
      const liste = [...contenu.questions];
      let ancre = qid;
      if (op === "dupliquer") {
        ancre = idLibre(contenu);
        liste.splice(rang + 1, 0, { ...structuredClone(liste[rang]), id: ancre });
      } else if (op === "supprimer") {
        if (liste.length === 1) {
          return c.html(detail(c, a, { erreur: "Une série garde au moins une question." }), 400);
        }
        liste.splice(rang, 1);
        ancre = liste[Math.max(0, rang - 1)].id;
      } else {
        const autre = op === "monter" ? rang - 1 : rang + 1;
        if (autre >= 0 && autre < liste.length) {
          [liste[rang], liste[autre]] = [liste[autre], liste[rang]];
        }
      }
      return nouvelleVersion(
        c,
        a,
        Number(valeur(b, "revision")),
        () => ({ ...contenu, questions: liste }),
        ancre,
      );
    },
  );

  app.post("/prof/activites/:id/reancrer", async (c) => {
    const x = exercice(c);
    if (!x) return c.notFound();
    const b = await c.req.parseBody();
    return nouvelleVersion(c, x.a, Number(valeur(b, "revision")), () =>
      reancrer(db, x.a, x.contenu),
    );
  });

  /**
   * Les réglages d'une activité, enregistrés ensemble. Un champ absent ne change rien. Le titre, la
   * date, l'objectif et les cours ne créent pas de version : un refus n'en enregistre aucun. Le
   * corrigé crée une version, après les autres.
   */
  app.post("/prof/activites/:id/reglages", async (c) => {
    const a = activiteProf(c);
    if (!a) return c.notFound();
    const b = await c.req.parseBody();
    const v = (k: string) => valeur(b, k);
    const compte = c.get("compte");
    const contenu = JSON.parse(a.contenu) as Contenu | Explication;
    const correction =
      "questions" in contenu && v("correction") && v("correction") !== contenu.correction
        ? v("correction")
        : "";
    const revision = Number(v("revision"));
    if (correction && revision !== a.revision) {
      return c.html(detail(c, a, { erreur: CONFLIT }), 409);
    }
    try {
      if (correction && correction !== "question" && correction !== "serie") {
        throw new Error("Corrigé inconnu.");
      }
      transaction(db, () => {
        if ("titre" in b) Activites.regler(db, a, v("titre"), v("a_rendre_le"));
        if (v("objectif_id") && v("objectif_id") !== a.objectif_id) {
          Activites.changerObjectif(db, a, v("objectif_id"));
        }
        if (!v("cours_id")) return;
        const manque = Activites.ajouterCours(db, compte, a, v("cours_id"));
        if (manque.length) {
          const nom = catalogueDe(db, compte).cours.find((x) => x.id === v("cours_id"))?.nom;
          throw new Error(
            `Rattachez d'abord à ${nom} ${manque.length > 1 ? "les sources citées" : "la source citée"} : ${manque.join(", ")}.`,
          );
        }
      });
    } catch (e) {
      return c.html(detail(c, a, { erreur: message(e) }), 400);
    }
    if (!correction) return c.redirect(`/prof/activites/${a.id}`, 303);
    const serie = contenu as Contenu;
    return nouvelleVersion(c, activiteProf(c)!, revision, () => ({
      ...serie,
      correction: correction as Contenu["correction"],
    }));
  });

  app.post("/prof/activites/:id/cours/:cours/retirer", (c) => {
    const a = activiteProf(c);
    if (!a) return c.notFound();
    try {
      Activites.retirerCours(db, c.get("compte"), a, c.req.param("cours"));
    } catch (e) {
      return c.html(detail(c, a, { erreur: message(e) }), 400);
    }
    return c.redirect(`/prof/activites/${a.id}`, 303);
  });

  app.post("/prof/activites/:id/:action{(?:archiver|supprimer|relire|publier)}", async (c) => {
    const a = activiteProf(c);
    if (!a) return c.notFound();
    const b = await c.req.parseBody();
    const v = (k: string) => valeur(b, k);
    const compte = c.get("compte");
    let refus = "";
    try {
      switch (c.req.param("action")) {
        case "archiver":
          Activites.archiver(db, a, v("oui") === "1");
          break;
        case "supprimer":
          if (await Activites.supprimerBrouillon(db, a)) {
            return c.redirect("/prof/activites", 303);
          }
          refus =
            "Une activité déjà publiée ou qui a des tentatives ne se supprime pas. Archivez-la.";
          break;
        case "relire":
          if (!Activites.relire(db, compte, a, Number(v("revision")))) refus = CONFLIT;
          break;
        default: {
          const r = Activites.publier(db, compte, a.id, Number(v("revision")));
          if (r === "refus") refus = "Seule la version relue d'une activité se publie.";
          if (r === "preuves") refus = "Une source citée ne tient plus : l'activité est à revoir.";
        }
      }
    } catch (e) {
      return c.html(detail(c, a, { erreur: message(e) }), 400);
    }
    if (refus) return c.html(detail(c, activiteProf(c)!, { erreur: refus }), 409);
    return c.redirect(`/prof/activites/${a.id}`, 303);
  });
}
