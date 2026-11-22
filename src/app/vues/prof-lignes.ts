import { html } from "hono/html";
import { type Audience, AUDIENCES } from "../depot.ts";
import { icone } from "../icones.ts";
import type { Profil } from "../../core/profils.ts";
import type { Libelles } from "../instance.ts";
import { fichier } from "./bureau.ts";
import { nombre } from "./commun.ts";

export const ETATS_JOB: Record<string, string> = {
  received: "en file",
  extracting: "extraction",
  enriching: "légendes",
  awaiting_review: "extrait",
  failed: "échec",
};
export const STATUTS: Record<string, string> = {
  a_relire: "à relire",
  certifiee: "certifiée",
  rejetee: "rejetée",
};

export type LigneSource = {
  id: string;
  titre: string;
  profil?: Profil;
  /** le nom du thème, le premier si la source en a plusieurs */
  theme: string | null;
  format: string;
  statut: string;
  etat: string;
  erreur: string | null;
  images_a_relire: number;
  revision_en_attente: number;
  images: number;
  legendes: number;
  image_id: string | null;
  audience?: Audience;
  /** 0 quand le compte lit la source sans pouvoir la modifier */
  modifiable?: number;
  /** les cours du compte qui rattachent la source, quand aucun cours n'est choisi */
  cours?: { id: string; nom: string }[];
  /** l'ordre de lecture que l'enseignant donne, `null` sans ordre */
  ordre?: number | null;
};

export const JOBS_ACTIFS = ["received", "extracting", "enriching"];

const statutLigne = (l: LigneSource) =>
  l.etat === "failed"
    ? html`<span class="statut failed">échec du traitement</span>`
    : JOBS_ACTIFS.includes(l.etat)
      ? html`<span class="statut en-cours">${ETATS_JOB[l.etat]}${
          l.etat === "enriching" && l.images ? ` ${l.legendes}/${l.images}` : ""
        }…</span>`
      : html`<span class="statut ${l.statut}">${STATUTS[l.statut] ?? l.statut}</span>`;
const versionLigne = (l: LigneSource) =>
  l.revision_en_attente ? html`<span class="statut a_relire">Nouvelle version à relire</span>` : "";
// Seul l'écart à la publication aux élèves est signalé.
const lecteursLigne = (l: LigneSource) =>
  l.audience && l.audience !== "eleves"
    ? html`<small>${AUDIENCES.find((a) => a.value === l.audience)?.label}</small>`
    : "";

const nonRelues = (n: number) => (n ? `${n} non relue${n > 1 ? "s" : ""}` : "");

const apercu = (l: LigneSource) =>
  html`<span class="passe-partout">${
    l.image_id
      ? html`<img src="/media/${l.image_id}" alt="" loading="lazy">`
      : html`<span class="sans-image">${icone("file-text")}</span>`
  }</span>`;

/** `suffixe` distingue la case d'une ressource qui revient dans un second cours. */
const caseSource = (l: LigneSource, classe = "", suffixe = "") =>
  html`
    <input id="selection-${l.id}${suffixe}" hx-preserve class="${classe}" type="checkbox" name="ids"
      value="${l.id}" ${l.modifiable === 0 ? "disabled" : ""}
      aria-label="Sélectionner ${l.titre}">
  `;

/** Une ressource ne signale que l'écart : « certifiée » sur chaque ressource ne dirait rien. */
const enEcart = (l: LigneSource) =>
  l.etat === "failed" || JOBS_ACTIFS.includes(l.etat) || l.statut !== "certifiee";

const carte = (l: LigneSource) => {
  const ecart = enEcart(l);
  return fichier({
    href: `/prof/sources/${l.id}`,
    titre: l.titre,
    format: l.format,
    image_id: l.image_id,
    classe: `carte ${l.statut === "rejetee" ? "rejetee" : ""}`,
    avant: caseSource(l, "carte-case"),
    apres:
      ecart || l.images_a_relire || l.revision_en_attente
        ? html`<p class="carte-etat">${ecart ? statutLigne(l) : ""}${versionLigne(l)}${
            l.images_a_relire
              ? html`<span class="statut unreviewed">${l.images_a_relire} légende${
                  l.images_a_relire > 1 ? "s" : ""
                } non relue${l.images_a_relire > 1 ? "s" : ""}</span>`
              : ""
          }</p>`
        : "",
  });
};

type Groupe = { cle: string; nom: string; coursId?: string; liste: LigneSource[] };

/**
 * Les ressources par cours, ou par thème quand un cours est choisi ou qu'elles tiennent toutes dans
 * un seul cours, chaque groupe dans l'ordre de lecture. Une ressource rattachée à deux cours
 * revient dans les deux.
 */
const grouper = (lignes: LigneSource[], noms: Pick<Libelles, "cours" | "regroupement">) => {
  // Un seul pli de cours ne rangerait rien : ses thèmes prennent sa place.
  const parCours =
    new Set(lignes.flatMap((l) => (l.cours?.length ? l.cours.map((c) => c.id) : [""]))).size > 1;
  const groupes = new Map<string, Groupe>();
  for (const l of lignes) {
    const cles = parCours
      ? l.cours?.length
        ? l.cours.map((c) => ({ cle: c.id, nom: c.nom, coursId: c.id }))
        : [{ cle: "", nom: `Sans ${noms.cours.toLowerCase()}` }]
      : [{ cle: l.theme ?? "", nom: l.theme ?? `Sans ${noms.regroupement.toLowerCase()}` }];
    for (const { cle, ...g } of cles) {
      if (!groupes.has(cle)) groupes.set(cle, { cle, ...g, liste: [] });
      groupes.get(cle)!.liste.push(l);
    }
  }
  const lecture = (a: LigneSource, b: LigneSource) =>
    (a.ordre ?? Infinity) - (b.ordre ?? Infinity) || a.titre.localeCompare(b.titre, "fr");
  return [...groupes.values()]
    .map((g) => ({ ...g, liste: g.liste.toSorted(lecture) }))
    .toSorted((a, b) => Number(!a.cle) - Number(!b.cle) || a.nom.localeCompare(b.nom, "fr"));
};

/**
 * Ce qui reste à faire dans un groupe, en mots, et rien quand tout est certifié. Les légendes non
 * relues se signalent sans ouvrir le pli : elles se relisent dans leur page.
 */
const etatGroupe = (liste: LigneSource[]) => {
  const n = (garde: (l: LigneSource) => boolean) => liste.filter(garde).length;
  const traitee = (l: LigneSource) => !JOBS_ACTIFS.includes(l.etat) && l.etat !== "failed";
  const legendes = liste.reduce((t, l) => t + l.images_a_relire, 0);
  const ecarts = [
    [n((l) => JOBS_ACTIFS.includes(l.etat)), "en-cours", "en cours", "en cours"],
    [n((l) => l.etat === "failed"), "failed", "en échec", "en échec"],
    [
      n((l) => traitee(l) && (l.statut === "a_relire" || !!l.revision_en_attente)),
      "a_relire",
      "à relire",
      "à relire",
    ],
    [n((l) => traitee(l) && l.statut === "rejetee"), "rejetee", "rejetée", "rejetées"],
    [legendes, "unreviewed", "légende non relue", "légendes non relues"],
  ] as const;
  const faits = ecarts.filter(([k]) => k > 0);
  return {
    aFaire: faits.some(([, classe]) => classe !== "unreviewed"),
    html: faits.map(
      ([k, classe, un, plusieurs]) =>
        html`<span class="statut ${classe}">${k} ${k > 1 ? plusieurs : un}</span>`,
    ),
  };
};

const ecartLigne = (l: LigneSource) =>
  html`<span class="pli-etat">${enEcart(l) ? statutLigne(l) : ""}${versionLigne(l)}${lecteursLigne(l)}${
    l.images_a_relire
      ? html`<span class="statut unreviewed">${nonRelues(l.images_a_relire)}</span>`
      : ""
  }</span>`;

/**
 * La vue « Liste » : un pli par groupe, fermé tant qu'il n'a rien à relire, si bien que tous les
 * cours tiennent sur un écran. Un filtre ouvre tous les plis. Un seul groupe sans nom s'affiche
 * à plat. Le libellé autour de la case lui donne une cible de 36px sans grossir la ligne.
 */
const plis = (
  lignes: LigneSource[],
  requete: string,
  noms: Pick<Libelles, "cours" | "regroupement"> & Partial<Pick<Libelles, "formes">>,
) => {
  const ce = noms.formes?.cours.ce ?? "ce cours";
  const groupes = grouper(lignes, noms);
  const p = new URLSearchParams(requete);
  const filtre = ["q", "statut", "theme", "lot"].some((k) => p.get(k));
  const vues = new Set<string>();
  const liste = (g: Groupe, i: number) => {
    // Le cours d'un carnet s'ouvre sur son introduction, d'ordre 0 : elle garde ce numéro.
    const premier = g.liste[0].ordre === 0 ? 0 : 1;
    return html`<ol class="pli-liste">${g.liste.map((l, k) => {
      const suffixe = vues.has(l.id) ? `-${i}` : "";
      vues.add(l.id);
      return html`<li><label class="pli-case">${caseSource(l, "", suffixe)}</label><span class="rang" aria-hidden="true">${
        premier + k
      }</span>${l.image_id ? apercu(l) : ""}<a href="/prof/sources/${l.id}">${l.titre}</a>${ecartLigne(l)}</li>`;
    })}</ol>`;
  };
  if (groupes.length === 1 && !groupes[0].cle) {
    return html`<div class="pli-seul">${liste(groupes[0], 0)}</div>`;
  }
  return groupes.map((g, i) => {
    const etat = etatGroupe(g.liste);
    const ouvert = filtre || groupes.length === 1 || etat.aFaire;
    return html`<details class="pli" data-pli="${g.cle}" ${ouvert ? "open" : ""}>
      <summary><span class="pli-nom">${g.nom}</span><span class="nombre">${nombre(
        g.liste.length,
        "ressource",
      )}</span>${etat.html}</summary>
      <div class="pli-corps">${liste(g, i)}${
        g.coursId
          ? html`<p class="pli-pied"><a href="/prof?cours_id=${g.coursId}">Ne montrer que ${ce}</a><a
              href="/prof/depot?cours=${g.coursId}">Déposer dans ${ce}</a></p>`
          : ""
      }</div>
    </details>`;
  });
};

/** `coursId` ouvre la vue « Dossiers » sur ce cours : elle finit par « Déposer ici ». */
export const lignesSources = (
  lignes: LigneSource[],
  requete: string,
  grille = false,
  coursId = "",
  noms: Pick<Libelles, "cours" | "regroupement"> & Partial<Pick<Libelles, "formes">> = {
    cours: "cours",
    regroupement: "thème",
  },
) => {
  const actifs = lignes.some((l) => JOBS_ACTIFS.includes(l.etat));
  const rafraichir = actifs
    ? html`
      hx-get="/prof/lignes?${requete}" hx-trigger="every 3s" hx-swap="outerHTML"
    `
    : "";
  if (grille) {
    return html`<ul id="lignes" class="bureau" ${rafraichir}>${lignes.map(carte)}${
      coursId
        ? html`<li class="dossier deposer"><a href="/prof/depot?cours=${coursId}"><span
            class="pictogramme">${icone("upload-simple")}</span><span class="nom"
            >Déposer ici</span></a></li>`
        : ""
    }</ul>`;
  }
  return html`<div id="lignes" class="plis" ${rafraichir}>${plis(lignes, requete, noms)}</div>`;
};
