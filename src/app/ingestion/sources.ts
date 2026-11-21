import { readFile, rm } from "node:fs/promises";
import { cleLegende } from "../../core/modeles.ts";
import { retirerSource, transaction } from "../../core/recherche.ts";
import { journalSans, type Resultat, resultatSans } from "../../core/reponse.ts";
import { oublierSource, revoirActivites } from "../activites.ts";
import { config, contenu } from "../config.ts";
import { type Db, maintenant } from "../db.ts";
import type { Audience } from "../depot.ts";
import { type Affiliation, affiliations } from "../domaines.ts";
import { cheminImage, lireInventaire, retirer, servirImages } from "./images.ts";
import { reindexer } from "./indexation.ts";
import { lireSource, revisionEnAttente } from "./revisions.ts";

/**
 * Ce qui empêche de certifier la source, ou `undefined` : seule une extraction qui attend sa
 * relecture se certifie. Une source a toujours un travail, créé avec elle par `deposer()`.
 */
export function refusCertification(db: Db, sourceId: string) {
  const etat = db
    .prepare("SELECT etat FROM ingestion_jobs WHERE source_id = ?")
    .get(sourceId)?.etat;
  if (etat === "awaiting_review") return undefined;
  if (etat === "failed") return "son traitement a échoué";
  return etat ? "son extraction n'est pas terminée" : "elle est introuvable";
}

/**
 * Certifie ou rejette une source. Certifier avec `revision`, sa révision en attente, fait servir
 * celle-ci et ses images dans la transaction de l'index : un échec laisse servir l'ancienne. Un
 * exercice qui citait une autre révision, montrait une image qu'elle retire, ou tenait à une
 * source rejetée, devient à revoir.
 */
export function statuer(
  db: Db,
  sourceId: string,
  statut: "certifiee" | "rejetee",
  par: string,
  revision?: number,
) {
  let retirees: string[] = [];
  transaction(db, () => {
    const refus = statut === "certifiee" && refusCertification(db, sourceId);
    if (refus) throw new Error(`La source n'est pas prête à être certifiée : ${refus}.`);
    if (revision !== undefined) {
      if (revisionEnAttente(db, sourceId)?.n !== revision) {
        throw new Error("Cette version n'attend plus de relecture.");
      }
      // Les questions suggérées ont été vérifiées sur l'ancien texte.
      db.prepare("UPDATE sources SET revision = ?, suggestions_le = NULL WHERE id = ?").run(
        revision,
        sourceId,
      );
      const images = lireInventaire(sourceId, revision);
      if (images) retirees = servirImages(db, sourceId, revision, images);
    }
    db.prepare("UPDATE sources SET statut = ?, statut_par = ?, statut_le = ? WHERE id = ?").run(
      statut,
      par,
      maintenant(),
      sourceId,
    );
    reindexer(db, sourceId);
    revoirActivites(db, sourceId);
  });
  retirer(retirees);
}

// Chaque changement d'une source écrit, réindexe et signale les activités à revoir dans une seule
// transaction, comme `statuer()`. Les routes et la CLI l'appellent sans rien ajouter.

/**
 * Change les lecteurs d'une source. Un exercice dont les élèves perdent l'accès devient à revoir.
 * L'index ne porte pas les lecteurs, et les questions suggérées ne dépendent pas d'eux.
 */
export function changerLecteurs(db: Db, sourceId: string, lecteurs: Audience) {
  transaction(db, () => {
    db.prepare("UPDATE sources SET audience = ? WHERE id = ?").run(lecteurs, sourceId);
    revoirActivites(db, sourceId);
  });
}

/**
 * Rattache une source à `liens`, à la place de ses cours et thèmes précédents. L'en-tête de ses
 * passages porte le nom de ses thèmes : elle se réindexe. Un exercice d'un cours retiré devient
 * à revoir.
 */
export function rattacher(db: Db, sourceId: string, liens: Affiliation[]) {
  transaction(db, () => {
    affiliations(db, sourceId, liens);
    reindexer(db, sourceId);
    revoirActivites(db, sourceId);
  });
}

/**
 * Enregistre les informations et les lecteurs d'une source, et ses cours quand `liens` est
 * donné. Les questions suggérées reprennent le titre et les informations : elles se régénèrent.
 */
export function modifierSource(
  db: Db,
  sourceId: string,
  m: {
    titre: string;
    meta: Record<string, unknown>;
    langue: string;
    audience: Audience;
    reponses: number;
    liens?: Affiliation[];
  },
) {
  transaction(db, () => {
    if (m.liens) affiliations(db, sourceId, m.liens);
    db.prepare(
      `UPDATE sources SET titre = ?, metadonnees = ?, langue = ?, audience = ?, reponses = ?,
       suggestions_le = NULL WHERE id = ?`,
    ).run(m.titre, JSON.stringify(m.meta), m.langue, m.audience, m.reponses, sourceId);
    reindexer(db, sourceId);
    revoirActivites(db, sourceId);
  });
}

/**
 * Relance l'extraction d'une présentation avec ou sans ses diapositives masquées. Rend `false`
 * pendant une extraction : le worker réécrirait la révision en cours.
 */
export function inclureDiapositivesMasquees(db: Db, sourceId: string, inclure: boolean) {
  return transaction(db, () => {
    const { changes } = db
      .prepare(
        `UPDATE ingestion_jobs SET etat = 'received', tentatives = 0, erreur = NULL,
         verrou_expire_le = NULL, maj_le = ?
         WHERE source_id = ? AND etat IN ('awaiting_review', 'failed')`,
      )
      .run(maintenant(), sourceId);
    if (changes) {
      db.prepare(
        `UPDATE sources SET metadonnees = json_set(metadonnees, '$.diapositives_masquees', json(?))
         WHERE id = ?`,
      ).run(JSON.stringify(inclure), sourceId);
    }
    return changes > 0;
  });
}

/**
 * Supprime une source pour de bon. La transaction retire sa ligne et tout ce qui en dérive en
 * base : index, révisions, images, rattachements, suggestions, travail, légendes en cache, et ses
 * citations dans les réponses et les exercices conservés. Ses fichiers partent ensuite. Refusée
 * pendant que le worker l'extrait : il réécrirait des fichiers et le cache après la suppression.
 * `secure_delete` (connexion) et l'option de la migration 0017 effacent aussi son texte du
 * fichier de la base.
 */
export async function supprimerSource(db: Db, sourceId: string) {
  const s = lireSource(db, sourceId);
  if (!s) throw new Error("Source introuvable.");
  const images = db
    .prepare("SELECT revision, fichier, mime FROM images WHERE source_id = ?")
    .all(sourceId) as { revision: number; fichier: string; mime: string }[];
  // ponytail: la clé suit le modèle de légende actuel. Une légende mise en cache sous un autre
  // modèle, pour une image qu'une extraction a retirée ou pour celle d'une révision en attente,
  // reste dans le cache.
  const cles: string[] = [];
  for (const i of images) {
    const octets = await readFile(cheminImage(sourceId, i)).catch(() => undefined);
    if (octets) cles.push(await cleLegende(config.modeles.legende, octets, i.mime, s.profil));
  }
  transaction(db, () => {
    const job = db
      .prepare("SELECT etat, verrou_expire_le FROM ingestion_jobs WHERE source_id = ?")
      .get(sourceId) as { etat: string; verrou_expire_le: string | null } | undefined;
    if (
      job &&
      ["extracting", "enriching"].includes(job.etat) &&
      (job.verrou_expire_le ?? "") > maintenant()
    ) {
      throw new Error("Extraction en cours : supprimer la source une fois le traitement terminé.");
    }
    retirerSource(db, sourceId);
    oublierSource(db, sourceId);
    for (const table of ["images", "suggestions", "ingestion_jobs"]) {
      db.prepare(`DELETE FROM ${table} WHERE source_id = ?`).run(sourceId);
    }
    // Les révisions et les rattachements suivent par ON DELETE CASCADE.
    db.prepare("DELETE FROM sources WHERE id = ?").run(sourceId);
    db.prepare("DELETE FROM cache_modeles WHERE cle IN (SELECT value FROM json_each(?))").run(
      JSON.stringify(cles),
    );
    const messages = db
      .prepare(
        "SELECT id, etat, resultat, journal FROM messages WHERE instr(resultat, ?) OR instr(journal, ?)",
      )
      .all(sourceId, sourceId) as {
      id: string;
      etat: string;
      resultat: string | null;
      journal: string | null;
    }[];
    const ecrire = db.prepare(
      "UPDATE messages SET etat = ?, resultat = ?, journal = ? WHERE id = ?",
    );
    for (const m of messages) {
      const avant = m.resultat ? (JSON.parse(m.resultat) as Resultat) : undefined;
      const apres = avant && resultatSans(avant, sourceId);
      ecrire.run(
        apres === avant ? m.etat : apres!.etat,
        apres ? JSON.stringify(apres) : null,
        m.journal && JSON.stringify(journalSans(JSON.parse(m.journal), (id) => id === sourceId)),
        m.id,
      );
    }
  });
  // Le WAL garde les anciennes pages jusqu'au point de contrôle. TRUNCATE le vide, sauf si une
  // lecture en cours l'en empêche.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  await rm(contenu(sourceId), { recursive: true, force: true });
}
