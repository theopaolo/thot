import { readFile } from "node:fs/promises";
import type { Hono } from "hono";
import { LISIBLE, parametresLisible } from "../../core/recherche.ts";
import { validerInformations } from "../../core/profils.ts";
import { type Compte, lecteur, peutModifier } from "../comptes.ts";
import { contenu } from "../config.ts";
import { audience } from "../depot.ts";
import * as Domaines from "../domaines.ts";
import {
  aLegender,
  ecarterRevision,
  fileLegendes,
  imagesEnAttente,
  inclureDiapositivesMasquees,
  lireDocument,
  lireNotes,
  modifierSource,
  relireLegende,
  revisionEnAttente,
  statuer,
  supprimerSource,
} from "../ingestion.ts";
import { libelles } from "../instance.ts";
import * as ProfLegendes from "../vues/prof-legendes.ts";
import * as ProfSource from "../vues/prof-source.ts";
import type { Env, Web } from "./web.ts";

export function routesProfSource(app: Hono<Env>, w: Web) {
  const modificationRefusee = () =>
    `Seuls son propriétaire, les administrateurs et les enseignants de ses ${libelles(w.db).formes.cours.noms} modifient cette source.`;
  const { db, instance, rendre } = w;

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
        images: imagesEnAttente(db, id, attente.n),
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
    if (!d.modifiable) return c.text(modificationRefusee(), 403);
    const inclure = (await c.req.parseBody()).inclure === "1";
    if (!inclureDiapositivesMasquees(db, d.source.id, inclure)) {
      return c.text("Extraction en cours : réessayer une fois le traitement terminé.", 409);
    }
    return c.redirect(`/prof/sources/${d.source.id}`, 303);
  });
  app.post("/prof/sources/:id/modifier", async (c) => {
    const d = detail(c.req.param("id"), c.get("compte"));
    if (!d) return c.notFound();
    if (!d.modifiable) return c.text(modificationRefusee(), 403);
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
    if (!d.modifiable) return c.text(modificationRefusee(), 403);
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
    if (!d.modifiable) return c.text(modificationRefusee(), 403);
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
      return c.text(modificationRefusee(), 403);
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
