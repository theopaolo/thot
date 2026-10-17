import {
  FILTRE_ACCES,
  FILTRE_DOMAINE,
  type Lecteur,
  parametresAcces,
  parametresDomaine,
  transaction,
} from "../core/recherche.ts";
import type { Db } from "./db.ts";
import { CHAMPS, type Champ, champsVerrouilles, type Profil, PROFILS } from "../core/profils.ts";

/** `champs` : les clés des champs du dépôt en JSON, `null` tant que la liste suit le profil. */
export type Matiere = {
  id: string;
  nom: string;
  profil: Profil;
  champs: string | null;
  version: number;
};
export type Cours = {
  id: string;
  matiere_id: string;
  nom: string;
  public: string;
  objectif: string;
};
export type Theme = { id: string; cours_id: string; nom: string };
export type Catalogue = { matieres: Matiere[]; cours: Cours[]; themes: Theme[] };
export const catalogue = (db: Db): Catalogue => ({
  matieres: db.prepare("SELECT * FROM matieres ORDER BY nom").all() as Matiere[],
  cours: db.prepare("SELECT * FROM cours ORDER BY nom").all() as Cours[],
  themes: db.prepare("SELECT * FROM themes ORDER BY nom").all() as Theme[],
});

const texte = (s: string, max = 200) => {
  if (!s.trim() || s.trim().length > max) throw new Error(`Texte attendu : 1 à ${max} caractères.`);
  return s.trim();
};
/** Le profil commun des matières et des ressources, absent tant que l'instance est vide. */
export const profilInstance = (db: Db) =>
  db.prepare("SELECT profil FROM matieres UNION SELECT profil FROM sources LIMIT 1").get()
    ?.profil as Profil | undefined;

/** Une instance garde un seul profil, partagé par ses matières et ses ressources. */
function garderProfil(db: Db, profil: string) {
  if (!Object.hasOwn(PROFILS, profil)) throw new Error("Profil inconnu.");
  const autres = db.prepare("SELECT profil FROM matieres UNION SELECT profil FROM sources").all();
  if (autres.some((l) => l.profil !== profil)) {
    throw new Error("L'instance garde un seul profil, partagé par ses matières et ses ressources.");
  }
}

export function matiere(db: Db, nom: string, profil: string = profilInstance(db) ?? "general") {
  const id = crypto.randomUUID();
  garderProfil(db, profil);
  db.prepare("INSERT INTO matieres (id, nom, profil) VALUES (?, ?, ?)").run(id, texte(nom), profil);
  return id;
}

/** Les champs prédéfinis, puis les champs personnalisés dans l'ordre de leur création. */
export const catalogueChamps = (db: Db): Champ[] => [
  ...Object.entries(CHAMPS).map(([cle, c]) => ({ cle, ...c })),
  ...(db
    .prepare("SELECT id AS cle, nom AS label, type FROM champs_personnalises ORDER BY rowid")
    .all() as Champ[]),
];
/** Les champs du dépôt d'une matière. Une source sans matière prend ceux de son profil. */
export function champsMatiere(db: Db, matiereId: string | null, profil: Profil): Champ[] {
  const liste = matiereId
    ? (db.prepare("SELECT champs FROM matieres WHERE id = ?").get(matiereId)?.champs as
        | string
        | null)
    : null;
  const cles = new Set([
    ...champsVerrouilles(profil),
    ...(liste ? (JSON.parse(liste) as string[]) : PROFILS[profil].informations),
  ]);
  return catalogueChamps(db).filter((c) => cles.has(c.cle));
}
/**
 * Enregistre les champs du dépôt d'une matière, sauf si sa liste a changé depuis `version`.
 * Rend `false` dans ce cas. Retirer un champ le masque et garde ses valeurs.
 */
export function enregistrerChamps(db: Db, matiereId: string, cles: string[], version: number) {
  const m = db.prepare("SELECT profil FROM matieres WHERE id = ?").get(matiereId);
  if (!m) throw new Error("Matière inconnue.");
  const choisis = new Set([...champsVerrouilles(m.profil as Profil), ...cles]);
  const connus = catalogueChamps(db).map((c) => c.cle);
  if ([...choisis].some((c) => !connus.includes(c))) throw new Error("Champ inconnu.");
  return (
    db
      .prepare("UPDATE matieres SET champs = ?, version = version + 1 WHERE id = ? AND version = ?")
      .run(JSON.stringify(connus.filter((c) => choisis.has(c))), matiereId, version).changes === 1
  );
}

export const TYPES_CHAMP = { text: "Texte", date: "Date", tags: "Mots-clés" };
/** Un libellé de champ est unique parmi les champs prédéfinis et personnalisés. */
function nomChamp(db: Db, nom: string, id = "") {
  const n = texte(nom, 60);
  if (
    Object.values(CHAMPS).some((c) => c.label === n) ||
    db.prepare("SELECT 1 FROM champs_personnalises WHERE nom = ? AND id != ?").get(n, id)
  ) {
    throw new Error(`« ${n} » existe déjà.`);
  }
  return n;
}
/** Le préfixe sépare la clé du champ des autres clés de `sources.metadonnees`. */
export function champPersonnalise(db: Db, nom: string, type: string) {
  if (!Object.hasOwn(TYPES_CHAMP, type)) throw new Error("Type de champ inconnu.");
  if ((db.prepare("SELECT count(*) n FROM champs_personnalises").get()!.n as number) >= 30) {
    throw new Error("30 champs personnalisés au maximum.");
  }
  const id = `perso_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  db.prepare("INSERT INTO champs_personnalises VALUES (?, ?, ?)").run(id, nomChamp(db, nom), type);
  return id;
}
/** Le nombre de ressources qui portent une valeur pour ce champ. */
export const ressourcesAvec = (db: Db, cle: string) =>
  db
    .prepare(
      "SELECT count(*) n FROM sources WHERE coalesce(json_extract(metadonnees, ?), '') != ''",
    )
    .get(`$.${cle}`)!.n as number;
export function cours(db: Db, matiereId: string, nom: string, publicCible = "", objectif = "") {
  const id = crypto.randomUUID();
  if (publicCible.trim().length > 200 || objectif.trim().length > 4000) {
    throw new Error("Public ou objectif trop long.");
  }
  db.prepare("INSERT INTO cours VALUES (?, ?, ?, ?, ?)").run(
    id,
    matiereId,
    texte(nom),
    publicCible.trim(),
    objectif.trim(),
  );
  return id;
}
export function theme(db: Db, coursId: string, nom: string) {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO themes VALUES (?, ?, ?)").run(id, coursId, texte(nom));
  return id;
}
/** Change le profil de toutes les matières d'un coup, tant qu'aucune ressource n'a un autre profil. */
export function changerProfil(db: Db, profil: string) {
  if (!Object.hasOwn(PROFILS, profil)) throw new Error("Profil inconnu.");
  if (db.prepare("SELECT 1 FROM sources WHERE profil != ?").get(profil)) {
    throw new Error("Des ressources sont déjà déposées : le profil de l'instance ne change plus.");
  }
  if (!db.prepare("UPDATE matieres SET profil = ?").run(profil).changes) {
    throw new Error("Aucune matière : le profil se choisit à la création de la première.");
  }
}

const TABLES: Record<string, string> = {
  matiere: "matieres",
  cours: "cours",
  theme: "themes",
  champ: "champs_personnalises",
};
function nomEntree(db: Db, genre: string, id: string) {
  if (!Object.hasOwn(TABLES, genre)) throw new Error("Type inconnu.");
  const ligne = db.prepare(`SELECT nom FROM ${TABLES[genre]} WHERE id = ?`).get(id);
  if (!ligne) throw new Error("Matière, cours, thème ou champ inconnu.");
  return ligne.nom as string;
}
/** L'identifiant reste: les rattachements et les valeurs d'un champ suivent le nouveau nom. */
export function renommer(db: Db, genre: string, id: string, nom: string) {
  nomEntree(db, genre, id);
  const n = genre === "champ" ? nomChamp(db, nom, id) : texte(nom);
  try {
    db.prepare(`UPDATE ${TABLES[genre]} SET nom = ? WHERE id = ?`).run(n, id);
  } catch (e) {
    if (!(e as Error).message.includes("UNIQUE")) throw e;
    throw new Error(`« ${n} » existe déjà.`);
  }
}
/**
 * Retire une matière, un cours ou un thème que rien n'utilise : ni ressource, ni question, ni
 * objectif d'apprentissage. Une matière ou un cours emporte ses cours et ses thèmes, et reste en
 * place si l'un d'eux sert encore. Un champ personnalisé reste tant qu'une ressource porte une
 * valeur pour lui.
 */
export function supprimer(db: Db, genre: string, id: string) {
  const nom = nomEntree(db, genre, id);
  const liste = (sql: string, ...p: string[]) =>
    db
      .prepare(sql)
      .all(...p)
      .map((l) => l.id);
  transaction(db, () => {
    if (genre === "champ") {
      const n = ressourcesAvec(db, id);
      if (n) {
        throw new Error(
          `« ${nom} » est rempli sur ${n} ressource${n > 1 ? "s" : ""}. Retirez-le des matières pour le masquer.`,
        );
      }
      db.prepare("DELETE FROM champs_personnalises WHERE id = ?").run(id);
      return;
    }
    const cours =
      genre === "cours"
        ? [id]
        : genre === "matiere"
          ? liste("SELECT id FROM cours WHERE matiere_id = ?", id)
          : [];
    const themes =
      genre === "theme"
        ? [id]
        : liste(
            "SELECT id FROM themes WHERE cours_id IN (SELECT value FROM json_each(?))",
            JSON.stringify(cours),
          );
    const [m, c, t] = [genre === "matiere" ? [id] : [], cours, themes].map((l) =>
      JSON.stringify(l),
    );
    const dans = "IN (SELECT value FROM json_each(?))";
    const ressources = db
      .prepare(
        `SELECT count(*) AS n FROM (SELECT id FROM sources WHERE matiere_id ${dans}
        UNION SELECT source_id FROM source_cours WHERE cours_id ${dans} OR theme_id ${dans})`,
      )
      .get(m, c, t)!.n as number;
    const questions = db
      .prepare(
        `SELECT count(*) AS n FROM messages
       WHERE matiere_id ${dans} OR cours_id ${dans} OR theme_id ${dans}
         OR EXISTS (SELECT 1 FROM json_each(?) j WHERE instr(',' || matieres || ',', ',' || j.value || ','))`,
      )
      .get(m, c, t, m)!.n as number;
    const objectifs = db
      .prepare(`SELECT count(*) AS n FROM objectifs WHERE cours_id ${dans}`)
      .get(c)!.n as number;
    if (ressources || questions || objectifs) {
      const emplois = [
        ressources && `${ressources} ressource(s)`,
        questions && `${questions} question(s)`,
        objectifs && `${objectifs} objectif(s)`,
      ];
      throw new Error(`« ${nom} » est utilisé par ${emplois.filter(Boolean).join(" et ")}.`);
    }
    for (const [table, ids] of [
      ["themes", t],
      ["cours", c],
      ["matieres", m],
    ]) {
      db.prepare(`DELETE FROM ${table} WHERE id ${dans}`).run(ids);
    }
  });
}
// ponytail: liste en dur. `thot ingest --matiere=` et la migration 0007 la lisent encore.
export const MATIERES = [
  { value: "arts-appliques", label: "Arts appliqués" },
  { value: "histoire-geographie", label: "Histoire-géographie" },
  { value: "francais", label: "Français" },
  { value: "physique-chimie", label: "Physique-chimie" },
  { value: "mathematiques", label: "Mathématiques" },
  { value: "eps", label: "Éducation physique et sportive" },
];

/** Une source sans matière prend le profil de l'instance. */
export function domaineSource(db: Db, champs: Record<string, string>) {
  let m: Matiere | undefined;
  if (champs.matiere_id) {
    m = db.prepare("SELECT * FROM matieres WHERE id = ?").get(champs.matiere_id) as
      | Matiere
      | undefined;
    if (!m) throw new Error("Matière inconnue.");
  } else if (champs.matiere?.trim()) {
    const cle = champs.matiere.trim();
    const nom = MATIERES.find((x) => x.value === cle)?.label ?? cle;
    m = db.prepare("SELECT * FROM matieres WHERE nom = ?").get(nom) as Matiere | undefined;
    if (!m) {
      const id = matiere(
        db,
        nom,
        profilInstance(db) ?? (cle === "arts-appliques" ? "arts-appliques" : "general"),
      );
      m = db.prepare("SELECT * FROM matieres WHERE id = ?").get(id) as Matiere;
    }
  }
  return {
    matiere_id: m?.id ?? null,
    profil: m?.profil ?? profilInstance(db) ?? "general",
    langue: langueSource(champs.langue),
  };
}
/** Les cours dont le compte est membre. */
export const coursDuCompte = (db: Db, compteId: string) =>
  new Set(
    db
      .prepare("SELECT cours_id FROM membres_cours WHERE compte_id = ?")
      .all(compteId)
      .map((l) => l.cours_id as string),
  );
export const membres = (db: Db, coursId: string) =>
  db
    .prepare(
      `SELECT a.id, a.identifiant, a.nom, a.role FROM membres_cours m JOIN comptes a ON a.id = m.compte_id
     WHERE m.cours_id = ? ORDER BY a.role, a.nom`,
    )
    .all(coursId) as { id: string; identifiant: string; nom: string; role: string }[];
export function inscrire(db: Db, coursId: string, compteId: string) {
  if (!db.prepare("SELECT 1 FROM cours WHERE id = ?").get(coursId)) {
    throw new Error("Cours inconnu.");
  }
  if (!db.prepare("SELECT 1 FROM comptes WHERE id = ?").get(compteId)) {
    throw new Error("Compte inconnu.");
  }
  db.prepare("INSERT OR IGNORE INTO membres_cours VALUES (?, ?)").run(coursId, compteId);
}
export const desinscrire = (db: Db, coursId: string, compteId: string) =>
  db
    .prepare("DELETE FROM membres_cours WHERE cours_id = ? AND compte_id = ?")
    .run(coursId, compteId);

type Membre = { id: string; administrateur: number };
/** Les cours et thèmes qu'un enseignant peut choisir : les siens. Un administrateur voit tout. */
export function catalogueDe(db: Db, c: Membre): Catalogue {
  const cat = catalogue(db);
  if (c.administrateur === 1) return cat;
  const siens = coursDuCompte(db, c.id);
  return {
    ...cat,
    cours: cat.cours.filter((x) => siens.has(x.id)),
    themes: cat.themes.filter((t) => siens.has(t.cours_id)),
  };
}
/**
 * Un enseignant ne rattache une source qu'à ses propres cours. Les rattachements de la source à
 * d'autres cours restent en place, puisque son formulaire ne les montre pas.
 */
export function liensAutorises(
  db: Db,
  c: Membre,
  liens: Affiliation[],
  sourceId?: string,
): Affiliation[] {
  const siens = c.administrateur === 1 ? null : coursDuCompte(db, c.id);
  if (siens && liens.some((l) => !siens.has(l.cours_id))) {
    throw new Error("Rattachement refusé : ce cours n'est pas le vôtre.");
  }
  const actuels = sourceId
    ? (db
        .prepare("SELECT cours_id, theme_id FROM source_cours WHERE source_id = ?")
        .all(sourceId) as Affiliation[])
    : [];
  const autres = siens ? actuels.filter((l) => !siens.has(l.cours_id)) : [];
  // Sans cours, une source partagée se lirait dans toute l'instance.
  if (actuels.length && !liens.length && !autres.length) {
    throw new Error("Une ressource rattachée garde au moins un cours.");
  }
  return [...liens, ...autres];
}

export type Affiliation = { cours_id: string; theme_id: string | null };
export function affiliations(db: Db, sourceId: string, liens: Affiliation[]) {
  for (const l of liens) {
    if (
      !db.prepare("SELECT id FROM cours WHERE id = ?").get(l.cours_id) ||
      (l.theme_id &&
        !db
          .prepare("SELECT id FROM themes WHERE id = ? AND cours_id = ?")
          .get(l.theme_id, l.cours_id))
    )
      throw new Error("Cours ou thème inconnu.");
  }
  db.prepare("DELETE FROM source_cours WHERE source_id = ?").run(sourceId);
  for (const l of liens) {
    db.prepare("INSERT INTO source_cours VALUES (?, ?, ?)").run(sourceId, l.cours_id, l.theme_id);
  }
}
export function liensFormulaire(b: Record<string, unknown>): Affiliation[] {
  return [...new Set([b.cours ?? []].flat().map(String))].map((id) => ({
    cours_id: id,
    theme_id: String(b[`theme_${id}`] ?? "") || null,
  }));
}
/** Le thème de ce nom dans le cours, créé s'il manque. Sans nom, aucun thème. */
export const themeNomme = (db: Db, coursId: string, nom = "") =>
  nom
    ? ((db.prepare("SELECT id FROM themes WHERE cours_id = ? AND nom = ?").get(coursId, nom)?.id as
        | string
        | undefined) ?? theme(db, coursId, nom))
    : null;
/**
 * Le thème qui remplace un ancien chapitre, c'est-à-dire une séquence : celui où sont rangées le
 * plus de sources de cette séquence, dans un cours du compte d'abord. Vide si aucun ne convient.
 * La migration 0018 fait le même choix pour les conversations.
 */
export const themeDuChapitre = (db: Db, nom: string, compteId: string) =>
  (db
    .prepare(
      `SELECT sc.theme_id FROM source_cours sc JOIN sources s ON s.id = sc.source_id
       JOIN themes t ON t.id = sc.theme_id
     WHERE json_extract(s.metadonnees, '$.sequence') = ?
     GROUP BY sc.theme_id
     ORDER BY EXISTS (SELECT 1 FROM membres_cours m WHERE m.cours_id = t.cours_id
       AND m.compte_id = ?) DESC, count(*) DESC
     LIMIT 1`,
    )
    .get(nom, compteId)?.theme_id as string | undefined) ?? "";
/**
 * Range une source sans cours choisi dans le premier cours de sa matière, sous le thème du nom de
 * sa séquence. Seul l'import CLI remplit encore la séquence, avec le nom du dossier. L'import et un
 * administrateur créent ce cours s'il manque. Un enseignant ne range que dans ses propres cours :
 * sans cours à lui dans la matière, la source reste non classée.
 */
export function rangerLegacy(
  db: Db,
  sourceId: string,
  matiereId: string | null,
  sequence: string,
  par?: Membre,
) {
  if (!matiereId) return;
  const restreint = par && par.administrateur !== 1;
  let c = db
    .prepare(
      `SELECT id FROM cours WHERE matiere_id = ? AND (? OR id IN
      (SELECT cours_id FROM membres_cours WHERE compte_id = ?))
     ORDER BY rowid LIMIT 1`,
    )
    .get(matiereId, restreint ? 0 : 1, par?.id ?? "")?.id as string | undefined;
  if (!c && restreint) {
    // Le formulaire ne montre pas les cours des autres enseignants : leurs liens restent.
    affiliations(db, sourceId, liensAutorises(db, par, [], sourceId));
    return;
  }
  c ??= cours(
    db,
    matiereId,
    db.prepare("SELECT nom FROM matieres WHERE id = ?").get(matiereId)!.nom as string,
  );
  const lien = [{ cours_id: c, theme_id: themeNomme(db, c, sequence) }];
  affiliations(db, sourceId, par ? liensAutorises(db, par, lien, sourceId) : lien);
}

/** `matieres` : les matières d'une comparaison, identifiants triés et séparés par des virgules. */
export type Scope = { matiere_id: string; cours_id: string; theme_id: string; matieres?: string };
export const idsMatieres = (matieres = "") => matieres.split(",").filter(Boolean);
/** Les matières arrivent en cases cochées ou en liste séparée par des virgules. */
export const lireScope = (champs: Record<string, unknown>): Scope => {
  const ids = [
    ...new Set([champs.matieres ?? []].flat().flatMap((v) => idsMatieres(String(v)))),
  ].sort();
  return {
    // Une seule matière cochée n'est pas une comparaison : c'est le périmètre de cette matière.
    matiere_id: ids.length > 1 ? "" : (ids[0] ?? String(champs.matiere_id ?? "")),
    cours_id: String(champs.cours_id ?? ""),
    theme_id: String(champs.theme_id ?? ""),
    ...(ids.length > 1 && { matieres: ids.join(",") }),
  };
};
export function sourcesPerimetre(db: Db, p: Scope) {
  return new Set(
    db
      .prepare(`SELECT s.id FROM sources s WHERE ${FILTRE_DOMAINE}`)
      .all(
        parametresDomaine({
          schoolId: "",
          lecteur: null,
          matiereId: p.matiere_id,
          matieres: idsMatieres(p.matieres),
          coursId: p.cours_id,
          themeId: p.theme_id,
        }),
      )
      .map((s) => s.id as string),
  );
}

/** Un rattachement ne nomme un cours qu'à ses membres et aux administrateurs. */
export const MES_COURS =
  "($administrateur OR sc.cours_id IN (SELECT cours_id FROM membres_cours WHERE compte_id = $lecteur))";
export const mesCours = (l: Lecteur) => ({
  administrateur: l.administrateur ? 1 : 0,
  lecteur: l.id,
});
export function catalogueVisible(db: Db, l: Lecteur): Catalogue {
  const cat = catalogue(db);
  const liens = db
    .prepare(
      `SELECT sc.cours_id, sc.theme_id FROM source_cours sc JOIN sources s ON s.id = sc.source_id
    WHERE s.statut = 'certifiee' AND ${FILTRE_ACCES} AND ${MES_COURS}`,
    )
    .all({ ...parametresAcces(l), ...mesCours(l) });
  const ids = new Set(liens.map((s) => s.cours_id));
  const themes = new Set(liens.map((s) => s.theme_id));
  cat.cours = cat.cours.filter((c) => ids.has(c.id));
  cat.matieres = cat.matieres.filter((m) => cat.cours.some((c) => c.matiere_id === m.id));
  cat.themes = cat.themes.filter((t) => themes.has(t.id));
  return cat;
}

export function langueSource(valeur = "fr") {
  const langue = valeur.trim().toLowerCase() || "fr";
  if (langue.length > 30 || !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(langue)) {
    throw new Error("Code de langue invalide.");
  }
  return langue;
}
