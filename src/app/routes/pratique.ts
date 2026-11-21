import { type Context, Hono } from "hono";
import type { Contenu, Explication, Question } from "../../core/activite.ts";
import { refusee, valeur } from "../../core/questions.ts";
import * as Activites from "../activites.ts";
import * as PratiqueVue from "../vues/pratique.ts";
import { lettre } from "../vues/questions.ts";
import type { Env, Web } from "./web.ts";

/**
 * La valeur d'une question telle que `valeur()` l'attend. Le navigateur envoie, pour une question
 * à choix, les lettres affichées à l'élève : elles redeviennent des identifiants d'options.
 */
function recue(q: Question, compteId: string, brut: unknown) {
  if (q.type !== "choix" && q.type !== "choix_multiple") return brut;
  const options = PratiqueVue.optionsAffichees(q, compteId);
  const ids = [brut ?? []].flat().map((l) => options.find((_, i) => lettre(i) === l)?.id ?? "");
  return q.type === "choix" ? ids[0] : ids;
}

const PERIMEE =
  "Cette série a changé pendant que tu répondais, et rien n'a été enregistré. Relis les questions : ce que tu avais écrit est resté dans son champ, tes choix sont à refaire.";

/**
 * Ce que l'élève a écrit dans les réponses à taper et rédigées, pour le lui rendre dans une page
 * qui refuse sa saisie. Un choix ne se reprend pas : sa lettre désigne une option de la version
 * que l'élève lisait.
 */
const textes = (contenu: Contenu, corps: Record<string, unknown>) =>
  Object.fromEntries(
    contenu.questions.flatMap((q) => {
      const v = corps[q.id];
      return (q.type === "terme" || q.type === "redigee") && typeof v === "string"
        ? [[q.id, v.replace(/\r\n?/g, "\n")]]
        : [];
    }),
  );

const INVALIDE: Record<Question["type"], string> = {
  choix: "Choisis une réponse.",
  choix_multiple: "Coche au moins une option.",
  terme: "Ta réponse : 1 à 200 caractères.",
  redigee: "Ta réponse : 1 à 4000 caractères.",
};

/** La page de l'élève, son aperçu par l'enseignant, les réponses de l'élève et les images. */
export function routesPratique(app: Hono<Env>, w: Web) {
  const { db, rendre, feuilleCitation } = w;
  const activiteProf = (c: Context<Env>) =>
    Activites.activiteProf(db, c.get("compte"), c.req.param("id")!);
  const titres = (contenu: Contenu) =>
    new Map(
      (
        db
          .prepare("SELECT id, titre FROM sources WHERE id IN (SELECT value FROM json_each(?))")
          .all(JSON.stringify(contenu.questions.flatMap((q) => q.ou ?? []))) as {
          id: string;
          titre: string;
        }[]
      ).map((s) => [s.id, s.titre]),
    );
  /**
   * La page de l'élève, ou son aperçu, qui n'a jamais de tentative donc aucun corrigé. `refus` :
   * pourquoi sa saisie n'est pas enregistrée, et le texte qu'elle portait.
   */
  const pageActivite = (
    c: Context<Env>,
    a: Activites.Activite,
    apercu = false,
    refus?: { alerte: string; saisie: Record<string, string> },
  ) => {
    const compte = c.get("compte");
    const commun = { a, relecteur: Activites.relecteur(db, a), apercu };
    if (a.type === "explication") {
      return rendre(
        c,
        a.titre,
        PratiqueVue.explication({ ...commun, contenu: JSON.parse(a.contenu) as Explication }),
      );
    }
    const contenu = JSON.parse(a.contenu) as Contenu;
    return rendre(
      c,
      a.titre,
      PratiqueVue.pratique({
        ...commun,
        contenu,
        compteId: compte.id,
        tentative: apercu ? undefined : Activites.tentative(db, compte, a),
        titres: titres(contenu),
        confirmer: c.req.query("confirmer") !== undefined,
        enregistree: c.req.query("enregistree") !== undefined,
        ...refus,
      }),
    );
  };
  app.get("/prof/activites/:id/apercu", (c) => {
    const a = activiteProf(c);
    return a ? c.html(pageActivite(c, a, true)) : c.notFound();
  });
  // Une activité se lit publiée, dans un cours du compte, tant que ses preuves tiennent. Le corrigé
  // d'une question n'est rendu que lorsque `corrigee()` le permet.
  const activiteEleve = (c: Context<Env>) =>
    Activites.activiteEleve(db, c.get("compte"), c.req.param("id")!);
  const exerciceEleve = (c: Context<Env>) => {
    const a = activiteEleve(c);
    return a?.type === "exercice" ? a : undefined;
  };
  app.get("/eleve/activites/:id", (c) => {
    const a = activiteEleve(c);
    return a ? c.html(pageActivite(c, a)) : c.notFound();
  });
  // Les passages d'une explication, pour l'élève ou dans l'aperçu de l'enseignant.
  const passagesExplication = (c: Context<Env>, a?: Activites.Activite) =>
    a?.type === "explication"
      ? feuilleCitation(c, (JSON.parse(a.contenu) as Explication).affirmations, a.id)
      : c.notFound();
  app.get("/eleve/activites/:id/citations/:n", (c) => passagesExplication(c, activiteEleve(c)));
  app.get("/prof/activites/:id/citations/:n", (c) => passagesExplication(c, activiteProf(c)));

  /**
   * L'exercice, sa série et le formulaire reçu. `perimee` : la page à rendre avec 409 quand le
   * formulaire ne porte pas la version publiée. Ses lettres désignent les options d'une autre
   * version, donc rien n'en est décodé.
   */
  const recu = async (c: Context<Env>) => {
    const a = exerciceEleve(c);
    if (!a) return undefined;
    const contenu = JSON.parse(a.contenu) as Contenu;
    const corps = await c.req.parseBody({ all: true });
    const perimee =
      Number(corps.revision) === a.revision
        ? undefined
        : pageActivite(c, a, false, { alerte: PERIMEE, saisie: textes(contenu, corps) });
    return { a, contenu, corps, perimee };
  };

  // Une série corrigée après sa remise. Remettre avec des questions sans réponse enregistre le
  // brouillon et demande de confirmer.
  app.post("/eleve/activites/:id/reponses", async (c) => {
    const x = await recu(c);
    if (!x) return c.notFound();
    if (x.perimee) return c.html(x.perimee, 409);
    const { a, contenu, corps } = x;
    if (contenu.correction !== "serie") return c.notFound();
    const compte = c.get("compte");
    const brutes = Object.fromEntries(
      contenu.questions.map((q) => [q.id, recue(q, compte.id, corps[q.id])]),
    );
    const sansReponse = contenu.questions.some((q) => valeur(q, brutes[q.id]) === null);
    const remettre =
      corps.remettre !== undefined && (!sansReponse || corps.confirmer !== undefined);
    const r = Activites.enregistrerReponses(db, compte, a, brutes, remettre);
    if (r === "refus") return c.text("Cette série est déjà remise.", 409);
    if (r === "refusee") {
      const n = contenu.questions.flatMap((q, i) => (refusee(q, brutes[q.id]) ? [i + 1] : []));
      const alerte =
        n.length > 1
          ? `Les réponses aux questions ${n.join(", ")} ne sont pas enregistrées : elles sont trop longues ou invalides. Tes réponses précédentes à ces questions sont gardées. Corrige-les, puis enregistre de nouveau.`
          : `La réponse à la question ${n[0]} n'est pas enregistrée : elle est trop longue ou invalide. Ta réponse précédente à cette question est gardée. Corrige-la, puis enregistre de nouveau.`;
      return c.html(pageActivite(c, a, false, { alerte, saisie: textes(contenu, corps) }), 400);
    }
    const suite =
      r === "rendue"
        ? "#bilan"
        : corps.remettre !== undefined
          ? "?confirmer#remise"
          : "?enregistree#remise";
    return c.redirect(`/eleve/activites/${a.id}${suite}`, 303);
  });
  // Une question corrigée dès qu'elle est finie.
  app.post("/eleve/activites/:id/questions/:q", async (c) => {
    const x = await recu(c);
    if (!x) return c.notFound();
    if (x.perimee) return c.html(x.perimee, 409);
    const { a, contenu, corps } = x;
    const q = contenu.questions.find((y) => y.id === c.req.param("q"));
    if (!q || contenu.correction !== "question") return c.notFound();
    const compte = c.get("compte");
    const r = Activites.essayer(db, compte, a, q.id, recue(q, compte.id, corps[q.id]));
    if (r === "invalide") return c.text(INVALIDE[q.type], 400);
    if (r === "refus") return c.text("Cette question est déjà finie.", 409);
    return c.redirect(`/eleve/activites/${a.id}#q-${q.id}`, 303);
  });
  app.post("/eleve/activites/:id/tentatives/:tentative/criteres/:q", async (c) => {
    const a = exerciceEleve(c);
    if (!a) return c.notFound();
    const b = await c.req.parseBody({ all: true });
    const coches = [b.criteres ?? []].flat().map(Number);
    const q = c.req.param("q");
    return Activites.cocher(db, c.get("compte"), a, c.req.param("tentative"), q, coches)
      ? c.redirect(`/eleve/activites/${a.id}#q-${q}`, 303)
      : c.notFound();
  });
  app.post("/eleve/activites/:id/recommencer", (c) => {
    const a = exerciceEleve(c);
    if (!a) return c.notFound();
    return Activites.recommencer(db, c.get("compte"), a)
      ? c.redirect(`/eleve/activites/${a.id}`, 303)
      : c.text("Ton enseignant n'a pas demandé de reprendre cette série.", 409);
  });

  // Une image déposée avec l'activité : pour un enseignant de ses cours, ou pour l'élève à qui elle
  // est servie, si sa version publiée la montre. Un élève membre d'un cours passerait
  // `activiteProf`, qui ne regarde pas le rôle : seul un enseignant l'essaie.
  app.get("/activites/:id/images/:fichier", async (c) => {
    const compte = c.get("compte");
    const fichier = c.req.param("fichier");
    const prof = compte.role === "enseignant" ? activiteProf(c) : undefined;
    const eleve = prof ? undefined : activiteEleve(c);
    const a =
      prof ??
      (eleve &&
      eleve.type === "exercice" &&
      (JSON.parse(eleve.contenu) as Contenu).questions.some((q) => q.image?.fichier === fichier)
        ? eleve
        : undefined);
    const image = a && (await Activites.lireImage(a.id, fichier));
    if (!image) return c.notFound();
    return c.body(image.octets, 200, {
      "content-type": image.mime,
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
    });
  });
}
