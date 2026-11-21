import type { Context, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Modeles } from "../../core/modeles.ts";
import type { Affirmation } from "../../core/reponse.ts";
import { CITABLE, type Lecteur, parametresCitable } from "../../core/recherche.ts";
import { type Compte, lecteur } from "../comptes.ts";
import { lireInstance } from "../instance.ts";
import type { Db } from "../db.ts";
import { lireDocument, nombreLegendes } from "../ingestion.ts";
import { boucleReponses } from "../reponses.ts";
import { page } from "../vues/page.ts";
import * as Eleve from "../vues/eleve.ts";
import * as Domaines from "../domaines.ts";

export type Env = { Variables: { compte: Compte } };

const CLES_PERIMETRE = ["matiere_id", "cours_id", "theme_id", "matieres", "chapitre"];
/**
 * Le cookie `perimetre` garde le dernier cours choisi : une page de ressources ouverte sans
 * périmètre le reprend. « Tous les cours » envoie un périmètre vide, qui l'efface. Un lot déposé
 * s'affiche en entier, hors du périmètre retenu.
 */
export async function retenirPerimetre(c: Context<Env>, next: Next) {
  const url = new URL(c.req.url);
  if (CLES_PERIMETRE.some((k) => url.searchParams.has(k))) {
    const p = new URLSearchParams(
      CLES_PERIMETRE.flatMap((k) => url.searchParams.getAll(k).map((v) => [k, v])).filter(
        ([, v]) => v,
      ),
    );
    setCookie(c, "perimetre", String(p), {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      maxAge: p.size ? 31536000 : 0,
    });
    return next();
  }
  const retenu = getCookie(c, "perimetre");
  if (!retenu || url.searchParams.has("lot")) return next();
  for (const [k, v] of new URLSearchParams(retenu)) url.searchParams.append(k, v);
  return c.redirect(url.pathname + url.search);
}
export type Reponses = ReturnType<typeof boucleReponses>;

/** La base, les modèles, la boucle de réponses et les aides de page que partagent les routes. */
export function contexteWeb(db: Db, modeles: Modeles, reponses: Reponses) {
  const instance = lireInstance(db);
  const rendre = (c: Context<Env>, titre: string, corps: unknown, classe = "") => {
    const compte = c.get("compte");
    return page(
      titre,
      compte ?? null,
      corps,
      classe,
      c.req.path,
      getCookie(c, "rail") === "replie",
      lireInstance(db),
      compte?.role === "enseignant" ? nombreLegendes(db, compte) : 0,
    );
  };

  const lu = (c: Context<Env>) => lecteur(c.get("compte"));
  // Qui lit les questions d'un élève : les enseignants de ses cours, ou tous s'il n'en a aucun.
  const mentionLecteurs = (c: Context<Env>) =>
    lireInstance(db).mode === "personal"
      ? ""
      : Domaines.coursDuCompte(db, c.get("compte").id).size
        ? "Les enseignants de tes cours lisent tes questions."
        : "Les enseignants lisent tes questions.";
  /** Une page ou un lien d'avant les thèmes nomme encore un chapitre : son thème le remplace. */
  const scopeChapitre = (c: Context<Env>, champs: Record<string, unknown>) => {
    const p = Domaines.lireScope(champs);
    if (champs.chapitre && !p.theme_id) {
      p.theme_id = Domaines.themeDuChapitre(db, String(champs.chapitre), lu(c));
    }
    return p;
  };
  const scope = (c: Context<Env>) =>
    scopeChapitre(c, { ...c.req.query(), matieres: c.req.queries("matieres") });
  const idsScope = (c: Context<Env>) => Domaines.sourcesPerimetre(db, scope(c));
  // Le thème `t` d'une source `s`, pris dans un cours du lecteur : il ouvre la page et le
  // périmètre de ce thème. Paramètres : `Domaines.mesCours()`.
  const THEME_LU = `LEFT JOIN themes t ON t.id = (SELECT sc.theme_id FROM source_cours sc
    WHERE sc.source_id = s.id AND sc.theme_id IS NOT NULL AND ${Domaines.MES_COURS}
    ORDER BY sc.theme_id LIMIT 1)`;
  const sourceCertifiee = (id: string, l: Lecteur) =>
    db
      .prepare(
        `SELECT s.id, s.titre, s.enseignant, s.profil, s.matiere_id, s.langue, s.metadonnees, s.revision,
         coalesce(t.id, '') AS theme_id, coalesce(t.nom, '') AS theme,
         coalesce(json_extract(s.metadonnees, '$.seance'), '') AS seance,
         coalesce(json_extract(s.metadonnees, '$.date'), '') AS date
       FROM sources s ${THEME_LU}
       WHERE s.id = ? AND ${CITABLE}`,
      )
      .get(
        {
          ...parametresCitable({ schoolId: instance.school_id, lecteur: l, bibliotheque: true }),
          ...Domaines.mesCours(l),
        },
        id,
      ) as Eleve.SourceLue | undefined;
  /** La feuille du passage `:n` d'une réponse ou d'une explication `id`, s'il est lisible. */
  const feuilleCitation = (
    c: Context<Env>,
    affirmations: Affirmation[],
    id: string,
    tete?: string,
  ) => {
    const n = Number(c.req.param("n"));
    const a = affirmations[n];
    const source = a && sourceCertifiee(a.source_id, lu(c));
    if (!a || !source) return c.html(Eleve.panneauSource(undefined, undefined, tete));
    const suite = { id, n, total: affirmations.length };
    if (a.debut === undefined || a.fin === undefined) {
      return c.html(Eleve.panneauSource({ ...a, enseignant: source.enseignant }, suite, tete));
    }
    const revision = a.revision ?? 1;
    const { debut, fin } = a;
    // Les blocs qui portent le passage, rendus comme dans le lecteur : un tableau reste un tableau.
    const blocs = lireDocument(a.source_id, revision).blocs.filter(
      (b) => b.debut < fin && b.fin > debut,
    );
    return c.html(
      Eleve.panneauSource({ ...a, revision, enseignant: source.enseignant, blocs }, suite, tete),
    );
  };
  return {
    db,
    modeles,
    reponses,
    instance,
    rendre,
    lu,
    mentionLecteurs,
    scopeChapitre,
    scope,
    idsScope,
    THEME_LU,
    sourceCertifiee,
    feuilleCitation,
  };
}
export type Web = ReturnType<typeof contexteWeb>;
