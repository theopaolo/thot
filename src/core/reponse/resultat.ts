import type { Schema } from "../notation.ts";

export type Affirmation = {
  texte: string;
  /**
   * Le passage tel que le document l'écrit, espaces réduites, et non la copie qu'en fait le
   * modèle : le juge et l'affichage lisent la source.
   */
  citation: string;
  source_id: string;
  chunk_id: string;
  titre: string;
  image_id?: string;
  /** offsets dans `document.txt`, absents quand la citation vient d'une légende certifiée */
  debut?: number;
  fin?: number;
  /** révision citée, absente des réponses antérieures aux révisions: elles citent la révision 1 */
  revision?: number;
  /** comparaison : la ou les matières de l'extrait cité */
  matiere?: string;
};

/**
 * Un bloc range des affirmations, désignées par leur indice dans la réponse. Il n'apporte aucun
 * fait : ses titres, colonnes, lignes et noms de nœuds viennent du modèle sans preuve.
 */
export type BlocReponse =
  | { type: "paragraphe" | "liste" | "etapes"; titre?: string; affirmations: number[] }
  | {
      type: "tableau";
      titre?: string;
      colonnes: string[];
      /** une case par colonne, `null` pour une case vide */
      lignes: { titre: string; affirmations: (number | null)[] }[];
    }
  | Schema;

export type Repondue = {
  affirmations: Affirmation[];
  /** absent : un seul paragraphe, comme toute réponse antérieure aux blocs */
  blocs?: BlocReponse[];
  /** une affirmation au moins est passée sans l'avis du juge */
  juge_indisponible?: boolean;
  /** des affirmations citaient une source supprimée depuis, et ont été retirées */
  source_supprimee?: boolean;
};

export type Resultat =
  | ({
      etat: "answered";
      partielle?: boolean;
      /** comparaison : les matières où aucun passage n'a passé le seuil */
      sans_passage?: string[];
    } & Repondue)
  | { etat: "out_of_corpus"; raison: "seuil" | "refus_modele" }
  | { etat: "failed"; code: string; message: string };

export type Journal = Record<string, unknown>;
