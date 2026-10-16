import { writeFile, mkdir, rename, rm } from "node:fs/promises";
import { contenu } from "./config.ts";
import { FILTRE_ACCES, parametresAcces, transaction } from "../core/recherche.ts";
import { lireFrontMatter } from "../core/markdown.ts";
import { type Compte, lecteur } from "./comptes.ts";
import { type Db, maintenant } from "./db.ts";
import {
  type Affiliation,
  affiliations,
  champsMatiere,
  domaineSource,
  rangerLegacy,
} from "./domaines.ts";
import { CHAMPS, validerInformations } from "../core/profils.ts";

export const MAX_OCTETS = 25 * 1024 * 1024;
/** Fichiers par lot. Les requêtes d'un lot arrivent une à une : le serveur compte les sources. */
export const MAX_LOT = 50;

export const FORMATS = ["pdf", "html", "png", "jpg", "md"] as const;
export type Format = (typeof FORMATS)[number];

// ponytail: listes en dur. Elles viendront du catalogue de l'établissement.
export const TYPES_DOCUMENT = [
  { value: "cours", label: "Cours" },
  { value: "sources", label: "Sources" },
  { value: "programme", label: "Programme" },
  { value: "referentiel", label: "Référentiel" },
  { value: "autres", label: "Autres" },
];
export const CLASSES = [
  { value: "2nde", label: "Seconde" },
  { value: "1ere", label: "Première" },
  { value: "terminale", label: "Terminale" },
  { value: "bts1", label: "BTS 1re année" },
  { value: "bts2", label: "BTS 2e année" },
];
export const AUDIENCES = [
  { value: "prive", label: "Moi seulement" },
  { value: "collegues", label: "Les enseignants" },
  { value: "eleves", label: "Les enseignants et les élèves" },
] as const;
export type Audience = (typeof AUDIENCES)[number]["value"];
export const audience = (v: unknown): Audience => {
  const a = AUDIENCES.find((a) => a.value === v);
  if (!a) throw new Error("Lecteurs inconnus.");
  return a.value;
};

export type Metadonnees = {
  titre: string;
  type_document: string;
  matiere: string;
  classe: string;
  sous_matiere: string;
  sequence: string;
  seance: string;
  resume: string;
  objectifs: string;
  evaluation: string;
  matiere_id?: string;
  langue?: string;
};

const REQUIS = ["titre", "type_document", "matiere", "classe", "matiere_id", "langue"] as const;
const LIBRES = ["sous_matiere", "sequence", "seance", "resume", "objectifs", "evaluation"] as const;

/**
 * Valide la saisie. Rend les métadonnées ou un message par champ. Les valeurs des champs
 * `informations` passent telles quelles : le dépôt les valide selon la matière.
 */
export function valider(
  champs: Record<string, string>,
  informations: string[] = Object.keys(CHAMPS),
): { meta: Metadonnees } | { erreurs: Record<string, string> } {
  const erreurs: Record<string, string> = {};
  const lu = (nom: string) => (champs[nom] ?? "").trim();
  for (const nom of REQUIS) {
    if (!lu(nom) && (nom === "titre" || nom === "type_document")) {
      erreurs[nom] = "Champ obligatoire.";
    } else if (lu(nom).length > 200) erreurs[nom] = "Texte trop long.";
  }
  for (const nom of LIBRES) if (lu(nom).length > 4000) erreurs[nom] = "Texte trop long.";
  const type = lu("type_document");
  if (type && !TYPES_DOCUMENT.some((t) => t.value === type)) {
    erreurs.type_document = "Valeur inconnue.";
  }
  if (Object.keys(erreurs).length) return { erreurs };
  const meta = Object.fromEntries([...REQUIS, ...LIBRES].map((n) => [n, lu(n)]));
  const valeurs = Object.fromEntries(
    informations.filter((n) => champs[n]?.trim()).map((n) => [n, champs[n].trim()]),
  );
  return { meta: { ...meta, ...valeurs } as Metadonnees };
}

const SIGNATURES: [Format, number[]][] = [
  ["pdf", [0x25, 0x50, 0x44, 0x46]],
  ["png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["jpg", [0xff, 0xd8, 0xff]],
];

const EST_MARKDOWN = /\.(md|markdown)$/i;

/**
 * Le type vient du contenu. Le Markdown n'a pas de signature: il demande l'extension du nom
 * reçu, des octets UTF-8 valides et aucun NUL. Le type MIME annoncé par le client n'est pas lu.
 */
export function detecterFormat(octets: Uint8Array, nom = ""): Format | null {
  for (const [format, sig] of SIGNATURES) if (sig.every((b, i) => octets[i] === b)) return format;
  if (EST_MARKDOWN.test(nom)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(octets);
    } catch {
      return null;
    }
    return octets.includes(0) ? null : "md";
  }
  const debut = new TextDecoder().decode(octets.subarray(0, 512)).trimStart();
  return debut.startsWith("<") ? "html" : null;
}

/** Un nom reçu ne devient jamais un chemin. */
export function nomSur(nom: string): string {
  const base = nom.split(/[/\\]/).at(-1)!;
  return (
    base
      .replace(/[^\p{L}\p{N}_.-]+/gu, "-")
      .replace(/^\.+/, "")
      .slice(0, 100) || "sans-nom"
  );
}

export async function sha256(octets: Uint8Array) {
  const h = await crypto.subtle.digest("SHA-256", octets as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Contrôle un fichier reçu. Rend le format ou le message à afficher sous le champ. */
export function controlerFichier(
  octets: Uint8Array,
  nom = "",
): { format: Format } | { erreur: string } {
  if (!octets.length) return { erreur: "Un fichier est attendu." };
  if (octets.length > MAX_OCTETS) {
    return { erreur: `Fichier trop lourd, ${MAX_OCTETS / 1024 / 1024} Mo au maximum.` };
  }
  const format = detecterFormat(octets, nom);
  if (!format) return { erreur: `Format non reconnu. Acceptés : ${FORMATS.join(", ")}.` };
  return { format };
}

/** Le titre du front matter pour un Markdown, sinon le nom du fichier sans son extension. */
export function titreParDefaut(octets: Uint8Array, nom: string, format: Format | null) {
  const titre =
    format === "md" ? lireFrontMatter(new TextDecoder().decode(octets)).titre : undefined;
  return (titre ?? nom.replace(/\.[^.]+$/, "")).replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Une source que le compte lit déjà avec les mêmes octets. Les autres n'existent pas pour lui. */
export const sourceIdentique = (db: Db, compte: Compte, schoolId: string, checksum: string) =>
  db
    .prepare(
      `SELECT s.id, s.titre FROM sources s
       WHERE s.school_id = ? AND s.checksum = ? AND ${FILTRE_ACCES} ORDER BY s.cree_le LIMIT 1`,
    )
    .get(schoolId, checksum, ...parametresAcces(lecteur(compte))) as
    | { id: string; titre: string }
    | undefined;

/** Écrit l'original puis ouvre son travail d'ingestion. */
export async function deposer(
  db: Db,
  d: {
    meta: Metadonnees;
    nomFichier: string;
    octets: Uint8Array;
    format: Format;
    schoolId: string;
    /** nom affiché. Sans `proprietaireId`, il désigne le compte s'il est le seul à le porter. */
    enseignant: string;
    proprietaireId?: string;
    /** le compte qui dépose par le web : il ne range la source que dans ses cours */
    par?: { id: string; administrateur: number };
    audience: Audience;
    reponses: boolean;
    liens?: Affiliation[];
    /** le lot du dépôt web et la clé qui rend un renvoi inoffensif */
    lotId?: string;
    cle?: string;
  },
): Promise<{ source_id: string; job_id: string }> {
  const source_id = crypto.randomUUID();
  const job_id = crypto.randomUUID();
  const nom = nomSur(d.nomFichier);
  const dossier = contenu(source_id, "original");
  await mkdir(dossier, { recursive: true });
  await writeFile(`${dossier}/.${nom}.partiel`, d.octets);
  await rename(`${dossier}/.${nom}.partiel`, `${dossier}/${nom}`);

  const checksum = await sha256(d.octets);
  const t = maintenant();
  try {
    transaction(db, () => {
      const domaine = domaineSource(db, d.meta as unknown as Record<string, string>);
      // Seuls les champs de la matière sont validés puis enregistrés.
      const informations = validerInformations(
        d.meta as unknown as Record<string, string>,
        champsMatiere(db, domaine.matiere_id, domaine.profil),
      );
      const saisie = Object.fromEntries([...REQUIS, ...LIBRES].map((n) => [n, d.meta[n]]));
      if (domaine.profil === "arts-appliques") {
        for (const nom of Object.keys(informations)) {
          if (!informations[nom]) delete informations[nom];
        }
      }
      db.prepare(
        `INSERT INTO sources (id, school_id, titre, metadonnees, fichier, format, checksum, octets,
       enseignant, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        source_id,
        d.schoolId,
        d.meta.titre,
        JSON.stringify({ ...saisie, ...informations }),
        nom,
        d.format,
        checksum,
        d.octets.length,
        d.enseignant,
        t,
      );
      db.prepare(
        `UPDATE sources SET matiere_id = ?, profil = ?, langue = ?, audience = ?, reponses = ?,
         proprietaire_id = coalesce(?, (SELECT min(id) FROM comptes
           WHERE role = 'enseignant' AND nom = ? HAVING count(*) = 1)),
         lot_id = ?, cle_depot = ? WHERE id = ?`,
      ).run(
        domaine.matiere_id,
        domaine.profil,
        domaine.langue,
        audience(d.audience),
        d.reponses ? 1 : 0,
        d.proprietaireId ?? null,
        d.enseignant,
        d.lotId ?? null,
        d.cle ?? null,
        source_id,
      );
      if (d.liens !== undefined) affiliations(db, source_id, d.liens);
      else rangerLegacy(db, source_id, domaine.matiere_id, d.meta.sequence, d.par);
      db.prepare(
        "INSERT INTO ingestion_jobs (id, source_id, etat, cree_le, maj_le) VALUES (?, ?, 'received', ?, ?)",
      ).run(job_id, source_id, t, t);
    });
  } catch (e) {
    await rm(contenu(source_id), { recursive: true });
    throw e;
  }
  return { source_id, job_id };
}
