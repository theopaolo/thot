import { contenu } from "./config.ts";
import { transaction } from "../core/recherche.ts";
import { type Db, maintenant } from "./db.ts";
import { type Affiliation, affiliations, domaineSource, rangerLegacy } from "./domaines.ts";
import { CHAMPS, validerInformations } from "../core/profils.ts";

export const MAX_OCTETS = 25 * 1024 * 1024;

export const FORMATS = ["pdf", "html", "png", "jpg"] as const;
export type Format = typeof FORMATS[number];

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
export type Audience = typeof AUDIENCES[number]["value"];
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

/** Valide la saisie. Rend les métadonnées ou un message par champ. */
export function valider(
  champs: Record<string, string>,
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
  const informations = Object.fromEntries(
    Object.keys(CHAMPS).filter((n) => champs[n]?.trim()).map((n) => [n, champs[n].trim()]),
  );
  return { meta: { ...meta, ...informations } as Metadonnees };
}

const SIGNATURES: [Format, number[]][] = [
  ["pdf", [0x25, 0x50, 0x44, 0x46]],
  ["png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["jpg", [0xff, 0xd8, 0xff]],
];

/** Le type vient du contenu, jamais de l'extension annoncée par le client. */
export function detecterFormat(octets: Uint8Array): Format | null {
  for (const [format, sig] of SIGNATURES) if (sig.every((b, i) => octets[i] === b)) return format;
  const debut = new TextDecoder().decode(octets.subarray(0, 512)).trimStart();
  return debut.startsWith("<") ? "html" : null;
}

/** Un nom reçu ne devient jamais un chemin. */
export function nomSur(nom: string): string {
  const base = nom.split(/[/\\]/).at(-1)!;
  return base.replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/^\.+/, "").slice(0, 100) || "sans-nom";
}

export async function sha256(octets: Uint8Array) {
  const h = await crypto.subtle.digest("SHA-256", octets as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Contrôle un fichier reçu. Rend le format ou le message à afficher sous le champ. */
export function controlerFichier(octets: Uint8Array): { format: Format } | { erreur: string } {
  if (!octets.length) return { erreur: "Un fichier est attendu." };
  if (octets.length > MAX_OCTETS) {
    return { erreur: `Fichier trop lourd, ${MAX_OCTETS / 1024 / 1024} Mo au maximum.` };
  }
  const format = detecterFormat(octets);
  if (!format) return { erreur: `Format non reconnu. Acceptés : ${FORMATS.join(", ")}.` };
  return { format };
}

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
  },
): Promise<{ source_id: string; job_id: string }> {
  const source_id = crypto.randomUUID();
  const job_id = crypto.randomUUID();
  const nom = nomSur(d.nomFichier);
  const dossier = contenu(source_id, "original");
  await Deno.mkdir(dossier, { recursive: true });
  await Deno.writeFile(`${dossier}/.${nom}.partiel`, d.octets);
  await Deno.rename(`${dossier}/.${nom}.partiel`, `${dossier}/${nom}`);

  const checksum = await sha256(d.octets);
  const t = maintenant();
  try {
    transaction(db, () => {
      const domaine = domaineSource(db, d.meta as unknown as Record<string, string>);
      const informations = validerInformations(
        d.meta as unknown as Record<string, string>,
        domaine.profil,
      );
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
        JSON.stringify({ ...d.meta, ...informations }),
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
           WHERE role = 'enseignant' AND nom = ? HAVING count(*) = 1)) WHERE id = ?`,
      ).run(
        domaine.matiere_id,
        domaine.profil,
        domaine.langue,
        audience(d.audience),
        d.reponses ? 1 : 0,
        d.proprietaireId ?? null,
        d.enseignant,
        source_id,
      );
      if (d.liens !== undefined) affiliations(db, source_id, d.liens);
      else rangerLegacy(db, source_id, domaine.matiere_id, d.meta.sequence, d.par);
      db.prepare(
        "INSERT INTO ingestion_jobs (id, source_id, etat, cree_le, maj_le) VALUES (?, ?, 'received', ?, ?)",
      ).run(job_id, source_id, t, t);
    });
  } catch (e) {
    await Deno.remove(contenu(source_id), { recursive: true });
    throw e;
  }
  return { source_id, job_id };
}
