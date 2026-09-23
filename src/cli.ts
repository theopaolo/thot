import { parseArgs } from "@std/cli/parse-args";
import { basename, dirname, extname, join, relative } from "@std/path";
import { decoder, rubriquesSommaire } from "./core/html.ts";
import { openrouter } from "./core/modeles.ts";
import { demander } from "./core/reponse.ts";
import { chercher, chercherFts } from "./core/recherche.ts";
import { creerCompte, reinitialiserMotDePasse, type Role } from "./app/comptes.ts";
import { config, RACINE } from "./app/config.ts";
import { cacheModeles, connexion, migrer } from "./app/db.ts";
import { controlerFichier, deposer, nomSur, PUBLICS_PAR_DEFAUT, sha256 } from "./app/depot.ts";
import { indexer, revendiquer, statuer, traiter } from "./app/ingestion.ts";
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
  rebuild                                   reconstruit l'index des sources certifiées
  ask "<question>" [--json]                 pose une question sur le corpus certifié
  eval recherche --img-order=<img_order.json> [--docs=<docs.json>] [--sans-reclasseur]
                                            rejoue les 59 requêtes annotées
  eval generation                           rejoue les 20 questions d'élève et les 15 pièges`;

const args = parseArgs(Deno.args, {
  boolean: ["json", "tout", "sans-reclasseur", "help"],
  string: ["matiere", "classe", "type", "img-order", "docs", "enseignant", "par"],
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
      sommaires.set(dossier, rubriquesSommaire(s));
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
       WHERE position = 0 AND legende IS NULL AND source_id IN (
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
  const lignes: {
    qid: string;
    registre: string;
    question: string;
    etat: string;
    detail?: string;
    bonne_source?: boolean;
    score: unknown;
    ms: number;
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
    else throw new Error("usage: thot eval recherche|generation");
    break;
  default:
    console.log(AIDE);
}
db.close();
