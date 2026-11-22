import { type Lien, LIENS } from "../notation.ts";
import type { Candidat, ChunkIndexe } from "../recherche.ts";
import { tranche, trouver } from "../texte.ts";
import type { Affirmation, BlocReponse, Repondue } from "./resultat.ts";

// Le profil général répond plus long et peut ranger ses affirmations en blocs (`ranger`).
export const MAX_AFFIRMATIONS = 8;
export const MAX_MOTS = 250;
export const MAX_BLOCS = 4;
const MAX_COLONNES = 4;
const MAX_TITRE = 60;
const MAX_NOEUDS = 8;

// Le modèle peut rendre n'importe quelle forme: chaque champ est vérifié avant usage.
type Brute = { refus?: unknown; affirmations?: unknown; blocs?: unknown };
type BruteAffirmation = { texte?: unknown; extrait?: unknown; citation?: unknown } | null;
type BruteBloc = Record<string, unknown> | null;

const chaine = (x: unknown) => (typeof x === "string" ? x.trim() : "");

/** Le premier objet JSON de la sortie du modèle, sans le texte autour. */
export function lire(sortie: string): Brute | null {
  const debut = sortie.indexOf("{");
  const fin = sortie.lastIndexOf("}");
  if (debut < 0 || fin < debut) return null;
  try {
    return JSON.parse(sortie.slice(debut, fin + 1));
  } catch {
    return null;
  }
}

/**
 * Contrôles déterministes: chaque citation existe mot pour mot, d'un seul tenant, dans l'extrait
 * qu'elle désigne. `verifier` ne lit pas les affirmations au-delà de `MAX_AFFIRMATIONS`.
 */
export function verifier(
  brute: Brute | null,
  retenus: (ChunkIndexe & Pick<Candidat, "matieres">)[],
) {
  const erreurs: string[] = [];
  // Suit la liste du modèle, que ses blocs désignent par rang : une affirmation refusée y laisse
  // un trou.
  const parRang: (Affirmation | undefined)[] = [];
  if (!brute) return { erreurs: ["La sortie n'est pas un objet JSON."], affirmations: [], parRang };
  if (brute.refus) return { erreurs, affirmations: [], parRang, refus: true };
  const liste: BruteAffirmation[] = Array.isArray(brute.affirmations)
    ? brute.affirmations.slice(0, MAX_AFFIRMATIONS)
    : [];
  if (!liste.length) erreurs.push("Aucune affirmation.");
  parRang.length = liste.length;
  liste.forEach((a, i) => {
    const c = retenus[Number(a?.extrait) - 1];
    const texte = chaine(a?.texte);
    const citation = chaine(a?.citation);
    if (!texte) return erreurs.push(`Affirmation ${i + 1}: texte vide.`);
    if (!c) return erreurs.push(`Affirmation ${i + 1}: l'extrait ${a?.extrait} n'existe pas.`);
    if (citation.split(/\s+/).length < 3) {
      return erreurs.push(`Affirmation ${i + 1}: citation trop courte.`);
    }
    const base = {
      texte,
      source_id: c.source_id,
      chunk_id: c.id,
      revision: c.revision,
      ...(c.matieres && { matiere: c.matieres.join(", ") }),
    };
    const lu = (t: string, [a, b]: [number, number]) => tranche(t, a, b).replace(/\s+/g, " ");
    const dansTexte = trouver(c.texte, citation);
    const dansPreuve = dansTexte ? null : trouver(c.preuve, citation);
    if (dansTexte) {
      parRang[i] = {
        ...base,
        citation: lu(c.texte, dansTexte),
        titre: c.titre,
        debut: c.debut + dansTexte[0],
        fin: c.debut + dansTexte[1],
      };
    } else if (dansPreuve) {
      parRang[i] = { ...base, citation: lu(c.preuve, dansPreuve), titre: c.titre };
    } else {
      erreurs.push(
        `Affirmation ${
          i + 1
        }: la citation n'apparaît pas mot pour mot dans l'extrait ${a?.extrait}.`,
      );
    }
  });
  return { erreurs, affirmations: parRang.filter((a) => a !== undefined), parRang, refus: false };
}

/**
 * Range les affirmations retenues dans les blocs du modèle, dans l'ordre de lecture : les
 * numéros des citations suivent cet ordre. Une affirmation refusée quitte son bloc, un bloc vide
 * disparaît, une affirmation qu'aucun bloc ne range finit dans un dernier paragraphe. Une
 * structure invalide donne un seul paragraphe.
 */
export function ranger(brutes: unknown, parRang: (Affirmation | undefined)[]): Repondue {
  const plat = { affirmations: parRang.filter((a) => a !== undefined) };
  if (!Array.isArray(brutes) || !brutes.length || brutes.length > MAX_BLOCS) return plat;
  const invalide = (): never => {
    throw new Error("structure invalide");
  };
  const titre = (x: unknown, requis = false) => {
    const t = chaine(x);
    return (requis && !t) || t.length > MAX_TITRE ? invalide() : t;
  };
  const liste = (x: unknown) => (Array.isArray(x) ? (x as unknown[]) : invalide());
  const affirmations: Affirmation[] = [];
  const vus = new Set<number>();
  // Un rang désigne une affirmation du modèle, une seule fois. Il devient son indice dans la
  // réponse, ou `null` si elle a été refusée.
  const placer = (x: unknown) => {
    const n = Number.isInteger(x) ? (x as number) : 0;
    if (n < 1 || n > parRang.length || vus.has(n)) invalide();
    vus.add(n);
    const a = parRang[n - 1];
    return a ? affirmations.push(a) - 1 : null;
  };
  try {
    const blocs = (brutes as BruteBloc[]).flatMap((b): BlocReponse[] => {
      const t = titre(b?.titre);
      const avecTitre = t ? { titre: t } : {};
      const type = b?.type;
      if (type === "tableau") {
        const colonnes = liste(b?.colonnes).map((c) => titre(c, true));
        if (!colonnes.length || colonnes.length > MAX_COLONNES) invalide();
        const lignes = liste(b?.lignes)
          .map((l) => {
            const cases = liste((l as BruteBloc)?.affirmations);
            if (cases.length > colonnes.length) invalide();
            return {
              titre: titre((l as BruteBloc)?.titre, true),
              affirmations: cases.map((x) => (x === null ? null : placer(x))),
            };
          })
          .filter((l) => l.affirmations.some((n) => n !== null));
        return lignes.length ? [{ type, ...avecTitre, colonnes, lignes }] : [];
      }
      if (type === "schema") {
        const brutsNoeuds = liste(b?.noeuds);
        const brutesRelations = liste(b?.relations);
        if (brutsNoeuds.length < 2 || brutsNoeuds.length > MAX_NOEUDS) invalide();
        if (!brutesRelations.length || brutesRelations.length > MAX_AFFIRMATIONS) invalide();
        // Les preuves des nœuds se placent avant celles des relations : le texte les lit ainsi.
        // Un nœud qui reprend la preuve d'une de ses relations la laisse à la relation et n'est
        // plus qu'un nom. Le modèle le fait quand la question porte sur des liens.
        const deRelations = new Set(brutesRelations.map((r) => (r as BruteBloc)?.affirmation));
        const noeuds = brutsNoeuds.map((x) => {
          const n = x as BruteBloc;
          const nom = n?.affirmation == null || deRelations.has(n.affirmation);
          return { titre: titre(n?.titre, true), affirmation: nom ? null : placer(n.affirmation) };
        });
        const noeud = (x: unknown) =>
          Number.isInteger(x) && (x as number) >= 1 && (x as number) <= noeuds.length
            ? (x as number) - 1
            : invalide();
        const relations = brutesRelations.flatMap((x) => {
          const r = x as BruteBloc;
          const [de, vers, lien] = [noeud(r?.de), noeud(r?.vers), r?.lien];
          if (de === vers || typeof lien !== "string" || !Object.hasOwn(LIENS, lien)) invalide();
          const affirmation = placer(r?.affirmation);
          return affirmation === null ? [] : [{ de, vers, lien: lien as Lien, affirmation }];
        });
        // Un nœud sans preuve retenue ni relation retenue disparaît.
        const gardes = noeuds.flatMap((n, i) =>
          n.affirmation !== null || relations.some((r) => r.de === i || r.vers === i) ? [i] : [],
        );
        if (!gardes.length) return [];
        return [
          {
            type,
            ...avecTitre,
            noeuds: gardes.map((i) => {
              const n = noeuds[i];
              return n.affirmation === null
                ? { titre: n.titre }
                : { titre: n.titre, affirmation: n.affirmation };
            }),
            relations: relations.map((r) => ({
              ...r,
              de: gardes.indexOf(r.de),
              vers: gardes.indexOf(r.vers),
            })),
          },
        ];
      }
      if (type !== "paragraphe" && type !== "liste" && type !== "etapes") return invalide();
      const indices = liste(b?.affirmations)
        .map(placer)
        .filter((n) => n !== null);
      return indices.length ? [{ type, ...avecTitre, affirmations: indices }] : [];
    });
    const reste = plat.affirmations.filter((a) => !affirmations.includes(a));
    if (reste.length) {
      blocs.push({ type: "paragraphe", affirmations: reste.map((a) => affirmations.push(a) - 1) });
    }
    return { affirmations, blocs };
  } catch {
    return plat;
  }
}
