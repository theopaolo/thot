import { parseArgs } from "@std/cli/parse-args";
import { basename, dirname, extname, join, relative } from "@std/path";
import { decoder, pageVide, rubriquesSommaire } from "./core/html.ts";
import { openrouter } from "./core/modeles.ts";
import { demander } from "./core/reponse.ts";
import { chercher, chercherFts, retirerSource, transaction } from "./core/recherche.ts";
import { creerCompte, reinitialiserMotDePasse, type Role } from "./app/comptes.ts";
import { config, contenu, RACINE } from "./app/config.ts";
import { cacheModeles, connexion, migrer } from "./app/db.ts";
import { controlerFichier, deposer, nomSur, PUBLICS_PAR_DEFAUT, sha256 } from "./app/depot.ts";
import {
  indexer,
  lireDocument,
  reextraire,
  revendiquer,
  statuer,
  traiter,
} from "./app/ingestion.ts";
import { contexte } from "./core/texte.ts";
import { genererSuggestions } from "./app/suggestions.ts";

const AIDE = `thot <commande>

  migrer                                    applique les migrations
  compte <identifiant> <nom> <enseignant|eleve>
                                            crée un compte et affiche son mot de passe
  reinitialiser <identifiant>               renouvelle le mot de passe enseignant
  ingest <dossier|fichier> [--matiere=arts-appliques] [--classe=terminale] [--type=cours]
         [--enseignant="M. Detienne"]
                                            dépose chaque fichier, chapitre tiré du dossier
  traiter                                   vide la file de travaux sans lancer le worker
  legendes-importer <legendes.json>         reprend des légendes déjà générées (banc d'essai)
  certifier <source_id...> | --tout [--par=nom]
                                            certifie des sources, trace le nom donné
  suggestions <source_id...> | --tout       questions vérifiées proposées aux élèves
  nettoyer                                  retire les pages Pearltrees réduites à leur titre
  rebuild                                   reconstruit l'index des sources certifiées
  reextraire                                rejoue l'extraction des sources, garde les offsets
  ask "<question>" [--json]                 pose une question sur le corpus certifié
  eval recherche --img-order=<img_order.json> [--docs=<docs.json>] [--sans-reclasseur]
                                            rejoue les 59 requêtes annotées
  eval generation [--paires=<paires.json>]  rejoue les 20 questions d'élève et les 15 pièges,
                                            écrit les paires affirmation-citation à annoter
  eval soutien --paires=<paires.json>       juge chaque paire annotée, mesure l'accord`;

const args = parseArgs(Deno.args, {
  boolean: ["json", "tout", "sans-reclasseur", "help"],
  string: ["matiere", "classe", "type", "img-order", "docs", "enseignant", "par", "paires"],
});
const [commande, ...reste] = args._.map(String);
const db = connexion();
migrer(db);
const modeles = openrouter(config.modeles, cacheModeles(db));

const FORMATS_ACCEPTES = new Set([".pdf", ".html", ".htm", ".png", ".jpg", ".jpeg"]);

async function* fichiers(chemin: string): AsyncGenerator<string> {
  const info = await Deno.stat(chemin);
  if (info.isFile) return yield chemin;
  const entrees = [];
  for await (const e of Deno.readDir(chemin)) entrees.push(e);
  entrees.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entrees) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory) yield* fichiers(join(chemin, e.name));
    else yield join(chemin, e.name);
  }
}

async function ingest(chemin: string) {
  const racine = (await Deno.stat(chemin)).isFile ? dirname(chemin) : chemin;
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
    const octets = await Deno.readFile(f);
    const controle = controlerFichier(octets);
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
      db.prepare("SELECT 1 FROM sources WHERE checksum = ? AND school_id = ?").get(
        await sha256(octets),
        config.schoolId,
      )
    ) {
      refus.push(`${relative(racine, f)}: déjà déposé`);
      continue;
    }
    const dossier = dirname(f);
    if (!sommaires.has(dossier)) {
      const s = await Deno.readTextFile(join(dossier, "Sommaire.html")).catch(() => "");
      const rubriques = rubriquesSommaire(s);
      // Le sommaire range la page qui présente une fiche PDF, pas la fiche: elle hérite de sa
      // rubrique.
      for (const [href, rubrique] of [...rubriques]) {
        const page = await Deno.readTextFile(join(dossier, href)).catch(() => "");
        const lie = page && pageVide(page)?.fichier;
        if (lie) rubriques.set(lie, rubrique);
      }
      sommaires.set(dossier, rubriques);
    }
    const sequence = basename(dossier);
    const titre = controle.format === "html"
      ? decoder(
        new TextDecoder().decode(octets).match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? nom,
      )
      : nom.replace(/\.[^.]+$/, "");
    await deposer(db, {
      meta: {
        titre: titre.replace(/\s+/g, " ").slice(0, 200),
        type_document: args.type ?? "cours",
        matiere: args.matiere ?? "arts-appliques",
        classe: args.classe ?? "terminale",
        sous_matiere: "",
        sequence,
        seance: sommaires.get(dossier)!.get(nom) ?? "",
        resume: "",
        objectifs: "",
        evaluation: "",
        publics: PUBLICS_PAR_DEFAUT,
      },
      nomFichier: nom,
      octets,
      format: controle.format,
      schoolId: config.schoolId,
      enseignant: args.enseignant ?? "import en ligne de commande",
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
  const pages = db.prepare(
    "SELECT id, fichier, metadonnees FROM sources WHERE format = 'html' AND school_id = ?",
  ).all(config.schoolId) as { id: string; fichier: string; metadonnees: string }[];
  let n = 0;
  for (const p of pages) {
    const vide = pageVide(await Deno.readTextFile(contenu(p.id, "original", p.fichier)));
    if (!vide) continue;
    const { sequence, seance } = JSON.parse(p.metadonnees);
    const fiche = vide.fichier && db.prepare(
      `SELECT id FROM sources WHERE fichier = ? AND json_extract(metadonnees, '$.sequence') = ?
         AND school_id = ?`,
    ).get(nomSur(vide.fichier), sequence, config.schoolId)?.id as string | undefined;
    transaction(db, () => {
      if (fiche && seance) {
        db.prepare(
          `UPDATE sources SET metadonnees = json_set(metadonnees, '$.seance', ?)
           WHERE id = ? AND json_extract(metadonnees, '$.seance') = ''`,
        ).run(seance, fiche);
      }
      retirerSource(db, p.id);
      for (const table of ["images", "suggestions", "ingestion_jobs", "sources"]) {
        db.prepare(`DELETE FROM ${table} WHERE ${table === "sources" ? "id" : "source_id"} = ?`)
          .run(p.id);
      }
    });
    if (fiche) indexer(db, fiche);
    await Deno.remove(contenu(p.id), { recursive: true });
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
  const json = JSON.parse(Deno.readTextFileSync(chemin));
  const modele = json._meta?.modele ?? "inconnu";
  let n = 0;
  for (const [rel, legende] of Object.entries(json.legendes as Record<string, string>)) {
    const sequence = rel.split("/").at(-2) ?? "";
    const r = db.prepare(
      `UPDATE images SET legende = ?, legende_origine = 'generated', modele = ?
       WHERE position = 0 AND legende IS NULL AND legende_statut = 'unreviewed' AND source_id IN (
         SELECT id FROM sources WHERE fichier = ? AND json_extract(metadonnees, '$.sequence') = ?)`,
    ).run(legende, modele, nomSur(basename(rel)), sequence);
    n += Number(r.changes);
  }
  for (const { id } of db.prepare("SELECT id FROM sources WHERE statut = 'certifiee'").all()) {
    indexer(db, id as string);
  }
  console.log(`${n} légende(s) importée(s) sur ${Object.keys(json.legendes).length}.`);
}

type Requete = { qid: string; type: string; q: string; gold: (number | string)[] };

const plier = (s: string) =>
  s.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function evalRecherche() {
  if (!args["img-order"]) throw new Error("--img-order=<chemin vers img_order.json> est requis.");
  const ordre = JSON.parse(await Deno.readTextFile(args["img-order"])) as string[];
  const requetes = JSON.parse(
    await Deno.readTextFile(join(RACINE, "evaluation/queries_real.json")),
  ) as Requete[];
  const sources = db.prepare(
    "SELECT id, fichier, json_extract(metadonnees, '$.sequence') AS sequence FROM sources",
  ).all() as { id: string; fichier: string; sequence: string }[];
  // Une cible de section (« Cubisme.pdf#02 ») désigne une rubrique d'une fiche PDF. Le banc
  // numérotait ses sections, `docs.json` du dépôt de recherche donne leur rubrique.
  const docs = args.docs
    ? (JSON.parse(await Deno.readTextFile(args.docs)) as { id: string; titre: string }[])
    : [];
  type Cible = { source: string; rubrique?: string };
  const cibles = (g: number | string): Cible[] => {
    if (typeof g === "number") {
      const [seq, nom] = [dirname(ordre[g]), nomSur(basename(ordre[g]))];
      return sources.filter((s) => s.fichier === nom && s.sequence === seq).map((s) => ({
        source: s.id,
      }));
    }
    if (g.includes("#")) {
      return docs.filter((d) => d.id.toLowerCase().includes(g.toLowerCase())).flatMap((d) => {
        const nom = nomSur(d.id.split("#")[0]);
        const rubrique = d.titre.split(" — ").at(-1);
        return sources.filter((s) => s.fichier === nom).map((s) => ({ source: s.id, rubrique }));
      });
    }
    return sources.filter((s) => plier(`${s.sequence} ${s.fichier}`).includes(plier(g)))
      .map((s) => ({ source: s.id }));
  };
  const touche = (c: { source_id: string; titre: string }, attendus: Cible[]) =>
    attendus.some((a) =>
      a.source === c.source_id && (!a.rubrique || c.titre.endsWith(`: ${a.rubrique}`))
    );
  const lignes: Record<string, unknown>[] = [];
  for (const r of requetes) {
    const attendus = r.gold.flatMap(cibles);
    const trouves = args["sans-reclasseur"]
      ? chercherFts(db, r.q, { schoolId: config.schoolId }).slice(0, 5)
      : (await chercher(db, modeles, r.q, { schoolId: config.schoolId }, config.seuil)).retenus;
    const rang = trouves.findIndex((c) => touche(c, attendus)) + 1;
    lignes.push({
      qid: r.qid,
      type: r.type,
      rang,
      cibles: attendus.length,
      trouves: trouves.map((c) => c.titre),
    });
  }
  const familles = [...new Set(lignes.map((l) => l.type as string))].sort();
  const resume = (ls: typeof lignes) => ({
    n: ls.length,
    succes_5: +(ls.filter((l) => (l.rang as number) > 0).length / ls.length).toFixed(2),
    mrr:
      +(ls.reduce((s, l) => s + ((l.rang as number) ? 1 / (l.rang as number) : 0), 0) / ls.length)
        .toFixed(2),
  });
  const rapport = {
    date: new Date().toISOString(),
    moteur: args["sans-reclasseur"] ? "fts5" : `fts5 + ${config.modeles.reclasseur}`,
    tous: resume(lignes),
    familles: Object.fromEntries(
      familles.map((f) => [f, resume(lignes.filter((l) => l.type === f))]),
    ),
    sans_cible: lignes.filter((l) => !l.cibles).map((l) => l.qid),
    echecs: lignes.filter((l) => !l.rang).map((l) => l.qid),
  };
  await Deno.mkdir(join(RACINE, "evaluation/resultats"), { recursive: true });
  const sortie = join(
    RACINE,
    `evaluation/resultats/recherche-${args["sans-reclasseur"] ? "fts5" : "reclasseur"}.json`,
  );
  await Deno.writeTextFile(sortie, JSON.stringify({ ...rapport, lignes }, null, 1));
  console.log(JSON.stringify(rapport, null, 1));
  console.log(`écrit dans ${relative(Deno.cwd(), sortie)}`);
}

async function evalGeneration() {
  const jeu = JSON.parse(
    await Deno.readTextFile(join(RACINE, "evaluation/queries_generation.json")),
  ) as {
    questions: { qid: string; q: string; gold: string[] }[];
    sans_reponse: { qid: string; q: string; registre: string }[];
  };
  const sources = new Map(
    (db.prepare(
      "SELECT id, fichier, json_extract(metadonnees, '$.sequence') AS sequence FROM sources",
    )
      .all() as { id: string; fichier: string; sequence: string }[]).map((
        s,
      ) => [s.id, plier(`${s.sequence} ${s.fichier}`)]),
  );
  const p = { schoolId: config.schoolId };
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
    reponse?: string[];
  }[] = [];
  for (
    const q of [
      ...jeu.questions.map((x) => ({ ...x, registre: "dans le corpus" })),
      ...jeu.sans_reponse.map((x) => ({ ...x, gold: [] as string[] })),
    ]
  ) {
    const t = Date.now();
    const { resultat, journal } = await demander(db, modeles, q.q, p, config.seuil);
    const citees = resultat.etat === "answered"
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
          soutient: null,
        })
      );
    }
    lignes.push({
      qid: q.qid,
      registre: q.registre,
      question: q.q,
      etat: resultat.etat,
      detail: "raison" in resultat
        ? resultat.raison
        : "code" in resultat
        ? resultat.code
        : undefined,
      bonne_source: q.gold.length
        ? citees.some((c) => q.gold.some((g) => c.includes(plier(g))))
        : undefined,
      score: journal.score,
      ms: Date.now() - t,
      essais: (journal.tentatives as unknown[] | undefined)?.length ?? 0,
      partielle: resultat.etat === "answered" && !!resultat.partielle,
      reponse: resultat.etat === "answered"
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
    },
    hors_corpus: Object.fromEntries(
      [...new Set(jeu.sans_reponse.map((x) => x.registre))].map((r) => [r, {
        n: par(r).length,
        refuse: taux(par(r), (l) => l.etat === "out_of_corpus"),
        repond: taux(par(r), (l) => l.etat === "answered"),
        panne: taux(par(r), (l) => l.etat === "failed"),
      }]),
    ),
    latence_mediane_ms:
      lignes.map((l) => l.ms).sort((a, b) => a - b)[Math.floor(lignes.length / 2)],
  };
  await Deno.mkdir(join(RACINE, "evaluation/resultats"), { recursive: true });
  const sortie = join(RACINE, "evaluation/resultats/generation.json");
  await Deno.writeTextFile(sortie, JSON.stringify({ ...rapport, lignes }, null, 1));
  console.log(JSON.stringify(rapport, null, 1));
  console.log(`écrit dans ${relative(Deno.cwd(), sortie)}`);
  if (args.paires) {
    // Une ligne par paire pour annoter à la main. `createNew` protège un fichier déjà annoté.
    await Deno.writeTextFile(
      args.paires,
      `[\n${paires.map((x) => JSON.stringify(x)).join(",\n")}\n]\n`,
      { createNew: true },
    );
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
  soutient: boolean | null;
};

function paragraphe(a: { source_id: string; citation: string; debut?: number; fin?: number }) {
  if (a.debut === undefined || a.fin === undefined) return a.citation;
  const x = contexte(lireDocument(a.source_id).texte, a.debut, a.fin);
  return x.avant + x.milieu + x.apres;
}

async function evalSoutien() {
  if (!args.paires) throw new Error("--paires=<chemin vers paires.json> est requis.");
  const toutes = JSON.parse(await Deno.readTextFile(args.paires)) as Paire[];
  const annotees = toutes.filter((x) => typeof x.soutient === "boolean");
  if (!annotees.some((x) => x.soutient) || !annotees.some((x) => !x.soutient)) {
    throw new Error("Il faut des paires annotées `soutient: true` et `soutient: false`.");
  }
  const lignes: { id: string; famille: string; soutient: boolean; p: number; ms: number }[] = [];
  for (const x of annotees) {
    const t = Date.now();
    const { probabilite } = await modeles.soutenir(x.texte, x.citation, x.titre ?? "");
    lignes.push({
      id: x.id,
      famille: x.famille,
      soutient: !!x.soutient,
      p: probabilite,
      ms: Date.now() - t,
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
    // Au seuil 0,5: part des bonnes affirmations rejetées, part des mauvaises qui passent.
    faux_rejets: taux(vrais, (l) => l.p < 0.5),
    faux_passages: taux(faux, (l) => l.p >= 0.5),
    par_famille: Object.fromEntries(
      [...new Set(lignes.map((l) => l.famille))].map((f) => {
        const ls = lignes.filter((l) => l.famille === f);
        return [f, { n: ls.length, erreurs_a_0_5: taux(ls, (l) => (l.p >= 0.5) !== l.soutient) }];
      }),
    ),
    latence_mediane_ms:
      lignes.map((l) => l.ms).sort((a, b) => a - b)[Math.floor(lignes.length / 2)],
  };
  // Les citations restent hors du dépôt: le rapport ne garde que les identifiants.
  await Deno.mkdir(join(RACINE, "evaluation/resultats"), { recursive: true });
  const sortie = join(RACINE, "evaluation/resultats/soutien.json");
  await Deno.writeTextFile(sortie, JSON.stringify({ ...rapport, lignes }, null, 1));
  console.log(JSON.stringify(rapport, null, 1));
  console.log(`écrit dans ${relative(Deno.cwd(), sortie)}`);
}

switch (commande) {
  case "migrer":
    break;
  case "compte": {
    const [identifiant, nom, role] = reste;
    if (!identifiant || !nom || !["enseignant", "eleve"].includes(role)) {
      console.error("usage: thot compte <identifiant> <nom> <enseignant|eleve>");
      Deno.exit(2);
    }
    console.log(
      `Mot de passe de ${identifiant}: ${await creerCompte(db, identifiant, nom, role as Role)}`,
    );
    break;
  }
  case "reinitialiser": {
    const identifiant = reste[0]?.trim().toLowerCase();
    if (!identifiant || reste.length !== 1) {
      console.error("usage: thot reinitialiser <identifiant enseignant>");
      Deno.exit(2);
    }
    const compte = db.prepare(
      "SELECT id FROM comptes WHERE identifiant = ? AND role = 'enseignant'",
    )
      .get(identifiant);
    if (!compte) {
      console.error(`Compte enseignant introuvable : ${identifiant}`);
      Deno.exit(1);
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
      ? db.prepare("SELECT id FROM sources WHERE statut = 'a_relire' AND school_id = ?").all(
        config.schoolId,
      ).map((l) => l.id as string)
      : reste;
    for (const id of ids) statuer(db, id, "certifiee", args.par ?? "cli");
    console.log(`${ids.length} source(s) certifiée(s).`);
    break;
  }
  case "suggestions": {
    const ids = args.tout
      ? db.prepare("SELECT id FROM sources WHERE statut = 'certifiee' AND school_id = ?")
        .all(config.schoolId).map((l) => l.id as string)
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
      if (etat === "texte_change") fichiers.forEach((f) => console.log(`  ${f}`));
    }
    break;
  }
  case "rebuild": {
    const ids = db.prepare("SELECT id FROM sources").all().map((l) => l.id as string);
    for (const id of ids) indexer(db, id);
    const n = db.prepare("SELECT count(*) n FROM chunks").get()!.n;
    console.log(`${ids.length} source(s) relue(s), ${n} chunk(s) indexé(s).`);
    break;
  }
  case "ask": {
    const { resultat, journal } = await demander(db, modeles, reste.join(" "), {
      schoolId: config.schoolId,
    }, config.seuil);
    if (args.json) console.log(JSON.stringify({ resultat, journal }, null, 1));
    else if (resultat.etat === "answered") {
      resultat.affirmations.forEach((a, i) => console.log(`${a.texte} [${i + 1}]`));
      resultat.affirmations.forEach((a, i) =>
        console.log(`  [${i + 1}] ${a.titre}: « ${a.citation} »`)
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
