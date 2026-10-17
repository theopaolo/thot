import { rattacher, renommerEntree, supprimerSource } from "../app/ingestion.ts";
import * as Domaines from "../app/domaines.ts";
import { type Commande, lire, texte } from "./commun.ts";

/** Inscrit ou retire un compte d'un cours, désigné par son identifiant de connexion. */
const membre = (nom: string, inscrire: boolean): Commande => ({
  aide: inscrire
    ? "  membre <cours_id> <identifiant>           inscrit un compte à un cours"
    : "  retirer-membre <cours_id> <identifiant>   retire un compte d'un cours",
  lancer(db, _, argv) {
    const { positionals: reste } = lire(argv, {});
    const [coursId, identifiant] = reste;
    if (!coursId || !identifiant || reste.length !== 2) {
      console.error(`usage: thot ${nom} <cours_id> <identifiant>`);
      process.exit(2);
    }
    const compte = db
      .prepare("SELECT id FROM comptes WHERE identifiant = ?")
      .get(identifiant.trim().toLowerCase());
    if (!compte) {
      console.error(`Compte introuvable : ${identifiant}`);
      process.exit(1);
    }
    if (inscrire) Domaines.inscrire(db, coursId, compte.id as string);
    else Domaines.desinscrire(db, coursId, compte.id as string);
  },
});

export const catalogue: Record<string, Commande> = {
  domaines: {
    aide: "  domaines                                 affiche le catalogue et le nombre de membres par cours",
    lancer(db, _, argv) {
      lire(argv, {});
      const cat = Domaines.catalogue(db);
      const cours = cat.cours.map((c) => ({ ...c, membres: Domaines.membres(db, c.id).length }));
      console.log(JSON.stringify({ ...cat, cours }, null, 2));
    },
  },
  matiere: {
    aide: "  matiere <nom> [--profil=general|arts-appliques]",
    lancer(db, _, argv) {
      const { values, positionals } = lire(argv, { profil: texte });
      console.log(Domaines.matiere(db, positionals.join(" "), values.profil));
    },
  },
  profil: {
    aide: `  profil <general|arts-appliques>           change le profil de toutes les matières,
                                            refusé si une ressource a un autre profil`,
    lancer(db, _, argv) {
      const [profil] = lire(argv, {}).positionals;
      Domaines.changerProfil(db, profil);
      console.log(`Profil de l'instance : ${profil}.`);
    },
  },
  cours: {
    aide: "  cours <matiere_id> <nom> [--niveau=...] [--objectif=...]",
    lancer(db, _, argv) {
      const { values, positionals } = lire(argv, { niveau: texte, objectif: texte });
      const [matiereId, ...nom] = positionals;
      console.log(Domaines.cours(db, matiereId, nom.join(" "), values.niveau, values.objectif));
    },
  },
  theme: {
    aide: "  theme <cours_id> <nom>                    crée un thème dans un cours",
    lancer(db, _, argv) {
      const [coursId, ...nom] = lire(argv, {}).positionals;
      console.log(Domaines.theme(db, coursId, nom.join(" ")));
    },
  },
  renommer: {
    aide: `  renommer <matiere|cours|theme> <id> <nom>
                                            garde l'identifiant et les rattachements`,
    lancer(db, _, argv) {
      const [genre, id, ...nom] = lire(argv, {}).positionals;
      renommerEntree(db, genre, id, nom.join(" "));
    },
  },
  supprimer: {
    aide: `  supprimer <matiere|cours|theme> <id>      refusé si une ressource ou une question l'utilise,
                                            emporte les cours et thèmes d'une matière
  supprimer source <source_id>              efface la source, ses fichiers et ses citations
                                            dans les réponses, sans retour possible`,
    async lancer(db, _, argv) {
      const [genre, id] = lire(argv, {}).positionals;
      if (genre === "source") {
        await supprimerSource(db, id);
        console.log(`Source ${id} supprimée.`);
      } else Domaines.supprimer(db, genre, id);
    },
  },
  rattacher: {
    aide: `  rattacher <source_id> <cours_id> [--theme-id=...]
                                            ajoute un rattachement : les membres du cours la lisent`,
    lancer(db, _, argv) {
      const { values, positionals } = lire(argv, { "theme-id": texte });
      const [sourceId, coursId] = positionals;
      const liens = db
        .prepare(
          "SELECT cours_id, theme_id FROM source_cours WHERE source_id = ? AND cours_id != ?",
        )
        .all(sourceId, coursId) as Domaines.Affiliation[];
      const lien = { cours_id: coursId, theme_id: values["theme-id"] ?? null };
      rattacher(db, sourceId, [...liens, lien]);
    },
  },
  membre: membre("membre", true),
  "retirer-membre": membre("retirer-membre", false),
};
