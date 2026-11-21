import { assertEquals } from "@std/assert";
import type { Db } from "../src/app/db.ts";
import { cours, matiere } from "../src/app/domaines.ts";
import { saisieDe } from "../src/app/edition.ts";
import { configurerInstance } from "../src/app/instance.ts";
import type { Contenu, Question } from "../src/core/activite.ts";
import type { Modeles } from "../src/core/modeles.ts";
import { environnement, fauxModeles, publier, session } from "./outils.ts";

const cite = (texte: string, citation: string) => ({
  texte,
  citations: [{ extrait: 1, citation }],
});
const ATTENDU = "Gaudí refuse la ligne droite.";
const CRITERE = "La réponse nomme la ligne droite.";
export const RETOUR = "Sa façade est couverte de céramique irisée.";
export const OBJECTIF = "Expliquer le refus de la ligne droite chez Gaudí";
/** Une sortie du générateur : le troisième critère cite un passage absent du cours. */
export const sortie = (attendu = "Gaudí refuse la ligne droite dans toute la façade") =>
  JSON.stringify({
    consigne: cite(
      "Que refuse Gaudí dans la façade de la Casa Batlló ?",
      "Gaudí refuse la ligne droite dans toute la façade",
    ),
    attendu: cite(ATTENDU, attendu),
    criteres: [
      cite(CRITERE, "refuse la ligne droite dans toute la façade"),
      cite("La réponse vise toute la façade.", "la ligne droite dans toute la façade"),
      cite("La réponse cite le plan libre.", "Le Corbusier invente le plan libre"),
    ],
    retour: cite(RETOUR, "La façade de la Casa Batlló est couverte de céramique irisée"),
  });

type Session = Awaited<ReturnType<typeof session>> & { id: string };

export async function compte(
  db: Db,
  role: "enseignant" | "eleve",
  modeles: Modeles = fauxModeles().modeles,
  inscrit = true,
): Promise<Session> {
  const s = await session(db, modeles, role, inscrit);
  const id = db.prepare("SELECT id FROM comptes ORDER BY rowid DESC LIMIT 1").get()!.id as string;
  return { ...s, id };
}

export const envoyer = (s: Session, url: string, corps: Record<string, string | string[]> = {}) => {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(corps)) for (const x of [v].flat()) f.append(k, x);
  return s.requete(url, { method: "POST", body: f });
};
export const page = async (s: Session, url: string) => (await s.requete(url)).text();
export const statut = async (r: Response | Promise<Response>) => (await r).status;

/**
 * Un cours, sa source publiée aux élèves, un enseignant et un élève du cours. `juge` remplace le
 * juge de soutien de l'enseignant.
 */
export async function cadre(personnel = false, juge?: Modeles["soutenir"], sorties = [sortie()]) {
  const { db, dir } = await environnement();
  if (personnel) configurerInstance(db, "Mon étude", "personal");
  const coursId = cours(db, matiere(db, "Arts appliqués"), "Design");
  const source = await publier(db, "Casa Batlló", coursId);
  const generateur = fauxModeles({ sorties });
  if (juge) generateur.modeles.soutenir = juge;
  const prof = await compte(db, "enseignant", generateur.modeles);
  const eleve = await compte(db, "eleve");
  return { db, dir, coursId, source, prof, eleve, vus: generateur.vus };
}

export async function preparer(s: Session, coursId: string, source: string, intitule = OBJECTIF) {
  const r = await envoyer(s, "/prof/activites", {
    cours_id: coursId,
    intitule,
    reference: "STD2A, référentiel 2024, C3",
    sources: source,
  });
  assertEquals(r.status, 303, await r.text());
  return r.headers.get("location")!.split("/").at(-1)!;
}

export const ligne = (db: Db, id: string) =>
  db
    .prepare("SELECT etat, revision, contenu, rejets, objectif_id FROM activites WHERE id = ?")
    .get(id) as {
    etat: string;
    revision: number;
    contenu: string;
    rejets: string;
    objectif_id: string;
  };
export const serie = (db: Db, id: string) => JSON.parse(ligne(db, id).contenu) as Contenu;
export type Redigee = Extract<Question, { type: "redigee" }>;
export const premiere = (db: Db, id: string) => serie(db, id).questions[0] as Redigee;

/** Le formulaire de la question `qid` rempli avec sa version enregistrée, puis `change`. */
function formulaire(db: Db, id: string, qid: string, change: Record<string, string | string[]>) {
  const q = serie(db, id).questions.find((x) => x.id === qid)!;
  return { revision: String(ligne(db, id).revision), ...saisieDe(q), ...change };
}
/** Enregistre la question `qid`, la première par défaut, avec les changements demandés. */
export const modifier = (
  s: Session,
  db: Db,
  id: string,
  change: Record<string, string | string[]> = {},
  qid = serie(db, id).questions[0].id,
) =>
  envoyer(
    s,
    `/prof/activites/${id}/questions/${encodeURIComponent(qid)}/enregistrer`,
    formulaire(db, id, qid, change),
  );

export async function relirePublier(prof: Session, db: Db, id: string) {
  const revision = String(ligne(db, id).revision);
  assertEquals(await statut(envoyer(prof, `/prof/activites/${id}/relire`, { revision })), 303);
  assertEquals(await statut(envoyer(prof, `/prof/activites/${id}/publier`, { revision })), 303);
  assertEquals(ligne(db, id).etat, "publiee");
}

export const actions = (db: Db, id: string) =>
  db
    .prepare("SELECT action, revision FROM relectures WHERE activite_id = ? ORDER BY rowid")
    .all(id)
    .map((l) => `${l.action} ${l.revision}`);
