import type { DatabaseSync } from "node:sqlite";
import { type Message, type Modeles, PanneModele } from "./modeles.ts";
import {
  type Candidat,
  chercher,
  type ChunkIndexe,
  lireChunk,
  type Perimetre,
  revisionCitable,
} from "./recherche.ts";
import { trouverFragments } from "./texte.ts";
import type { Profil } from "./profils.ts";

export type Affirmation = {
  texte: string;
  citation: string;
  source_id: string;
  chunk_id: string;
  titre: string;
  image_id?: string;
  /** offsets dans `document.txt`, absents quand la citation vient d'une légende certifiée */
  debut?: number;
  fin?: number;
  /** révision citée, absente des réponses antérieures aux révisions: elles citent la révision 1 */
  revision?: number;
  /** comparaison : la ou les matières de l'extrait cité */
  matiere?: string;
};

/**
 * Un bloc range des affirmations, désignées par leur indice dans la réponse. Il n'apporte aucun
 * fait : ses titres, colonnes et lignes viennent du modèle sans preuve.
 */
export type BlocReponse =
  | { type: "paragraphe" | "liste" | "etapes"; titre?: string; affirmations: number[] }
  | {
      type: "tableau";
      titre?: string;
      colonnes: string[];
      /** une case par colonne, `null` pour une case vide */
      lignes: { titre: string; affirmations: (number | null)[] }[];
    };

type Repondue = {
  affirmations: Affirmation[];
  /** absent : un seul paragraphe, comme toute réponse antérieure aux blocs */
  blocs?: BlocReponse[];
  /** une affirmation au moins est passée sans l'avis du juge */
  juge_indisponible?: boolean;
  /** des affirmations citaient une source supprimée depuis, et ont été retirées */
  source_supprimee?: boolean;
};

export type Resultat =
  | ({
      etat: "answered";
      partielle?: boolean;
      /** comparaison : les matières où aucun passage n'a passé le seuil */
      sans_passage?: string[];
    } & Repondue)
  | { etat: "out_of_corpus"; raison: "seuil" | "refus_modele" }
  | { etat: "failed"; code: string; message: string };

export type Journal = Record<string, unknown>;

// Le texte d'arts appliqués est celui que mesurent `evaluation/resultats/ml4-*`.
const SYSTEME_ARTS = `Tu reponds a des eleves de Terminale a partir d'extraits d'un corpus de cours
fourni par leur professeur, et de RIEN d'autre.

Regles, sans exception :
1. Chaque affirmation de ta reponse doit se trouver dans les extraits fournis.
   Tu n'ajoutes aucune connaissance personnelle, meme si tu es sur d'elle.
2. Si les extraits ne contiennent pas de quoi repondre, tu rends exactement {"refus": true}.
   Une reponse partielle vaut mieux qu'une invention, mais une invention ne vaut jamais
   mieux qu'un refus.
3. Tu rends uniquement un objet JSON, sans texte autour, de cette forme :
   {"affirmations": [{"texte": "...", "extrait": 2, "citation": "..."}]}
   - "texte" : une phrase de ta reponse, en francais, dans une langue simple.
   - "extrait" : le numero de l'extrait qui justifie cette phrase.
   - "citation" : un passage de 5 a 40 mots recopie EXACTEMENT, mot pour mot, de cet
     extrait, et qui prouve la phrase. Un seul passage continu, sans points de
     suspension, sans guillemets ajoutes, sans corriger l'orthographe du cours.
4. Une affirmation porte un seul fait, pris dans un seul extrait, et ne dit rien de plus que
   sa citation : aucune cause, date, nom, exemple ou precision venus d'un autre extrait ou de
   tes connaissances. Si la reponse a besoin de deux extraits, ecris deux affirmations.
5. Nomme le sujet de chaque affirmation (mouvement, artiste, oeuvre) comme l'extrait le nomme.
   Choisis une citation qui contient le fait affirme et, quand c'est possible, le nom de ce
   sujet : une citation qui commence par « il » ou « ils » ne dit pas de qui elle parle.
6. Cinq affirmations au maximum, 120 mots de reponse au total.`;
// Le profil général répond plus long et peut ranger ses affirmations en blocs (`ranger`).
const MAX_AFFIRMATIONS = 8;
const MAX_MOTS = 250;
const MAX_BLOCS = 4;
const MAX_COLONNES = 4;
const MAX_TITRE = 60;
const SYSTEME: Record<Profil, string> = {
  "arts-appliques": SYSTEME_ARTS,
  general: SYSTEME_ARTS.replace(
    "des eleves de Terminale a partir d'extraits d'un corpus de cours\nfourni par leur professeur",
    "une personne qui apprend a partir d'extraits de ressources\nfournies",
  )
    .replace("(mouvement, artiste, oeuvre)", "(personne, notion, objet)")
    .replace(
      "6. Cinq affirmations au maximum, 120 mots de reponse au total.",
      `6. Au plus ${MAX_AFFIRMATIONS} affirmations et ${MAX_MOTS} mots de reponse au total.
   Ecris seulement ce que la question demande. Chaque affirmation apporte un fait nouveau :
   retire celle qui redit une affirmation precedente avec d'autres mots, meme si elle vient
   d'un autre extrait.
7. Si la question demande une procedure, une comparaison ou une enumeration, ajoute a cote de
   "affirmations" une cle "blocs" qui les range dans l'ordre de lecture :
   "blocs": [{"type": "etapes", "titre": "...", "affirmations": [1, 2, 3]}]
   - "etapes" pour une procedure, une etape par affirmation, dans l'ordre ou on les fait.
     "liste" pour des elements sans ordre. "paragraphe" pour une explication.
   - Pour comparer, un bloc "tableau" : une colonne par element compare, une ligne par point
     de comparaison, une affirmation ou null par case :
     {"type": "tableau", "colonnes": ["A", "B"], "lignes": [{"titre": "...", "affirmations": [4, 5]}]}
   - Les nombres designent tes affirmations, 1 pour la premiere. Chaque affirmation va dans un
     seul bloc. ${MAX_BLOCS} blocs au maximum.
   - Un titre, une colonne ou une ligne tient en quelques mots et n'apporte aucun fait.
   Pour une question simple, n'ajoute pas de blocs.`,
    ),
};
// Ajoutée au profil général pour une comparaison seulement : la consigne ordinaire ne change pas.
const COMPARAISON =
  "8. Les extraits nomment leur matiere : dans un tableau, une colonne par matiere.";

/** Les consignes d'arts appliqués servent quand toutes les sources citables en viennent. */
export function profilSources(db: DatabaseSync, ids: string[]): Profil {
  const arts =
    ids.length > 0 &&
    ids.every(
      (id) =>
        db.prepare("SELECT profil FROM sources WHERE id = ?").get(id)?.profil === "arts-appliques",
    );
  return arts ? "arts-appliques" : "general";
}

// En comparaison seulement, l'extrait nomme sa matière : le format mesuré ne change pas.
const bloc = (retenus: Candidat[]) =>
  retenus
    .map(
      (c, i) =>
        `[${i + 1}] ${c.titre}${c.matieres ? ` (matière : ${c.matieres.join(", ")})` : ""}\n${c.preuve}`,
    )
    .join("\n\n");

// Le modèle peut rendre n'importe quelle forme: chaque champ est vérifié avant usage.
type Brute = { refus?: unknown; affirmations?: unknown; blocs?: unknown };
type BruteAffirmation = { texte?: unknown; extrait?: unknown; citation?: unknown } | null;
type BruteBloc = Record<string, unknown> | null;

const chaine = (x: unknown) => (typeof x === "string" ? x.trim() : "");

/** Le premier objet JSON de la sortie du modèle, sans le texte autour. */
export function lire(sortie: string): Brute | null {
  const debut = sortie.indexOf("{");
  const fin = sortie.lastIndexOf("}");
  if (debut < 0 || fin < debut) return null;
  try {
    return JSON.parse(sortie.slice(debut, fin + 1));
  } catch {
    return null;
  }
}

/** Contrôles déterministes: chaque citation existe mot pour mot dans l'extrait qu'elle désigne. */
export function verifier(
  brute: Brute | null,
  retenus: (ChunkIndexe & Pick<Candidat, "matieres">)[],
) {
  const erreurs: string[] = [];
  // Suit la liste du modèle, que ses blocs désignent par rang : une affirmation refusée y laisse
  // un trou.
  const parRang: (Affirmation | undefined)[] = [];
  if (!brute) return { erreurs: ["La sortie n'est pas un objet JSON."], affirmations: [], parRang };
  if (brute.refus) return { erreurs, affirmations: [], parRang, refus: true };
  const liste: BruteAffirmation[] = Array.isArray(brute.affirmations) ? brute.affirmations : [];
  if (!liste.length) erreurs.push("Aucune affirmation.");
  parRang.length = liste.length;
  liste.forEach((a, i) => {
    const c = retenus[Number(a?.extrait) - 1];
    const texte = chaine(a?.texte);
    const citation = chaine(a?.citation);
    if (!texte) return erreurs.push(`Affirmation ${i + 1}: texte vide.`);
    if (!c) return erreurs.push(`Affirmation ${i + 1}: l'extrait ${a?.extrait} n'existe pas.`);
    if (citation.split(/\s+/).length < 3) {
      return erreurs.push(`Affirmation ${i + 1}: citation trop courte.`);
    }
    const base = {
      texte,
      citation,
      source_id: c.source_id,
      chunk_id: c.id,
      revision: c.revision,
      ...(c.matieres && { matiere: c.matieres.join(", ") }),
    };
    const dansTexte = trouverFragments(c.texte, citation);
    if (dansTexte) {
      parRang[i] = {
        ...base,
        titre: c.titre,
        debut: c.debut + dansTexte[0],
        fin: c.debut + dansTexte[1],
      };
    } else if (trouverFragments(c.preuve, citation)) {
      parRang[i] = { ...base, titre: c.titre };
    } else {
      erreurs.push(
        `Affirmation ${
          i + 1
        }: la citation n'apparaît pas mot pour mot dans l'extrait ${a?.extrait}.`,
      );
    }
  });
  return { erreurs, affirmations: parRang.filter((a) => a !== undefined), parRang, refus: false };
}

/**
 * Range les affirmations retenues dans les blocs du modèle, dans l'ordre de lecture : les
 * numéros des citations suivent cet ordre. Une affirmation refusée quitte son bloc, un bloc vide
 * disparaît, une affirmation qu'aucun bloc ne range finit dans un dernier paragraphe. Une
 * structure invalide donne un seul paragraphe.
 */
export function ranger(brutes: unknown, parRang: (Affirmation | undefined)[]): Repondue {
  const plat = { affirmations: parRang.filter((a) => a !== undefined) };
  if (!Array.isArray(brutes) || !brutes.length || brutes.length > MAX_BLOCS) return plat;
  const invalide = (): never => {
    throw new Error("structure invalide");
  };
  const titre = (x: unknown, requis = false) => {
    const t = chaine(x);
    return (requis && !t) || t.length > MAX_TITRE ? invalide() : t;
  };
  const liste = (x: unknown) => (Array.isArray(x) ? (x as unknown[]) : invalide());
  const affirmations: Affirmation[] = [];
  const vus = new Set<number>();
  // Un rang désigne une affirmation du modèle, une seule fois. Il devient son indice dans la
  // réponse, ou `null` si elle a été refusée.
  const placer = (x: unknown) => {
    const n = Number.isInteger(x) ? (x as number) : 0;
    if (n < 1 || n > parRang.length || vus.has(n)) invalide();
    vus.add(n);
    const a = parRang[n - 1];
    return a ? affirmations.push(a) - 1 : null;
  };
  try {
    const blocs = (brutes as BruteBloc[]).flatMap((b): BlocReponse[] => {
      const t = titre(b?.titre);
      const avecTitre = t ? { titre: t } : {};
      const type = b?.type;
      if (type === "tableau") {
        const colonnes = liste(b?.colonnes).map((c) => titre(c, true));
        if (!colonnes.length || colonnes.length > MAX_COLONNES) invalide();
        const lignes = liste(b?.lignes)
          .map((l) => {
            const cases = liste((l as BruteBloc)?.affirmations);
            if (cases.length > colonnes.length) invalide();
            return {
              titre: titre((l as BruteBloc)?.titre, true),
              affirmations: cases.map((x) => (x === null ? null : placer(x))),
            };
          })
          .filter((l) => l.affirmations.some((n) => n !== null));
        return lignes.length ? [{ type, ...avecTitre, colonnes, lignes }] : [];
      }
      if (type !== "paragraphe" && type !== "liste" && type !== "etapes") return invalide();
      const indices = liste(b?.affirmations)
        .map(placer)
        .filter((n) => n !== null);
      return indices.length ? [{ type, ...avecTitre, affirmations: indices }] : [];
    });
    const reste = plat.affirmations.filter((a) => !affirmations.includes(a));
    if (reste.length) {
      blocs.push({ type: "paragraphe", affirmations: reste.map((a) => affirmations.push(a) - 1) });
    }
    return { affirmations, blocs };
  } catch {
    return plat;
  }
}

/**
 * Une réponse conservée perd sa validation dès qu'une de ses preuves est retirée ou modifiée. Une
 * citation d'une révision qui ne sert plus se revérifie dans les chunks que `ancienne` recalcule
 * pour cette révision, avec les titres et légendes actuels.
 */
export function actualiserResultat(
  db: DatabaseSync,
  resultat: Resultat,
  p: Perimetre,
  ancienne: (sourceId: string, revision: number) => ChunkIndexe[] = () => [],
): Resultat {
  if (resultat.etat !== "answered") return resultat;
  for (const a of resultat.affirmations) {
    const n = a.revision ?? 1;
    let c = lireChunk(db, a.source_id, a.chunk_id, p);
    if (c?.revision !== n) {
      const servie = c?.revision ?? revisionCitable(db, a.source_id, p);
      c =
        servie !== undefined && n < servie
          ? ancienne(a.source_id, n).find((x) => x.id === a.chunk_id)
          : undefined;
    }
    const valide = c && verifier({ affirmations: [{ ...a, extrait: 1 }] }, [c]).affirmations[0];
    if (!valide || valide.titre !== a.titre || valide.debut !== a.debut || valide.fin !== a.fin) {
      return {
        etat: "failed",
        code: "EVIDENCE_WITHDRAWN",
        message:
          "Une source de cette réponse a été retirée ou modifiée. Pose à nouveau ta question.",
      };
    }
  }
  return resultat;
}

/**
 * Une réponse conservée sans les affirmations qui citent une source supprimée. Les autres
 * restent, chacune prouvée par sa citation, en un paragraphe : les titres de blocs viennent du
 * modèle sans preuve et ont pu nommer la source retirée. Sans affirmation, la réponse est
 * indisponible.
 */
export function resultatSans(r: Resultat, sourceId: string): Resultat {
  if (r.etat !== "answered" || !r.affirmations.some((a) => a.source_id === sourceId)) return r;
  const affirmations = r.affirmations.filter((a) => a.source_id !== sourceId);
  if (!affirmations.length) {
    return { etat: "failed", code: "SOURCE_DELETED", message: "Une source citée a été supprimée." };
  }
  const reste = { ...r, affirmations, source_supprimee: true };
  delete reste.blocs;
  return reste;
}

/**
 * Un journal sans les candidats des sources `retiree`. Les sorties du modèle partent avec eux :
 * elles recopient les extraits.
 */
export function journalSans(journal: Journal, retiree: (sourceId: string) => boolean): Journal {
  const candidats = (journal.candidats ?? []) as { source_id: string }[];
  if (!candidats.some((c) => retiree(c.source_id))) return journal;
  const reste: Journal = { ...journal, candidats: candidats.filter((c) => !retiree(c.source_id)) };
  delete reste.tentatives;
  return reste;
}

/**
 * Probabilité de soutien sous laquelle une affirmation est refusée. Le juge raisonne puis rend
 * presque toujours 0 ou 1. Sur 223 paires et trois passages
 * (`evaluation/resultats/soutien-calibrage-*.json`), aucune paire fausse ne dépasse 0,35 et
 * aucune bonne phrase ne tombe entre 0,35 et 0,59.
 */
export const SEUIL_SOUTIEN = 0.5;
/** Un appel du juge dure 1 s en médiane, mais la queue monte à 10 s: au-delà, il ne bloque pas. */
const DELAI_JUGE_MS = 4000;

/**
 * Le juge vérifie que chaque citation, lue sous le titre de son extrait, prouve sa phrase.
 * Un juge injoignable ou trop lent laisse passer l'affirmation: les citations restent vérifiées
 * mot pour mot, la panne est notée au journal et la réponse porte `juge_indisponible`.
 */
async function juger(
  modeles: Modeles,
  affirmations: Affirmation[],
  journal: Journal,
  profil: Profil,
  signal?: AbortSignal,
) {
  const verdicts = await Promise.allSettled(
    affirmations.map((a) => {
      const controle = new AbortController();
      let minuteur: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        modeles.soutenir(
          a.texte,
          a.citation,
          a.titre,
          AbortSignal.any([controle.signal, ...(signal ? [signal] : [])]),
          profil,
        ),
        new Promise<never>((_, non) => {
          minuteur = setTimeout(() => {
            const erreur = new Error("juge au-delà du délai");
            controle.abort(erreur);
            non(erreur);
          }, DELAI_JUGE_MS);
        }),
      ]).finally(() => clearTimeout(minuteur));
    }),
  );
  const soutenues: Affirmation[] = [];
  const erreurs: string[] = [];
  const probabilites: (number | null)[] = [];
  verdicts.forEach((v, i) => {
    const a = affirmations[i];
    if (v.status === "rejected") {
      journal.juge_indisponible = (v.reason as Error).message;
      probabilites.push(null);
      return soutenues.push(a);
    }
    probabilites.push(v.value.probabilite);
    if (v.value.probabilite >= SEUIL_SOUTIEN) return soutenues.push(a);
    erreurs.push(
      `L'affirmation « ${a.texte} » dit plus que sa citation. Reformule-la au plus près de la citation, sans rien ajouter, ou retire-la.`,
    );
  });
  return { soutenues, erreurs, probabilites };
}

/**
 * Recherche, génération, vérification. Aucune exception ne sort: une panne devient `failed`.
 * `signal` interrompt l'appel de modèle en cours.
 */
export async function demander(
  db: DatabaseSync,
  modeles: Modeles,
  question: string,
  p: Perimetre,
  seuil: number,
  etape: (nom: string) => void = () => {},
  questionPrecedente?: string,
  signal?: AbortSignal,
): Promise<{ resultat: Resultat; journal: Journal }> {
  const journal: Journal = { seuil };
  let gardees: Repondue = { affirmations: [] };
  let sansPassage: string[] = [];
  const repondre = (reponse: Repondue, partielle = false) => {
    for (const a of reponse.affirmations) {
      const images = db
        .prepare(
          "SELECT id, legende, legende_statut FROM images WHERE source_id = ? ORDER BY position",
        )
        .all(a.source_id) as { id: string; legende: string | null; legende_statut: string }[];
      const image =
        images.find(
          (i) =>
            a.debut === undefined &&
            i.legende_statut === "certified" &&
            i.legende &&
            trouverFragments(i.legende, a.citation),
        ) ?? images[0];
      if (image) {
        a.image_id = image.id;
      }
    }
    return {
      resultat: actualiserResultat(
        db,
        {
          etat: "answered",
          ...reponse,
          ...(partielle && { partielle }),
          ...(sansPassage.length > 0 && { sans_passage: sansPassage }),
        },
        p,
      ),
      journal,
    };
  };
  try {
    let recherche = question;
    if (questionPrecedente) {
      etape("Mise en contexte de la question");
      try {
        const reformulee = await modeles.reformuler(questionPrecedente, question, signal);
        if (reformulee && reformulee.length <= 1000) recherche = reformulee;
      } catch {
        /* Une reformulation indisponible ne bloque pas la question. */
      }
      journal.question_recherche = recherche;
    }
    etape("Recherche dans les documents du cours");
    const r = await chercher(db, modeles, recherche, p, seuil, signal);
    journal.score = r.score;
    if (r.panneReclasseur) journal.reclasseur_indisponible = r.panneReclasseur;
    journal.candidats = r.candidats.map((c) => ({
      id: c.id,
      source_id: c.source_id,
      rang_fts: c.rang_fts,
      score: c.score,
      matieres: c.matieres,
    }));
    sansPassage = r.sansPassage ?? [];
    if (sansPassage.length) journal.sans_passage = sansPassage;
    if (r.horsCorpus) return { resultat: { etat: "out_of_corpus", raison: "seuil" }, journal };

    etape("Rédaction à partir des passages trouvés");
    const profil = profilSources(
      db,
      r.retenus.map((c) => c.source_id),
    );
    // `sansPassage` n'existe qu'en comparaison, même vide.
    const comparaison = r.sansPassage && profil === "general" ? `\n${COMPARAISON}` : "";
    const messages: Message[] = [
      { role: "system", content: SYSTEME[profil] + comparaison },
      {
        role: "user",
        content: `Extraits du corpus :\n\n${bloc(r.retenus)}\n\n${
          questionPrecedente ? `Question précédente : ${questionPrecedente}\n` : ""
        }Question de l'eleve : ${question}`,
      },
    ];
    const tentatives: unknown[] = [];
    journal.tentatives = tentatives;
    for (let essai = 0; essai < 2; essai++) {
      const { texte, modele } = await modeles.generer(messages, signal);
      journal.modele = modele;
      etape("Vérification des citations");
      const brute = lire(texte);
      const v = verifier(brute, r.retenus);
      if (v.refus) {
        tentatives.push({ sortie: texte, erreurs: v.erreurs });
        if (gardees.affirmations.length) return repondre(gardees, true);
        // Sans reclasseur, les extraits sont mal triés: leur refus ne prouve pas une limite du cours.
        if (r.panneReclasseur) {
          return {
            resultat: { etat: "failed", code: "MODEL_UNAVAILABLE", message: r.panneReclasseur },
            journal,
          };
        }
        return { resultat: { etat: "out_of_corpus", raison: "refus_modele" }, journal };
      }
      const j = await juger(modeles, v.affirmations, journal, profil, signal);
      const erreurs = [...v.erreurs, ...j.erreurs];
      tentatives.push({ sortie: texte, erreurs, soutien: j.probabilites });
      // Les réponses d'arts appliqués restent plates, comme l'évaluation les a mesurées.
      const rangee: Repondue = {
        ...ranger(
          profil === "general" ? brute?.blocs : undefined,
          v.parRang.map((a) => (a && j.soutenues.includes(a) ? a : undefined)),
        ),
        ...(j.probabilites.includes(null) && { juge_indisponible: true }),
      };
      if (rangee.affirmations.length > gardees.affirmations.length) gardees = rangee;
      if (!erreurs.length) return repondre(rangee);
      messages.push(
        { role: "assistant", content: texte },
        {
          role: "user",
          content:
            `Ta reponse ne passe pas la verification :\n- ${erreurs.join("\n- ")}\n` +
            `Rends le JSON complet corrige. Chaque citation doit etre recopiee mot pour mot de l'extrait indique.`,
        },
      );
    }
    if (gardees.affirmations.length) return repondre(gardees, true);
    return {
      resultat: {
        etat: "failed",
        code: "CITATION_UNVERIFIED",
        message:
          "La réponse proposée cite des passages introuvables dans le cours, ou qui ne prouvent pas ses phrases.",
      },
      journal,
    };
  } catch (e) {
    const code = e instanceof PanneModele ? e.code : "INTERNAL_ERROR";
    journal.erreur = (e as Error).message;
    if (gardees.affirmations.length) {
      try {
        return repondre(gardees, true);
      } catch {
        /* Une erreur de base reste une panne. */
      }
    }
    return { resultat: { etat: "failed", code, message: (e as Error).message }, journal };
  }
}
