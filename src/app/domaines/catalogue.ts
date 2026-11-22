import { type Profil, PROFILS } from "../../core/profils.ts";
import { FILTRE_ACCES, type Lecteur, parametresAcces, transaction } from "../../core/recherche.ts";
import type { Db } from "../db.ts";
import { nomChamp, ressourcesAvec, texte } from "./champs.ts";
import { coursDuCompte, type Membre, MES_COURS, mesCours } from "./membres.ts";

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

export function cours(db: Db, matiereId: string, nom: string, publicCible = "", objectif = "") {
  const id = crypto.randomUUID();
  if (publicCible.trim().length > 200 || objectif.trim().length > 4000) {
    throw new Error("Public ou objectif trop long.");
  }
  if (!db.prepare("SELECT 1 FROM matieres WHERE id = ?").get(matiereId)) {
    throw new Error("Matière inconnue.");
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
/**
 * Le cours que le dépôt crée, dans une matière existante ou créée avec lui. Un dépôt web envoie
 * une requête par fichier : la suivante retrouve la matière et le cours du même nom.
 */
export function coursDuDepot(
  db: Db,
  compte: { administrateur: number },
  v: {
    nouveau_matiere?: string;
    nouvelle_matiere?: string;
    nouveau_cours?: string;
    profil?: string;
  },
) {
  if (compte.administrateur !== 1) throw new Error("Seul un administrateur crée un cours.");
  const nomCours = (v.nouveau_cours ?? "").trim();
  if (!nomCours) throw new Error("Nommez le cours à créer.");
  return transaction(db, () => {
    let matiereId = v.nouveau_matiere ?? "";
    if (matiereId === "nouvelle") {
      const nom = (v.nouvelle_matiere ?? "").trim();
      if (!nom) throw new Error("Nommez la matière à créer.");
      matiereId =
        (db.prepare("SELECT id FROM matieres WHERE nom = ?").get(nom)?.id as string) ??
        matiere(db, nom, v.profil || undefined);
    } else if (!db.prepare("SELECT 1 FROM matieres WHERE id = ?").get(matiereId)) {
      throw new Error("Matière inconnue.");
    }
    return (
      (db.prepare("SELECT id FROM cours WHERE matiere_id = ? AND nom = ?").get(matiereId, nomCours)
        ?.id as string) ?? cours(db, matiereId, nomCours)
    );
  });
}
export const matiereDuCours = (db: Db, coursId: string) =>
  db.prepare("SELECT matiere_id FROM cours WHERE id = ?").get(coursId)?.matiere_id as
    | string
    | undefined;
export const coursDuTheme = (db: Db, themeId: string) =>
  db.prepare("SELECT cours_id FROM themes WHERE id = ?").get(themeId)?.cours_id as
    | string
    | undefined;
export function theme(db: Db, coursId: string, nom: string) {
  const id = crypto.randomUUID();
  const n = texte(nom);
  try {
    db.prepare("INSERT INTO themes VALUES (?, ?, ?)").run(id, coursId, n);
  } catch (e) {
    if (!(e as Error).message.includes("UNIQUE")) throw e;
    throw new Error(`« ${n} » existe déjà.`);
  }
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
