import { Hono } from "hono";
import { html } from "hono/html";
import {
  chercher,
  documentsProches,
  FILTRE_ACCES,
  type Lecteur,
  parametresAcces,
} from "../../core/recherche.ts";
import { libelles, lireInstance } from "../instance.ts";
import { config } from "../config.ts";
import { lireDocument } from "../ingestion.ts";
import { faitAuHasard, suggestionsDuPerimetre } from "../suggestions.ts";
import * as Eleve from "../vues/eleve.ts";
import * as Domaines from "../domaines.ts";
import * as DomaineVue from "../vues/domaines.ts";
import * as Activites from "../activites.ts";
import * as ActiviteVue from "../vues/activites.ts";
import type { Env, Web } from "./web.ts";

/** Réponses admises au quiz: artiste et mouvement enregistrés, séparés par `|`. */
const QUIZ = `CASE WHEN s.profil = 'arts-appliques' THEN trim(coalesce(json_extract(s.metadonnees, '$.artiste'), '') || '|' ||
  coalesce(json_extract(s.metadonnees, '$.mouvement'), ''), '|') ELSE '' END AS quiz_reponse`;

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
        `SELECT id, titre, profil, coalesce(json_extract(metadonnees, '$.seance'), '') AS seance,
         coalesce(json_extract(metadonnees, '$.date'), '') AS date,
         ${QUIZ},
         (SELECT id FROM images WHERE source_id = s.id ORDER BY position LIMIT 1) AS image_id
       FROM sources s WHERE statut = 'certifiee' AND school_id = ? AND ${FILTRE_ACCES}
       ORDER BY seance, titre`,
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
          };
          chapitres.push(ch);
        }
        ch.sources.push(r);
      }
    }
    // Par cours, les sources hors cours en dernier. Dans un cours, celles sans thème d'abord.
    chapitres.sort(
      (a, b) =>
        Number(!a.cours) - Number(!b.cours) ||
        (a.cours ?? "").localeCompare(b.cours ?? "", "fr") ||
        (a.coursId ?? "").localeCompare(b.coursId ?? "") ||
        a.nom.localeCompare(b.nom, "fr", { numeric: true }),
    );
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
    const activites = Activites.activitesEleve(
      db,
      c.get("compte"),
      scope(c).cours_id,
      scope(c).matiere_id,
    );
    // La liste rangée par cours met les activités sous leur cours. L'accueil par chapitres, sans
    // titre de cours, les liste après ses chapitres.
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
          ${Eleve.ressourcesParCours(chapitres, c.req.query("vue") === "grille", activites)}
          ${!visibles.length ? html`<p>Aucune ressource dans ce périmètre.</p>` : ""}`,
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
        html`${filtresDomaines}${Eleve.accueilEleve(
          prenom,
          chapitres,
          oeuvre ? undefined : fait,
          oeuvre,
          lireInstance(db).mode === "personal",
          mention,
          libelles(db),
        )}${ActiviteVue.exercices(activites)}`,
        "accueil",
      ),
    );
  });

  // Un lien partagé avant les thèmes nomme une séquence : il mène au thème de ses sources.
  app.get("/eleve/sequences/:nom", (c) => {
    const id = Domaines.themeDuChapitre(db, c.req.param("nom"), c.get("compte").id);
    const doc = c.req.query("doc");
    return c.redirect(
      `${id ? `/eleve/themes/${id}` : "/eleve/sans-sequence"}${
        doc ? `?doc=${encodeURIComponent(doc)}` : ""
      }`,
    );
  });
  // Sans thème : les sources qui n'ont de thème dans aucun cours du lecteur.
  app.on("GET", ["/eleve/sans-sequence", "/eleve/themes/:theme"], (c) => {
    const themeId = c.req.param("theme") ?? "";
    const cat = Domaines.catalogueVisible(db, lu(c));
    const theme = themeId ? cat.themes.find((t) => t.id === themeId) : undefined;
    if (themeId && !theme) return c.notFound();
    const nom = theme?.nom ?? "";
    const cours = cat.cours.find((c) => c.id === theme?.cours_id);
    const matiere = cat.matieres.find((m) => m.id === cours?.matiere_id);
    const sources = db
      .prepare(
        `SELECT s.id, s.titre, s.profil, coalesce(json_extract(s.metadonnees, '$.seance'), '') AS seance,
         coalesce(json_extract(s.metadonnees, '$.date'), '') AS date,
         ${QUIZ},
         (SELECT id FROM images WHERE source_id = s.id ORDER BY position LIMIT 1) AS image_id
       FROM sources s WHERE s.school_id = ? AND s.statut = 'certifiee' AND ${FILTRE_ACCES}
         AND CASE WHEN ? = '' THEN NOT EXISTS (SELECT 1 FROM source_cours sc
             WHERE sc.source_id = s.id AND sc.theme_id IS NOT NULL AND ${Domaines.MES_COURS})
           ELSE EXISTS (SELECT 1 FROM source_cours sc WHERE sc.source_id = s.id AND sc.theme_id = ?) END
       ORDER BY seance = '', seance, s.titre`,
      )
      .all(
        instance.school_id,
        ...parametresAcces(lu(c)),
        themeId,
        ...Domaines.mesCours(lu(c)),
        themeId,
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

  const apercu = (id: string, l: Lecteur): Eleve.Apercu | undefined => {
    const s = sourceCertifiee(id, l);
    if (!s) return undefined;
    const images = db
      .prepare(
        `SELECT id, CASE WHEN legende_statut = 'certified' THEN legende END AS legende, credit
       FROM images WHERE source_id = ? ORDER BY position`,
      )
      .all(id) as { id: string; legende: string | null; credit: string | null }[];
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
      credit: images[0]?.credit ?? null,
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
        `SELECT id, CASE WHEN legende_statut = 'certified' THEN legende END AS legende, credit
       FROM images WHERE source_id = ? ORDER BY position`,
      )
      .all(s.id) as { id: string; legende: string | null; credit: string | null }[];
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
    const proches = documentsProches(r, config.seuil);
    const ids = proches.map((x) => x.source_id);
    const sources = new Map(
      db
        .prepare(
          `SELECT s.id, s.titre, s.profil, coalesce(t.id, '') AS theme_id, coalesce(t.nom, '') AS theme,
           coalesce(json_extract(s.metadonnees, '$.date'), '') AS date,
           (SELECT id FROM images WHERE source_id = s.id ORDER BY position LIMIT 1) AS image_id
         FROM sources s ${THEME_LU} WHERE s.id IN (${ids.map(() => "?").join(",")})
           AND s.statut = 'certifiee' AND s.school_id = ? AND ${FILTRE_ACCES}`,
        )
        .all(...Domaines.mesCours(lu(c)), ...ids, instance.school_id, ...parametresAcces(lu(c)))
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
}
