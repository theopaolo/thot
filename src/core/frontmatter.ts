// Ce module n'importe rien : le navigateur le charge pour proposer un titre avant l'envoi
// (`src/app/client/depot.ts`), et un import de `node:` y arrêterait tout le script de la page.

/** `s` sans les `caracteres` de sa fin. Un motif fini par `$` relirait cette fin depuis chacun. */
export function rogner(s: string, caracteres: string) {
  let fin = s.length;
  while (fin && caracteres.includes(s[fin - 1])) fin--;
  return s.slice(0, fin);
}

/**
 * Front matter YAML en tête de fichier. Seuls `title` et `order` sont lus, `corps` est le reste.
 * Il se ferme dans le début du fichier, sinon le fichier n'en a pas : le navigateur lit la même
 * fenêtre, comptée en octets, pour proposer le titre avant l'envoi.
 */
export function lireFrontMatter(md: string): { titre?: string; ordre?: number; corps: string } {
  const texte = md.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = texte.match(/^---\n(?:([\s\S]{0,16384}?)\n)?---[ \t]*(?:\n|$)/);
  if (!m) return { corps: texte };
  // La valeur est rognée hors du motif : `[ \t]*$` après un groupe paresseux relirait la ligne
  // depuis chacun de ses caractères.
  const cle = (nom: string) => {
    const valeur = m[1]?.match(new RegExp(`^${nom}:(.+)$`, "m"))?.[1];
    return (
      valeur &&
      rogner(valeur, " \t")
        .replace(/^[ \t]+/, "")
        .replace(/^(["'])(.*)\1$/, "$2")
    );
  };
  const ordre = Number(cle("order"));
  return {
    titre: cle("title") || undefined,
    ordre: Number.isFinite(ordre) ? ordre : undefined,
    corps: texte.slice(m[0].length),
  };
}
