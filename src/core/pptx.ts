import { posix } from "node:path";
import type { Extraction, Image, Partie } from "./document.ts";
import {
  type Archive,
  BORNES,
  bornerTexte,
  enfants,
  imageOffice,
  imagesEcartees,
  lireXml,
  type Noeud,
  ouvrirArchive,
  premier,
  tous,
} from "./ooxml.ts";

const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MATH = "http://schemas.openxmlformats.org/officeDocument/2006/math";

/** Les relations d'une partie : identifiant vers chemin dans l'archive. Les cibles externes sont omises. */
function relations(a: Archive, partie: string) {
  const dossier = posix.dirname(partie);
  const doc = lireXml(a, `${dossier}/_rels/${posix.basename(partie)}.rels`);
  const r = new Map<string, { cible: string; type: string }>();
  for (const el of doc ? tous(doc, "Relationship") : []) {
    const cible = el.getAttribute("Target") ?? "";
    if (el.getAttribute("TargetMode") === "External") continue;
    r.set(el.getAttribute("Id") ?? "", {
      cible: cible.startsWith("/") ? cible.slice(1) : posix.join(dossier, cible),
      type: el.getAttribute("Type") ?? "",
    });
  }
  return r;
}

/** Les diapositives dans l'ordre de la présentation : la liste `p:sldIdLst` et ses relations. */
function diapositives(a: Archive) {
  const rels = relations(a, "ppt/presentation.xml");
  const pres = lireXml(a, "ppt/presentation.xml")!;
  return tous(pres, "sldId").map((s, i) => ({
    n: i + 1,
    chemin: rels.get(s.getAttributeNS(R, "id") ?? "")?.cible,
  }));
}

/** Le texte d'un `txBody` : une ligne par paragraphe, les sauts de ligne gardés. */
const texteCorps = (corps?: Noeud) =>
  (corps ? enfants(corps, "p") : [])
    .map((p) =>
      enfants(p)
        .map((c) =>
          c.localName === "br"
            ? "\n"
            : c.localName === "r" || c.localName === "fld"
              ? (premier(c, "t")?.textContent ?? "")
              : "",
        )
        .join("")
        .replace(/[^\S\n]+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");

/** Un tableau : une ligne par rangée, cellules séparées par « | », cellules fusionnées omises. */
const texteTable = (tbl: Noeud) =>
  enfants(tbl, "tr")
    .map((tr) =>
      enfants(tr, "tc")
        .filter((tc) => !tc.getAttribute("hMerge") && !tc.getAttribute("vMerge"))
        .map((tc) => texteCorps(premier(tc, "txBody")).replace(/\n/g, " "))
        .join(" | "),
    )
    .filter((l) => l.replace(/[| ]/g, ""))
    .join("\n");

/** En-têtes, pieds de page, dates et numéros répétés par le masque : pas du contenu. */
const REPETES = new Set(["ftr", "sldNum", "dt", "hdr"]);

type Lu = { titre: string; blocs: string[]; medias: string[]; manques: Set<string> };

/**
 * Formes d'un arbre, dans l'ordre du fichier. C'est l'ordre de superposition, pas forcément
 * l'ordre de lecture visuel, sauf le titre placé en tête. Un groupe se lit à sa place.
 */
function parcourir(arbre: Noeud, rels: Map<string, { cible: string }>, lu: Lu, profondeur = 0) {
  if (profondeur > 32) throw new Error("PPTX : formes imbriquées sur plus de 32 niveaux.");
  for (const f of enfants(arbre)) {
    if (f.localName === "sp") {
      const ph = premier(f, "ph")?.getAttribute("type") ?? "";
      if (REPETES.has(ph)) continue;
      const t = texteCorps(premier(f, "txBody"));
      if ((ph === "title" || ph === "ctrTitle") && !lu.titre) lu.titre = t.replace(/\s+/g, " ");
      else if (t) lu.blocs.push(t);
    } else if (f.localName === "grpSp") parcourir(f, rels, lu, profondeur + 1);
    else if (f.localName === "graphicFrame") {
      const uri = premier(f, "graphicData")?.getAttribute("uri") ?? "";
      const tbl = premier(f, "tbl");
      if (tbl) lu.blocs.push(texteTable(tbl));
      else if (uri.endsWith("/chart")) lu.manques.add("Graphiques non extraits");
      else if (uri.endsWith("/diagram")) lu.manques.add("Diagrammes SmartArt non extraits");
      else lu.manques.add("Objets intégrés non extraits");
    } else if (f.localName === "pic") {
      const id = premier(f, "blip")?.getAttributeNS(R, "embed");
      const media = id && rels.get(id)?.cible;
      if (media) lu.medias.push(media);
    } else if (f.localName === "AlternateContent") {
      // Le choix porte la forme récente (équation, encre), le repli sa version lisible partout.
      const repli = enfants(f, "Fallback")[0];
      if (repli) parcourir(repli, rels, lu, profondeur + 1);
    }
  }
}

/**
 * Présentation PowerPoint : une section par diapositive, « Diapositive n : titre », dans l'ordre
 * de la présentation. `page` porte le numéro de diapositive. Les diapositives masquées sont
 * écartées, sauf `masquees`. Cette fonction ne lit pas les notes de l'orateur : `notesPptx` les
 * lit à la demande pour la relecture.
 */
export function extrairePptx(octets: Uint8Array, masquees = false): Extraction {
  const limite = Date.now() + BORNES.delaiMs;
  const a = ouvrirArchive(octets);
  const parties: Partie[] = [];
  const images: Image[] = [];
  const ecartees: string[] = [];
  const medias = new Set<string>();
  const cachees: number[] = [];
  const manques = new Map<string, number[]>();
  for (const { n, chemin } of diapositives(a)) {
    if (Date.now() > limite) {
      throw new Error(`PPTX : extraction au-delà de ${BORNES.delaiMs / 1000} secondes.`);
    }
    const doc = chemin && lireXml(a, chemin);
    if (!doc) {
      const m = "Diapositives absentes de l'archive";
      manques.set(m, [...(manques.get(m) ?? []), n]);
      continue;
    }
    const masquee = /^(0|false)$/.test(doc.documentElement.getAttribute("show") ?? "");
    if (masquee) cachees.push(n);
    if (masquee && !masquees) continue;
    const lu: Lu = { titre: "", blocs: [], medias: [], manques: new Set() };
    const arbre = premier(doc.documentElement, "spTree");
    if (arbre) parcourir(arbre, relations(a, chemin), lu);
    if (doc.getElementsByTagNameNS(MATH, "oMath").length) lu.manques.add("Équations non extraites");
    if (tous(doc, "videoFile").length || tous(doc, "audioFile").length) {
      lu.manques.add("Vidéos et sons non extraits");
    }
    if (tous(doc, "timing").length)
      lu.manques.add("Animations ignorées, le texte se lit en entier");
    for (const m of lu.manques) manques.set(m, [...(manques.get(m) ?? []), n]);

    const section = `Diapositive ${n}${masquee ? " (masquée)" : ""}${lu.titre ? ` : ${lu.titre}` : ""}`;
    parties.push(
      { texte: section, section, page: n },
      ...lu.blocs.map((texte) => ({ texte, section, page: n })),
    );
    // Une image répétée sur plusieurs diapositives, un logo par exemple, entre une fois.
    for (const m of lu.medias) {
      if (medias.has(m)) continue;
      medias.add(m);
      const lue = a.lire(m);
      const im = lue ? imageOffice(lue) : "image absente de l'archive";
      if (typeof im === "string") ecartees.push(`${im}, diapositive ${n}`);
      else images.push({ ...im, section });
    }
  }

  const liste = (ns: number[]) =>
    `${ns.length > 1 ? "diapositives" : "diapositive"} ${ns.join(", ")}`;
  return {
    parties: bornerTexte(parties),
    images,
    avertissements: [
      ...(cachees.length
        ? [
            `Diapositives masquées, ${masquees ? "incluses dans le" : "exclues du"} texte : ${liste(cachees)}.`,
          ]
        : []),
      ...[...manques].map(([m, ns]) => `${m} : ${liste(ns)}.`),
      ...imagesEcartees(ecartees),
    ],
  };
}

/**
 * Les notes de l'orateur, par diapositive, lues dans l'original. Elles ne vont que dans la page
 * de relecture, pas dans `document.txt`, l'index ou une réponse.
 */
export function notesPptx(octets: Uint8Array) {
  const a = ouvrirArchive(octets);
  return diapositives(a).flatMap(({ n, chemin }) => {
    const rel =
      chemin && [...relations(a, chemin).values()].find((r) => r.type.endsWith("/notesSlide"));
    const doc = rel && lireXml(a, rel.cible);
    const texte = doc
      ? tous(doc, "sp")
          .filter((sp) => premier(sp, "ph")?.getAttribute("type") === "body")
          .map((sp) => texteCorps(premier(sp, "txBody")))
          .filter(Boolean)
          .join("\n")
      : "";
    return texte ? [{ diapositive: n, texte }] : [];
  });
}
