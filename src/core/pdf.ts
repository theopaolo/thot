import type { Extraction, Partie } from "./document.ts";
import { sansAccents } from "./texte.ts";

// ponytail: rubriques des fiches ATC en dur. Une matière qui écrit d'autres rubriques verra
// ses PDF découpés par paragraphe seulement. Passer la liste en configuration par matière.
const RUBRIQUES = new Set(
  [
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
  ].map((r) => sansAccents(r).toLowerCase()),
);

const SEUIL_PAGE_MUETTE = 200;

const estRubrique = (ligne: string) => RUBRIQUES.has(sansAccents(ligne).toLowerCase());

/** Numéro de page, puce isolée, ligne d'un caractère. */
const bruit = (l: string) => l.length < 2 || /^\d+\s*(sur|\/)\s*[\d!]+$/i.test(l);

export async function extrairePdf(chemin: string): Promise<Extraction> {
  const sortie = await new Deno.Command("pdftotext", { args: [chemin, "-"], stdout: "piped" })
    .output();
  if (!sortie.success) throw new Error(`pdftotext a échoué (code ${sortie.code})`);
  return decouperPdf(new TextDecoder().decode(sortie.stdout));
}

export function decouperPdf(brut: string): Extraction {
  const pages = brut.split("\f").map((p) => p.split("\n").map((l) => l.trim()));
  if (pages.length > 1 && pages.at(-1)!.every((l) => !l)) pages.pop();

  // En-têtes et pieds de page: une ligne présente sur au moins la moitié des pages.
  const vues = new Map<string, number>();
  for (const p of pages) for (const l of new Set(p)) if (l) vues.set(l, (vues.get(l) ?? 0) + 1);
  const repetee = (l: string) => pages.length > 1 && (vues.get(l) ?? 0) >= pages.length / 2;

  const parties: Partie[] = [];
  const avertissements: string[] = [];
  let section = "Introduction";
  pages.forEach((lignes, i) => {
    const page = i + 1;
    const utiles = lignes.filter((l) => l && !bruit(l) && !repetee(l));
    const n = utiles.join("").length;
    if (n < SEUIL_PAGE_MUETTE) {
      avertissements.push(`Page ${page}: ${n} caractères de texte, contenu probablement en image.`);
    }
    let paragraphe: string[] = [];
    const fermer = () => {
      if (paragraphe.length) parties.push({ texte: paragraphe.join("\n"), section, page });
      paragraphe = [];
    };
    for (const l of lignes) {
      if (!l) {
        fermer();
        continue;
      }
      if (bruit(l) || repetee(l)) continue;
      if (estRubrique(l)) {
        fermer();
        section = l;
        parties.push({ texte: l, section, page });
        continue;
      }
      // Un intertitre court sans ponctuation finale, suivi d'une majuscule, reste un bloc à part:
      // « Réaction » puis « Le Fauvisme est… » ne forment pas une phrase.
      const precedente = paragraphe.at(-1);
      if (
        paragraphe.length === 1 && precedente!.split(/\s+/).length <= 4 &&
        !/[.,;:!?)]$/.test(precedente!) && /^\p{Lu}/u.test(l)
      ) {
        fermer();
        paragraphe.push(l);
        continue;
      }
      // pdftotext coupe les lignes à la largeur de la colonne. Une puce ouvre une ligne.
      if (paragraphe.length && !/^[•·▪◦\-–]/.test(l)) paragraphe[paragraphe.length - 1] += " " + l;
      else paragraphe.push(l);
    }
    fermer();
  });
  return { parties, images: [], avertissements };
}
