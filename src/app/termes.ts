import type { Db } from "./db.ts";
import { type Formes, formes, type Genre } from "../core/accords.ts";
import { type Profil, PROFILS } from "../core/profils.ts";

// Les termes de l'instance. Ce module n'importe aucun autre module de l'application : une règle
// de `domaines/` ou d'`activites/` y lit le mot à écrire dans son message.

/** Le profil commun des matières et des ressources, absent tant que l'instance est vide. */
export const profilInstance = (db: Db) =>
  db.prepare("SELECT profil FROM matieres UNION SELECT profil FROM sources LIMIT 1").get()
    ?.profil as Profil | undefined;

/** Les termes que l'instance règle, chacun au singulier et au pluriel sauf le niveau. */
export const TERMES = [
  ["matiere", "matieres"],
  ["cours", "cours_pluriel"],
  ["niveau"],
  ["regroupement", "regroupements"],
] as const;
export type Terme = (typeof TERMES)[number][number];
/** Les deux termes qu'une phrase accorde, chacun avec le genre que l'instance lui règle. */
export const GENRES = ["matiere_genre", "cours_genre"] as const;
export type Libelles = Record<Terme, string> & {
  sousRegroupement: string;
  seance: string;
  /** la matière et le cours dans une phrase : « un cours », « cette matière » */
  formes: { matiere: Formes; cours: Formes };
};
/**
 * Les termes affichés : ceux de l'instance, sinon ceux du profil, général tant qu'elle est vide.
 * Le sous-regroupement et la séance restent ceux du profil. Un terme réglé prend le genre réglé
 * avec lui, un terme du profil garde le sien.
 */
export function libelles(db: Db): Libelles {
  const i = db
    .prepare(`SELECT ${[...TERMES.flat(), ...GENRES].join(", ")} FROM instance WHERE singleton = 1`)
    .get() as Record<Terme, string> & Record<(typeof GENRES)[number], Genre>;
  const p = PROFILS[profilInstance(db) ?? "general"];
  const termes = Object.fromEntries(TERMES.flat().map((t) => [t, i[t] || p[t]])) as Record<
    Terme,
    string
  >;
  return {
    ...termes,
    sousRegroupement: p.sousRegroupement,
    seance: p.seance,
    formes: {
      matiere: formes(
        termes.matiere,
        termes.matieres,
        i.matiere ? i.matiere_genre : p.matiere_genre,
      ),
      cours: formes(termes.cours, termes.cours_pluriel, i.cours ? i.cours_genre : p.cours_genre),
    },
  };
}
