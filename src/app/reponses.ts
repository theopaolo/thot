import { EventEmitter } from "node:events";
import type { Modeles } from "../core/modeles.ts";
import { actualiserResultat, demander, type Resultat } from "../core/reponse.ts";
import { transaction } from "../core/recherche.ts";
import { lecteur, lireCompte } from "./comptes.ts";
import { idsMatieres } from "./domaines.ts";
import { config } from "./config.ts";
import { type Db, maintenant } from "./db.ts";
import { lireInstance } from "./instance.ts";
import type { Perimetre } from "./vues/eleve.ts";

/** Un serveur arrêté pendant une réponse la laisse reprendre une fois ce verrou expiré. */
export const VERROU_MS = 60_000;
const MAX_TENTATIVES = 3;
/** Réponses calculées en même temps. L'extraction tourne dans le worker et ne les retarde pas. */
const SIMULTANEES = 4;

export const ARRETEE: Resultat = { etat: "failed", code: "CANCELLED", message: "Réponse arrêtée." };

export const memePerimetre = (a: Perimetre, b: Perimetre) =>
  a.chapitre === b.chapitre &&
  a.matiere_id === b.matiere_id &&
  a.cours_id === b.cours_id &&
  a.theme_id === b.theme_id &&
  a.matieres === b.matieres;

// Le flux SSE attend ce signal entre deux lectures de la base, qui reste la référence : un
// changement venu d'un autre processus se lit au tour suivant.
const changements = new EventEmitter().setMaxListeners(0);

/** Attend un changement de l'échange `id`, au plus `ms`. */
export const attendreChangement = (id: string, ms: number) =>
  new Promise<void>((fin) => {
    const finir = () => {
      clearTimeout(minuteur);
      changements.off(id, finir);
      fin();
    };
    const minuteur = setTimeout(finir, ms);
    changements.on(id, finir);
  });

type Travail = Perimetre & {
  id: string;
  compte_id: string;
  question: string;
  conversation_id: string;
  rang: number;
  generation_id: string;
  tentatives: number;
  journal: string | null;
};

/**
 * Revendique la plus ancienne question en attente, ou une réponse dont le verrou a expiré parce
 * que son serveur s'est arrêté. Une réponse interrompue MAX_TENTATIVES fois échoue. Chaque
 * revendication donne un nouveau `generation_id` : l'ancienne tentative ne peut plus publier.
 */
export function revendiquerReponse(db: Db, ms = Date.now()): Travail | undefined {
  const t = maintenant(ms);
  db.prepare(
    `UPDATE messages SET etat = 'failed', resultat = ?, etape = NULL, verrou_expire_le = NULL,
       generation_id = NULL, maj_le = ?
     WHERE etat = 'en_cours' AND verrou_expire_le < ? AND tentatives >= ?`,
  ).run(
    JSON.stringify({
      etat: "failed",
      code: "INTERRUPTED",
      message: `Le calcul de la réponse a été interrompu ${MAX_TENTATIVES} fois.`,
    }),
    t,
    t,
    MAX_TENTATIVES,
  );
  return db
    .prepare(
      `UPDATE messages SET etat = 'en_cours', tentatives = tentatives + 1, generation_id = ?,
       verrou_expire_le = ?, maj_le = ?
     WHERE id = (SELECT id FROM messages
                 WHERE etat = 'en_attente' OR (etat = 'en_cours' AND verrou_expire_le < ?)
                 ORDER BY cree_le, rowid LIMIT 1)
     RETURNING id, compte_id, question, conversation_id, rang, chapitre, matiere_id, cours_id,
       theme_id, matieres, generation_id, tentatives, journal`,
    )
    .get(crypto.randomUUID(), maintenant(ms + VERROU_MS), t, t) as Travail | undefined;
}

/**
 * La boucle de réponses du serveur, hors de toute connexion : au plus SIMULTANEES réponses à la
 * fois. Une conversation n'a qu'une réponse en file, l'ordre de ses tours tient donc.
 */
export function boucleReponses(db: Db, modeles: Modeles) {
  const schoolId = lireInstance(db).school_id;
  const actives = new Map<string, AbortController>();
  const proprietaire = "WHERE id = ? AND generation_id = ? AND etat = 'en_cours'";

  async function repondre(t: Travail, controle: AbortController) {
    const debut = Date.now();
    const renouveler = setInterval(() => {
      try {
        const r = db
          .prepare(`UPDATE messages SET verrou_expire_le = ? ${proprietaire}`)
          .run(maintenant(Date.now() + VERROU_MS), t.id, t.generation_id);
        // Arrêtée, purgée ou reprise ailleurs : l'appel en cours s'interrompt.
        if (!r.changes) controle.abort(new Error("Tentative remplacée."));
      } catch (e) {
        console.error(`verrou de la réponse ${t.id}:`, e);
      }
    }, VERROU_MS / 4);
    try {
      // Le contexte vient du tour précédent de la même conversation, posé dans le même
      // périmètre. Un changement de périmètre repart de zéro.
      const avant = db
        .prepare(
          `SELECT question, chapitre, matiere_id, cours_id, theme_id, matieres FROM messages
           WHERE conversation_id = ? AND rang < ? ORDER BY rang DESC LIMIT 1`,
        )
        .get(t.conversation_id, t.rang) as (Perimetre & { question: string }) | undefined;
      const p = {
        schoolId,
        lecteur: lecteur(lireCompte(db, t.compte_id)!),
        chapitre: t.chapitre || undefined,
        matiereId: t.matiere_id,
        matieres: idsMatieres(t.matieres),
        coursId: t.cours_id,
        themeId: t.theme_id,
      };
      const { resultat, journal } = await demander(
        db,
        modeles,
        t.question,
        p,
        config.seuil,
        (etape) => {
          db.prepare(`UPDATE messages SET etape = ? ${proprietaire}`).run(
            etape,
            t.id,
            t.generation_id,
          );
          changements.emit(t.id);
        },
        avant && memePerimetre(avant, t) ? avant.question : undefined,
        controle.signal,
      );
      // Seule la tentative propriétaire publie, avec les droits actuels de l'élève. Un échange
      // purgé ou supprimé n'a plus de ligne : rien ne le recrée, ni sa conversation, que la clé
      // étrangère garde tant qu'elle a des échanges.
      transaction(db, () => {
        const actuel = actualiserResultat(db, resultat, {
          ...p,
          lecteur: lecteur(lireCompte(db, t.compte_id)!),
        });
        db.prepare(
          `UPDATE messages SET etat = ?, resultat = ?, journal = ?, etape = NULL,
             verrou_expire_le = NULL, generation_id = NULL, nouvelle = 1, maj_le = ?
           ${proprietaire}`,
        ).run(
          actuel.etat,
          JSON.stringify(actuel),
          JSON.stringify({
            ...journal,
            // `tentatives` y liste déjà les essais du générateur.
            revendications: t.tentatives,
            attente_ms: debut - JSON.parse(t.journal ?? "{}").demande_ms,
            traitement_ms: Date.now() - debut,
          }),
          maintenant(),
          t.id,
          t.generation_id,
        );
      });
    } finally {
      clearInterval(renouveler);
      changements.emit(t.id);
    }
  }

  function reveiller(ms = Date.now()) {
    try {
      while (actives.size < SIMULTANEES) {
        const t = revendiquerReponse(db, ms);
        if (!t) return;
        const controle = new AbortController();
        actives.set(t.id, controle);
        repondre(t, controle)
          .catch((e) => console.error(`réponse ${t.id}:`, e))
          .finally(() => {
            if (actives.get(t.id) === controle) actives.delete(t.id);
            reveiller();
          });
      }
    } catch (e) {
      console.error("file des réponses:", e);
    }
  }

  return {
    reveiller,
    /** Interrompt l'appel en cours d'une réponse déjà marquée arrêtée. */
    annuler(id: string) {
      actives.get(id)?.abort(new Error("Réponse arrêtée."));
      changements.emit(id);
    },
  };
}
