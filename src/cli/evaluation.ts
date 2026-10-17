import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Modeles } from "../core/modeles.ts";
import type { Profil } from "../core/profils.ts";
import { candidatsFts, chercher, documentsProches } from "../core/recherche.ts";
import { demander, profilSources, SEUIL_SOUTIEN } from "../core/reponse.ts";
import { contexte } from "../core/texte.ts";
import { config, RACINE } from "../app/config.ts";
import type { Db } from "../app/db.ts";
import { nomSur } from "../app/depot.ts";
import { lireDocument } from "../app/ingestion.ts";
import { lireInstance } from "../app/instance.ts";
import { type Commande, lire, oui, texte } from "./commun.ts";

type Requete = { qid: string; type: string; q: string; gold: (number | string)[] };

/** Une phrase de réponse et la citation qui doit la prouver. `soutient` est l'annotation. */
type Paire = {
  id: string;
  famille: string;
  texte: string;
  titre?: string;
  /** le paragraphe que le panneau source montre autour de la citation, pour l'annotation */
  paragraphe?: string;
  citation: string;
  /** la consigne du juge. Absent: arts appliqués, le corpus des premières paires. */
  profil?: Profil;
  soutient: boolean | null;
};

const plier = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const taux = <T>(ls: T[], f: (l: T) => boolean) => +(ls.filter(f).length / ls.length).toFixed(2);
const mediane = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Suffixe des rapports d'un autre jeu (« -dev » pour evaluation/dev/…), vide pour le pilote. */
const suffixeJeu = (requetes?: string) =>
  requetes ? `-${basename(dirname(resolve(requetes)))}` : "";

const sourcesDuCorpus = (db: Db) =>
  db
    .prepare("SELECT id, fichier, json_extract(metadonnees, '$.sequence') AS sequence FROM sources")
    .all() as { id: string; fichier: string; sequence: string }[];

/** Écrit le rapport et ses lignes dans `evaluation/resultats/`, affiche le rapport seul. */
async function ecrireRapport(nom: string, rapport: object, lignes: unknown[]) {
  await mkdir(join(config.donnees, "evaluation/resultats"), { recursive: true });
  const sortie = join(config.donnees, `evaluation/resultats/${nom}.json`);
  await writeFile(sortie, JSON.stringify({ ...rapport, lignes }, null, 1));
  console.log(JSON.stringify(rapport, null, 1));
  console.log(`écrit dans ${relative(process.cwd(), sortie)}`);
}

type Cible = { source: string; rubrique?: string };

/**
 * Les sources qu'une cible annotée désigne. Une cible numérique est un rang de `img_order.json`.
 * Une cible de section (« Cubisme.pdf#02 ») désigne une rubrique d'une fiche PDF : le banc
 * numérotait ses sections, `docs.json` du dépôt de recherche donne leur rubrique. Un autre jeu
 * écrit « docker/index.md#Titre de section », le cours et le fichier, puis la section.
 */
function lecteurDeCibles(
  sources: ReturnType<typeof sourcesDuCorpus>,
  ordre: string[],
  docs: { id: string; titre: string }[],
  autreJeu: boolean,
) {
  return (g: number | string): Cible[] => {
    if (typeof g === "number") {
      const [seq, nom] = [dirname(ordre[g]), nomSur(basename(ordre[g]))];
      return sources
        .filter((s) => s.fichier === nom && s.sequence === seq)
        .map((s) => ({ source: s.id }));
    }
    if (g.includes("#") && !autreJeu) {
      return docs
        .filter((d) => d.id.toLowerCase().includes(g.toLowerCase()))
        .flatMap((d) => {
          const nom = nomSur(d.id.split("#")[0]);
          const rubrique = d.titre.split(" — ").at(-1);
          return sources.filter((s) => s.fichier === nom).map((s) => ({ source: s.id, rubrique }));
        });
    }
    const [nom, rubrique] = g.split("#");
    return sources
      .filter((s) => plier(`${s.sequence} ${s.fichier}`).includes(plier(nom)))
      .map((s) => ({ source: s.id, rubrique }));
  };
}

type Mesure = { rang: number; vues: number; n: number };

/** Pour chaque famille et chaque ratio, ce que la liste de /eleve/recherche aurait montré. */
function affichageParRatio(
  valides: Record<string, unknown>[],
  familles: string[],
  ratios: number[],
) {
  const moy = (x: number[]) => +(x.reduce((a, b) => a + b, 0) / x.length).toFixed(2);
  return Object.fromEntries(
    ["tous", ...familles].map((f) => {
      const lf = valides.filter((l) => f === "tous" || l.type === f);
      return [
        f,
        Object.fromEntries(
          ratios.map((ratio) => {
            const mesures = lf.map((l) => (l.affichage as Record<number, Mesure>)[ratio]);
            return [
              ratio,
              {
                succes: moy(mesures.map((m) => +(m.rang > 0))),
                mrr: moy(mesures.map((m) => (m.rang ? 1 / m.rang : 0))),
                rappel: +(
                  mesures.reduce((a, m) => a + m.vues, 0) /
                  lf.reduce((a, l) => a + (l.cibles as number), 0)
                ).toFixed(2),
                documents: moy(mesures.map((m) => m.n)),
              },
            ];
          }),
        ),
      ];
    }),
  );
}

async function evalRecherche(db: Db, modeles: Modeles, argv: string[]) {
  const { values: args } = lire(argv, {
    "img-order": texte,
    requetes: texte,
    docs: texte,
    "sans-reclasseur": oui,
    ratios: texte,
  });
  if (!args["img-order"] && !args.requetes) {
    throw new Error("--img-order=<chemin vers img_order.json> ou --requetes=<jeu> est requis.");
  }
  const ordre = args["img-order"]
    ? (JSON.parse(await readFile(args["img-order"], "utf8")) as string[])
    : [];
  const requetes = JSON.parse(
    await readFile(args.requetes ?? join(RACINE, "evaluation/queries_real.json"), "utf8"),
  ) as Requete[];
  const docs = args.docs
    ? (JSON.parse(await readFile(args.docs, "utf8")) as { id: string; titre: string }[])
    : [];
  const cibles = lecteurDeCibles(sourcesDuCorpus(db), ordre, docs, !!args.requetes);
  const touche = (c: { source_id: string; titre: string }, attendus: Cible[]) =>
    attendus.some(
      (a) => a.source === c.source_id && (!a.rubrique || c.titre.endsWith(`: ${a.rubrique}`)),
    );
  const p = { lecteur: null, schoolId: lireInstance(db).school_id };
  const lignes: Record<string, unknown>[] = [];
  const ratios = args["sans-reclasseur"] ? [] : (args.ratios?.split(",") ?? []).map(Number);
  for (const r of requetes) {
    const attendus = r.gold.flatMap(cibles);
    let trouves;
    let affichage;
    if (args["sans-reclasseur"]) {
      // Sans reclasseur, mais avec la traduction quand le périmètre contient une source anglaise.
      trouves = (await candidatsFts(db, modeles, r.q, p)).candidats.slice(0, 5);
    } else {
      const recherche = await chercher(db, modeles, r.q, p, config.seuil);
      // Un repli FTS5 mesuré sous l'étiquette du reclasseur fausserait le rapport.
      if (recherche.panneReclasseur) throw new Error(recherche.panneReclasseur);
      // Sous le seuil, l'élève reçoit un refus : aucun passage n'est montré.
      trouves = recherche.horsCorpus ? [] : recherche.retenus;
      // Dans la liste de /eleve/recherche: rang de l'œuvre attendue, cibles montrées, documents.
      affichage = Object.fromEntries(
        ratios.map((ratio) => {
          const docs = documentsProches(recherche, config.seuil, ratio);
          return [
            ratio,
            {
              rang: docs.findIndex((c) => touche(c, attendus)) + 1,
              vues: docs.filter((c) => touche(c, attendus)).length,
              n: docs.length,
            },
          ];
        }),
      );
    }
    lignes.push({
      qid: r.qid,
      type: r.type,
      rang: trouves.findIndex((c) => touche(c, attendus)) + 1,
      cibles: attendus.length,
      trouves: trouves.map((c) => c.titre),
      ...(ratios.length ? { affichage } : {}),
    });
  }
  // Un piège (cible vide) n'a pas de rang: il sort des taux et se compte à part.
  const pieges = new Set(requetes.filter((r) => !r.gold.length).map((r) => r.qid));
  const valides = lignes.filter((l) => !pieges.has(l.qid as string));
  const familles = [...new Set(valides.map((l) => l.type as string))].sort();
  const resume = (ls: typeof lignes) => ({
    n: ls.length,
    succes_5: taux(ls, (l) => (l.rang as number) > 0),
    mrr: +(
      ls.reduce((s, l) => s + ((l.rang as number) ? 1 / (l.rang as number) : 0), 0) / ls.length
    ).toFixed(2),
  });
  const rapport = {
    date: new Date().toISOString(),
    moteur: args["sans-reclasseur"] ? "fts5" : `fts5 + ${config.modeles.reclasseur}`,
    tous: resume(valides),
    familles: Object.fromEntries(
      familles.map((f) => [f, resume(valides.filter((l) => l.type === f))]),
    ),
    sans_cible: valides.filter((l) => !l.cibles).map((l) => l.qid),
    echecs: valides.filter((l) => !l.rang).map((l) => l.qid),
    ...(ratios.length ? { affichage: affichageParRatio(valides, familles, ratios) } : {}),
    ...(pieges.size
      ? {
          hors_corpus: {
            n: pieges.size,
            avec_resultat: lignes.filter(
              (l) => pieges.has(l.qid as string) && (l.trouves as string[]).length,
            ).length,
          },
        }
      : {}),
  };
  const moteur = args["sans-reclasseur"] ? "fts5" : "reclasseur";
  await ecrireRapport(`recherche-${moteur}${suffixeJeu(args.requetes)}`, rapport, lignes);
}

function paragraphe(a: {
  source_id: string;
  citation: string;
  debut?: number;
  fin?: number;
  revision?: number;
}) {
  if (a.debut === undefined || a.fin === undefined) return a.citation;
  const x = contexte(lireDocument(a.source_id, a.revision ?? 1).texte, a.debut, a.fin);
  return x.avant + x.milieu + x.apres;
}

async function evalGeneration(db: Db, modeles: Modeles, argv: string[]) {
  const { values: args } = lire(argv, { requetes: texte, paires: texte });
  const jeu = JSON.parse(
    await readFile(args.requetes ?? join(RACINE, "evaluation/queries_generation.json"), "utf8"),
  ) as {
    questions: { qid: string; q: string; gold: string[] }[];
    sans_reponse: { qid: string; q: string; registre: string }[];
  };
  const sources = new Map(
    sourcesDuCorpus(db).map((s) => [s.id, plier(`${s.sequence} ${s.fichier}`)]),
  );
  const p = { lecteur: null, schoolId: lireInstance(db).school_id };
  const paires: Paire[] = [];
  const lignes: {
    qid: string;
    registre: string;
    question: string;
    etat: string;
    detail?: string;
    bonne_source?: boolean;
    score: unknown;
    ms: number;
    /** 2 quand la première sortie a échoué à `verifier()` ou au juge */
    essais: number;
    partielle: boolean;
    /** types des blocs, absent pour une réponse en un paragraphe */
    blocs?: string[];
    reponse?: string[];
  }[] = [];
  for (const q of [
    ...jeu.questions.map((x) => ({ ...x, registre: "dans le corpus" })),
    ...jeu.sans_reponse.map((x) => ({ ...x, gold: [] as string[] })),
  ]) {
    const t = Date.now();
    const { resultat, journal } = await demander(db, modeles, q.q, p, config.seuil);
    if (journal.reclasseur_indisponible) throw new Error(String(journal.reclasseur_indisponible));
    const repondue = resultat.etat === "answered" ? resultat : undefined;
    const citees = repondue?.affirmations.map((a) => sources.get(a.source_id) ?? "") ?? [];
    repondue?.affirmations.forEach((a, i) =>
      paires.push({
        id: `${q.qid}-${i + 1}`,
        famille: "sortie",
        texte: a.texte,
        titre: a.titre,
        paragraphe: paragraphe(a),
        citation: a.citation,
        profil: profilSources(db, [a.source_id]),
        soutient: null,
      }),
    );
    lignes.push({
      qid: q.qid,
      registre: q.registre,
      question: q.q,
      etat: resultat.etat,
      detail:
        "raison" in resultat ? resultat.raison : "code" in resultat ? resultat.code : undefined,
      bonne_source: q.gold.length
        ? citees.some((c) => q.gold.some((g) => c.includes(plier(g))))
        : undefined,
      score: journal.score,
      ms: Date.now() - t,
      essais: (journal.tentatives as unknown[] | undefined)?.length ?? 0,
      partielle: !!repondue?.partielle,
      blocs: repondue?.blocs?.map((b) => b.type),
      reponse: repondue?.affirmations.map((a) => `${a.texte} [${a.titre}]`),
    });
    console.log(`${q.qid} ${resultat.etat.padEnd(13)} ${q.q}`);
  }
  const par = (r: string) => lignes.filter((l) => l.registre === r);
  const dedans = par("dans le corpus");
  const rapport = {
    date: new Date().toISOString(),
    modele: config.modeles.generation,
    seuil: config.seuil,
    dans_le_corpus: {
      n: dedans.length,
      repond: taux(dedans, (l) => l.etat === "answered"),
      bonne_source: taux(dedans, (l) => !!l.bonne_source),
      faux_refus: taux(dedans, (l) => l.etat === "out_of_corpus"),
      panne: taux(dedans, (l) => l.etat === "failed"),
      reparee: taux(dedans, (l) => l.essais > 1),
      partielle: taux(dedans, (l) => l.partielle),
      avec_blocs: taux(dedans, (l) => !!l.blocs),
    },
    hors_corpus: Object.fromEntries(
      [...new Set(jeu.sans_reponse.map((x) => x.registre))].map((r) => [
        r,
        {
          n: par(r).length,
          refuse: taux(par(r), (l) => l.etat === "out_of_corpus"),
          repond: taux(par(r), (l) => l.etat === "answered"),
          panne: taux(par(r), (l) => l.etat === "failed"),
        },
      ]),
    ),
    latence_mediane_ms: mediane(lignes.map((l) => l.ms)),
  };
  await ecrireRapport(`generation${suffixeJeu(args.requetes)}`, rapport, lignes);
  if (args.paires) {
    // Une ligne par paire pour annoter à la main. `wx` protège un fichier déjà annoté.
    await writeFile(args.paires, `[\n${paires.map((x) => JSON.stringify(x)).join(",\n")}\n]\n`, {
      flag: "wx",
    });
    console.log(`${paires.length} paires à annoter dans ${args.paires}`);
  }
}

async function evalSoutien(_db: Db, modeles: Modeles, argv: string[]) {
  const { values: args } = lire(argv, { paires: texte });
  if (!args.paires) throw new Error("--paires=<chemin vers paires.json> est requis.");
  const toutes = JSON.parse(await readFile(args.paires, "utf8")) as Paire[];
  const annotees = toutes.filter((x) => typeof x.soutient === "boolean");
  if (!annotees.some((x) => x.soutient) || !annotees.some((x) => !x.soutient)) {
    throw new Error("Il faut des paires annotées `soutient: true` et `soutient: false`.");
  }
  const lignes: {
    id: string;
    famille: string;
    soutient: boolean;
    p: number;
    ms: number;
    modele: string;
  }[] = [];
  for (const x of annotees) {
    const t = Date.now();
    const { probabilite, modele } = await modeles.soutenir(
      x.texte,
      x.citation,
      x.titre ?? "",
      undefined,
      x.profil ?? "arts-appliques",
    );
    lignes.push({
      id: x.id,
      famille: x.famille,
      soutient: !!x.soutient,
      p: probabilite,
      ms: Date.now() - t,
      modele,
    });
    console.log(`${x.id.padEnd(10)} ${String(x.soutient).padEnd(5)} ${probabilite.toFixed(3)}`);
  }
  const vrais = lignes.filter((l) => l.soutient);
  const faux = lignes.filter((l) => !l.soutient);
  // AUC de Mann-Whitney: probabilité qu'une paire soutenue passe devant une paire qui ne l'est pas.
  let gagnees = 0;
  for (const v of vrais) for (const f of faux) gagnees += v.p > f.p ? 1 : v.p === f.p ? 0.5 : 0;
  const rapport = {
    date: new Date().toISOString(),
    modele: config.modeles.soutien,
    n: lignes.length,
    non_annotees: toutes.length - annotees.length,
    auc: +(gagnees / (vrais.length * faux.length)).toFixed(3),
    seuil: SEUIL_SOUTIEN,
    // Au seuil: part des bonnes affirmations rejetées, part des mauvaises qui passent.
    faux_rejets: taux(vrais, (l) => l.p < SEUIL_SOUTIEN),
    faux_passages: taux(faux, (l) => l.p >= SEUIL_SOUTIEN),
    par_famille: Object.fromEntries(
      [...new Set(lignes.map((l) => l.famille))].map((f) => {
        const ls = lignes.filter((l) => l.famille === f);
        return [f, { n: ls.length, erreurs: taux(ls, (l) => l.p >= SEUIL_SOUTIEN !== l.soutient) }];
      }),
    ),
    // Pour choisir le seuil: ce que chaque valeur rejette de bon et attrape de faux.
    seuils: [0.001, 0.01, 0.05, 0.1, 0.3, 0.5, 0.7, 0.9].map((s) => ({
      seuil: s,
      bonnes_rejetees: `${vrais.filter((l) => l.p < s).length}/${vrais.length}`,
      erreurs_attrapees: `${faux.filter((l) => l.p < s).length}/${faux.length}`,
    })),
    latence_mediane_ms: mediane(lignes.map((l) => l.ms)),
  };
  // Les citations restent hors du dépôt: le rapport ne garde que les identifiants.
  await ecrireRapport("soutien", rapport, lignes);
}

const BANCS: Record<string, (db: Db, modeles: Modeles, argv: string[]) => Promise<void>> = {
  recherche: evalRecherche,
  generation: evalGeneration,
  soutien: evalSoutien,
};

export const evaluation: Record<string, Commande> = {
  ask: {
    aide: `  ask "<question>" [--json]                 pose une question sur le corpus certifié`,
    async lancer(db, modeles, argv) {
      const { values: args, positionals } = lire(argv, {
        json: oui,
        "matiere-id": texte,
        "cours-id": texte,
        "theme-id": texte,
      });
      const p = {
        lecteur: null,
        schoolId: lireInstance(db).school_id,
        matiereId: args["matiere-id"],
        coursId: args["cours-id"],
        themeId: args["theme-id"],
      };
      const { resultat, journal } = await demander(
        db,
        modeles,
        positionals.join(" "),
        p,
        config.seuil,
      );
      if (args.json) console.log(JSON.stringify({ resultat, journal }, null, 1));
      else if (resultat.etat === "answered") {
        resultat.affirmations.forEach((a, i) => console.log(`${a.texte} [${i + 1}]`));
        resultat.affirmations.forEach((a, i) =>
          console.log(`  [${i + 1}] ${a.titre}: « ${a.citation} »`),
        );
      } else console.log(resultat.etat, "message" in resultat ? resultat.message : resultat.raison);
    },
  },
  eval: {
    aide: `  eval recherche --img-order=<img_order.json> [--docs=<docs.json>] [--sans-reclasseur]
                                            [--ratios=0.1,0.25,0.5]
                                            rejoue les 59 requêtes annotées, --ratios mesure
                                            la liste de /eleve/recherche à chaque ratio
  eval recherche --requetes=<requetes.json> [--sans-reclasseur]
                                            rejoue un autre jeu, cibles en nom de fichier
                                            (« cours/fichier.md#section »)
  eval generation [--requetes=<questions.json>] [--paires=<paires.json>]
                                            rejoue les 20 questions d'élève et les 15 pièges
                                            (ou un autre jeu), écrit les paires
                                            affirmation-citation à annoter
  eval soutien --paires=<paires.json>       juge chaque paire annotée, mesure l'accord`,
    lancer(db, modeles, [banc, ...argv]) {
      if (!banc || !Object.hasOwn(BANCS, banc)) {
        throw new Error("usage: thot eval recherche|generation|soutien");
      }
      return BANCS[banc](db, modeles, argv);
    },
  },
};
