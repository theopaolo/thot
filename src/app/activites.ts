import {
  ancrer,
  type Champ,
  champs,
  citationsDe,
  type Contenu,
  CRITERES,
  type Explication,
  genererActivite,
  jugerChamps,
  MAX_TEXTE,
} from "../core/activite.ts";
import type { Modeles } from "../core/modeles.ts";
import {
  type ChunkIndexe,
  chercherFts,
  type Perimetre,
  revisionCitable,
  transaction,
} from "../core/recherche.ts";
import { demander } from "../core/reponse.ts";
import { type Compte, lecteur, lireCompte } from "./comptes.ts";
import { config } from "./config.ts";
import { type Db, maintenant } from "./db.ts";
import { catalogueDe } from "./domaines.ts";
import { lireInstance } from "./instance.ts";

export type Activite = {
  id: string;
  cours_id: string;
  objectif_id: string;
  auteur_id: string;
  /** `cours` : les élèves du cours. `prive` : son auteur seul, en mode personnel. */
  audience: "cours" | "prive";
  etat: "brouillon" | "relue" | "publiee" | "a_revoir";
  /** Une explication se lit, sans tentative ni corrigé. */
  type: "exercice" | "explication";
  revision: number;
  /** JSON de `Contenu` pour un exercice, d'`Explication` pour une explication */
  contenu: string;
  /** JSON des motifs des champs rejetés à la génération */
  rejets: string;
  intitule: string;
  reference: string;
  cours: string;
  auteur: string;
};

export type Tentative = { id: string; reponse: string; criteres: string; revision: number };

/**
 * Un exercice privé ne s'ouvre qu'à son auteur. Celui d'un cours s'ouvre à ses membres et aux
 * administrateurs : ses enseignants le préparent, ses élèves le pratiquent une fois publié.
 */
const ACCES = `CASE a.audience WHEN 'prive' THEN a.auteur_id = ? ELSE (? OR EXISTS (
  SELECT 1 FROM membres_cours m WHERE m.cours_id = a.cours_id AND m.compte_id = ?)) END`;
const acces = (c: Compte) => [c.id, c.administrateur, c.id];
const SELECT = `SELECT a.*, o.intitule, o.reference, co.nom AS cours, au.nom AS auteur
  FROM activites a JOIN objectifs o ON o.id = a.objectif_id JOIN cours co ON co.id = a.cours_id
  JOIN comptes au ON au.id = a.auteur_id`;

type Cible = Pick<Activite, "cours_id" | "audience" | "auteur_id">;

/**
 * Le lecteur des preuves : les élèves du cours (le système, restreint au cours), ou l'auteur d'un
 * exercice privé. Une source citée doit être certifiée, rattachée au cours, lisible par ce lecteur
 * et servir à Thot pour répondre.
 */
export const perimetre = (db: Db, a: Cible): Perimetre => ({
  schoolId: lireInstance(db).school_id,
  coursId: a.cours_id,
  lecteur: a.audience === "prive" ? lecteur(lireCompte(db, a.auteur_id)!) : null,
});

const citations = (contenu: string) => citationsDe(JSON.parse(contenu));

/** La révision que sert aujourd'hui chaque source citée, `undefined` si elle n'est plus citable. */
export function servies(db: Db, a: Cible & Pick<Activite, "contenu">) {
  const p = perimetre(db, a);
  const ids = new Set(citations(a.contenu).map((c) => c.source_id));
  return new Map([...ids].map((id) => [id, revisionCitable(db, id, p)]));
}

/** Vrai si chaque citation vise la révision servie d'une source citable dans ce périmètre. */
export const preuvesValides = (db: Db, a: Cible & Pick<Activite, "contenu">) => {
  const s = servies(db, a);
  return citations(a.contenu).every((c) => s.get(c.source_id) === c.revision);
};

const historique = (
  db: Db,
  id: string,
  revision: number,
  action: string,
  compteId: string | null,
) =>
  db
    .prepare("INSERT INTO relectures VALUES (?, ?, ?, ?, ?)")
    .run(id, revision, action, compteId, maintenant());

export const relectures = (db: Db, id: string) =>
  db
    .prepare(
      `SELECT r.revision, r.action, r.le, r.compte_id, c.nom FROM relectures r
       LEFT JOIN comptes c ON c.id = r.compte_id WHERE r.activite_id = ? ORDER BY r.rowid`,
    )
    .all(id) as {
    revision: number;
    action: string;
    le: string;
    compte_id: string | null;
    nom: string | null;
  }[];

/** Qui a relu la version actuelle. */
export const relecteur = (db: Db, a: Activite) =>
  relectures(db, a.id).findLast((r) => r.action === "relue" && r.revision === a.revision)?.nom ??
  undefined;

/** Les exercices que l'enseignant prépare : ceux de ses cours et les siens. */
export const activitesProf = (db: Db, c: Compte) =>
  db
    .prepare(`${SELECT} WHERE ${ACCES} ORDER BY co.nom, o.intitule, a.cree_le`)
    .all(...acces(c)) as Activite[];

export const activiteProf = (db: Db, c: Compte, id: string) =>
  db.prepare(`${SELECT} WHERE a.id = ? AND ${ACCES}`).get(id, ...acces(c)) as Activite | undefined;

/** Les exercices publiés que le compte pratique, tant que leurs preuves tiennent. */
export const activitesEleve = (db: Db, c: Compte, coursId = "", matiereId = "") =>
  (
    db
      .prepare(
        `${SELECT} WHERE a.etat = 'publiee' AND ${ACCES} AND (? = '' OR a.cours_id = ?)
         AND (? = '' OR co.matiere_id = ?) ORDER BY co.nom, o.intitule`,
      )
      .all(...acces(c), coursId, coursId, matiereId, matiereId) as Activite[]
  ).filter((a) => preuvesValides(db, a));

export const activiteEleve = (db: Db, c: Compte, id: string) => {
  const a = db
    .prepare(`${SELECT} WHERE a.id = ? AND a.etat = 'publiee' AND ${ACCES}`)
    .get(id, ...acces(c)) as Activite | undefined;
  return a && preuvesValides(db, a) ? a : undefined;
};

export const objectifs = (db: Db, coursId: string) =>
  db
    .prepare("SELECT id, intitule, reference FROM objectifs WHERE cours_id = ? ORDER BY intitule")
    .all(coursId) as { id: string; intitule: string; reference: string }[];

/** Les sources du cours qu'un exercice peut citer. */
export const sourcesCitables = (db: Db, a: Cible) => {
  const p = perimetre(db, a);
  return (
    db
      .prepare(
        `SELECT s.id, s.titre FROM sources s JOIN source_cours sc ON sc.source_id = s.id
         WHERE sc.cours_id = ? AND s.statut = 'certifiee' ORDER BY s.titre`,
      )
      .all(a.cours_id) as { id: string; titre: string }[]
  ).filter((s) => revisionCitable(db, s.id, p) !== undefined);
};

const PASSAGES = 8;
export const MAX_SOURCES = 4;
// ponytail: quelques passages par source, choisis par FTS5 sur l'objectif, sinon les premiers. Un
// long document peut cacher le passage utile : passer par `chercher()` et son reclasseur si les
// brouillons en souffrent.
function passages(db: Db, a: Cible, objectif: string, ids: string[]) {
  const p = perimetre(db, a);
  const k = Math.max(2, Math.floor(PASSAGES / ids.length));
  return ids.flatMap((id) => {
    const trouves = chercherFts(db, objectif, { ...p, sourceId: id }, k);
    return trouves.length
      ? trouves
      : (db
          .prepare("SELECT * FROM chunks WHERE source_id = ? ORDER BY debut LIMIT ?")
          .all(id, k) as ChunkIndexe[]);
  });
}

const texte = (v: unknown, nom: string, max: number, requis = true) => {
  const t = String(v ?? "").trim();
  if ((requis && !t) || t.length > max) {
    throw new Error(`${nom} : ${requis ? "1" : "0"} à ${max} caractères.`);
  }
  return t;
};

export type Preparation = {
  type: Activite["type"];
  coursId: string;
  /** vide : un nouvel objectif, `intitule` et `reference` */
  objectifId: string;
  intitule: string;
  reference: string;
  sources: string[];
};

/**
 * Rédige le brouillon d'un exercice ou d'une explication sur l'objectif, d'après les sources
 * choisies. Un nouvel objectif n'est enregistré qu'avec l'activité. Une saisie invalide lève une
 * erreur. Rend l'identifiant de l'activité, ou ce qui a manqué à la génération.
 */
export async function preparer(
  db: Db,
  modeles: Modeles,
  compte: Compte,
  s: Preparation,
): Promise<{ id: string } | { erreur: string; rejets: string[] }> {
  const cible: Cible = {
    cours_id: s.coursId,
    audience: lireInstance(db).mode === "personal" ? "prive" : "cours",
    auteur_id: compte.id,
  };
  if (!catalogueDe(db, compte).cours.some((c) => c.id === s.coursId)) {
    throw new Error("Choisissez un de vos cours.");
  }
  const existant = s.objectifId
    ? (db
        .prepare("SELECT intitule FROM objectifs WHERE id = ? AND cours_id = ?")
        .get(s.objectifId, s.coursId) as { intitule: string } | undefined)
    : undefined;
  if (s.objectifId && !existant) throw new Error("Objectif inconnu dans ce cours.");
  const intitule = existant?.intitule ?? texte(s.intitule, "Objectif", 300);
  const reference = existant ? "" : texte(s.reference, "Référence", 300, false);
  const citables = new Set(sourcesCitables(db, cible).map((x) => x.id));
  const ids = [...new Set(s.sources)];
  // Le nombre de sources borne les passages, donc la taille de l'appel.
  if (!ids.length || ids.length > MAX_SOURCES || ids.some((id) => !citables.has(id))) {
    throw new Error(`Choisissez de 1 à ${MAX_SOURCES} sources certifiées de ce cours.`);
  }
  const g =
    s.type === "explication"
      ? await expliquer(db, modeles, intitule, { ...perimetre(db, cible), sources: ids })
      : await genererActivite(modeles, intitule, passages(db, cible, intitule, ids));
  if ("erreur" in g) return { erreur: g.erreur, rejets: [] };
  if (!g.contenu) {
    return {
      erreur:
        "refus" in g
          ? "Thot ne trouve pas dans ces sources de quoi rédiger un exercice sur cet objectif."
          : `Thot n'a pas pu ancrer l'exercice. Il faut une consigne, une réponse attendue, ${CRITERES.min} critères et un retour, chacun cité mot pour mot.`,
      rejets: g.rejets,
    };
  }
  const id = crypto.randomUUID();
  const t = maintenant();
  const contenu = JSON.stringify(g.contenu);
  transaction(db, () => {
    let objectifId = s.objectifId;
    if (!objectifId) {
      objectifId = crypto.randomUUID();
      db.prepare("INSERT INTO objectifs VALUES (?, ?, ?, ?, ?)").run(
        objectifId,
        s.coursId,
        intitule,
        reference,
        t,
      );
    }
    // Une source a pu changer pendant la génération : le brouillon naît alors à revoir.
    db.prepare(
      `INSERT INTO activites (id, cours_id, objectif_id, auteur_id, audience, etat, type, contenu,
       rejets, modele, cree_le, maj_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      s.coursId,
      objectifId,
      compte.id,
      cible.audience,
      preuvesValides(db, { ...cible, contenu }) ? "brouillon" : "a_revoir",
      s.type,
      contenu,
      JSON.stringify(g.rejets),
      g.modele,
      t,
      t,
    );
  });
  return { id };
}

/**
 * Une explication est la réponse vérifiée de `demander()` à l'objectif, posé comme une question
 * dans les sources choisies : mêmes citations, même juge, mêmes blocs.
 */
async function expliquer(
  db: Db,
  modeles: Modeles,
  objectif: string,
  p: Perimetre,
): Promise<{ erreur: string } | { contenu: Explication; rejets: string[]; modele: string }> {
  const { resultat, journal } = await demander(db, modeles, objectif, p, config.seuil);
  if (resultat.etat === "out_of_corpus") {
    return { erreur: "Thot ne trouve pas dans ces sources de quoi expliquer cet objectif." };
  }
  if (resultat.etat === "failed") {
    return { erreur: `Thot n'a pas pu rédiger l'explication : ${resultat.message}` };
  }
  const { affirmations, blocs, partielle, juge_indisponible } = resultat;
  const contenu: Explication = { affirmations, blocs, partielle, juge_indisponible };
  return { contenu, rejets: [], modele: String(journal.modele ?? "") };
}

export const nomChamp = (i: number, n: number) =>
  i === 0 ? "Consigne" : i === 1 ? "Réponse attendue" : i === n - 1 ? "Retour" : `Critère ${i - 1}`;

/** Ce que lit le juge : un champ qui garde son texte et ses passages garde son avis. */
const lu = (ch: Champ) =>
  JSON.stringify([ch.texte, ch.citations.map((c) => [c.citation, c.titre])]);

/**
 * Enregistre la saisie du formulaire de modification (`texte_{i}`, `citation_{i}_{j}`, dans
 * l'ordre de `champs`). Chaque passage se recherche mot pour mot dans la révision servie de sa
 * source : une citation d'une ancienne version s'y réancre ou bloque l'enregistrement. Un critère
 * ou un passage vidé disparaît. Un changement crée une version de l'exercice, à relire. Le juge
 * relit les champs changés et ceux restés sans avis.
 */
export async function modifier(
  db: Db,
  modeles: Modeles,
  compte: Compte,
  a: Activite,
  b: Record<string, unknown>,
) {
  if (a.type === "explication") {
    throw new Error("Une explication ne se modifie pas. Préparez-en une autre.");
  }
  if (Number(b.revision) !== a.revision) return "conflit";
  const liste = champs(JSON.parse(a.contenu) as Contenu);
  const p = perimetre(db, a);
  const nouveaux = liste.map((ch, i): Champ | undefined => {
    const nom = nomChamp(i, liste.length);
    const t = texte(b[`texte_${i}`], nom, MAX_TEXTE, false);
    const cites = ch.citations.flatMap((c, j) => {
      const passage = texte(b[`citation_${i}_${j}`], `${nom}, passage`, 1000, false);
      if (!passage) return [];
      if (revisionCitable(db, c.source_id, p) === undefined) {
        throw new Error(
          `« ${c.titre} » n'est plus une source citable de ce cours. Préparez un autre exercice.`,
        );
      }
      const chunks = db
        .prepare("SELECT * FROM chunks WHERE source_id = ? ORDER BY debut")
        .all(c.source_id) as ChunkIndexe[];
      const trouvee = ancrer(passage, chunks);
      if (!trouvee) {
        throw new Error(`${nom} : passage introuvable mot pour mot dans « ${c.titre} ».`);
      }
      return [trouvee];
    });
    if (!t) return undefined;
    if (!cites.length) throw new Error(`${nom} : un champ garde au moins un passage cité.`);
    const nouveau: Champ = { texte: t, citations: cites };
    return lu(nouveau) === lu(ch) && "soutien" in ch
      ? { ...nouveau, soutien: ch.soutien }
      : nouveau;
  });
  const [consigne, attendu] = nouveaux;
  const retour = nouveaux.at(-1);
  const criteres = nouveaux.slice(2, -1).filter((c) => c !== undefined);
  if (!consigne || !attendu || !retour) {
    throw new Error("La consigne, la réponse attendue et le retour restent remplis.");
  }
  if (criteres.length < CRITERES.min || criteres.length > CRITERES.max) {
    throw new Error(`De ${CRITERES.min} à ${CRITERES.max} critères.`);
  }
  const neuf: Contenu = { consigne, attendu, criteres, retour };
  if (JSON.stringify(neuf) === a.contenu) return "inchange";
  await jugerChamps(modeles, champs(neuf));
  const contenu = JSON.stringify(neuf);
  return transaction(db, () => {
    const r = db
      .prepare(
        `UPDATE activites SET contenu = ?, revision = revision + 1, etat = 'brouillon', maj_le = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(contenu, maintenant(), a.id, a.revision);
    if (!r.changes) return "conflit";
    historique(db, a.id, a.revision + 1, "modifiee", compte.id);
    return "modifie";
  });
}

/** Relit la version affichée d'un brouillon. Une autre version ne se relit pas à sa place. */
export const relire = (db: Db, compte: Compte, a: Activite, revision: number) =>
  transaction(db, () => {
    const r = db
      .prepare(
        "UPDATE activites SET etat = 'relue', maj_le = ? WHERE id = ? AND revision = ? AND etat = 'brouillon'",
      )
      .run(maintenant(), a.id, revision);
    if (r.changes) historique(db, a.id, revision, "relue", compte.id);
    return r.changes > 0;
  });

const signaler = (db: Db, a: Pick<Activite, "id" | "revision">) => {
  db.prepare("UPDATE activites SET etat = 'a_revoir', maj_le = ? WHERE id = ?").run(
    maintenant(),
    a.id,
  );
  historique(db, a.id, a.revision, "a_revoir", null);
};

/** Publie la version relue. Une preuve qui ne tient plus fait signaler l'exercice à revoir. */
export const publier = (db: Db, compte: Compte, id: string, revision: number) =>
  transaction(db, () => {
    // Relue dans la transaction : une modification arrivée entre-temps n'est pas publiée.
    const a = db.prepare("SELECT * FROM activites WHERE id = ?").get(id) as Activite;
    if (a.etat !== "relue" || a.revision !== revision) return "refus";
    if (!preuvesValides(db, a)) {
      signaler(db, a);
      return "preuves";
    }
    db.prepare("UPDATE activites SET etat = 'publiee', maj_le = ? WHERE id = ?").run(
      maintenant(),
      a.id,
    );
    historique(db, a.id, revision, "publiee", compte.id);
    return "publiee";
  });

/**
 * Signale à revoir les exercices qui citent la source et dont une preuve ne tient plus : nouvelle
 * révision servie, rejet, lecteurs ou cours retirés. `statuer()` l'appelle, comme les routes qui
 * changent les lecteurs ou les cours d'une source. La page de l'élève revérifie aussi à chaque affichage.
 */
export function revoirActivites(db: Db, sourceId: string) {
  const liste = db
    .prepare("SELECT * FROM activites WHERE etat != 'a_revoir' AND instr(contenu, ?)")
    .all(sourceId) as Activite[];
  for (const a of liste) if (!preuvesValides(db, a)) signaler(db, a);
}

/**
 * Retire des activités ce qui vient d'une source supprimée : ses passages, et le texte des champs
 * qui les citaient, rédigé d'après elle. Une explication perd les phrases qui la citaient et ses
 * blocs, dont les titres ont pu la nommer. L'activité est à revoir. Les tentatives des élèves
 * gardent leur réponse et la version à laquelle elles répondaient.
 */
export function oublierSource(db: Db, sourceId: string) {
  const liste = db
    .prepare("SELECT id, revision, etat, contenu FROM activites WHERE instr(contenu, ?)")
    .all(sourceId) as Pick<Activite, "id" | "revision" | "etat" | "contenu">[];
  const sans = (ch: Champ): Champ =>
    ch.citations.some((c) => c.source_id === sourceId)
      ? { texte: "", citations: ch.citations.filter((c) => c.source_id !== sourceId) }
      : ch;
  for (const a of liste) {
    const c = JSON.parse(a.contenu) as Contenu | Explication;
    const contenu: Contenu | Explication =
      "affirmations" in c
        ? { affirmations: c.affirmations.filter((x) => x.source_id !== sourceId) }
        : {
            consigne: sans(c.consigne),
            attendu: sans(c.attendu),
            criteres: c.criteres.map(sans),
            retour: sans(c.retour),
          };
    db.prepare("UPDATE activites SET contenu = ? WHERE id = ?").run(JSON.stringify(contenu), a.id);
    if (a.etat !== "a_revoir") signaler(db, a);
  }
}

/** La dernière tentative du compte sur la version actuelle : elle seule ouvre le corrigé. */
export const tentative = (db: Db, c: Compte, a: Activite) =>
  db
    .prepare(
      `SELECT id, reponse, criteres, revision FROM tentatives
       WHERE activite_id = ? AND compte_id = ? AND revision = ? ORDER BY rowid DESC LIMIT 1`,
    )
    .get(a.id, c.id, a.revision) as Tentative | undefined;

export const repondre = (db: Db, c: Compte, a: Activite, reponse: string) =>
  db
    .prepare(
      "INSERT INTO tentatives (id, activite_id, compte_id, revision, reponse, cree_le) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(crypto.randomUUID(), a.id, c.id, a.revision, reponse, maintenant());

/** Les critères que l'élève coche sur sa tentative de la version actuelle. */
export function evaluer(db: Db, c: Compte, a: Activite, tentativeId: string, coches: number[]) {
  const n = (JSON.parse(a.contenu) as Contenu).criteres.length;
  const criteres = [...new Set(coches)].filter((i) => Number.isInteger(i) && i >= 0 && i < n);
  return (
    db
      .prepare(
        `UPDATE tentatives SET criteres = ? WHERE id = ? AND activite_id = ? AND compte_id = ?
         AND revision = ?`,
      )
      .run(JSON.stringify(criteres.sort((x, y) => x - y)), tentativeId, a.id, c.id, a.revision)
      .changes > 0
  );
}
