import { readFile } from "node:fs/promises";
import { type Context, Hono } from "hono";
import { html } from "hono/html";
import {
  FILTRE_ACCES,
  filtreAcces,
  indexerSource,
  parametresAcces,
  transaction,
} from "../../core/recherche.ts";
import { notesPptx } from "../../core/pptx.ts";
import {
  type Compte,
  filtreModification,
  parametresModification,
  peutLire,
  peutModifier,
} from "../comptes.ts";
import { libelles } from "../instance.ts";
import { contenu } from "../config.ts";
import { maintenant } from "../db.ts";
import { audience } from "../depot.ts";
import {
  chunksSource,
  ecarterRevision,
  lireDocument,
  relireLegende,
  revisionEnAttente,
  statuer,
  supprimerSource,
} from "../ingestion.ts";
import { validerInformations } from "../../core/profils.ts";
import * as Prof from "../vues/prof.ts";
import * as Domaines from "../domaines.ts";
import * as DomaineVue from "../vues/domaines.ts";
import * as Activites from "../activites.ts";
import type { Env, Web } from "./web.ts";

/** Le nom du thème d'une source, le premier par ordre alphabétique si elle en a plusieurs. */
const nomTheme = (s: string) =>
  `(SELECT min(t.nom) FROM source_cours sc JOIN themes t ON t.id = sc.theme_id WHERE sc.source_id = ${s}.id)`;

const MODIFICATION_REFUSEE =
  "Seuls son propriétaire, les administrateurs et les enseignants de ses cours modifient cette source.";

export function routesProf(app: Hono<Env>, w: Web) {
  const { db, instance, rendre, lu, scope, idsScope } = w;

  const lignes = (c: Context<Env>, statut: string, theme: string) =>
    db
      .prepare(
        `SELECT s.id, s.titre, s.profil, ${nomTheme("s")} AS theme, s.format, s.statut,
         s.audience, coalesce(${filtreModification()}, 0) AS modifiable,
         j.etat, j.erreur,
         (SELECT count(*) FROM images i WHERE i.source_id = s.id AND i.legende_statut = 'unreviewed') AS images_a_relire,
         EXISTS (SELECT 1 FROM revisions r WHERE r.source_id = s.id AND r.n > s.revision) AS revision_en_attente,
         (SELECT count(*) FROM images i WHERE i.source_id = s.id) AS images,
         (SELECT count(legende) FROM images i WHERE i.source_id = s.id) AS legendes,
         (SELECT id FROM images WHERE source_id = s.id ORDER BY position LIMIT 1) AS image_id
       FROM sources s JOIN ingestion_jobs j ON j.source_id = s.id
       WHERE s.school_id = ? AND ${FILTRE_ACCES} AND (? = '' OR s.statut = ?)
         AND (? = '' OR theme = ?) AND (? = '' OR s.lot_id = ?)
       ORDER BY theme, s.titre`,
      )
      .all(
        ...parametresModification(c.get("compte")),
        instance.school_id,
        ...parametresAcces(lu(c)),
        statut,
        statut,
        theme,
        theme,
        c.req.query("lot") ?? "",
        c.req.query("lot") ?? "",
      ) as unknown as Prof.LigneSource[];
  const filtres = (c: Context<Env>) => ({
    statut: c.req.query("statut") ?? "",
    theme: c.req.query("theme") ?? "",
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
      ...Map.groupBy(ressources, (s) => `${s.theme ?? ""}\0${statut(s)}`).values(),
    ].map((liste) => ({
      theme: liste[0].theme ?? "",
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
            (s) => (!f.statut || statut(s) === f.statut) && (!f.theme || s.theme === f.theme),
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
  // Un enseignant lit les questions posées dans ses cours. Sans cours choisi, celles des élèves
  // avec qui il partage un cours, ou de tout élève qui n'a aucun cours. Un administrateur lit tout.
  app.get("/prof/questions", (c) => {
    const l = lu(c);
    const messages = db
      .prepare(
        `SELECT m.id, m.question, m.etat, m.avis, m.cree_le, c.nom,
         json_extract(m.resultat, '$.code') AS code,
         coalesce((SELECT nom FROM themes WHERE id = m.theme_id), ${nomTheme("s")},
           ${nomTheme("s2")}, '') AS chapitre
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
        lignes(c, f.statut, f.theme).filter((s) => selection.has(s.id)),
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
        Activites.revoirActivites(db, id);
      }
    } else {
      const statut = b.statut === "certifiee" ? "certifiee" : "rejetee";
      for (const id of ids) statuer(db, id, statut, c.get("compte").nom);
    }
    return c.redirect(`/prof?${new URLSearchParams(filtres(c))}`, 303);
  });
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

  const original = (d: Prof.Detail) => readFile(contenu(d.source.id, "original", d.source.fichier));
  app.get("/prof/sources/:id", async (c) => {
    const d = detail(c.req.param("id"), c.get("compte"));
    if (!d) return c.notFound();
    // Les notes de l'orateur se lisent dans l'original, par ceux qui relisent la source seulement.
    let notes: Prof.Detail["notes"];
    if (d.modifiable && d.source.format === "pptx") {
      try {
        notes = notesPptx(await original(d));
      } catch (e) {
        notes = (e as Error).message;
      }
    }
    return c.html(rendre(c, d.source.titre, Prof.detailSource({ ...d, notes })));
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
    const relancee = transaction(db, () => {
      const { changes } = db
        .prepare(
          `UPDATE ingestion_jobs SET etat = 'received', tentatives = 0, erreur = NULL,
           verrou_expire_le = NULL, maj_le = ?
         WHERE source_id = ? AND etat IN ('awaiting_review', 'failed')`,
        )
        .run(maintenant(), d.source.id);
      if (changes) {
        db.prepare(
          `UPDATE sources SET metadonnees = json_set(metadonnees, '$.diapositives_masquees', json(?))
         WHERE id = ?`,
        ).run(JSON.stringify(inclure), d.source.id);
      }
      return changes > 0;
    });
    if (!relancee) {
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
    if (
      !titre ||
      titre.length > 200 ||
      date.length > 40 ||
      artiste.length > 120 ||
      mouvement.length > 120
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
    const meta: Record<string, unknown> = { ...d.meta, ...informations, titre, langue };
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
        Activites.revoirActivites(db, d.source.id);
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
       ORDER BY (i.id = ?) DESC, ${nomTheme("s")}, s.titre, i.position LIMIT 1`,
      )
      .get(...file(c), imageId ?? "") as Prof.ALegender | undefined;
    return i && { ...i, restantes };
  };
  // Les douze prochaines images de la file, dans l'ordre où elles seront proposées.
  const fileLegendes = (c: Context<Env>) =>
    db
      .prepare(
        `SELECT i.id, s.titre FROM images i JOIN sources s ON s.id = i.source_id WHERE ${FILE}
       ORDER BY ${nomTheme("s")}, s.titre, i.position LIMIT 12`,
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
      String(b.credit ?? ""),
    );
    return c.html(Prof.legende(aLegender(c), fileLegendes(c)));
  });
}
