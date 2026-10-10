export type Profil = "general" | "arts-appliques";

export const PROFILS = {
  general: {
    nom: "Général",
    public: "Niveau",
    theme: "Thème",
    rubriques: [],
    informations: [
      "auteur",
      "version",
      "juridiction",
      "date_evenement",
      "date_publication",
      "valide_du",
      "valide_au",
    ],
    activites: ["explication"],
  },
  "arts-appliques": {
    nom: "Arts appliqués",
    public: "Classe",
    theme: "Séquence",
    rubriques: [
      "Ou et Quand ?",
      "Quoi ?",
      "Qui ?",
      "Pourquoi ?",
      "Comment ?",
      "Sujet (Themes)",
      "Sujet (genres)",
      "Retombees",
      "Conclusion",
      "Sources",
      "Influences formelles",
      "Pour resumer :",
    ],
    informations: ["date", "artiste", "mouvement"],
    activites: ["explication", "quiz-oeuvre"],
  },
} as const;

export const CHAMPS = {
  auteur: { label: "Auteur", type: "text" },
  version: { label: "Version de la source", type: "text" },
  juridiction: { label: "Juridiction", type: "text" },
  date_evenement: { label: "Date de l’événement", type: "date" },
  date_publication: { label: "Date de publication", type: "date" },
  valide_du: { label: "Applicable du", type: "date" },
  valide_au: { label: "Applicable au", type: "date" },
  date: { label: "Date de l’œuvre", type: "text" },
  artiste: { label: "Artiste", type: "tags" },
  mouvement: { label: "Mouvement", type: "tags" },
} as const;

export function validerInformations(champs: Record<string, string>, profil: Profil) {
  const meta: Record<string, string> = {};
  for (const nom of PROFILS[profil].informations) {
    const valeur = (champs[nom] ?? "").trim();
    if (valeur.length > 120) throw new Error(`${CHAMPS[nom].label} : 120 caractères maximum.`);
    if (
      CHAMPS[nom].type === "date" && valeur &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(valeur) ||
        new Date(valeur).toISOString().slice(0, 10) !== valeur)
    ) {
      throw new Error(`${CHAMPS[nom].label} : date invalide.`);
    }
    meta[nom] = valeur;
  }
  if (meta.valide_du && meta.valide_au && meta.valide_du > meta.valide_au) {
    throw new Error("La fin de validité précède son début.");
  }
  return meta;
}
