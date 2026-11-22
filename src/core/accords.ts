// Les termes de matière et de cours qu'une instance règle, écrits dans une phrase. Ce module
// n'importe rien.

export type Genre = "m" | "f";

/** Un terme dans une phrase : « Matières et cours ». Un sigle garde ses capitales : « UE ». */
export const minuscule = (terme: string) =>
  /^\p{Lu}\p{Lu}/u.test(terme) ? terme : terme.charAt(0).toLocaleLowerCase("fr") + terme.slice(1);

/** La première lettre en capitale, pour ouvrir une phrase. */
export const majuscule = (texte: string) =>
  texte.charAt(0).toLocaleUpperCase("fr") + texte.slice(1);

/**
 * Les formes d'un terme : son article, son démonstratif, son possessif, et l'accord des mots qui
 * le suivent. « Cours » au masculin donne « un cours », « ce cours », « du cours ». « Unité » au
 * féminin donne « une unité », « cette unité », « de l'unité ».
 */
export function formes(singulier: string, pluriel: string, genre: Genre) {
  const nom = minuscule(singulier);
  const noms = minuscule(pluriel);
  const f = genre === "f";
  // ponytail: tout h initial élide, comme dans « l'horaire ». Un h aspiré (« le hall ») s'écrit
  // mal : ajouter un réglage si une instance en choisit un.
  const voyelle = /^[aeiouyhàâäéèêëîïôöùûüœ]/i.test(nom);
  return {
    nom,
    noms,
    un: `${f ? "une" : "un"} ${nom}`,
    le: voyelle ? `l'${nom}` : `${f ? "la" : "le"} ${nom}`,
    du: voyelle ? `de l'${nom}` : f ? `de la ${nom}` : `du ${nom}`,
    au: voyelle ? `à l'${nom}` : f ? `à la ${nom}` : `au ${nom}`,
    ce: f ? `cette ${nom}` : `${voyelle ? "cet" : "ce"} ${nom}`,
    /** après une quantité ou une négation : « pas de cours », « objectif de cours » */
    de: voyelle ? `d'${nom}` : `de ${nom}`,
    ton: `${f && !voyelle ? "ta" : "ton"} ${nom}`,
    son: `${f && !voyelle ? "sa" : "son"} ${nom}`,
    aucun: `${f ? "aucune" : "aucun"} ${nom}`,
    /** la marque d'accord d'un adjectif ou d'un participe : « créé », « créée » */
    e: f ? "e" : "",
    /** un mot qui change avec le genre : `selon("premier", "première")`, `selon("il", "elle")` */
    selon: (masculin: string, feminin: string) => (f ? feminin : masculin),
  };
}
export type Formes = ReturnType<typeof formes>;
