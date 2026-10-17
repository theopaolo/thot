import { type Context, Hono } from "hono";
import { html } from "hono/html";
import { streamSSE } from "hono/streaming";
import type { Resultat } from "../../core/reponse.ts";
import { FILTRE_ACCES, type Lecteur, MAX_MATIERES, parametresAcces } from "../../core/recherche.ts";
import { type Compte, lecteur } from "../comptes.ts";
import { libelles, lireInstance } from "../instance.ts";
import { config } from "../config.ts";
import { attendreChangement } from "../reponses.ts";
import { questionsProches } from "../../core/suggestions.ts";
import { suggestionsDuPerimetre } from "../suggestions.ts";
import * as Eleve from "../vues/eleve.ts";
import * as Conversations from "../conversations.ts";
import * as Domaines from "../domaines.ts";
import type { Env, Web } from "./web.ts";

type Perimetre = Domaines.Scope;

export function routesChat(app: Hono<Env>, w: Web) {
  const {
    db,
    modeles,
    reponses,
    instance,
    rendre,
    lu,
    mentionLecteurs,
    scopeChapitre,
    scope,
    sourceCertifiee,
    feuilleCitation,
  } = w;
  // Un échange nomme son périmètre quand il diffère de celui de l'échange précédent.
  const messagesDe = (compte: Compte, conversationId: string, nomme: (p: Perimetre) => string) => {
    const lignes = Conversations.echanges(db, compte, conversationId);
    return lignes.map((m, i): Eleve.MessageVue => ({
      ...m,
      resultat: m.resultat && JSON.stringify(m.resultat),
      perimetre: i && !Conversations.memePerimetre(lignes[i - 1], m) ? nomme(m) : undefined,
    }));
  };

  // Un refus rechargé ne repaie pas le reclasseur : ses questions proches restent en mémoire.
  // ponytail: perdues au redémarrage, le premier affichage suivant les recalcule.
  const proches = new Map<string, string[]>();
  const ideesPour = async (l: Lecteur, r: Resultat, question = "", messageId = "") => {
    const m = messageId
      ? db
          .prepare("SELECT matiere_id, cours_id, theme_id, matieres FROM messages WHERE id = ?")
          .get(messageId)
      : undefined;
    const cadre = m && Object.values(m).some(Boolean);
    // Après un refus, seules les questions proches du sens de la question, dans le cadre posé.
    if (r.etat === "out_of_corpus") {
      const candidates = suggestionsDuPerimetre(
        db,
        l,
        Domaines.sourcesPerimetre(db, Domaines.lireScope(m ?? {})),
        question,
        Infinity,
      );
      const connues = proches.get(messageId);
      // Un droit retiré depuis retire aussi la question.
      if (connues) return connues.filter((q) => candidates.includes(q));
      const idees = await questionsProches(modeles, question, candidates, config.seuil);
      if (messageId) {
        proches.set(messageId, idees);
        if (proches.size > 1000) proches.delete(proches.keys().next().value!);
      }
      return idees;
    }
    if (cadre) {
      return suggestionsDuPerimetre(
        db,
        l,
        Domaines.sourcesPerimetre(db, Domaines.lireScope(m)),
        question,
      );
    }
    // Sans périmètre : les questions du thème d'une source, dans un cours du lecteur.
    const duTheme = (sourceId: unknown) => {
      const theme = sourceId ? sourceCertifiee(String(sourceId), l)?.theme_id : "";
      return theme
        ? suggestionsDuPerimetre(
            db,
            l,
            Domaines.sourcesPerimetre(db, { matiere_id: "", cours_id: "", theme_id: theme }),
            question,
          )
        : [];
    };
    if (r.etat !== "answered") return [];
    const ids = [...new Set(r.affirmations.map((a) => a.source_id))];
    if (!ids.length) return [];
    const memesSources = db
      .prepare(
        `SELECT sg.question FROM suggestions sg JOIN sources s ON s.id = sg.source_id
       WHERE sg.source_id IN (${ids.map(() => "?").join(",")}) AND s.statut = 'certifiee'
         AND s.school_id = ? AND sg.question != ? AND s.audience = 'eleves' AND s.reponses = 1
         AND ${FILTRE_ACCES}
       ORDER BY random() LIMIT 3`,
      )
      .all(...ids, instance.school_id, question, ...parametresAcces(l))
      .map((x) => x.question as string);
    return memesSources.length ? memesSources : duTheme(ids[0]);
  };

  // Les règles de la conversation vivent dans `conversations.ts`. Ces routes traduisent ses refus :
  // un identifiant d'un autre compte reçoit le même 404 qu'un identifiant inconnu.
  const conversationDe = (c: Context<Env>, id: string) =>
    Conversations.conversationDe(db, c.get("compte"), id);
  const refuser = (
    c: Context<Env>,
    refus: Conversations.Refus,
    archivee = "Cette conversation est archivée.",
  ) =>
    refus === "introuvable"
      ? c.notFound()
      : c.text(
          refus === "archivee"
            ? archivee
            : "Une réponse est déjà en cours dans cette conversation.",
          409,
        );
  const libelleTheme = () => libelles(db).regroupement;

  /** Pourquoi le compte ne peut pas poser de question dans ce périmètre, sinon rien. */
  const perimetreRefuse = (c: Context<Env>, perimetre: Perimetre) => {
    const p = Domaines.lireScope(perimetre);
    const comparees = Domaines.idsMatieres(p.matieres);
    if (comparees.length > MAX_MATIERES) return `Compare ${MAX_MATIERES} matières au plus.`;
    if (Object.values(p).some(Boolean)) {
      const lisibles = db
        .prepare(
          `SELECT id FROM sources s WHERE statut = 'certifiee' AND school_id = ? AND ${FILTRE_ACCES}`,
        )
        .all(instance.school_id, ...parametresAcces(lu(c)));
      const visible = (q: Domaines.Scope) => {
        const disponibles = Domaines.sourcesPerimetre(db, q);
        return lisibles.some((s) => disponibles.has(s.id as string));
      };
      // Chaque matière comparée offre une source lisible, comme une matière seule.
      const matieres = comparees.map((m) => ({ matiere_id: m, cours_id: "", theme_id: "" }));
      if (![p, ...matieres].every(visible)) return "Périmètre indisponible.";
      // Un élève ne pose une question dans un cours que s'il en est membre.
      const coursId =
        p.cours_id ||
        String(
          db.prepare("SELECT cours_id FROM themes WHERE id = ?").get(p.theme_id)?.cours_id ?? "",
        );
      if (
        (p.cours_id || p.theme_id) &&
        !lu(c).administrateur &&
        !Domaines.coursDuCompte(db, lu(c).id).has(coursId)
      )
        return "Périmètre indisponible.";
    }
  };

  const conversations = (c: Context<Env>, archivees: boolean, toutes: boolean, q = "") => {
    const cat = Domaines.catalogueVisible(db, lu(c));
    const theme = libelleTheme();
    const { lignes, plus } = Conversations.lister(db, c.get("compte"), archivees, toutes, q);
    return {
      liste: lignes.map((l) => ({ ...l, perimetre: Eleve.nomPerimetre(cat, l, theme) })),
      plus,
    };
  };
  const nombreArchivees = (c: Context<Env>) => Conversations.nombreArchivees(db, c.get("compte"));

  const pageChat = async (c: Context<Env>, conv?: Conversations.Conversation) => {
    const compte = c.get("compte");
    if (conv) Conversations.conversationLue(db, compte, conv.id);
    const cat = Domaines.catalogueVisible(db, lu(c));
    const theme = libelleTheme();
    // Une nouvelle conversation part du périmètre choisi, sinon de celui de la dernière.
    const p: Perimetre = conv ??
      (Object.hasOwn(c.req.query(), "matiere_id") || Object.hasOwn(c.req.query(), "matieres")
        ? scope(c)
        : Conversations.dernierPerimetre(db, compte)) ?? {
        matiere_id: "",
        cours_id: "",
        theme_id: "",
      };
    const messages = conv
      ? messagesDe(compte, conv.id, (m) => Eleve.nomPerimetre(cat, m, theme))
      : [];
    const dernier = messages.findLast((m) => m.resultat);
    const { liste, plus } = conversations(c, false, false);
    return c.html(
      rendre(
        c,
        conv?.titre ?? "Nouvelle conversation",
        Eleve.chat({
          compte: compte.id,
          conversation: conv && { id: conv.id, titre: conv.titre, archivee: !!conv.archivee_le },
          messages,
          idees: !conv
            ? suggestionsDuPerimetre(
                db,
                lu(c),
                Domaines.sourcesPerimetre(db, Domaines.lireScope(p)),
              )
            : dernier
              ? await ideesPour(lu(c), JSON.parse(dernier.resultat!), dernier.question, dernier.id)
              : [],
          liste,
          archivees: nombreArchivees(c),
          suite: plus ? "/eleve/conversations?toutes=1" : "",
          perimetre: {
            matiere_id: p.matiere_id,
            cours_id: p.cours_id,
            theme_id: p.theme_id,
            matieres: p.matieres ?? "",
          },
          catalogue: cat,
          theme,
          indisponible: !!perimetreRefuse(c, p),
          statut: c.req.query("archivee") ? "Conversation archivée." : undefined,
          personnel: lireInstance(db).mode === "personal",
          mention: mentionLecteurs(c),
        }),
        "page-chat",
      ),
    );
  };

  app.get("/eleve/chat", (c) => pageChat(c, Conversations.derniereOuverte(db, c.get("compte"))));
  app.get("/eleve/chat/nouvelle", (c) => pageChat(c));
  app.get("/eleve/chat/:id", (c) => {
    const conv = conversationDe(c, c.req.param("id"));
    return conv ? pageChat(c, conv) : c.notFound();
  });
  app.on("GET", ["/eleve/conversations", "/eleve/conversations/archivees"], (c) => {
    const archive = c.req.path.endsWith("/archivees");
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    const { liste, plus } = conversations(c, archive, c.req.query("toutes") === "1", q);
    const suite = plus
      ? `${c.req.path}?${new URLSearchParams({ toutes: "1", ...(q ? { q } : {}) })}`
      : "";
    const archivees = archive ? 0 : nombreArchivees(c);
    // La recherche HTMX ne remplace que les résultats : la page sans JavaScript se recharge.
    if (c.req.header("HX-Request") && !c.req.header("HX-Boosted")) {
      const courante = c.req.query("courante") ?? "";
      return c.html(Eleve.resultatsConversations(liste, courante, archivees, suite, q));
    }
    return c.html(
      rendre(
        c,
        archive ? "Conversations archivées" : "Conversations",
        Eleve.pageConversations(archive, liste, archivees, suite, q),
      ),
    );
  });
  // La liste suit une réponse qui tourne dans une autre conversation, sans toucher au focus.
  app.get("/eleve/conversations/:id/etat", (c) => {
    const conv = Conversations.etatDe(db, c.get("compte"), c.req.param("id"));
    return conv
      ? c.html(Eleve.statutConversation(conv, c.req.query("ouverte") === "1"))
      : c.notFound();
  });
  app.post("/eleve/chat/:id/renommer", async (c) => {
    const titre = String((await c.req.parseBody()).titre ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!titre || titre.length > 120) return c.text("Titre attendu : 1 à 120 caractères.", 400);
    return Conversations.renommer(db, c.get("compte"), c.req.param("id"), titre)
      ? c.redirect(`/eleve/chat/${c.req.param("id")}`, 303)
      : c.notFound();
  });
  // Archiver ouvre la conversation la plus récente qui reste, ou une nouvelle.
  app.post("/eleve/chat/:id/:action{(?:archiver|desarchiver)}", (c) => {
    const archiver = c.req.param("action") === "archiver";
    if (!Conversations.archiver(db, c.get("compte"), c.req.param("id"), archiver)) {
      return c.notFound();
    }
    return c.redirect(
      archiver ? "/eleve/chat?archivee=1" : `/eleve/chat/${c.req.param("id")}`,
      303,
    );
  });
  app.post("/eleve/chat/:id/perimetre", async (c) => {
    const conv = conversationDe(c, c.req.param("id"));
    if (!conv) return c.notFound();
    if (conv.archivee_le) return refuser(c, "archivee");
    const b = await c.req.parseBody({ all: true });
    // Le formulaire de comparaison n'envoie que ses cases : vide, il ne vaut pas « tout ».
    if (!Object.hasOwn(b, "matiere_id") && !Object.hasOwn(b, "matieres")) {
      return c.text("Coche les matières à comparer.", 400);
    }
    const p = Domaines.lireScope(b);
    const refus = perimetreRefuse(c, p);
    if (refus) return c.text(refus, 400);
    const ecriture = Conversations.changerPerimetre(db, c.get("compte"), conv.id, p);
    if (ecriture) return refuser(c, ecriture);
    return c.redirect(`/eleve/chat/${conv.id}`, 303);
  });

  /**
   * Sans conversation, la question en ouvre une avec le périmètre de la page d'où elle part.
   * Avec une conversation, elle prend son périmètre actuel, revérifié à chaque envoi.
   */
  app.post("/eleve/questions", async (c) => {
    const b = await c.req.parseBody();
    const texte = String(b.texte ?? "")
      .trim()
      .slice(0, 1000);
    if (!texte) return c.text("Question vide.", 400);
    const compte = c.get("compte");
    const cle = String(b.cle ?? "").slice(0, 100) || null;
    // Hors HTMX (accueil, idée proposée, première question), la conversation s'ouvre et le flux
    // démarre là-bas.
    const envoye = (conversationId: string, id: string, question: string) =>
      !c.req.header("HX-Request") || c.req.header("HX-Boosted")
        ? c.redirect(`/eleve/chat/${conversationId}`, 303)
        : c.html(html`
            ${Eleve.question(question)}${Eleve.attente(id)}
          `);
    const deja = cle ? Conversations.echangeParCle(db, compte, cle) : undefined;
    if (deja) return envoye(deja.conversation_id, deja.id, deja.question);
    const conv = b.conversation ? conversationDe(c, String(b.conversation)) : undefined;
    if (b.conversation && !conv) return c.notFound();
    const p: Perimetre = conv ?? scopeChapitre(c, b);
    // Un chapitre qu'aucun thème ne remplace n'élargit pas la question à toutes les ressources.
    if (!conv && b.chapitre && !p.theme_id) return c.text("Périmètre indisponible.", 400);
    const refus = perimetreRefuse(c, p);
    if (refus) return c.text(refus, 400);
    const r = Conversations.poser(db, compte, { texte, cle, perimetre: p, conversation: conv?.id });
    if (typeof r === "string") {
      return refuser(
        c,
        r,
        "Cette conversation a été archivée dans un autre onglet. Ta question est conservée.",
      );
    }
    reponses.reveiller();
    return envoye(r.conversation, r.echange, texte);
  });

  app.post("/eleve/messages/:id/relancer", (c) => {
    const refus = Conversations.relancer(db, c.get("compte"), c.req.param("id"));
    if (refus) return refuser(c, refus);
    reponses.reveiller();
    return c.html(Eleve.attente(c.req.param("id")));
  });

  app.post("/eleve/messages/:id/arreter", (c) => {
    const id = c.req.param("id");
    const compte = c.get("compte");
    if (Conversations.arreter(db, compte, id)) reponses.annuler(id);
    // Une réponse publiée juste avant l'arrêt s'affiche telle quelle.
    const m = Conversations.echange(db, compte, id);
    return m?.resultat ? c.html(Eleve.reponse(id, m.resultat, m.avis)) : c.notFound();
  });

  /**
   * Le flux lit l'état enregistré : l'étape annoncée, puis la réponse. Le fermer n'arrête ni ne
   * relance le calcul, et une reconnexion repart de l'état actuel.
   */
  app.get("/eleve/messages/:id/flux", (c) => {
    const id = c.req.param("id");
    const compte = c.get("compte");
    if (!Conversations.echange(db, compte, id)) return c.notFound();
    return streamSSE(c, async (flux) => {
      let annoncee = "";
      // Au bout de dix minutes, le flux se ferme et le navigateur se reconnecte.
      for (let i = 0; i < 600 && !flux.aborted; i++) {
        const m = Conversations.echange(db, compte, id);
        if (!m) return;
        if (m.resultat) {
          Conversations.echangeLu(db, compte, id);
          const r = m.resultat;
          await flux.writeSSE({
            event: "reponse",
            data: String(
              await Eleve.reponse(
                id,
                r,
                null,
                await ideesPour(lecteur(compte), r, m.question, id),
                true,
              ),
            ).replace(/\n/g, " "),
          });
          return;
        }
        const etape = m.etape ?? "En attente";
        if (etape !== annoncee) {
          await flux.writeSSE({ event: "etape", data: etape });
          annoncee = etape;
        }
        await attendreChangement(id, 1000);
      }
    });
  });

  app.post("/eleve/messages/:id/avis", async (c) => {
    const avis = String((await c.req.parseBody()).avis ?? "");
    if (!["utile", "confus", "faux"].includes(avis)) return c.text("Avis invalide.", 400);
    return Conversations.donnerAvis(db, c.get("compte"), c.req.param("id"), avis)
      ? c.html(Eleve.avis(c.req.param("id"), avis))
      : c.notFound();
  });

  app.get("/eleve/messages/:id/citations/:n", (c) => {
    const m = Conversations.echange(db, c.get("compte"), c.req.param("id"));
    if (!m) return c.notFound();
    const r = m.resultat;
    return feuilleCitation(c, r?.etat === "answered" ? r.affirmations : [], c.req.param("id"));
  });
}
