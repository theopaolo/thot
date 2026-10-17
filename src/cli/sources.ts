import { readFileSync } from "node:fs";
import { opendir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { decoder, pageVide, rubriquesSommaire } from "../core/html.ts";
import { lireFrontMatter } from "../core/markdown.ts";
import { lireInstance } from "../app/instance.ts";
import { contenu } from "../app/config.ts";
import type { Db } from "../app/db.ts";
import { controlerFichier, deposer, nomSur, sha256, valider } from "../app/depot.ts";
import {
  indexer,
  reextraire,
  revendiquer,
  statuer,
  supprimerSource,
  traiter,
} from "../app/ingestion.ts";
import { sauvegarder } from "../app/sauvegarde.ts";
import { genererSuggestions } from "../app/suggestions.ts";
import { type Commande, lire, oui, texte } from "./commun.ts";

const FORMATS_ACCEPTES = new Set([
  ".pdf",
  ".html",
  ".htm",
  ".md",
  ".markdown",
  ".docx",
  ".pptx",
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

/** Le `<title>` d'une page, le titre du front matter d'un Markdown, sinon le nom du fichier. */
function titreDe(nom: string, octets: Uint8Array, format: string) {
  const sansExtension = nom.replace(/\.[^.]+$/, "");
  const lu = () => new TextDecoder().decode(octets);
  if (format === "html") {
    return decoder(
      lu()
        .match(/<title>([\s\S]*?)<\/title>/i)?.[1]
        ?.trim() ?? nom,
    );
  }
  if (format === "md") return lireFrontMatter(lu()).titre ?? sansExtension;
  return sansExtension;
}

/**
 * La rubrique de chaque fichier d'un dossier, d'après son `Sommaire.html`. Le sommaire range la
 * page qui présente une fiche PDF, pas la fiche : elle hérite de sa rubrique.
 */
async function rubriquesDuDossier(dossier: string) {
  const s = await readFile(join(dossier, "Sommaire.html"), "utf8").catch(() => "");
  const rubriques = rubriquesSommaire(s);
  // oxlint-disable-next-line unicorn/no-useless-spread -- la boucle ajoute des entrées.
  for (const [href, rubrique] of [...rubriques]) {
    const page = await readFile(join(dossier, href), "utf8").catch(() => "");
    const lie = page && pageVide(page)?.fichier;
    if (lie) rubriques.set(lie, rubrique);
  }
  return rubriques;
}

/** Dépose chaque fichier du chemin. Le chapitre vient du dossier, la séance de son sommaire. */
async function ingest(db: Db, argv: string[]) {
  const { values: args, positionals } = lire(argv, {
    matiere: texte,
    "matiere-id": texte,
    "cours-id": texte,
    "theme-id": texte,
    classe: texte,
    type: texte,
    langue: texte,
    auteur: texte,
    version: texte,
    juridiction: texte,
    "date-publication": texte,
    "date-evenement": texte,
    "valide-du": texte,
    "valide-au": texte,
    enseignant: texte,
  });
  const chemin = positionals[0] ?? ".";
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
    if (!sommaires.has(dossier)) sommaires.set(dossier, await rubriquesDuDossier(dossier));
    const validation = valider({
      titre: titreDe(nom, octets, controle.format).replace(/\s+/g, " ").slice(0, 200),
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
      sequence: basename(dossier),
      seance: sommaires.get(dossier)!.get(nom) ?? "",
      resume: "",
      objectifs: "",
      evaluation: "",
    });
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
async function nettoyer(db: Db) {
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

/** Légendes produites par le banc d'essai avec le même modèle et la même consigne. */
function importerLegendes(db: Db, chemin: string) {
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

/** Les sources désignées, ou avec `--tout` toutes celles de l'établissement dans `statut`. */
const designees = (db: Db, statut: string, tout: boolean | undefined, ids: string[]) =>
  tout
    ? db
        .prepare("SELECT id FROM sources WHERE statut = ? AND school_id = ?")
        .all(statut, lireInstance(db).school_id)
        .map((l) => l.id as string)
    : ids;

export const sources: Record<string, Commande> = {
  ingest: {
    aide: `  ingest <dossier|fichier> [--matiere-id=...] [--cours-id=...] [--theme-id=...]
         [--matiere=arts-appliques] [--classe=...] [--type=cours] [--langue=fr]
         [--auteur=...] [--version=...] [--juridiction=...]
         [--date-publication=...] [--date-evenement=...] [--valide-du=...] [--valide-au=...]
         [--enseignant="M. Detienne"]
                                            dépose chaque fichier, chapitre tiré du dossier`,
    lancer: (db, _, argv) => ingest(db, argv),
  },
  traiter: {
    aide: "  traiter                                   vide la file de travaux sans lancer le worker",
    async lancer(db, modeles, argv) {
      lire(argv, {});
      let n = 0;
      for (let job = revendiquer(db); job; job = revendiquer(db)) {
        await traiter(db, job, modeles);
        if (++n % 20 === 0) console.log(`${n} travaux traités`);
      }
      console.log(`${n} travail(aux) traité(s).`);
    },
  },
  "legendes-importer": {
    aide: "  legendes-importer <legendes.json>         reprend des légendes déjà générées (banc d'essai)",
    lancer: (db, _, argv) => importerLegendes(db, lire(argv, {}).positionals[0]),
  },
  certifier: {
    aide: `  certifier <source_id...> | --tout [--par=nom]
                                            certifie des sources, trace le nom donné`,
    lancer(db, _, argv) {
      const { values, positionals } = lire(argv, { tout: oui, par: texte });
      const ids = designees(db, "a_relire", values.tout, positionals);
      for (const id of ids) statuer(db, id, "certifiee", values.par ?? "cli");
      console.log(`${ids.length} source(s) certifiée(s).`);
    },
  },
  suggestions: {
    aide: "  suggestions <source_id...> | --tout       questions vérifiées proposées aux élèves",
    async lancer(db, modeles, argv) {
      const { values, positionals } = lire(argv, { tout: oui });
      const ids = designees(db, "certifiee", values.tout, positionals);
      let n = 0;
      for (const [i, id] of ids.entries()) {
        n += await genererSuggestions(db, modeles, id);
        if ((i + 1) % 10 === 0)
          console.log(`${i + 1}/${ids.length} sources, ${n} questions gardées`);
      }
      console.log(`${n} question(s) vérifiée(s) pour ${ids.length} source(s).`);
    },
  },
  nettoyer: {
    aide: "  nettoyer                                  retire les pages Pearltrees réduites à leur titre",
    lancer(db, _, argv) {
      lire(argv, {});
      return nettoyer(db);
    },
  },
  rebuild: {
    aide: "  rebuild                                   reconstruit l'index des sources certifiées",
    lancer(db, _, argv) {
      lire(argv, {});
      const ids = db
        .prepare("SELECT id FROM sources")
        .all()
        .map((l) => l.id as string);
      for (const id of ids) indexer(db, id);
      const n = db.prepare("SELECT count(*) n FROM chunks").get()!.n;
      console.log(`${ids.length} source(s) relue(s), ${n} chunk(s) indexé(s).`);
    },
  },
  reextraire: {
    aide: `  reextraire                                rejoue l'extraction des sources, un texte changé
                                            devient une révision à certifier`,
    async lancer(db, _, argv) {
      lire(argv, {});
      const bilan: Record<string, string[]> = {};
      for (const { id, fichier } of db.prepare("SELECT id, fichier FROM sources").all()) {
        const r = await reextraire(db, id as string);
        (bilan[r] ??= []).push(fichier as string);
      }
      for (const [etat, fichiers] of Object.entries(bilan)) {
        console.log(`${etat}: ${fichiers.length}`);
        if (etat === "revision") fichiers.forEach((f) => console.log(`  ${f}`));
      }
    },
  },
  backup: {
    aide: `  backup <destination>                      copie base, contenu et secret dans un répertoire vide,
                                            serveur et worker peuvent tourner`,
    lancer(db, _, argv) {
      const reste = lire(argv, {}).positionals;
      if (reste.length !== 1) throw new Error("usage: thot backup <destination>");
      sauvegarder(db, reste[0]);
      console.log(`Sauvegarde dans ${resolve(reste[0])}`);
    },
  },
};
