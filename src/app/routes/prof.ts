import { readFile } from "node:fs/promises";
import { type Context, Hono } from "hono";
import { html } from "hono/html";
import { LISIBLE, parametresLisible } from "../../core/recherche.ts";
import {
  type Compte,
  filtreModification,
  lecteur,
  parametresModification,
  peutModifier,
} from "../comptes.ts";
import { libelles, lireInstance } from "../instance.ts";
import { contenu } from "../config.ts";
import { audience } from "../depot.ts";
import { questionDesEleves, questionsDesEleves } from "../conversations.ts";
import {
  aLegender,
  changerLecteurs,
  ecarterRevision,
  fileLegendes,
  inclureDiapositivesMasquees,
  lireDocument,
  lireNotes,
  modifierSource,
  relireLegende,
  revisionEnAttente,
  refusCertification,
  statuer,
  supprimerSource,
} from "../ingestion.ts";
import { validerInformations } from "../../core/profils.ts";
import * as ProfBibliotheque from "../vues/prof-bibliotheque.ts";
import * as ProfLegendes from "../vues/prof-legendes.ts";
import * as ProfLignes from "../vues/prof-lignes.ts";
import * as ProfQuestions from "../vues/prof-questions.ts";
import * as ProfSource from "../vues/prof-source.ts";
import * as Domaines from "../domaines.ts";
import * as DomaineVue from "../vues/domaines.ts";
import type { Env, Web } from "./web.ts";

const MODIFICATION_REFUSEE =
  "Seuls son propriétaire, les administrateurs et les enseignants de ses cours modifient cette source.";

export function routesProf(app: Hono<Env>, w: Web) {
  const { db, instance, rendre, lu, scope, idsScope, feuilleCitation } = w;

  const lignes = (c: Context<Env>, statut: string, theme: string, lot = c.req.query("lot") ?? "") =>
    db
      .prepare(
        `SELECT s.id, s.titre, s.profil, ${Domaines.nomTheme("s")} AS theme, s.format, s.statut,
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
      ) as unknown as ProfLignes.LigneSource[];
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
    const ressources = lignesVisibles(c, f.lot ? lignes(c, "", "") : toutes);
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
        html`${DomaineVue.filtre(cat, scope(c), "/prof", libelles(db), {
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
            questions: personnel ? [] : questionsDesEleves(db, lu(c)),
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
  app.get("/prof/questions", (c) =>
    c.html(
      rendre(c, "Questions des élèves", ProfQuestions.questionsProf(questionsDesEleves(db, lu(c)))),
    ),
  );
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
    return feuilleCitation(c, r?.etat === "answered" ? r.affirmations : [], e.id, "Dans le cours");
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
  const detail = (id: string, compte: Compte): ProfSource.Detail | undefined => {
    const source = db
      .prepare(`SELECT * FROM sources s WHERE s.id = ? AND ${LISIBLE}`)
      .get(parametresLisible(instance.school_id, lecteur(compte)), id) as
      | (ProfSource.Detail["source"] & {
          metadonnees: string;
          revision: number;
          proprietaire_id: string | null;
        })
      | undefined;
    if (!source) return undefined;
    const job = db
      .prepare("SELECT etat, erreur, avertissements FROM ingestion_jobs WHERE source_id = ?")
      .get(id) as { etat: string; erreur: string | null; avertissements: string } | undefined;
    let blocs: ProfSource.Detail["blocs"] = [];
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
        .all(id) as unknown as ProfSource.ImageVue[],
      blocs,
    };
  };

  const original = (d: ProfSource.Detail) =>
    readFile(contenu(d.source.id, "original", d.source.fichier));
  app.get("/prof/sources/:id", (c) => {
    const d = detail(c.req.param("id"), c.get("compte"));
    if (!d) return c.notFound();
    // Les notes de l'orateur ne vont qu'à ceux qui relisent la source. Le worker les a lues à
    // l'extraction : le serveur n'ouvre pas l'original.
    const notes =
      d.modifiable && d.source.format === "pptx" ? (lireNotes(db, d.source.id) ?? null) : undefined;
    return c.html(rendre(c, d.source.titre, ProfSource.detailSource({ ...d, notes })));
  });
  // Un original HTML ne s'ouvre pas: il lancerait ses scripts sur l'origine de Thot. Word et
  // PowerPoint se téléchargent. Une présentation peut porter des notes de l'orateur : son
  // original ne va qu'à ceux qui relisent la source.
  const TYPES_ORIGINAL: Record<string, string> = {
    pdf: "application/pdf",
    md: "text/markdown; charset=utf-8",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  app.get("/prof/sources/:id/original", async (c) => {
    const d = detail(c.req.param("id"), c.get("compte"));
    const type = d && TYPES_ORIGINAL[d.source.format];
    if (!d || !type) return c.notFound();
    if (d.source.format === "pptx" && !d.modifiable) {
      return c.text("L'original d'une présentation va à ceux qui relisent la source.", 403);
    }
    const office = d.source.format === "docx" || d.source.format === "pptx";
    return c.body(await original(d), 200, {
      "content-type": type,
      "content-disposition": office
        ? `attachment; filename*=UTF-8''${encodeURIComponent(d.source.fichier)}`
        : "inline",
      "x-content-type-options": "nosniff",
    });
  });
  // Inclure ou exclure les diapositives masquées relance l'extraction. Un texte changé devient
  // une version à relire, comme toute réextraction.
  app.post("/prof/sources/:id/diapositives-masquees", async (c) => {
    const d = detail(c.req.param("id"), c.get("compte"));
    if (!d || d.source.format !== "pptx") return c.notFound();
    if (!d.modifiable) return c.text(MODIFICATION_REFUSEE, 403);
    const inclure = (await c.req.parseBody()).inclure === "1";
    if (!inclureDiapositivesMasquees(db, d.source.id, inclure)) {
      return c.text("Extraction en cours : réessayer une fois le traitement terminé.", 409);
    }
    return c.redirect(`/prof/sources/${d.source.id}`, 303);
  });
  app.post("/prof/sources/:id/modifier", async (c) => {
    const d = detail(c.req.param("id"), c.get("compte"));
    if (!d) return c.notFound();
    if (!d.modifiable) return c.text(MODIFICATION_REFUSEE, 403);
    const b = await c.req.parseBody({ all: true });
    const titre = String(b.titre ?? "").trim();
    const date = String(b.date ?? "").trim();
    const artiste = String(b.artiste ?? "").trim();
    const mouvement = String(b.mouvement ?? "").trim();
    // Un ordre vidé retire la source de l'ordre de lecture : elle suit alors par titre.
    const ordreSaisi = String(b.ordre ?? d.meta.ordre ?? "").trim();
    const ordre = ordreSaisi ? Number(ordreSaisi) : undefined;
    if (
      !titre ||
      titre.length > 200 ||
      date.length > 40 ||
      artiste.length > 120 ||
      mouvement.length > 120 ||
      (ordre !== undefined && !Number.isFinite(ordre))
    ) {
      return c.text("Titre ou champ invalide.", 400);
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
    // Une ancienne séquence reste dans les métadonnées : le formulaire ne la montre plus.
    const meta: Record<string, unknown> = { ...d.meta, ...informations, titre, langue, ordre };
    delete meta.propositions;
    delete meta.quiz_reponse;
    try {
      modifierSource(db, d.source.id, {
        titre,
        meta,
        langue,
        audience: lecteurs,
        reponses: b.audience === undefined ? d.source.reponses : b.reponses ? 1 : 0,
        liens: b.affiliations_presentes
          ? Domaines.liensAutorises(db, c.get("compte"), Domaines.liensFormulaire(b), d.source.id)
          : undefined,
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
    try {
      statuer(db, id, c.req.param("statut") as "certifiee" | "rejetee", c.get("compte").nom);
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_SQLITE_ERROR") throw e;
      return c.text((e as Error).message, 409);
    }
    return c.html(ProfSource.statutSource(detail(id, c.get("compte"))!.source));
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

  app.get("/prof/legendes", (c) =>
    c.html(
      rendre(
        c,
        "Légendes",
        ProfLegendes.pageLegendes(
          aLegender(db, c.get("compte"), c.req.query("image")),
          fileLegendes(db, c.get("compte")),
        ),
      ),
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
      String(b.credit ?? ""),
    );
    return c.html(
      ProfLegendes.legende(aLegender(db, c.get("compte")), fileLegendes(db, c.get("compte"))),
    );
  });
}
