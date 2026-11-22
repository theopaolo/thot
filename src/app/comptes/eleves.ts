import { transaction } from "../../core/recherche.ts";
import { type Db, maintenant } from "../db.ts";
import { inscrire } from "../domaines.ts";
import { type Compte, deriver, hex } from "./compte.ts";

/** Un compte saisi dans un formulaire ou le CSV des élèves, ou `undefined` s'il est invalide. */
export function compteSaisi(identifiant = "", nom = "") {
  identifiant = identifiant.trim().toLowerCase();
  nom = nom.trim();
  if (!/^[a-z0-9._-]{3,40}$/.test(identifiant) || !nom || nom.length > 100) return undefined;
  return { identifiant, nom };
}

/** CSV UTF-8 avec colonnes identifiant,nom. Les guillemets et retours de ligne sont permis. */
export function lireListe(csv: string): { identifiant: string; nom: string }[] {
  const lignes: string[][] = [];
  let ligne: string[] = [],
    valeur = "",
    cite = false,
    ferme = false;
  csv = csv.replace(/^\uFEFF/, "");
  const separateur =
    (csv.split(/\r?\n/, 1)[0].match(/;/g)?.length ?? 0) >
    (csv.split(/\r?\n/, 1)[0].match(/,/g)?.length ?? 0)
      ? ";"
      : ",";
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (ferme && c !== separateur && c !== "\n" && c !== "\r") {
      throw new Error("Guillemets CSV invalides.");
    }
    if (c === '"') {
      if (cite && csv[i + 1] === '"') {
        valeur += '"';
        i++;
      } else if (!cite && valeur) throw new Error("Guillemets CSV invalides.");
      else {
        cite = !cite;
        ferme = !cite;
      }
    } else if (c === separateur && !cite) {
      ligne.push(valeur);
      valeur = "";
      ferme = false;
    } else if ((c === "\n" || c === "\r") && !cite) {
      if (c === "\r" && csv[i + 1] === "\n") i++;
      ligne.push(valeur);
      valeur = "";
      if (ligne.some((x) => x.trim())) lignes.push(ligne);
      ligne = [];
      ferme = false;
    } else valeur += c;
  }
  if (cite) throw new Error("Guillemets CSV non fermés.");
  ligne.push(valeur);
  if (ligne.some((x) => x.trim())) lignes.push(ligne);
  const entetes = lignes.shift()?.map((x) => x.trim().toLowerCase());
  if (!entetes || entetes.length !== 2 || entetes[0] !== "identifiant" || entetes[1] !== "nom") {
    throw new Error("Le CSV doit commencer par identifiant,nom.");
  }
  if (!lignes.length || lignes.length > 100) {
    throw new Error("Le CSV doit contenir de 1 à 100 élèves.");
  }
  const comptes = lignes.map(([identifiant, nom], i) => {
    const eleve = lignes[i].length === 2 ? compteSaisi(identifiant, nom) : undefined;
    if (!eleve) throw new Error(`Ligne ${i + 2}: identifiant ou nom invalide.`);
    return eleve;
  });
  if (new Set(comptes.map((c) => c.identifiant)).size !== comptes.length) {
    throw new Error("Le CSV contient un identifiant en double.");
  }
  return comptes;
}

export const importerEleves = (db: Db, csv: string, cours: string[] = []) =>
  creerEleves(db, lireListe(csv), cours);

/**
 * Crée les comptes élèves et les inscrit aux cours donnés, dans la même transaction. Le mot de
 * passe rendu est provisoire : l'enseignant le remet, l'élève choisit le sien à sa première
 * connexion. Un compte existant ne s'inscrit pas par son identifiant : les enseignants d'un cours
 * réinitialisent le mot de passe de ses élèves, et inscrire un compte existant leur ouvrirait ce
 * compte.
 */
export async function creerEleves(
  db: Db,
  comptes: { identifiant: string; nom: string }[],
  cours: string[] = [],
) {
  const existants = db.prepare("SELECT identifiant FROM comptes WHERE identifiant = ?");
  for (const c of comptes) {
    if (existants.get(c.identifiant)) {
      throw new Error(
        `Identifiant déjà utilisé : ${c.identifiant}. Un élève qui a déjà un compte rejoint vos cours par un lien d'inscription.`,
      );
    }
  }
  const resultats: ((typeof comptes)[number] & {
    motDePasse: string;
    id: string;
    sel: string;
    empreinte: string;
  })[] = [];
  for (const c of comptes) {
    const motDePasse = hex(crypto.getRandomValues(new Uint8Array(6)));
    const sel = hex(crypto.getRandomValues(new Uint8Array(16)));
    resultats.push({
      ...c,
      motDePasse,
      id: crypto.randomUUID(),
      sel,
      empreinte: await deriver(motDePasse, sel),
    });
  }
  transaction(db, () => {
    const insert = db.prepare(
      "INSERT INTO comptes (id, identifiant, nom, role, sel, empreinte, cree_le, renouveler_mdp) VALUES (?, ?, ?, 'eleve', ?, ?, ?, 1)",
    );
    for (const c of resultats) {
      insert.run(c.id, c.identifiant, c.nom, c.sel, c.empreinte, maintenant());
      for (const coursId of cours) inscrire(db, coursId, c.id);
    }
  });
  return resultats.map(({ identifiant, nom, motDePasse }) => ({ identifiant, nom, motDePasse }));
}

// Réinitialiser ouvre le compte : seuls les administrateurs gèrent les élèves sans cours.
const ELEVES_GERES = `role = 'eleve' AND ($administrateur OR EXISTS (SELECT 1 FROM membres_cours lui
      JOIN membres_cours moi ON moi.cours_id = lui.cours_id
      WHERE lui.compte_id = comptes.id AND moi.compte_id = $lecteur))`;

export const parametresGeres = (c: Compte) => ({
  administrateur: c.administrateur === 1 ? 1 : 0,
  lecteur: c.id,
});

/** Les élèves sans cours, que seuls les administrateurs gèrent. `undefined` pour un enseignant. */
export function elevesSansCours(db: Db, compte: Compte) {
  if (compte.administrateur !== 1) return undefined;
  return db
    .prepare(
      `SELECT id, identifiant, nom FROM comptes WHERE role = 'eleve'
       AND NOT EXISTS (SELECT 1 FROM membres_cours WHERE compte_id = comptes.id) ORDER BY nom`,
    )
    .all() as { id: string; identifiant: string; nom: string }[];
}

/** Vrai si le compte est élève du cours donné. */
export const estEleveDuCours = (db: Db, coursId: string, eleveId: string) =>
  db
    .prepare(
      `SELECT 1 FROM membres_cours m JOIN comptes a ON a.id = m.compte_id
       WHERE m.cours_id = ? AND m.compte_id = ? AND a.role = 'eleve'`,
    )
    .get(coursId, eleveId) !== undefined;

/** L'élève que le compte gère, ou `undefined`. */
export const eleveGere = (db: Db, compte: Compte, id: string) =>
  db
    .prepare(`SELECT identifiant, nom FROM comptes WHERE id = ? AND ${ELEVES_GERES}`)
    .get(parametresGeres(compte), id) as { identifiant: string; nom: string } | undefined;
