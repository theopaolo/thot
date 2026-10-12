import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import type { Extraction, Partie } from "./document.ts";
import { sansAccents } from "./texte.ts";
import { type Profil, PROFILS } from "./profils.ts";

const SEUIL_PAGE_MUETTE = 200;

/** Numéro de page, puce isolée, ligne d'un caractère. */
const execFileP = promisify(execFile);

const bruit = (l: string) => l.length < 2 || /^\d+\s*(sur|\/)\s*[\d!]+$/i.test(l);

export async function extrairePdf(chemin: string, profil: Profil = "general"): Promise<Extraction> {
  const linux = process.platform === "linux";
  const processus = spawn(
    linux ? "/usr/bin/prlimit" : "pdftotext",
    [...(linux ? ["--as=536870912", "--cpu=30", "--", "pdftotext"] : []), chemin, "-"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let termine = false;
  const statut = once(processus, "close").then(([code]) => {
    termine = true;
    return code as number | null;
  });
  let erreur: Error | undefined;
  const arreter = (raison: string) => {
    erreur ??= new Error(raison);
    processus.kill("SIGKILL");
  };
  const minuteur = setTimeout(() => arreter("PDF : extraction au-delà de 30 secondes."), 30_000);
  let controleEnCours: Promise<void> | undefined;
  // shortcut: macOS borne le RSS par sondage, utiliser Linux pour une limite mémoire stricte.
  const memoire = linux ? undefined : setInterval(() => {
    if (controleEnCours) return;
    controleEnCours = (async () => {
      const { stdout } = await execFileP("/bin/ps", ["-o", "rss=", "-p", String(processus.pid)], {
        timeout: 1000,
      });
      if (Number(stdout.trim()) > 512 * 1024) {
        arreter("PDF : extraction au-delà de 512 Mo de mémoire.");
      }
    })().catch(() => {
      if (!termine) arreter("PDF : contrôle de mémoire impossible.");
    })
      .finally(() => {
        controleEnCours = undefined;
      });
  }, 100);
  try {
    const decoder = new TextDecoder();
    let texte = "";
    let octets = 0;
    for await (const bloc of processus.stdout) {
      octets += bloc.byteLength;
      if (octets > 10 * 1024 * 1024) {
        arreter("PDF : texte extrait au-delà de 10 Mo.");
        break;
      }
      texte += decoder.decode(bloc, { stream: true });
    }
    const code = await statut;
    clearInterval(memoire);
    await controleEnCours;
    if (erreur) throw erreur;
    if (code !== 0) throw new Error(`pdftotext a échoué (code ${code})`);
    return decouperPdf(texte + decoder.decode(), profil);
  } finally {
    clearTimeout(minuteur);
    clearInterval(memoire);
    processus.kill("SIGKILL");
    await statut;
    await controleEnCours;
  }
}

export function decouperPdf(brut: string, profil: Profil = "general"): Extraction {
  const rubriques = new Set(PROFILS[profil].rubriques.map((r) => sansAccents(r).toLowerCase()));
  const estRubrique = (ligne: string) => rubriques.has(sansAccents(ligne).toLowerCase());
  const pages = brut.split("\f").map((p) => p.split("\n").map((l) => l.trim()));
  if (pages.length > 1 && pages.at(-1)!.every((l) => !l)) pages.pop();

  // Seules les occurrences aux bords de page peuvent être des en-têtes ou pieds de page.
  const bords = pages.map((p) => {
    const indices = p.flatMap((l, i) => l ? [i] : []);
    return new Set([indices[0], indices.at(-1)]);
  });
  const vues = new Map<string, number>();
  pages.forEach((p, i) => {
    for (const l of new Set(p.filter((_, n) => bords[i].has(n)))) {
      if (l) vues.set(l, (vues.get(l) ?? 0) + 1);
    }
  });
  const repetee = (l: string) => (vues.get(l) ?? 0) >= Math.max(2, pages.length / 2);

  const parties: Partie[] = [];
  const avertissements: string[] = [];
  let section = "Introduction";
  pages.forEach((lignes, i) => {
    const page = i + 1;
    const entete = (l: string, n: number) => bords[i].has(n) && repetee(l);
    const utiles = lignes.filter((l, n) => l && !bruit(l) && !entete(l, n));
    const n = utiles.join("").length;
    if (n < SEUIL_PAGE_MUETTE) {
      avertissements.push(`Page ${page}: ${n} caractères de texte, contenu probablement en image.`);
    }
    let paragraphe: string[] = [];
    const fermer = () => {
      if (paragraphe.length) parties.push({ texte: paragraphe.join("\n"), section, page });
      paragraphe = [];
    };
    for (const [n, l] of lignes.entries()) {
      if (!l) {
        fermer();
        continue;
      }
      if (bruit(l) || entete(l, n)) continue;
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
