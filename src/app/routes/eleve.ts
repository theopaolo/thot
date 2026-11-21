import { Hono } from "hono";
import { html } from "hono/html";
import {
  CITABLE,
  chercher,
  documentsProches,
  LISIBLE,
  type Lecteur,
  parametresCitable,
  parametresLisible,
} from "../../core/recherche.ts";
import { libelles, lireInstance } from "../instance.ts";
import { config } from "../config.ts";
import { imagesLues, lireDocument } from "../ingestion.ts";
import { faitAuHasard, suggestionsDuPerimetre } from "../suggestions.ts";
import * as EleveAccueil from "../vues/eleve-accueil.ts";
import * as EleveChapitre from "../vues/eleve-chapitre.ts";
import * as EleveCommun from "../vues/eleve-commun.ts";
import * as EleveLecture from "../vues/eleve-lecture.ts";
import * as EleveRessources from "../vues/eleve-ressources.ts";
import * as Domaines from "../domaines.ts";
import * as DomaineVue from "../vues/domaines.ts";
import * as Activites from "../activites.ts";
import * as PratiqueVue from "../vues/pratique.ts";
import * as Lectures from "../lectures.ts";
import type { Env, Web } from "./web.ts";

/** Réponses admises au quiz: artiste et mouvement enregistrés, séparés par `|`. */
const QUIZ = `CASE WHEN s.profil = 'arts-appliques' THEN trim(coalesce(json_extract(s.metadonnees, '$.artiste'), '') || '|' ||
  coalesce(json_extract(s.metadonnees, '$.mouvement'), ''), '|') ELSE '' END AS quiz_reponse`;

/** Après la séance : l'ordre de lecture que l'enseignant donne, puis le titre. */
const ORDRE_LECTURE = `json_extract(s.metadonnees, '$.ordre') IS NULL,
  json_extract(s.metadonnees, '$.ordre'), s.titre`;

/** « 2 sur $ »: compteur de diapositive resté dans deux exports HTML, sans valeur pour un élève. */
const COMPTEUR_DIAPO = /^\d+ sur \$\d*$/;

export function routesEleve(app: Hono<Env>, w: Web) {
  const {
    db,
    modeles,
    instance,
    rendre,
    lu,
    mentionLecteurs,
    scope,
    idsScope,
    THEME_LU,
    sourceCertifiee,
  } = w;
  app.get("/eleve", (c) => {
    const rangs = db
      .prepare(
        `SELECT id, titre, profil, format, coalesce(json_extract(metadonnees, '$.seance'), '') AS seance,
         coalesce(json_extract(metadonnees, '$.date'), '') AS date,
         json_extract(metadonnees, '$.ordre') AS ordre,
         ${QUIZ},
         (SELECT id FROM images WHERE source_id = s.id ORDER BY position LIMIT 1) AS image_id
       FROM sources s WHERE ${CITABLE}
       ORDER BY seance, ${ORDRE_LECTURE}`,
      )
      .all(
        parametresCitable({ schoolId: instance.school_id, lecteur: lu(c), bibliotheque: true }),
      ) as EleveCommun.SourceChapitre[];
    const selection = idsScope(c);
    const visibles = rangs.filter((r) => selection.has(r.id));
    const chapitres: EleveCommun.ChapitreVue[] = [];
    const rattachements = db
      .prepare(
        `SELECT sc.*, c.nom AS cours, t.nom AS theme, c.matiere_id, m.nom AS matiere
      FROM source_cours sc JOIN cours c ON c.id = sc.cours_id
      JOIN matieres m ON m.id = c.matiere_id LEFT JOIN themes t ON t.id = sc.theme_id
      WHERE ${Domaines.MES_COURS}`,
      )
      .all(Domaines.mesCours(lu(c)));
    for (const r of visibles) {
      const liens = rattachements.filter((l) => l.source_id === r.id);
      for (const lien of liens.length ? liens : [undefined]) {
        const themeId = lien?.theme_id as string | undefined;
        const coursId = lien?.cours_id as string | undefined;
        const nom = (lien?.theme ?? "") as string;
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
            matiereId: lien?.matiere_id as string | undefined,
            matiere: lien?.matiere as string | undefined,
          };
          chapitres.push(ch);
        }
        ch.sources.push(r);
      }
    }
    // Par matière puis par cours, les sources hors cours en dernier. Dans un cours, celles sans
    // thème d'abord.
    chapitres.sort(
      (a, b) =>
        Number(!a.cours) - Number(!b.cours) ||
        (a.matiere ?? "").localeCompare(b.matiere ?? "", "fr") ||
        (a.matiereId ?? "").localeCompare(b.matiereId ?? "") ||
        (a.cours ?? "").localeCompare(b.cours ?? "", "fr") ||
        (a.coursId ?? "").localeCompare(b.coursId ?? "") ||
        a.nom.localeCompare(b.nom, "fr", { numeric: true }),
    );
    const prenom = c.get("compte").nom.split(" ")[0];
    const cat = Domaines.catalogueVisible(db, lu(c));
    const filtresDomaines = DomaineVue.filtre(cat, scope(c), "/eleve", libelles(db), {
      vue: c.req.query("vue") ?? "",
    });
    const generique =
      visibles.every((r) => r.profil === "general") || Object.values(scope(c)).some(Boolean);
    const mention = mentionLecteurs(c);
    const activites = Activites.avecAvancement(
      db,
      c.get("compte"),
      Activites.activitesEleve(db, c.get("compte"), scope(c).cours_id, scope(c).matiere_id),
    );
    // La liste rangée par cours met les activités sous leur cours. L'accueil par chapitres, sans
    // titre de cours, les liste après ses chapitres.
    if (generique) {
      const personnel = lireInstance(db).mode === "personal";
      // Un enseignant qui ne trouve rien à lire ici a souvent des ressources à relire avant.
      const aRelire =
        !visibles.length && c.get("compte").role === "enseignant"
          ? (db
              .prepare(
                `SELECT count(*) n FROM sources s WHERE ${LISIBLE} AND s.statut = 'a_relire'`,
              )
              .get(parametresLisible(instance.school_id, lu(c)))!.n as number)
          : 0;
      const titre = personnel ? "Mes documents" : "Ressources";
      return c.html(
        rendre(
          c,
          titre,
          html`<h1>${titre}</h1>
          <p class="sous-titre">${
            personnel
              ? "Tes ressources certifiées. Thot répond à tes questions en citant uniquement ces ressources."
              : "Les ressources publiées par tes enseignants. Thot répond à tes questions en citant uniquement ces ressources."
          }</p>${filtresDomaines}
          <form method="post" action="/eleve/questions" class="question-rapide">
            ${DomaineVue.champsScope(scope(c))}${EleveCommun.cleEnvoi()}
            <label for="texte">Une question sur ces ressources ?</label>
            <div class="saisie"><input type="text" id="texte" name="texte" required maxlength="1000"><button>Demander</button></div>
            ${mention ? html`<small>${mention}</small>` : ""}
          </form>
          ${
            c.req.query("vue") === "grille"
              ? EleveRessources.bureauEleve(chapitres, activites, scope(c))
              : EleveRessources.sommaireEleve(
                  chapitres,
                  activites,
                  scope(c),
                  Lectures.lues(
                    db,
                    c.get("compte").id,
                    visibles.map((r) => r.id),
                  ),
                )
          }
          ${
            visibles.length
              ? ""
              : aRelire
                ? html`<p>${aRelire} ressource${aRelire > 1 ? "s attendent leur" : " attend sa"} relecture.
                  <a href="/prof?statut=a_relire">Relire et certifier</a> : Thot ne cite que les
                  ressources certifiées.</p>`
                : Object.values(scope(c)).some(Boolean)
                  ? html`<p>Aucune ressource dans ce cours pour l'instant.</p>`
                  : html`<p>Aucune ressource publiée pour l'instant.</p>`
          }`,
        ),
      );
    }
    for (const ch of chapitres) {
      ch.questions = suggestionsDuPerimetre(db, lu(c), new Set(ch.sources.map((s) => s.id)));
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
        html`${filtresDomaines}${EleveAccueil.accueilEleve(
          prenom,
          chapitres,
          oeuvre ? undefined : fait,
          oeuvre,
          lireInstance(db).mode === "personal",
          mention,
          libelles(db),
        )}${PratiqueVue.exercices(activites)}`,
        "accueil",
      ),
    );
  });

  // Un lien partagé avant les thèmes nomme une séquence : il mène au thème de ses sources.
  app.get("/eleve/sequences/:nom", (c) => {
    const id = Domaines.themeDuChapitre(db, c.req.param("nom"), lu(c));
    const doc = c.req.query("doc");
    return c.redirect(
      `${id ? `/eleve/themes/${id}` : "/eleve/sans-sequence"}${
        doc ? `?doc=${encodeURIComponent(doc)}` : ""
      }`,
    );
  });
  /** Les sources d'un thème, ou sans `themeId` celles qui n'ont de thème dans aucun cours du lecteur. */
  const sourcesDuTheme = (l: Lecteur, themeId: string) =>
    db
      .prepare(
        `SELECT s.id, s.titre, s.profil, coalesce(json_extract(s.metadonnees, '$.seance'), '') AS seance,
         coalesce(json_extract(s.metadonnees, '$.date'), '') AS date,
         ${QUIZ},
         (SELECT id FROM images WHERE source_id = s.id ORDER BY position LIMIT 1) AS image_id
       FROM sources s WHERE ${CITABLE}
         AND ($theme != '' OR NOT EXISTS (SELECT 1 FROM source_cours sc
           WHERE sc.source_id = s.id AND sc.theme_id IS NOT NULL AND ${Domaines.MES_COURS}))
       ORDER BY seance = '', seance, ${ORDRE_LECTURE}`,
      )
      .all({
        ...parametresCitable({
          schoolId: instance.school_id,
          lecteur: l,
          bibliotheque: true,
          themeId,
        }),
        ...Domaines.mesCours(l),
      }) as EleveCommun.SourceChapitre[];
  /**
   * Le cours où se lit une source sans thème : le premier des cours du lecteur qui la rattachent,
   * et ses ressources rangées directement dans ce cours, dans l'ordre de lecture.
   */
  const coursDeLecture = (l: Lecteur, sourceId: string) =>
    db
      .prepare(
        `SELECT c.id, c.nom FROM source_cours sc JOIN cours c ON c.id = sc.cours_id
         WHERE sc.source_id = $source AND ${Domaines.MES_COURS} ORDER BY c.nom LIMIT 1`,
      )
      .get({ source: sourceId, ...Domaines.mesCours(l) }) as
      | { id: string; nom: string }
      | undefined;
  const sourcesDuCours = (l: Lecteur, coursId: string) =>
    db
      .prepare(
        `SELECT s.id, s.titre FROM sources s WHERE ${CITABLE}
         AND EXISTS (SELECT 1 FROM source_cours sc
           WHERE sc.source_id = s.id AND sc.cours_id = $cours AND sc.theme_id IS NULL)
         ORDER BY coalesce(json_extract(s.metadonnees, '$.seance'), '') = '',
           coalesce(json_extract(s.metadonnees, '$.seance'), ''), ${ORDRE_LECTURE}`,
      )
      // Le périmètre du cours restreint CITABLE à ce cours ; `$cours` y est son identifiant.
      .all(
        parametresCitable({
          schoolId: instance.school_id,
          lecteur: l,
          bibliotheque: true,
          coursId,
        }),
      ) as { id: string; titre: string }[];
  app.on("GET", ["/eleve/sans-sequence", "/eleve/themes/:theme"], (c) => {
    const themeId = c.req.param("theme") ?? "";
    const cat = Domaines.catalogueVisible(db, lu(c));
    const theme = themeId ? cat.themes.find((t) => t.id === themeId) : undefined;
    if (themeId && !theme) return c.notFound();
    const nom = theme?.nom ?? "";
    const cours = cat.cours.find((c) => c.id === theme?.cours_id);
    const matiere = cat.matieres.find((m) => m.id === cours?.matiere_id);
    const sources = sourcesDuTheme(lu(c), themeId);
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
        EleveChapitre.pageChapitre(
          nom,
          sources,
          suggestionsDuPerimetre(db, lu(c), new Set(sources.map((s) => s.id))),
          apercu(doc.id, lu(c)),
          themeId,
          theme ? `${matiere?.nom} / ${cours?.nom} / ${nom}` : "",
          mentionLecteurs(c),
          libelles(db),
        ),
      ),
    );
  });

  const apercu = (id: string, l: Lecteur): EleveChapitre.Apercu | undefined => {
    const s = sourceCertifiee(id, l);
    if (!s) return undefined;
    const images = imagesLues(db, id);
    let extrait = "";
    try {
      const texte = lireDocument(id, s.revision)
        .blocs.filter(
          (b) => b.texte !== s.titre && b.texte !== b.section && !COMPTEUR_DIAPO.test(b.texte),
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
      credit: images[0]?.credit ?? null,
      images: images.length,
      extrait,
    };
  };
  app.get("/eleve/documents/:id/apercu", (c) => {
    const a = apercu(c.req.param("id"), lu(c));
    return a ? c.html(EleveChapitre.lecteur(a, libelles(db))) : c.notFound();
  });

  // Le lecteur l'envoie quand la fin du texte paraît à l'écran.
  app.post("/eleve/sources/:id/lu", (c) => {
    const s = sourceCertifiee(c.req.param("id"), lu(c));
    if (!s) return c.notFound();
    Lectures.marquerLu(db, c.get("compte").id, s.id, s.revision);
    return c.body(null, 204);
  });

  app.get("/eleve/sources/:id", (c) => {
    const s = sourceCertifiee(c.req.param("id"), lu(c));
    if (!s) return c.notFound();
    const images = imagesLues(db, s.id);
    const debut = Number(c.req.query("debut"));
    const fin = Number(c.req.query("fin"));
    const marque =
      Number.isInteger(debut) && Number.isInteger(fin) && fin > debut
        ? ([debut, fin] as [number, number])
        : undefined;
    // Une ancienne réponse ouvre la révision qu'elle cite. Une révision en attente ne se lit pas.
    const revision = Number(c.req.query("revision") ?? s.revision);
    if (!Number.isInteger(revision) || revision < 1 || revision > s.revision) return c.notFound();
    // Un cours général se lit de ressource en ressource : dans son thème, sinon dans son cours.
    const cours = s.profil === "general" && !s.theme_id ? coursDeLecture(lu(c), s.id) : undefined;
    const voisins =
      s.profil !== "general"
        ? []
        : s.theme_id
          ? sourcesDuTheme(lu(c), s.theme_id)
          : cours
            ? sourcesDuCours(lu(c), cours.id)
            : [];
    return c.html(
      rendre(
        c,
        s.titre,
        EleveLecture.lectureSource(
          s,
          images,
          lireDocument(s.id, revision).blocs.filter((b) => !COMPTEUR_DIAPO.test(b.texte)),
          Domaines.champsMatiere(db, s.matiere_id, s.profil ?? "general"),
          libelles(db),
          marque,
          revision < s.revision,
          voisins,
          Activites.avecAvancement(
            db,
            c.get("compte"),
            Activites.activitesEleve(db, c.get("compte")).filter((a) => Activites.couvre(a, s.id)),
          ),
          cours,
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
            libelles(db),
          )}${EleveRessources.recherche("", [], scope(c))}`,
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
    const proches = documentsProches(r, config.seuil);
    const ids = proches.map((x) => x.source_id);
    const sources = new Map(
      db
        .prepare(
          `SELECT s.id, s.titre, s.profil, coalesce(t.id, '') AS theme_id, coalesce(t.nom, '') AS theme,
           coalesce(json_extract(s.metadonnees, '$.date'), '') AS date,
           (SELECT id FROM images WHERE source_id = s.id ORDER BY position LIMIT 1) AS image_id
         FROM sources s ${THEME_LU} WHERE s.id IN (${ids.map(() => "?").join(",")}) AND ${CITABLE}`,
        )
        .all(
          {
            ...parametresCitable({
              schoolId: instance.school_id,
              lecteur: lu(c),
              bibliotheque: true,
            }),
            ...Domaines.mesCours(lu(c)),
          },
          ...ids,
        )
        .map((s) => [s.id as string, s as unknown as EleveRessources.Trouve]),
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
          libelles(db),
          { q },
        )}${EleveRessources.recherche(q, trouves, scope(c))}`,
      ),
    );
  });
}
