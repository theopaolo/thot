import { actualiserResultat, type Resultat } from "../core/reponse.ts";
import {
  FILTRE_ACCES,
  filtreAcces,
  type Lecteur,
  type Perimetre,
  parametresAcces,
  transaction,
} from "../core/recherche.ts";
import { type Compte, lecteur } from "./comptes.ts";
import { type Db, maintenant } from "./db.ts";
import { nomTheme, type Scope } from "./domaines.ts";
import { chunksSource } from "./ingestion.ts";
import { lireInstance } from "./instance.ts";

// Une conversation et ses échanges appartiennent à un compte : chaque fonction reçoit le compte
// et ne lit ni n'écrit rien d'un autre. Un identifiant d'un autre compte vaut un identifiant
// inconnu.

export type Conversation = Scope & { id: string; titre: string; archivee_le: string | null };
export type Echange = Scope & {
  id: string;
  question: string;
  etat: string;
  etape: string | null;
  /** le résultat relu avec les droits actuels du compte */
  resultat: Resultat | null;
  avis: string | null;
};
export type Resume = Scope & {
  id: string;
  titre: string;
  active_le: string;
  etat: string | null;
  nouvelle: number;
};
/** Ce qu'une écriture refuse. */
export type Refus = "introuvable" | "archivee" | "en_cours";

export const ARRETEE: Resultat = { etat: "failed", code: "CANCELLED", message: "Réponse arrêtée." };

export const memePerimetre = (a: Scope, b: Scope) =>
  a.matiere_id === b.matiere_id &&
  a.cours_id === b.cours_id &&
  a.theme_id === b.theme_id &&
  a.matieres === b.matieres;

// La relecture d'une réponse revérifie ses preuves avec les droits de `p`, dans la révision
// qu'elle cite.
// ponytail: une révision qui ne sert plus se relit et se redécoupe à chaque affichage. Garder ses
// chunks en mémoire si le chat ralentit.
export const resultatActuel = (db: Db, resultat: Resultat, p: Perimetre) =>
  actualiserResultat(db, resultat, p, (id, n) => chunksSource(db, id, n));

const relu = (db: Db, compte: Compte, texte: string) =>
  resultatActuel(db, JSON.parse(texte), {
    schoolId: lireInstance(db).school_id,
    lecteur: lecteur(compte),
  });

export const conversationDe = (db: Db, compte: Compte, id: string) =>
  db.prepare("SELECT * FROM conversations WHERE id = ? AND compte_id = ?").get(id, compte.id) as
    | Conversation
    | undefined;

export const derniereOuverte = (db: Db, compte: Compte) =>
  db
    .prepare(
      `SELECT * FROM conversations WHERE compte_id = ? AND archivee_le IS NULL
       ORDER BY active_le DESC, rowid DESC LIMIT 1`,
    )
    .get(compte.id) as Conversation | undefined;

/** Le périmètre de la conversation la plus récente, même archivée. */
export const dernierPerimetre = (db: Db, compte: Compte) =>
  db
    .prepare(
      `SELECT matiere_id, cours_id, theme_id, matieres FROM conversations
       WHERE compte_id = ? ORDER BY active_le DESC, rowid DESC LIMIT 1`,
    )
    .get(compte.id) as Scope | undefined;

// L'état du dernier échange, et une réponse terminée que l'élève n'a pas encore ouverte.
const ETAT = `(SELECT etat FROM messages WHERE conversation_id = v.id ORDER BY rang DESC LIMIT 1) AS etat,
  EXISTS (SELECT 1 FROM messages WHERE conversation_id = v.id AND nouvelle) AS nouvelle`;

/**
 * Les conversations du compte, archivées ou non, les plus récentes d'abord. `q` cherche dans le
 * titre et les questions, ses jokers LIKE neutralisés. Sans `toutes`, 50 au plus.
 */
export function lister(db: Db, compte: Compte, archivees: boolean, toutes: boolean, q = "") {
  const motif = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const lignes = db
    .prepare(
      `SELECT id, titre, matiere_id, cours_id, theme_id, matieres, active_le, ${ETAT}
       FROM conversations v WHERE compte_id = ? AND (archivee_le IS NOT NULL) = ?
       AND (? = '' OR titre LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m
         WHERE m.conversation_id = v.id AND m.question LIKE ? ESCAPE '\\'))
       ORDER BY active_le DESC, rowid DESC LIMIT ?`,
    )
    .all(compte.id, archivees ? 1 : 0, q, motif, motif, toutes ? -1 : 51) as Resume[];
  return { lignes: toutes ? lignes : lignes.slice(0, 50), plus: !toutes && lignes.length > 50 };
}

/** L'état du dernier échange d'une conversation, que la liste suit. */
export const etatDe = (db: Db, compte: Compte, id: string) =>
  db
    .prepare(`SELECT id, ${ETAT} FROM conversations v WHERE id = ? AND compte_id = ?`)
    .get(id, compte.id) as Pick<Resume, "id" | "etat" | "nouvelle"> | undefined;

export const nombreArchivees = (db: Db, compte: Compte) =>
  db
    .prepare(
      "SELECT count(*) AS n FROM conversations WHERE compte_id = ? AND archivee_le IS NOT NULL",
    )
    .get(compte.id)!.n as number;

/** Les échanges d'une conversation dans l'ordre, chacun avec son résultat relu. */
export function echanges(db: Db, compte: Compte, conversationId: string): Echange[] {
  const lignes = db
    .prepare(
      `SELECT id, question, etat, etape, resultat, avis, matiere_id, cours_id, theme_id, matieres
       FROM messages WHERE conversation_id = ? AND compte_id = ? ORDER BY rang`,
    )
    .all(conversationId, compte.id) as (Echange & { resultat: string | null })[];
  return lignes.map((m) => {
    if (!m.resultat) return { ...m, resultat: null };
    const r = relu(db, compte, m.resultat);
    return { ...m, etat: r.etat, resultat: r };
  });
}

export function echange(db: Db, compte: Compte, id: string): Echange | undefined {
  const m = db
    .prepare(
      `SELECT id, question, etat, etape, resultat, avis, matiere_id, cours_id, theme_id, matieres
       FROM messages WHERE id = ? AND compte_id = ?`,
    )
    .get(id, compte.id) as (Echange & { resultat: string | null }) | undefined;
  return m && { ...m, resultat: m.resultat ? relu(db, compte, m.resultat) : null };
}

/** L'échange déjà créé par un envoi de même clé. */
export const echangeParCle = (db: Db, compte: Compte, cle: string) =>
  db
    .prepare("SELECT id, conversation_id, question FROM messages WHERE compte_id = ? AND cle = ?")
    .get(compte.id, cle) as { id: string; conversation_id: string; question: string } | undefined;

// Une réponse ouverte n'est plus annoncée comme nouvelle.
export const conversationLue = (db: Db, compte: Compte, id: string) =>
  db
    .prepare("UPDATE messages SET nouvelle = 0 WHERE conversation_id = ? AND compte_id = ?")
    .run(id, compte.id);
export const echangeLu = (db: Db, compte: Compte, id: string) =>
  db.prepare("UPDATE messages SET nouvelle = 0 WHERE id = ? AND compte_id = ?").run(id, compte.id);

/** Le dernier titre enregistré l'emporte : un titre ne justifie pas un conflit. */
export const renommer = (db: Db, compte: Compte, id: string, titre: string) =>
  db
    .prepare("UPDATE conversations SET titre = ? WHERE id = ? AND compte_id = ?")
    .run(titre, id, compte.id).changes > 0;

export const archiver = (db: Db, compte: Compte, id: string, archivee: boolean) =>
  db
    .prepare("UPDATE conversations SET archivee_le = ? WHERE id = ? AND compte_id = ?")
    .run(archivee ? maintenant() : null, id, compte.id).changes > 0;

const refusEcriture = (conv: Conversation | undefined): Refus | undefined =>
  !conv ? "introuvable" : conv.archivee_le ? "archivee" : undefined;

/** Le nouveau périmètre vaut pour les questions suivantes. Les échanges passés gardent le leur. */
export const changerPerimetre = (db: Db, compte: Compte, id: string, p: Scope) =>
  transaction(db, () => {
    const refus = refusEcriture(conversationDe(db, compte, id));
    if (refus) return refus;
    db.prepare(
      "UPDATE conversations SET matiere_id = ?, cours_id = ?, theme_id = ?, matieres = ? WHERE id = ?",
    ).run(p.matiere_id, p.cours_id, p.theme_id, p.matieres ?? "", id);
  });

/**
 * Une question attend la boucle de réponses, ou sa réponse tourne. La boucle compte sur une
 * seule réponse en file par conversation pour garder l'ordre des tours : les écritures qui en
 * ajoutent une le vérifient dans leur transaction.
 */
const reponseEnCours = (db: Db, conversationId: string) =>
  !!db
    .prepare(
      "SELECT 1 FROM messages WHERE conversation_id = ? AND etat IN ('en_attente', 'en_cours')",
    )
    .get(conversationId);

/**
 * Pose une question dans la conversation `conversation`, ou en ouvre une, titrée par la question,
 * dans `perimetre`. L'échange attend la boucle de réponses.
 */
export const poser = (
  db: Db,
  compte: Compte,
  q: { texte: string; cle: string | null; perimetre: Scope; conversation?: string },
): { conversation: string; echange: string } | Refus =>
  transaction(db, () => {
    const t = maintenant();
    let conversation = q.conversation;
    const p = q.perimetre;
    if (conversation) {
      const refus = refusEcriture(conversationDe(db, compte, conversation));
      if (refus) return refus;
      if (reponseEnCours(db, conversation)) return "en_cours";
      db.prepare("UPDATE conversations SET active_le = ? WHERE id = ?").run(t, conversation);
    } else {
      conversation = crypto.randomUUID();
      // Le titre reprend la question, coupée à 80 caractères sur une fin de mot.
      const ligne = q.texte.replace(/\s+/g, " ");
      const titre =
        ligne.length > 80
          ? ligne
              .slice(0, 81)
              .replace(/\s+\S*$/, "")
              .slice(0, 80)
          : ligne;
      db.prepare(
        `INSERT INTO conversations (id, compte_id, titre, matiere_id, cours_id, theme_id,
         matieres, active_le, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        conversation,
        compte.id,
        titre,
        p.matiere_id,
        p.cours_id,
        p.theme_id,
        p.matieres ?? "",
        t,
        t,
      );
    }
    const id = crypto.randomUUID();
    // Le journal garde l'heure de la demande : la boucle en tire le temps d'attente.
    db.prepare(
      `INSERT INTO messages (id, compte_id, conversation_id, rang, cle, question,
       matiere_id, cours_id, theme_id, matieres, etat, journal, cree_le, maj_le)
       VALUES (?, ?, ?, (SELECT coalesce(max(rang), 0) + 1 FROM messages WHERE conversation_id = ?),
       ?, ?, ?, ?, ?, ?, 'en_attente', json_object('demande_ms', ?), ?, ?)`,
    ).run(
      id,
      compte.id,
      conversation,
      conversation,
      q.cle,
      q.texte,
      p.matiere_id,
      p.cours_id,
      p.theme_id,
      p.matieres ?? "",
      Date.now(),
      t,
      t,
    );
    return { conversation, echange: id };
  });

/** Remet en file un échange en échec, ou dont la réponse a perdu sa preuve. */
export const relancer = (db: Db, compte: Compte, id: string): Refus | undefined =>
  transaction(db, () => {
    const m = db
      .prepare(
        `SELECT m.etat, m.resultat, m.conversation_id, v.archivee_le FROM messages m
         LEFT JOIN conversations v ON v.id = m.conversation_id WHERE m.id = ? AND m.compte_id = ?`,
      )
      .get(id, compte.id) as
      | { etat: string; resultat: string | null; conversation_id: string; archivee_le: string }
      | undefined;
    if (
      !m ||
      (m.etat !== "failed" && (!m.resultat || relu(db, compte, m.resultat).etat !== "failed"))
    )
      return "introuvable";
    if (m.archivee_le) return "archivee";
    if (reponseEnCours(db, m.conversation_id)) return "en_cours";
    const r = db
      .prepare(
        `UPDATE messages SET etat = 'en_attente', resultat = NULL, generation_id = NULL,
         tentatives = 0, journal = json_object('demande_ms', ?), maj_le = ?
         WHERE id = ? AND compte_id = ? AND etat IN ('failed', 'answered', 'annule')`,
      )
      .run(Date.now(), maintenant(), id, compte.id);
    if (!r.changes) return "introuvable";
  });

/**
 * « Arrêter » : la question reste, sa réponse ne sera pas publiée et peut se relancer. Rend
 * `false` quand rien n'était en cours.
 */
export const arreter = (db: Db, compte: Compte, id: string) =>
  db
    .prepare(
      `UPDATE messages SET etat = 'annule', resultat = ?, etape = NULL, verrou_expire_le = NULL,
       generation_id = NULL, maj_le = ?
       WHERE id = ? AND compte_id = ? AND etat IN ('en_attente', 'en_cours')`,
    )
    .run(JSON.stringify(ARRETEE), maintenant(), id, compte.id).changes > 0;

/** Un avis ne porte que sur une réponse publiée. */
export const donnerAvis = (db: Db, compte: Compte, id: string, avis: string) =>
  db
    .prepare("UPDATE messages SET avis = ? WHERE id = ? AND compte_id = ? AND etat = 'answered'")
    .run(avis, id, compte.id).changes > 0;

export type QuestionDesEleves = {
  id: string;
  question: string;
  etat: string;
  code: string | null;
  avis: string | null;
  cree_le: string;
  nom: string;
  chapitre: string;
};

// Un enseignant lit les questions posées dans ses cours. Sans cours choisi, celles des élèves
// avec qui il partage un cours, ou de tout élève qui n'a aucun cours. Un administrateur lit tout.
export const questionsDesEleves = (db: Db, l: Lecteur) =>
  db
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
       WHERE c.role = 'eleve' AND ($administrateur OR CASE
         WHEN m.cours_id != '' THEN m.cours_id IN (SELECT cours_id FROM membres_cours WHERE compte_id = $lecteur)
         WHEN m.theme_id != '' THEN EXISTS (SELECT 1 FROM themes t JOIN membres_cours mc
           ON mc.cours_id = t.cours_id WHERE t.id = m.theme_id AND mc.compte_id = $lecteur)
         WHEN m.matiere_id != '' THEN EXISTS (SELECT 1 FROM cours co JOIN membres_cours mc
           ON mc.cours_id = co.id WHERE co.matiere_id = m.matiere_id AND mc.compte_id = $lecteur)
         WHEN m.matieres != '' THEN EXISTS (SELECT 1 FROM cours co JOIN membres_cours mc
           ON mc.cours_id = co.id WHERE instr(',' || m.matieres || ',', ',' || co.matiere_id || ',')
           AND mc.compte_id = $lecteur)
         ELSE NOT EXISTS (SELECT 1 FROM membres_cours WHERE compte_id = m.compte_id)
           OR EXISTS (SELECT 1 FROM membres_cours moi JOIN membres_cours lui
             ON lui.cours_id = moi.cours_id WHERE moi.compte_id = $lecteur AND lui.compte_id = m.compte_id)
         END)
       ORDER BY (m.etat = 'out_of_corpus') DESC, (m.avis = 'faux') DESC, m.cree_le DESC`,
    )
    .all(parametresAcces(l)) as QuestionDesEleves[];
