import { readFileSync } from "node:fs";
import { mkdir, opendir, readFile, stat, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { decoder, pageVide, rubriquesSommaire } from "./core/html.ts";
import { lireFrontMatter } from "./core/markdown.ts";
import { openrouter } from "./core/modeles.ts";
import { demander, profilSources, SEUIL_SOUTIEN } from "./core/reponse.ts";
import type { Profil } from "./core/profils.ts";
import { chercher, chercherFts, documentsProches, transaction } from "./core/recherche.ts";
import {
  creerAdministrateur,
  creerCompte,
  reinitialiserMotDePasse,
  type Role,
} from "./app/comptes.ts";
import { configurerInstance, lireInstance, traitements } from "./app/instance.ts";
import { config, contenu, preparerDonnees, RACINE } from "./app/config.ts";
import { cacheModeles, connexion, migrer } from "./app/db.ts";
import { controlerFichier, deposer, nomSur, sha256 } from "./app/depot.ts";
import {
  indexer,
  lireDocument,
  reextraire,
  revendiquer,
  statuer,
  supprimerSource,
  traiter,
} from "./app/ingestion.ts";
import { contexte } from "./core/texte.ts";
import { sauvegarder } from "./app/sauvegarde.ts";
import { genererSuggestions } from "./app/suggestions.ts";
import * as Domaines from "./app/domaines.ts";
import { valider } from "./app/depot.ts";

const AIDE = `thot <commande>

  migrer                                    applique les migrations
  instance [--nom="Nom affiché"] [--mode=shared|personal]
                                            configure l'instance et affiche les services autorisés
  administrateur <identifiant> <nom>        provisionne l'administrateur, code à usage unique
  compte <identifiant> <nom> <enseignant|eleve> [--cours=<id>]...
                                            crée un compte, l'inscrit aux cours, affiche son
                                            mot de passe
  reinitialiser <identifiant>               renouvelle le mot de passe enseignant
  domaines                                 affiche le catalogue et le nombre de membres par cours
  matiere <nom> [--profil=general|arts-appliques]
  profil <general|arts-appliques>           change le profil de toutes les matières,
                                            refusé si une ressource a un autre profil
  cours <matiere_id> <nom> [--niveau=...] [--objectif=...]
  theme <cours_id> <nom>                    crée un thème dans un cours
  renommer <matiere|cours|theme> <id> <nom>
                                            garde l'identifiant et les rattachements
  supprimer <matiere|cours|theme> <id>      refusé si une ressource ou une question l'utilise,
                                            emporte les cours et thèmes d'une matière
  supprimer source <source_id>              efface la source, ses fichiers et ses citations
                                            dans les réponses, sans retour possible
  rattacher <source_id> <cours_id> [--theme-id=...]
                                            ajoute un rattachement : les membres du cours la lisent
  membre <cours_id> <identifiant>           inscrit un compte à un cours
  retirer-membre <cours_id> <identifiant>   retire un compte d'un cours
  ingest <dossier|fichier> [--matiere-id=...] [--cours-id=...] [--theme-id=...]
         [--matiere=arts-appliques] [--classe=...] [--type=cours] [--langue=fr]
         [--auteur=...] [--version=...] [--juridiction=...]
         [--date-publication=...] [--date-evenement=...] [--valide-du=...] [--valide-au=...]
         [--enseignant="M. Detienne"]
                                            dépose chaque fichier, chapitre tiré du dossier
  traiter                                   vide la file de travaux sans lancer le worker
  legendes-importer <legendes.json>         reprend des légendes déjà générées (banc d'essai)
  certifier <source_id...> | --tout [--par=nom]
                                            certifie des sources, trace le nom donné
  suggestions <source_id...> | --tout       questions vérifiées proposées aux élèves
  nettoyer                                  retire les pages Pearltrees réduites à leur titre
  rebuild                                   reconstruit l'index des sources certifiées
  reextraire                                rejoue l'extraction des sources, un texte changé
                                            devient une révision à certifier
  backup <destination>                      copie base, contenu et secret dans un répertoire vide,
                                            serveur et worker peuvent tourner
  ask "<question>" [--json]                 pose une question sur le corpus certifié
  eval recherche --img-order=<img_order.json> [--docs=<docs.json>] [--sans-reclasseur]
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
  eval soutien --paires=<paires.json>       juge chaque paire annotée, mesure l'accord`;

const oui = { type: "boolean" } as const;
const texte = { type: "string" } as const;
const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: oui,
    tout: oui,
    "sans-reclasseur": oui,
    help: oui,
    matiere: texte,
    classe: texte,
    type: texte,
    "img-order": texte,
    docs: texte,
    ratios: texte,
    requetes: texte,
    enseignant: texte,
    par: texte,
    paires: texte,
    nom: texte,
    mode: texte,
    profil: texte,
    "matiere-id": texte,
    "cours-id": texte,
    cours: { type: "string", multiple: true },
    "theme-id": texte,
    langue: texte,
    auteur: texte,
    version: texte,
    juridiction: texte,
    "date-publication": texte,
    "date-evenement": texte,
    "valide-du": texte,
    "valide-au": texte,
    niveau: texte,
    objectif: texte,
  },
});
const [commande, ...reste] = positionals;
preparerDonnees();
const db = connexion();
migrer(db);
const modeles = openrouter(config.modeles, cacheModeles(db));

const FORMATS_ACCEPTES = new Set([
  ".pdf",
  ".html",
  ".htm",
  ".md",
  ".markdown",
  ".png",
  ".jpg",
  ".jpeg",
]);

async function* fichiers(chemin: string): AsyncGenerator<string> {
  const info = await stat(chemin);
  if (info.isFile()) return yield chemin;
  const entrees = [];
  for await (const e of await opendir(chemin)) entrees.push(e);
  entrees.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entrees) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) yield* fichiers(join(chemin, e.name));
    else yield join(chemin, e.name);
  }
}

async function ingest(chemin: string) {
  const racine = (await stat(chemin)).isFile() ? dirname(chemin) : chemin;
  const sommaires = new Map<string, Map<string, string>>();
  let deposes = 0;
  const refus: string[] = [];
  for await (const f of fichiers(chemin)) {
    const nom = basename(f);
    if (nom === "Sommaire.html") continue;
    if (!FORMATS_ACCEPTES.has(extname(nom).toLowerCase())) {
      refus.push(`${relative(racine, f)}: extension non acceptée`);
      continue;
    }
    const octets = await readFile(f);
    const controle = controlerFichier(octets, nom);
    if ("erreur" in controle) {
      refus.push(`${relative(racine, f)}: ${controle.erreur}`);
      continue;
    }
    const vide = controle.format === "html" && pageVide(new TextDecoder().decode(octets));
    if (vide) {
      refus.push(
        `${relative(racine, f)}: titre seul${vide.fichier ? `, voir ${vide.fichier}` : ""}`,
      );
      continue;
    }
    if (
      db
        .prepare("SELECT 1 FROM sources WHERE checksum = ? AND school_id = ?")
        .get(await sha256(octets), lireInstance(db).school_id)
    ) {
      refus.push(`${relative(racine, f)}: déjà déposé`);
      continue;
    }
    const dossier = dirname(f);
    if (!sommaires.has(dossier)) {
      const s = await readFile(join(dossier, "Sommaire.html"), "utf8").catch(() => "");
      const rubriques = rubriquesSommaire(s);
      // Le sommaire range la page qui présente une fiche PDF, pas la fiche: elle hérite de sa
      // rubrique.
      // oxlint-disable-next-line unicorn/no-useless-spread -- la boucle ajoute des entrées.
      for (const [href, rubrique] of [...rubriques]) {
        const page = await readFile(join(dossier, href), "utf8").catch(() => "");
        const lie = page && pageVide(page)?.fichier;
        if (lie) rubriques.set(lie, rubrique);
      }
      sommaires.set(dossier, rubriques);
    }
    const sequence = basename(dossier);
    const nomSansExtension = nom.replace(/\.[^.]+$/, "");
    const titre =
      controle.format === "html"
        ? decoder(
            new TextDecoder()
              .decode(octets)
              .match(/<title>([\s\S]*?)<\/title>/i)?.[1]
              ?.trim() ?? nom,
          )
        : controle.format === "md"
          ? (lireFrontMatter(new TextDecoder().decode(octets)).titre ?? nomSansExtension)
          : nomSansExtension;
    const champs = {
      titre: titre.replace(/\s+/g, " ").slice(0, 200),
      type_document: args.type ?? "cours",
      matiere: args.matiere ?? "",
      matiere_id: args["matiere-id"] ?? "",
      langue: args.langue ?? "fr",
      auteur: args.auteur ?? "",
      version: args.version ?? "",
      juridiction: args.juridiction ?? "",
      date_publication: args["date-publication"] ?? "",
      date_evenement: args["date-evenement"] ?? "",
      valide_du: args["valide-du"] ?? "",
      valide_au: args["valide-au"] ?? "",
      classe: args.classe ?? "",
      sous_matiere: "",
      sequence,
      seance: sommaires.get(dossier)!.get(nom) ?? "",
      resume: "",
      objectifs: "",
      evaluation: "",
    };
    const validation = valider(champs);
    if ("erreurs" in validation) throw new Error(JSON.stringify(validation.erreurs));
    await deposer(db, {
      meta: validation.meta,
      nomFichier: nom,
      octets,
      format: controle.format,
      schoolId: lireInstance(db).school_id,
      enseignant: args.enseignant ?? "import en ligne de commande",
      audience: lireInstance(db).lecteurs,
      reponses: true,
      liens: args["cours-id"]
        ? [{ cours_id: args["cours-id"], theme_id: args["theme-id"] ?? null }]
        : undefined,
    });
    deposes++;
  }
  console.log(`${deposes} fichier(s) déposé(s).`);
  if (refus.length) console.log(`${refus.length} refusé(s):\n  ${refus.join("\n  ")}`);
}

/**
 * Pages vides déjà importées, avant que `ingest` les écarte. La fiche PDF qu'une page présente
 * reprend sa rubrique, puis la page sort de la base et du disque.
 */
async function nettoyer() {
  const pages = db
    .prepare("SELECT id, fichier, metadonnees FROM sources WHERE format = 'html' AND school_id = ?")
    .all(lireInstance(db).school_id) as { id: string; fichier: string; metadonnees: string }[];
  let n = 0;
  for (const p of pages) {
    const vide = pageVide(await readFile(contenu(p.id, "original", p.fichier), "utf8"));
    if (!vide) continue;
    const { sequence, seance } = JSON.parse(p.metadonnees);
    const fiche =
      vide.fichier &&
      (db
        .prepare(
          `SELECT id FROM sources WHERE fichier = ? AND json_extract(metadonnees, '$.sequence') = ?
         AND school_id = ?`,
        )
        .get(nomSur(vide.fichier), sequence, lireInstance(db).school_id)?.id as string | undefined);
    if (fiche && seance) {
      db.prepare(
        `UPDATE sources SET metadonnees = json_set(metadonnees, '$.seance', ?)
         WHERE id = ? AND json_extract(metadonnees, '$.seance') = ''`,
      ).run(seance, fiche);
    }
    await supprimerSource(db, p.id);
    if (fiche) indexer(db, fiche);
    console.log(`  ${p.fichier}${fiche ? ` → ${vide.fichier}` : ""}`);
    n++;
  }
  console.log(`${n} page(s) vide(s) retirée(s).`);
}

async function traiterFile() {
  let n = 0;
  for (let job = revendiquer(db); job; job = revendiquer(db)) {
    await traiter(db, job, modeles);
    if (++n % 20 === 0) console.log(`${n} travaux traités`);
  }
  console.log(`${n} travail(aux) traité(s).`);
}

/** Légendes produites par le banc d'essai avec le même modèle et la même consigne. */
function importerLegendes(chemin: string) {
  const json = JSON.parse(readFileSync(chemin, "utf8"));
  const modele = json._meta?.modele ?? "inconnu";
  let n = 0;
  for (const [rel, legende] of Object.entries(json.legendes as Record<string, string>)) {
    const sequence = rel.split("/").at(-2) ?? "";
    const r = db
      .prepare(
        `UPDATE images SET legende = ?, legende_origine = 'generated', modele = ?
       WHERE position = 0 AND legende IS NULL AND legende_statut = 'unreviewed' AND source_id IN (
         SELECT id FROM sources WHERE fichier = ? AND json_extract(metadonnees, '$.sequence') = ?)`,
      )
      .run(legende, modele, nomSur(basename(rel)), sequence);
    n += Number(r.changes);
  }
  for (const { id } of db.prepare("SELECT id FROM sources WHERE statut = 'certifiee'").all()) {
    indexer(db, id as string);
  }
  console.log(`${n} légende(s) importée(s) sur ${Object.keys(json.legendes).length}.`);
}

type Requete = { qid: string; type: string; q: string; gold: (number | string)[] };

const plier = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Suffixe des rapports d'un autre jeu (« -dev » pour evaluation/dev/…), vide pour le pilote. */
const suffixeJeu = args.requetes ? `-${basename(dirname(resolve(args.requetes)))}` : "";

async function evalRecherche() {
  if (!args["img-order"] && !args.requetes) {
    throw new Error("--img-order=<chemin vers img_order.json> ou --requetes=<jeu> est requis.");
  }
  const ordre = args["img-order"]
    ? (JSON.parse(await readFile(args["img-order"], "utf8")) as string[])
    : [];
  const requetes = JSON.parse(
    await readFile(args.requetes ?? join(RACINE, "evaluation/queries_real.json"), "utf8"),
  ) as Requete[];
  const sources = db
    .prepare("SELECT id, fichier, json_extract(metadonnees, '$.sequence') AS sequence FROM sources")
    .all() as { id: string; fichier: string; sequence: string }[];
  // Une cible de section (« Cubisme.pdf#02 ») désigne une rubrique d'une fiche PDF. Le banc
  // numérotait ses sections, `docs.json` du dépôt de recherche donne leur rubrique.
  const docs = args.docs
    ? (JSON.parse(await readFile(args.docs, "utf8")) as { id: string; titre: string }[])
    : [];
  type Cible = { source: string; rubrique?: string };
  const cibles = (g: number | string): Cible[] => {
    if (typeof g === "number") {
      const [seq, nom] = [dirname(ordre[g]), nomSur(basename(ordre[g]))];
      return sources
        .filter((s) => s.fichier === nom && s.sequence === seq)
        .map((s) => ({
          source: s.id,
        }));
    }
    if (g.includes("#") && !args.requetes) {
      return docs
        .filter((d) => d.id.toLowerCase().includes(g.toLowerCase()))
        .flatMap((d) => {
          const nom = nomSur(d.id.split("#")[0]);
          const rubrique = d.titre.split(" — ").at(-1);
          return sources.filter((s) => s.fichier === nom).map((s) => ({ source: s.id, rubrique }));
        });
    }
    // Autre jeu: « docker/index.md#Titre de section », le cours et le fichier, puis la section.
    const [nom, rubrique] = g.split("#");
    return sources
      .filter((s) => plier(`${s.sequence} ${s.fichier}`).includes(plier(nom)))
      .map((s) => ({ source: s.id, rubrique }));
  };
  const touche = (c: { source_id: string; titre: string }, attendus: Cible[]) =>
    attendus.some(
      (a) => a.source === c.source_id && (!a.rubrique || c.titre.endsWith(`: ${a.rubrique}`)),
    );
  const lignes: Record<string, unknown>[] = [];
  const ratios = args["sans-reclasseur"] ? [] : (args.ratios?.split(",") ?? []).map(Number);
  for (const r of requetes) {
    const attendus = r.gold.flatMap(cibles);
    let trouves;
    let affichage;
    if (args["sans-reclasseur"]) {
      trouves = chercherFts(db, r.q, { lecteur: null, schoolId: lireInstance(db).school_id }).slice(
        0,
        5,
      );
    } else {
      const recherche = await chercher(
        db,
        modeles,
        r.q,
        { lecteur: null, schoolId: lireInstance(db).school_id },
        config.seuil,
      );
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
    const rang = trouves.findIndex((c) => touche(c, attendus)) + 1;
    lignes.push({
      qid: r.qid,
      type: r.type,
      rang,
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
    succes_5: +(ls.filter((l) => (l.rang as number) > 0).length / ls.length).toFixed(2),
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
    ...(ratios.length
      ? {
          affichage: Object.fromEntries(
            ["tous", ...familles].map((f) => [
              f,
              Object.fromEntries(
                ratios.map((ratio) => {
                  const lf = valides.filter((l) => f === "tous" || l.type === f);
                  const mesures = lf.map(
                    (l) =>
                      (l.affichage as Record<number, { rang: number; vues: number; n: number }>)[
                        ratio
                      ],
                  );
                  const moy = (x: number[]) =>
                    +(x.reduce((a, b) => a + b, 0) / x.length).toFixed(2);
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
            ]),
          ),
        }
      : {}),
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
  await mkdir(join(config.donnees, "evaluation/resultats"), { recursive: true });
  const sortie = join(
    config.donnees,
    `evaluation/resultats/recherche-${args["sans-reclasseur"] ? "fts5" : "reclasseur"}${suffixeJeu}.json`,
  );
  await writeFile(sortie, JSON.stringify({ ...rapport, lignes }, null, 1));
  console.log(JSON.stringify(rapport, null, 1));
  console.log(`écrit dans ${relative(process.cwd(), sortie)}`);
}

async function evalGeneration() {
  const jeu = JSON.parse(
    await readFile(args.requetes ?? join(RACINE, "evaluation/queries_generation.json"), "utf8"),
  ) as {
    questions: { qid: string; q: string; gold: string[] }[];
    sans_reponse: { qid: string; q: string; registre: string }[];
  };
  const sources = new Map(
    (
      db
        .prepare(
          "SELECT id, fichier, json_extract(metadonnees, '$.sequence') AS sequence FROM sources",
        )
        .all() as { id: string; fichier: string; sequence: string }[]
    ).map((s) => [s.id, plier(`${s.sequence} ${s.fichier}`)]),
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
    const citees =
      resultat.etat === "answered"
        ? resultat.affirmations.map((a) => sources.get(a.source_id) ?? "")
        : [];
    if (resultat.etat === "answered") {
      resultat.affirmations.forEach((a, i) =>
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
    }
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
      partielle: resultat.etat === "answered" && !!resultat.partielle,
      blocs: resultat.etat === "answered" ? resultat.blocs?.map((b) => b.type) : undefined,
      reponse:
        resultat.etat === "answered"
          ? resultat.affirmations.map((a) => `${a.texte} [${a.titre}]`)
          : undefined,
    });
    console.log(`${q.qid} ${resultat.etat.padEnd(13)} ${q.q}`);
  }
  const par = (r: string) => lignes.filter((l) => l.registre === r);
  const taux = (ls: typeof lignes, f: (l: (typeof lignes)[0]) => boolean) =>
    +(ls.filter(f).length / ls.length).toFixed(2);
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
    latence_mediane_ms: lignes.map((l) => l.ms).sort((a, b) => a - b)[
      Math.floor(lignes.length / 2)
    ],
  };
  await mkdir(join(config.donnees, "evaluation/resultats"), { recursive: true });
  const sortie = join(config.donnees, `evaluation/resultats/generation${suffixeJeu}.json`);
  await writeFile(sortie, JSON.stringify({ ...rapport, lignes }, null, 1));
  console.log(JSON.stringify(rapport, null, 1));
  console.log(`écrit dans ${relative(process.cwd(), sortie)}`);
  if (args.paires) {
    // Une ligne par paire pour annoter à la main. `createNew` protège un fichier déjà annoté.
    await writeFile(args.paires, `[\n${paires.map((x) => JSON.stringify(x)).join(",\n")}\n]\n`, {
      flag: "wx",
    });
    console.log(`${paires.length} paires à annoter dans ${args.paires}`);
  }
}

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

async function evalSoutien() {
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
  const taux = (ls: typeof lignes, f: (l: (typeof lignes)[0]) => boolean) =>
    +(ls.filter(f).length / ls.length).toFixed(2);
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
    latence_mediane_ms: lignes.map((l) => l.ms).sort((a, b) => a - b)[
      Math.floor(lignes.length / 2)
    ],
  };
  // Les citations restent hors du dépôt: le rapport ne garde que les identifiants.
  await mkdir(join(config.donnees, "evaluation/resultats"), { recursive: true });
  const sortie = join(config.donnees, "evaluation/resultats/soutien.json");
  await writeFile(sortie, JSON.stringify({ ...rapport, lignes }, null, 1));
  console.log(JSON.stringify(rapport, null, 1));
  console.log(`écrit dans ${relative(process.cwd(), sortie)}`);
}

switch (commande) {
  case "domaines": {
    const cat = Domaines.catalogue(db);
    console.log(
      JSON.stringify(
        {
          ...cat,
          cours: cat.cours.map((c) => ({ ...c, membres: Domaines.membres(db, c.id).length })),
        },
        null,
        2,
      ),
    );
    break;
  }
  case "matiere":
    console.log(Domaines.matiere(db, reste.join(" "), args.profil));
    break;
  case "cours":
    console.log(Domaines.cours(db, reste[0], reste.slice(1).join(" "), args.niveau, args.objectif));
    break;
  case "theme":
    console.log(Domaines.theme(db, reste[0], reste.slice(1).join(" ")));
    break;
  case "profil":
    Domaines.changerProfil(db, reste[0]);
    console.log(`Profil de l'instance : ${reste[0]}.`);
    break;
  case "renommer":
    Domaines.renommer(db, reste[0], reste[1], reste.slice(2).join(" "));
    break;
  case "supprimer":
    if (reste[0] === "source") {
      await supprimerSource(db, reste[1]);
      console.log(`Source ${reste[1]} supprimée.`);
    } else Domaines.supprimer(db, reste[0], reste[1]);
    break;
  case "rattacher": {
    const [sourceId, coursId] = reste;
    transaction(db, () => {
      const liens = db
        .prepare(
          "SELECT cours_id, theme_id FROM source_cours WHERE source_id = ? AND cours_id != ?",
        )
        .all(sourceId, coursId) as Domaines.Affiliation[];
      Domaines.affiliations(db, sourceId, [
        ...liens,
        {
          cours_id: coursId,
          theme_id: args["theme-id"] ?? null,
        },
      ]);
    });
    break;
  }
  case "membre":
  case "retirer-membre": {
    const [coursId, identifiant] = reste;
    if (!coursId || !identifiant || reste.length !== 2) {
      console.error(`usage: thot ${commande} <cours_id> <identifiant>`);
      process.exit(2);
    }
    const compte = db
      .prepare("SELECT id FROM comptes WHERE identifiant = ?")
      .get(identifiant.trim().toLowerCase());
    if (!compte) {
      console.error(`Compte introuvable : ${identifiant}`);
      process.exit(1);
    }
    if (commande === "membre") Domaines.inscrire(db, coursId, compte.id as string);
    else Domaines.desinscrire(db, coursId, compte.id as string);
    break;
  }
  case "instance":
    console.log(
      JSON.stringify(
        {
          ...configurerInstance(db, args.nom, args.mode),
          traitements: traitements(),
        },
        null,
        2,
      ),
    );
    break;
  case "administrateur": {
    if (reste.length !== 2) throw new Error("usage: thot administrateur <identifiant> <nom>");
    console.log(
      `Code provisoire de ${reste[0]}: ${await creerAdministrateur(db, reste[0], reste[1])}`,
    );
    console.log(
      "À utiliser une seule fois pour choisir un mot de passe. Récupération : thot reinitialiser.",
    );
    break;
  }
  case "migrer":
    break;
  case "compte": {
    const [identifiant, nom, role] = reste;
    if (!identifiant || !nom || !["enseignant", "eleve"].includes(role)) {
      console.error("usage: thot compte <identifiant> <nom> <enseignant|eleve> [--cours=<id>]...");
      process.exit(2);
    }
    const motDePasse = await creerCompte(db, identifiant, nom, role as Role, args.cours);
    console.log(`Mot de passe de ${identifiant}: ${motDePasse}`);
    break;
  }
  case "reinitialiser": {
    const identifiant = reste[0]?.trim().toLowerCase();
    if (!identifiant || reste.length !== 1) {
      console.error("usage: thot reinitialiser <identifiant enseignant>");
      process.exit(2);
    }
    const compte = db
      .prepare("SELECT id FROM comptes WHERE identifiant = ? AND role = 'enseignant'")
      .get(identifiant);
    if (!compte) {
      console.error(`Compte enseignant introuvable : ${identifiant}`);
      process.exit(1);
    }
    console.log(
      `Nouveau mot de passe de ${identifiant}: ${await reinitialiserMotDePasse(
        db,
        compte.id as string,
        "enseignant",
      )}`,
    );
    break;
  }
  case "ingest":
    await ingest(reste[0] ?? ".");
    break;
  case "traiter":
    await traiterFile();
    break;
  case "legendes-importer":
    importerLegendes(reste[0]);
    break;
  case "certifier": {
    const ids = args.tout
      ? db
          .prepare("SELECT id FROM sources WHERE statut = 'a_relire' AND school_id = ?")
          .all(lireInstance(db).school_id)
          .map((l) => l.id as string)
      : reste;
    for (const id of ids) statuer(db, id, "certifiee", args.par ?? "cli");
    console.log(`${ids.length} source(s) certifiée(s).`);
    break;
  }
  case "suggestions": {
    const ids = args.tout
      ? db
          .prepare("SELECT id FROM sources WHERE statut = 'certifiee' AND school_id = ?")
          .all(lireInstance(db).school_id)
          .map((l) => l.id as string)
      : reste;
    let n = 0;
    for (const [i, id] of ids.entries()) {
      n += await genererSuggestions(db, modeles, id);
      if ((i + 1) % 10 === 0) console.log(`${i + 1}/${ids.length} sources, ${n} questions gardées`);
    }
    console.log(`${n} question(s) vérifiée(s) pour ${ids.length} source(s).`);
    break;
  }
  case "nettoyer":
    await nettoyer();
    break;
  case "reextraire": {
    const bilan: Record<string, string[]> = {};
    for (const { id, fichier } of db.prepare("SELECT id, fichier FROM sources").all()) {
      const r = await reextraire(db, id as string);
      (bilan[r] ??= []).push(fichier as string);
    }
    for (const [etat, fichiers] of Object.entries(bilan)) {
      console.log(`${etat}: ${fichiers.length}`);
      if (etat === "revision") fichiers.forEach((f) => console.log(`  ${f}`));
    }
    break;
  }
  case "rebuild": {
    const ids = db
      .prepare("SELECT id FROM sources")
      .all()
      .map((l) => l.id as string);
    for (const id of ids) indexer(db, id);
    const n = db.prepare("SELECT count(*) n FROM chunks").get()!.n;
    console.log(`${ids.length} source(s) relue(s), ${n} chunk(s) indexé(s).`);
    break;
  }
  case "backup": {
    if (reste.length !== 1) throw new Error("usage: thot backup <destination>");
    sauvegarder(db, reste[0]);
    console.log(`Sauvegarde dans ${resolve(reste[0])}`);
    break;
  }
  case "ask": {
    const { resultat, journal } = await demander(
      db,
      modeles,
      reste.join(" "),
      {
        lecteur: null,
        schoolId: lireInstance(db).school_id,
        matiereId: args["matiere-id"],
        coursId: args["cours-id"],
        themeId: args["theme-id"],
      },
      config.seuil,
    );
    if (args.json) console.log(JSON.stringify({ resultat, journal }, null, 1));
    else if (resultat.etat === "answered") {
      resultat.affirmations.forEach((a, i) => console.log(`${a.texte} [${i + 1}]`));
      resultat.affirmations.forEach((a, i) =>
        console.log(`  [${i + 1}] ${a.titre}: « ${a.citation} »`),
      );
    } else console.log(resultat.etat, "message" in resultat ? resultat.message : resultat.raison);
    break;
  }
  case "eval":
    if (reste[0] === "recherche") await evalRecherche();
    else if (reste[0] === "generation") await evalGeneration();
    else if (reste[0] === "soutien") await evalSoutien();
    else throw new Error("usage: thot eval recherche|generation|soutien");
    break;
  default:
    console.log(AIDE);
}
db.close();
