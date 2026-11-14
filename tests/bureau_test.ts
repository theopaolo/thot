import { test } from "vite-plus/test";
import { assert, assertStringIncludes } from "@std/assert";
import { affiliations, cours, matiere, theme } from "../src/app/domaines.ts";
import { environnement, fauxModeles, publier, session } from "./outils.ts";

test("la vue Dossiers ouvre un cours puis un thème, et montre les fichiers de ce niveau", async () => {
  const { db } = await environnement();
  const c = cours(db, matiere(db, "Histoire"), "Moyen Âge");
  const t = theme(db, c, "Châteaux");
  await publier(db, "Les foires", c);
  affiliations(db, await publier(db, "Le donjon", c), [{ cours_id: c, theme_id: t }]);
  await publier(db, "Glossaire");
  const lire = async (
    requete: (chemin: string) => Response | Promise<Response>,
    chemin: string,
  ) => {
    const r = await requete(chemin);
    assert(r.ok, chemin);
    return r.text();
  };

  const prof = (await session(db, fauxModeles().modeles, "enseignant")).requete;
  const racine = await lire(prof, "/prof?vue=grille&cours_id=");
  assertStringIncludes(racine, 'Moyen Âge</span><span class="detail">2 ressources');
  assertStringIncludes(racine, "Glossaire");
  assert(!racine.includes("Le donjon") && !racine.includes("Les foires"));
  const dansCours = await lire(prof, `/prof?vue=grille&cours_id=${c}`);
  assertStringIncludes(dansCours, 'Châteaux</span><span class="detail">1 ressource');
  assertStringIncludes(dansCours, "Les foires");
  assertStringIncludes(dansCours, `href="/prof/depot?cours=${c}"`);
  assert(!dansCours.includes("Le donjon"));
  const dansTheme = await lire(prof, `/prof?vue=grille&cours_id=${c}&theme_id=${t}`);
  assertStringIncludes(dansTheme, "Le donjon");
  assert(!dansTheme.includes("Les foires"));
  // Une recherche montre les fichiers trouvés, où qu'ils soient rangés.
  assertStringIncludes(await lire(prof, "/prof?vue=grille&cours_id=&q=donjon"), "Le donjon");
  // Le rafraîchissement d'un dépôt en cours rend les mêmes fichiers.
  const lignes = await lire(prof, `/prof/lignes?vue=grille&cours_id=${c}`);
  assert(lignes.includes("Les foires") && !lignes.includes("Le donjon"));

  const eleve = (await session(db, fauxModeles().modeles, "eleve")).requete;
  assertStringIncludes(
    await lire(eleve, "/eleve?vue=grille&cours_id="),
    'Moyen Âge</span><span class="detail">2 documents',
  );
  const coursEleve = await lire(eleve, `/eleve?vue=grille&cours_id=${c}`);
  assertStringIncludes(coursEleve, `theme_id=${t}`);
  assert(coursEleve.includes("Les foires") && !coursEleve.includes("Le donjon"));
  const themeEleve = await lire(eleve, `/eleve?vue=grille&cours_id=${c}&theme_id=${t}`);
  assert(themeEleve.includes("Le donjon") && !themeEleve.includes("Les foires"));
});
