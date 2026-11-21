import type { Modeles } from "../../core/modeles.ts";
import { type Db, maintenant } from "../db.ts";
import { type Meta, regroupement } from "./indexation.ts";
import { lireDocument, lireSource } from "./revisions.ts";

const INFORMATIONS = ["date", "artiste", "mouvement"] as const;

const CONSIGNE_INFORMATIONS = `Tu lis la fiche d'un document de cours d'arts appliqués : titre,
nom de fichier, séquence, séance et début du texte. Relève l'œuvre qu'il présente :
- date : l'année ou la période de l'œuvre, par exemple « 1923 » ou « 1900-1913 » ;
- artiste : le ou les auteurs de l'œuvre, séparés par des virgules ;
- mouvement : le mouvement artistique, par exemple « Art nouveau ». La séquence le nomme
  souvent.

Recopie les mots de la fiche. Laisse le champ vide si la fiche ne le donne pas : n'utilise pas
ce que tu sais par ailleurs.

Réponds par un objet JSON seul : {"date": "", "artiste": "", "mouvement": ""}`;

const plier = (s: string) =>
  ` ${s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;

/**
 * Date, artiste et mouvement lus dans la sortie du modèle. Une valeur dont un morceau ne se lit
 * pas dans la fiche est inventée: elle reste vide.
 */
export function lireInformations(sortie: string, fiche: string): Record<string, string> {
  const brut = JSON.parse(sortie.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
  const lue = plier(fiche);
  return Object.fromEntries(
    INFORMATIONS.map((nom) => {
      const v = typeof brut[nom] === "string" ? brut[nom].trim().slice(0, 120) : "";
      const morceaux = v
        .split(/,| et /)
        .map(plier)
        .filter((m) => m.trim());
      return [nom, morceaux.every((m) => lue.includes(m)) ? v : ""];
    }),
  );
}

/** Prochaine source extraite sans proposition, que l'enseignant n'a pas encore enregistrée. */
export const sourceSansInformations = (db: Db) =>
  db
    .prepare(
      `SELECT s.id FROM sources s JOIN ingestion_jobs j ON j.source_id = s.id
     WHERE j.etat = 'awaiting_review' AND s.statut != 'rejetee' AND s.profil = 'arts-appliques'
       AND json_type(s.metadonnees, '$.propositions') IS NULL
       AND json_type(s.metadonnees, '$.artiste') IS NULL
     LIMIT 1`,
    )
    .get()?.id as string | undefined;

/**
 * Propose date, artiste et mouvement d'après le titre, le nom du fichier et le début du texte.
 * La proposition reste dans `propositions`, hors de la vue élève, jusqu'à ce que l'enseignant
 * enregistre le formulaire de la source.
 */
export async function proposerInformations(db: Db, modeles: Modeles, sourceId: string) {
  const s = lireSource(db, sourceId);
  if (s.profil !== "arts-appliques") return;
  const meta = JSON.parse(s.metadonnees) as Meta;
  let texte: string;
  try {
    texte = lireDocument(sourceId, s.revision).texte;
  } catch (e) {
    // Un fichier de la révision manque ou est abîmé, par exemple après la restauration d'une
    // sauvegarde prise pendant une suppression. Le travail passe en échec : la source ne revient
    // plus ici, sa page affiche la cause, et le worker continue.
    const cause = `Texte extrait illisible : ${(e as Error).message}`;
    console.error(`informations ${sourceId}: ${cause}`);
    db.prepare(
      `UPDATE ingestion_jobs SET etat = 'failed', erreur = ?, maj_le = ?
       WHERE source_id = ? AND etat = 'awaiting_review'`,
    ).run(cause, maintenant(), sourceId);
    return;
  }
  const fiche = [
    `Titre : ${s.titre}`,
    `Fichier : ${s.fichier}`,
    `Séquence : ${regroupement(db, s) ?? ""}`,
    `Séance : ${meta.seance ?? ""}`,
    `Texte : ${texte.slice(0, 2000)}`,
  ].join("\n");
  let propositions = {};
  try {
    const { texte } = await modeles.generer([
      { role: "system", content: CONSIGNE_INFORMATIONS },
      { role: "user", content: fiche },
    ]);
    propositions = lireInformations(texte, fiche);
  } catch (e) {
    // ponytail: un échec laisse une proposition vide pour ne pas boucler. Retirer
    // `$.propositions` des métadonnées relance la source.
    console.error(`informations ${sourceId}: ${(e as Error).message}`);
  }
  // L'enseignant a pu enregistrer pendant l'appel: sa saisie l'emporte.
  db.prepare(
    `UPDATE sources SET metadonnees = json_set(metadonnees, '$.propositions', json(?))
     WHERE id = ? AND json_type(metadonnees, '$.artiste') IS NULL`,
  ).run(JSON.stringify(propositions), sourceId);
}
