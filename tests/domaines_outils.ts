import { assert } from "@std/assert";
import { connexion } from "../src/app/db.ts";
import { deposer, valider } from "../src/app/depot.ts";
import { lireInstance } from "../src/app/instance.ts";
import { revendiquer, statuer, traiter } from "../src/app/ingestion.ts";
import { fauxModeles, session } from "./outils.ts";

export async function ressource(
  db: ReturnType<typeof connexion>,
  champs: Record<string, string>,
  liens?: { cours_id: string; theme_id: string | null }[],
  texte = "La lumière traverse le prisme transparent et se décompose en couleurs visibles.",
) {
  const v = valider({ titre: "ATC Lumière", type_document: "cours", ...champs });
  assert("meta" in v);
  const { source_id } = await deposer(db, {
    meta: v.meta,
    liens,
    nomFichier: "cours.html",
    format: "html",
    schoolId: lireInstance(db).school_id,
    enseignant: "Prof original",
    audience: "eleves",
    reponses: true,
    octets: new TextEncoder().encode(
      `<html><h1>Lumière</h1><img src="data:image/jpeg;base64,/9j/wAARCAACAAIDAREAAhEAAxEA/9kA"><p>${texte}</p></html>`,
    ),
  });
  await traiter(db, revendiquer(db)!, fauxModeles().modeles);
  statuer(db, source_id, "certifiee", "Test");
  return source_id;
}

export async function administrateur(db: ReturnType<typeof connexion>) {
  const prof = await session(db, fauxModeles().modeles, "enseignant");
  db.prepare("UPDATE comptes SET administrateur = 1 WHERE role = 'enseignant'").run();
  return {
    ...prof,
    poster: (action: string, champs: Record<string, string>) =>
      prof.requete(`/administration/domaines/${action}`, {
        method: "POST",
        body: new URLSearchParams(champs),
      }),
  };
}
