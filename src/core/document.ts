import { longueur } from "./texte.ts";

/** Un passage extrait, avant assemblage. */
export type Partie = { texte: string; section: string; page?: number };

export type Bloc = Partie & { id: string; debut: number; fin: number };

export type Image = { octets: Uint8Array; mime: string; extension: string };

export type Extraction = { parties: Partie[]; images: Image[]; avertissements: string[] };

export type Document = { texte: string; blocs: Bloc[] };

export type Chunk = { id: string; section: string; debut: number; fin: number; texte: string };

const SEPARATEUR = "\n\n";

/** Assemble `document.txt`. Chaque bloc vérifie `tranche(texte, debut, fin) === bloc.texte`. */
export function assembler(parties: Partie[]): Document {
  const blocs: Bloc[] = [];
  let texte = "";
  let curseur = 0;
  for (const p of parties) {
    const t = p.texte.trim();
    if (!t) continue;
    if (texte) {
      texte += SEPARATEUR;
      curseur += SEPARATEUR.length;
    }
    const n = longueur(t);
    blocs.push({ ...p, texte: t, id: `blk_${blocs.length}`, debut: curseur, fin: curseur + n });
    texte += t;
    curseur += n;
  }
  return { texte, blocs };
}

const MAX_CHUNK = 1800;

/**
 * Découpe par section et borne aussi les blocs longs. Un chunk est une
 * tranche continue de `document.txt`, ses offsets servent directement de citation.
 */
export function decouper(doc: Document): Chunk[] {
  const chunks: Chunk[] = [];
  let courant: Bloc[] = [];
  const fermer = () => {
    if (!courant.length) return;
    const debut = courant[0].debut;
    const fin = courant.at(-1)!.fin;
    const texte = courant.map((b) => b.texte).join(SEPARATEUR);
    chunks.push({ id: `chk_${chunks.length}`, section: courant[0].section, debut, fin, texte });
    courant = [];
  };
  for (const b of doc.blocs) {
    if (
      courant.length &&
      (b.section !== courant[0].section || b.fin - courant[0].debut > MAX_CHUNK)
    ) {
      fermer();
    }
    const caracteres = Array.from(b.texte);
    for (let debut = 0; debut < caracteres.length;) {
      let fin = Math.min(debut + MAX_CHUNK, caracteres.length);
      if (fin < caracteres.length) {
        let espace = fin;
        while (espace > debut && !/\s/.test(caracteres[espace - 1])) espace--;
        if (espace > debut) fin = espace;
      }
      courant.push({
        ...b,
        debut: b.debut + debut,
        fin: b.debut + fin,
        texte: caracteres.slice(debut, fin).join(""),
      });
      debut = fin;
      if (debut < caracteres.length) fermer();
    }
  }
  fermer();
  return chunks;
}
