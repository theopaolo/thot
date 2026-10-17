import {
  creerAdministrateur,
  creerCompte,
  reinitialiserMotDePasse,
  type Role,
} from "../app/comptes.ts";
import { configurerInstance, traitements } from "../app/instance.ts";
import { type Commande, lire, texte } from "./commun.ts";

export const comptes: Record<string, Commande> = {
  // L'entrée de la CLI applique les migrations avant toute commande.
  migrer: {
    aide: "  migrer                                    applique les migrations",
    lancer: (_db, _, argv) => lire(argv, {}),
  },
  instance: {
    aide: `  instance [--nom="Nom affiché"] [--mode=shared|personal]
                                            configure l'instance et affiche les services autorisés`,
    lancer(db, _, argv) {
      const { values } = lire(argv, { nom: texte, mode: texte });
      const instance = configurerInstance(db, values.nom, values.mode);
      console.log(JSON.stringify({ ...instance, traitements: traitements() }, null, 2));
    },
  },
  administrateur: {
    aide: "  administrateur <identifiant> <nom>        provisionne l'administrateur, code à usage unique",
    async lancer(db, _, argv) {
      const reste = lire(argv, {}).positionals;
      if (reste.length !== 2) throw new Error("usage: thot administrateur <identifiant> <nom>");
      console.log(
        `Code provisoire de ${reste[0]}: ${await creerAdministrateur(db, reste[0], reste[1])}`,
      );
      console.log(
        "À utiliser une seule fois pour choisir un mot de passe. Récupération : thot reinitialiser.",
      );
    },
  },
  compte: {
    aide: `  compte <identifiant> <nom> <enseignant|eleve> [--cours=<id>]...
                                            crée un compte, l'inscrit aux cours, affiche son
                                            mot de passe`,
    async lancer(db, _, argv) {
      const { values, positionals } = lire(argv, { cours: { type: "string", multiple: true } });
      const [identifiant, nom, role] = positionals;
      if (!identifiant || !nom || !["enseignant", "eleve"].includes(role)) {
        console.error(
          "usage: thot compte <identifiant> <nom> <enseignant|eleve> [--cours=<id>]...",
        );
        process.exit(2);
      }
      const motDePasse = await creerCompte(db, identifiant, nom, role as Role, values.cours);
      console.log(`Mot de passe de ${identifiant}: ${motDePasse}`);
    },
  },
  reinitialiser: {
    aide: "  reinitialiser <identifiant>               renouvelle le mot de passe enseignant",
    async lancer(db, _, argv) {
      const reste = lire(argv, {}).positionals;
      const identifiant = reste[0]?.trim().toLowerCase();
      if (!identifiant || reste.length !== 1) {
        console.error("usage: thot reinitialiser <identifiant enseignant>");
        process.exit(2);
      }
      const compte = db
        .prepare("SELECT id FROM comptes WHERE identifiant = ? AND role = 'enseignant'")
        .get(identifiant);
      if (!compte) {
        console.error(`Compte enseignant introuvable : ${identifiant}`);
        process.exit(1);
      }
      const motDePasse = await reinitialiserMotDePasse(db, compte.id as string, "enseignant");
      console.log(`Nouveau mot de passe de ${identifiant}: ${motDePasse}`);
    },
  },
};
