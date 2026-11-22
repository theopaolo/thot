import { type Context, Hono } from "hono";
import { html } from "hono/html";
import { LISIBLE, parametresLisible } from "../../core/recherche.ts";
import { filtreModification, parametresModification, peutModifier } from "../comptes.ts";
import { libelles, lireInstance } from "../instance.ts";
import { audience } from "../depot.ts";
import {
  questionDesEleves,
  questionsDesEleves,
  resumeQuestionsDesEleves,
} from "../conversations.ts";
import { changerLecteurs, refusCertification, statuer } from "../ingestion.ts";
import * as ProfBibliotheque from "../vues/prof-bibliotheque.ts";
import * as ProfLignes from "../vues/prof-lignes.ts";
import * as ProfQuestions from "../vues/prof-questions.ts";
import * as Domaines from "../domaines.ts";
import * as Perimetre from "../vues/perimetre.ts";
import type { Env, Web } from "./web.ts";

export function routesProf(app: Hono<Env>, w: Web) {
  const { db, instance, rendre, lu, scope, idsScope, feuilleCitation } = w;

  const lignes = (c: Context<Env>, statut: string, theme: string, lot = c.req.query("lot") ?? "") =>
    db
      .prepare(
        `SELECT s.id, s.titre, s.profil, s.lot_id, ${Domaines.nomTheme("s")} AS theme, s.format, s.statut,
         s.audience, coalesce(${filtreModification()}, 0) AS modifiable,
         j.etat, j.erreur,
         (SELECT count(*) FROM images i WHERE i.source_id = s.id AND i.legende_statut = 'unreviewed') AS images_a_relire,
         EXISTS (SELECT 1 FROM revisions r WHERE r.source_id = s.id AND r.n > s.revision) AS revision_en_attente,
         (SELECT count(*) FROM images i WHERE i.source_id = s.id) AS images,
         (SELECT count(legende) FROM images i WHERE i.source_id = s.id) AS legendes,
         (SELECT id FROM images WHERE source_id = s.id ORDER BY position LIMIT 1) AS image_id,
         json_extract(s.metadonnees, '$.ordre') AS ordre
       FROM sources s JOIN ingestion_jobs j ON j.source_id = s.id
       WHERE ${LISIBLE} AND (? = '' OR s.statut = ?)
         AND (? = '' OR theme = ?) AND (? = '' OR s.lot_id = ?)
       ORDER BY theme, s.titre`,
      )
      .all(
        {
          ...parametresModification(c.get("compte")),
          ...parametresLisible(instance.school_id, lu(c)),
        },
        statut,
        statut,
        theme,
        theme,
        lot,
        lot,
      ) as unknown as (ProfLignes.LigneSource & { lot_id: string | null })[];
  /** Sans accents ni casse : « algebre » trouve « Algèbre ». */
  const plier = (t: string) =>
    t
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLocaleLowerCase("fr");
  /**
   * Les ressources du périmètre qui contiennent la recherche dans leur titre. Sans cours choisi,
   * chaque ligne nomme ses cours, parmi ceux du compte.
   */
  const lignesVisibles = (c: Context<Env>, liste: ProfLignes.LigneSource[]) => {
    const selection = idsScope(c);
    const q = plier(c.req.query("q") ?? "");
    const garde = liste.filter((s) => selection.has(s.id) && plier(s.titre).includes(q));
    if (scope(c).cours_id) return garde;
    const noms = Map.groupBy(
      db
        .prepare(
          `SELECT sc.source_id, c.id, c.nom FROM source_cours sc JOIN cours c ON c.id = sc.cours_id
           WHERE ${Domaines.MES_COURS} ORDER BY c.nom`,
        )
        .all(Domaines.mesCours(lu(c))) as { source_id: string; id: string; nom: string }[],
      (l) => l.source_id,
    );
    return garde.map((s) => ({
      ...s,
      cours: (noms.get(s.id) ?? []).map(({ id, nom }) => ({ id, nom })),
    }));
  };
  /**
   * La vue « Dossiers » montre un niveau : à la racine, un dossier par cours et les ressources
   * sans cours, dans un cours, un dossier par thème et les ressources sans thème. Une recherche,
   * un lot ou un thème choisi montrent tous les fichiers trouvés, sans dossiers.
   */
  const ranger = (
    c: Context<Env>,
    f: ReturnType<typeof filtres>,
    ressources: ProfLignes.LigneSource[],
    cat: Domaines.Catalogue,
  ): { rangement: ProfBibliotheque.Rangement; fichiers: ProfLignes.LigneSource[] } => {
    const p = scope(c);
    const racine = { nom: "Bibliothèque", portee: { matiere_id: "", cours_id: "", theme_id: "" } };
    const cours = cat.cours.find((x) => x.id === p.cours_id);
    const theme = cat.themes.find((x) => x.id === p.theme_id);
    const fil = [
      racine,
      ...(cours ? [{ nom: cours.nom, portee: { cours_id: cours.id, theme_id: "" } }] : []),
      ...(theme ? [{ nom: theme.nom, portee: { theme_id: theme.id } }] : []),
    ];
    if (f.q || f.lot || f.theme || p.theme_id) {
      return { rangement: { fil, dossiers: [] }, fichiers: ressources };
    }
    const liens = db
      .prepare(
        `SELECT sc.source_id, sc.cours_id, sc.theme_id FROM source_cours sc
         WHERE ${Domaines.MES_COURS}`,
      )
      .all(Domaines.mesCours(lu(c))) as {
      source_id: string;
      cours_id: string;
      theme_id: string | null;
    }[];
    const parId = new Map(ressources.map((r) => [r.id, r]));
    const contenu = (garde: (l: (typeof liens)[number]) => boolean) =>
      [
        ...new Set(liens.filter((l) => parId.has(l.source_id) && garde(l)).map((l) => l.source_id)),
      ].map((id) => parId.get(id)!);
    const aRelire = (liste: ProfLignes.LigneSource[]) =>
      liste.filter((s) => s.statut === "a_relire" || s.revision_en_attente).length;
    const dossiers = (
      groupes: { nom: string; portee: Partial<typeof f>; liste: ProfLignes.LigneSource[] }[],
    ) =>
      groupes
        .filter((g) => g.liste.length)
        .map((g) => ({
          nom: g.nom,
          portee: g.portee,
          n: g.liste.length,
          aRelire: aRelire(g.liste),
        }));
    if (cours) {
      return {
        rangement: {
          fil,
          coursId: cours.id,
          dossiers: dossiers(
            cat.themes
              .filter((t) => t.cours_id === cours.id)
              .map((t) => ({
                nom: t.nom,
                portee: { theme_id: t.id },
                liste: contenu((l) => l.cours_id === cours.id && l.theme_id === t.id),
              })),
          ),
        },
        fichiers: contenu((l) => l.cours_id === cours.id && !l.theme_id),
      };
    }
    const ranges = new Set(liens.map((l) => l.source_id));
    return {
      rangement: {
        fil,
        dossiers: dossiers(
          cat.cours
            .filter((x) => !p.matiere_id || x.matiere_id === p.matiere_id)
            .map((x) => ({
              nom: x.nom,
              portee: { cours_id: x.id, theme_id: "" },
              liste: contenu((l) => l.cours_id === x.id),
            })),
        ),
      },
      fichiers: ressources.filter((r) => !ranges.has(r.id)),
    };
  };
  const filtres = (c: Context<Env>) => ({
    q: c.req.query("q") ?? "",
    statut: c.req.query("statut") ?? "",
    theme: c.req.query("theme") ?? "",
    lot: c.req.query("lot") ?? "",
    vue: c.req.query("vue") === "grille" ? "grille" : "",
    ...Domaines.lireScope(c.req.query()),
  });

  app.get("/prof", (c) => {
    const f = filtres(c);
    // La prise en main compte toute la bibliothèque, pas seulement le lot affiché.
    const toutes = lignes(c, "", "", "");
    const ressources = lignesVisibles(c, f.lot ? toutes.filter((s) => s.lot_id === f.lot) : toutes);
    const cat = Domaines.catalogueDe(db, c.get("compte"));
    const personnel = lireInstance(db).mode === "personal";
    // Une nouvelle version à relire compte avec les sources à relire.
    const statut = (s: ProfLignes.LigneSource) => (s.revision_en_attente ? "a_relire" : s.statut);
    const repartition = [
      ...Map.groupBy(ressources, (s) => `${s.theme ?? ""}\0${statut(s)}`).values(),
    ].map((liste) => ({
      theme: liste[0].theme ?? "",
      statut: statut(liste[0]),
      n: liste.length,
    }));
    const montrees = ressources.filter(
      (s) => (!f.statut || statut(s) === f.statut) && (!f.theme || s.theme === f.theme),
    );
    const bureau = f.vue === "grille" ? ranger(c, f, montrees, cat) : undefined;
    return c.html(
      rendre(
        c,
        "Bibliothèque",
        html`${Perimetre.filtre(cat, scope(c), "/prof", libelles(db), {
          statut: f.statut,
          vue: f.vue,
        })}${ProfBibliotheque.sources(
          bureau?.fichiers ?? montrees,
          f,
          repartition,
          libelles(db),
          // Le profil vient de toute la bibliothèque : une recherche vide ne le change pas.
          toutes.some((s) => s.profil === "general"),
          c.req.query("supprimee") !== undefined,
          {
            cours: cat.cours.length > 0,
            ressource: toutes.length > 0,
            certifiee: toutes.some((s) => s.statut === "certifiee"),
            administrateur: c.get("compte").administrateur === 1,
            personnel,
            activite:
              !personnel && cat.cours.length > 0 && toutes.some((s) => s.statut === "certifiee")
                ? resumeQuestionsDesEleves(db, lu(c))
                : undefined,
          },
          bureau?.rangement,
          // Les sources que l'action groupée n'a pas certifiées. Seules celles que le compte lit
          // sont nommées, et la raison se relit en base : rien ne vient de l'adresse que des
          // identifiants.
          (c.req.queries("refus") ?? []).flatMap((id) => {
            const s = toutes.find((l) => l.id === id);
            return s
              ? [
                  {
                    id,
                    titre: s.titre,
                    raison: refusCertification(db, id) ?? "réessayez depuis sa page",
                  },
                ]
              : [];
          }),
        )}`,
      ),
    );
  });
  app.get("/prof/questions", (c) => {
    const toutes = c.req.query("toutes") === "1";
    const liste = questionsDesEleves(db, lu(c), toutes ? undefined : 101);
    const plus = !toutes && liste.length > 100;
    return c.html(
      rendre(
        c,
        "Questions des élèves",
        ProfQuestions.questionsProf(plus ? liste.slice(0, 100) : liste, libelles(db), plus),
      ),
    );
  });
  // Un échange de la liste, sans sa conversation. Hors de la liste, il répond 404.
  const echange = (c: Context<Env>) =>
    questionDesEleves(db, c.get("compte"), c.req.param("echange")!);
  app.get("/prof/questions/:echange", (c) => {
    const e = echange(c);
    if (!e) return c.notFound();
    const cat = Domaines.catalogueDe(db, c.get("compte"));
    return c.html(
      rendre(c, `Question de ${e.nom}`, ProfQuestions.echangeProf(e, cat, libelles(db))),
    );
  });
  app.get("/prof/questions/:echange/citations/:n", (c) => {
    const e = echange(c);
    if (!e) return c.notFound();
    const r = e.resultat;
    return feuilleCitation(
      c,
      r?.etat === "answered" ? r.affirmations : [],
      e.id,
      `Dans ${libelles(db).formes.cours.le}`,
    );
  });
  app.get("/prof/lignes", (c) => {
    const f = filtres(c);
    const liste = lignesVisibles(c, lignes(c, f.statut, f.theme));
    const bureau =
      f.vue === "grille"
        ? ranger(c, f, liste, Domaines.catalogueDe(db, c.get("compte")))
        : undefined;
    return c.html(
      ProfLignes.lignesSources(
        bureau?.fichiers ?? liste,
        new URLSearchParams(f).toString(),
        f.vue === "grille",
        bureau?.rangement.coursId,
        libelles(db),
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
      for (const id of ids) changerLecteurs(db, id, lecteurs);
      return c.redirect(`/prof?${new URLSearchParams(filtres(c))}`, 303);
    }
    const statut = b.statut === "certifiee" ? "certifiee" : "rejetee";
    // Une source qui n'est pas prête ne retient pas les autres : la bibliothèque la nomme ensuite.
    const retour = new URLSearchParams(filtres(c));
    for (const id of ids) {
      try {
        statuer(db, id, statut, c.get("compte").nom);
      } catch (e) {
        if (statut !== "certifiee" || (e as { code?: string }).code === "ERR_SQLITE_ERROR") throw e;
        retour.append("refus", id);
      }
    }
    return c.redirect(`/prof?${retour}`, 303);
  });
}
