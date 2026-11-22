import { html } from "hono/html";
import { icone } from "../icones.ts";
import type { Profil } from "../../core/profils.ts";
import { idsMatieres, type Scope } from "../domaines.ts";
import { type Activite, type Avancement, couvre } from "../activites.ts";
import { champsScope } from "./perimetre.ts";
import { type Etape, dossier, fichier, fil } from "./bureau.ts";
import {
  type ChapitreVue,
  idee,
  lienTheme,
  nomChapitre,
  type SourceChapitre,
} from "./eleve-commun.ts";

/** Le mot accordé au nombre, sans le nombre. */
const accord = (n: number, mot: string) => `${mot}${n > 1 ? "s" : ""}`;
const statutActivite = (a: ActiviteListee) =>
  a.avancement
    ? html`<span class="statut ${AVANCEMENTS[a.avancement][1]}">${AVANCEMENTS[a.avancement][0]}</span>`
    : "";
const avancee = (lus: number, total: number) =>
  html`<progress max="${total}" value="${lus}" aria-hidden="true"></progress>`;

/**
 * Les ressources de l'élève dans la vue liste. À la racine, ses cours, chacun avec sa progression,
 * puis les ressources hors cours. Dans un cours ou un thème, son sommaire.
 */
export const sommaireEleve = (
  chapitres: ChapitreVue[],
  activites: ActiviteCitante[],
  p: Scope,
  lues: Set<string>,
) => {
  if (p.cours_id || p.theme_id) {
    const choisis = chapitres.filter((ch) =>
      p.theme_id ? ch.themeId === p.theme_id : ch.coursId === p.cours_id,
    );
    return sommaireCours(
      choisis,
      activites.filter((a) => a.cours_id === choisis[0]?.coursId),
      Boolean(p.theme_id),
      lues,
    );
  }
  const matieres = p.matieres ? idsMatieres(p.matieres) : p.matiere_id ? [p.matiere_id] : [];
  const cours = [
    ...Map.groupBy(
      chapitres.filter(
        (ch) => ch.coursId && (!matieres.length || matieres.includes(ch.matiereId ?? "")),
      ),
      (ch) => ch.coursId,
    ).values(),
  ];
  const autres = chapitres.filter((ch) => !ch.coursId).flatMap((ch) => ch.sources);
  return html`${
    cours.length
      ? html`<ul class="liste-cours">${cours.map((liste) => {
          const ids = new Set(liste.flatMap((ch) => ch.sources.map((s) => s.id)));
          const total = ids.size;
          const lus = [...ids].filter((id) => lues.has(id)).length;
          const aFaire = activites.filter(
            (a) => a.cours_id === liste[0].coursId && a.avancement === "a_faire",
          ).length;
          return html`<li>
            <a href="/eleve?cours_id=${liste[0].coursId}">${liste[0].cours}</a>
            <span class="discret"><span class="chiffres">${total}</span> ${accord(
              total,
              "chapitre",
            )}</span>
            ${
              lus
                ? html`<span class="lus"><span class="chiffres">${lus} sur ${total}</span>${avancee(
                    lus,
                    total,
                  )}</span>`
                : ""
            }
            ${aFaire ? html`<span class="statut nouvelle"><span class="chiffres">${aFaire}</span> à faire</span>` : ""}
          </li>`;
        })}</ul>`
      : ""
  }${
    autres.length
      ? html`<h2>Autres documents</h2>
        <ul>${autres.map((s) => html`<li><a href="/eleve/sources/${s.id}">${s.titre}</a></li>`)}</ul>`
      : ""
  }`;
};

/**
 * Le sommaire d'un cours, ou d'un de ses thèmes : les ressources numérotées dans l'ordre de
 * lecture, les ressources sans thème en tête, puis un groupe par thème. Chaque activité suit la
 * dernière ressource qu'elle cite.
 */
const sommaireCours = (
  chapitres: ChapitreVue[],
  activites: ActiviteCitante[],
  dansTheme: boolean,
  lues: Set<string>,
) => {
  // Un thème qui porte le nom de son cours, souvent celui d'un dossier importé, reste à plat.
  const enGroupe = (ch: ChapitreVue) => !dansTheme && ch.themeId && ch.nom !== ch.cours;
  const groupes = [
    ...Map.groupBy(
      chapitres.toSorted((a, b) => Number(enGroupe(a)) - Number(enGroupe(b))),
      (ch) => (enGroupe(ch) ? ch.themeId : ""),
    ).values(),
  ].map((liste) => ({
    nom: enGroupe(liste[0]) ? liste[0].nom : "",
    sources: liste.flatMap((ch) => ch.sources),
  }));
  const rangs = groupes.flatMap((g) => g.sources);
  if (!rangs.length) return "";
  const lu = (s: SourceChapitre) => lues.has(s.id);
  // Le cours d'un carnet s'ouvre sur son introduction, d'ordre 0 : elle garde ce numéro.
  const premier = rangs[0].ordre === 0 ? 0 : 1;
  const premierLu = rangs.findIndex(lu);
  const ici =
    premierLu < 0
      ? 0
      : [rangs.findIndex((s, i) => i > premierLu && !lu(s)), rangs.findIndex((s) => !lu(s))].find(
          (i) => i >= 0,
        );
  const places = Map.groupBy(activites, (a) => rangs.findLastIndex((s) => couvre(a, s.id)));
  const activite = (a: ActiviteCitante) => {
    const n =
      a.type === "explication"
        ? 0
        : (JSON.parse(a.contenu) as { questions: unknown[] }).questions.length;
    return html`<li class="activite"><span class="numero">${icone("exam")}</span><a href="/eleve/activites/${a.id}">${a.titre}</a><span class="discret">${
      a.type === "explication"
        ? "Explication"
        : html`<span class="chiffres">${n}</span> ${accord(n, "question")}`
    }</span>${statutActivite(a)}</li>`;
  };
  const ligne = (s: SourceChapitre) => {
    const i = rangs.indexOf(s);
    return html`<li class="${lu(s) ? "lu" : i === ici ? "ici" : ""}"><span class="numero chiffres">${
      premier + i
    }</span><a href="/eleve/sources/${s.id}">${s.titre}</a>${
      lu(s) ? html`<span class="visuellement-cache">, lu</span>` : ""
    }${
      i === ici
        ? html`<span class="repere">${premierLu < 0 ? "Commencer ici" : "Tu en es là"}</span>`
        : ""
    }</li>${(places.get(i) ?? []).map(activite)}`;
  };
  const total = rangs.length;
  const lus = rangs.filter(lu).length;
  const ch = chapitres[0];
  return html`<section class="sommaire-cours" aria-labelledby="sommaire-cours">
    <h2 id="sommaire-cours">${dansTheme ? ch.nom : ch.cours}</h2>
    ${dansTheme ? html`<p class="discret"><a href="/eleve?cours_id=${ch.coursId}">${ch.cours}</a></p>` : ""}
    <p class="discret"><span class="chiffres">${total}</span> ${accord(total, "chapitre")}</p>
    ${
      lus
        ? html`<p class="lus"><span><span class="chiffres">${lus} sur ${total}</span> ${accord(
            lus,
            "lu",
          )}</span>${avancee(lus, total)}</p>`
        : ""
    }
    ${groupes.map(
      (g) => html`${g.nom ? html`<h3>${g.nom}</h3>` : ""}<ol>${g.sources.map(ligne)}</ol>`,
    )}
    ${!dansTheme && places.has(-1) ? html`<ol>${places.get(-1)!.map(activite)}</ol>` : ""}
  </section>`;
};

/**
 * La vue « Dossiers » de l'élève : à la racine, un dossier par cours, dans un cours, un dossier
 * par thème, puis les ressources sans thème et les activités du cours en fichiers.
 */
export const bureauEleve = (chapitres: ChapitreVue[], activites: ActiviteListee[], p: Scope) => {
  const lien = (q: Record<string, string>) =>
    `/eleve?${new URLSearchParams({ ...q, vue: "grille" })}`;
  const uniques = (liste: ChapitreVue[]) => [
    ...new Map(liste.flatMap((ch) => ch.sources).map((s) => [s.id, s])).values(),
  ];
  const documents = (n: number) => `${n} document${n > 1 ? "s" : ""}`;
  const ressource = (s: SourceChapitre) =>
    fichier({
      href: `/eleve/sources/${s.id}`,
      titre: s.titre,
      format: s.format,
      image_id: s.image_id,
    });
  const activite = (a: ActiviteListee) =>
    fichier({
      href: `/eleve/activites/${a.id}`,
      titre: a.titre,
      activite: true,
      apres: statutActivite(a),
    });
  const grille = (dossiers: unknown[], fichiers: unknown[]) =>
    html`${dossiers.length ? html`<ul class="bureau">${dossiers}</ul>` : ""}${
      fichiers.length ? html`<ul class="bureau">${fichiers}</ul>` : ""
    }`;
  const racine: Etape = { nom: "Ressources", href: lien({ cours_id: "" }) };
  const ducours = chapitres.filter((ch) => ch.coursId === p.cours_id);
  const etapeCours: Etape[] = ducours[0]
    ? [{ nom: ducours[0].cours ?? "", href: lien({ cours_id: p.cours_id }) }]
    : [];
  // Un thème qui porte le nom de son cours, souvent celui d'un dossier importé, reste à plat.
  const enDossier = (ch: ChapitreVue) => ch.themeId && ch.nom !== ch.cours;
  if (p.theme_id) {
    const du = ducours.filter((ch) => ch.themeId === p.theme_id);
    return html`${fil([racine, ...etapeCours, { nom: du[0]?.nom ?? "", href: "" }])}${grille(
      [],
      uniques(du).map(ressource),
    )}`;
  }
  if (p.cours_id) {
    return html`${fil([racine, ...etapeCours])}${grille(
      ducours.filter(enDossier).map((ch) =>
        dossier({
          href: lien({ cours_id: p.cours_id, theme_id: ch.themeId ?? "" }),
          nom: ch.nom,
          detail: documents(ch.sources.length),
        }),
      ),
      [
        ...uniques(ducours.filter((ch) => !enDossier(ch))).map(ressource),
        ...activites.filter((a) => a.cours_id === p.cours_id).map(activite),
      ],
    )}`;
  }
  const cours = [
    ...Map.groupBy(
      chapitres.filter((ch) => ch.coursId),
      (ch) => ch.coursId,
    ).values(),
  ];
  return grille(
    cours.map((liste) => {
      const aFaire = activites.filter(
        (a) => a.cours_id === liste[0].coursId && a.avancement === "a_faire",
      ).length;
      return dossier({
        href: lien({ cours_id: liste[0].coursId ?? "" }),
        nom: liste[0].cours ?? "",
        detail: documents(uniques(liste).length),
        signal: aFaire ? `${aFaire} à faire` : "",
      });
    }),
    uniques(chapitres.filter((ch) => !ch.coursId)).map(ressource),
  );
};

export type ActiviteListee = {
  id: string;
  titre: string;
  type: string;
  cours_id: string;
  cours: string;
  avancement?: Avancement;
};
const AVANCEMENTS: Record<Avancement, [string, string]> = {
  a_faire: ["À faire", "nouvelle"],
  en_cours: ["En cours", "en-cours"],
  remise: ["Remise", "certifiee"],
  retour: ["Retour reçu", "certifiee"],
};
/** Une activité dans une liste de l'élève : son titre, son type, son cours et où il en est. */
export const ligneActivite = (a: ActiviteListee, cours = false) =>
  html`<li><a href="/eleve/activites/${a.id}">${a.titre}</a> <span class="discret">${
    a.type === "explication" ? "Explication" : "Exercice"
  }${cours ? `, ${a.cours}` : ""}</span>${
    a.avancement
      ? html` <span class="statut ${AVANCEMENTS[a.avancement][1]}">${AVANCEMENTS[a.avancement][0]}</span>`
      : ""
  }</li>`;
/** Une activité avec son contenu, pour savoir quelles ressources elle cite. */
type ActiviteCitante = ActiviteListee & Pick<Activite, "contenu">;

const formRecherche = (q: string, p?: Scope) =>
  html`
    <form method="get" action="/eleve/recherche" class="question-rapide" role="search">
      ${p ? champsScope(p) : ""}
      <label for="q">Chercher une ressource</label>
      <div class="saisie">
        <input type="search" id="q" name="q" value="${q}" required maxlength="300"
          placeholder="Un sujet ou une description">
        <button>${icone("magnifying-glass")}Chercher</button>
      </div>
    </form>
  `;

export type Trouve = {
  id: string;
  titre: string;
  /** le nom du thème */
  theme: string;
  date: string;
  image_id: string | null;
  profil?: Profil;
  theme_id: string;
  /** début du passage trouvé, sans le titre */
  extrait: string;
};

/** Les documents les plus proches de la recherche, du plus proche au moins proche. */
/**
 * `incomplete` : la traduction de la recherche est en panne, les ressources en anglais n'ont été
 * cherchées qu'avec les mots français. Ne rien trouver ne dit alors rien du cours.
 */
export const recherche = (q: string, trouves: Trouve[] = [], p?: Scope, incomplete = false) =>
  html`
    <a class="bouton retour" href="/eleve">${icone("arrow-left")}Ressources</a>
    <h1>Chercher une ressource</h1>
    ${formRecherche(q, p)}
    ${
      incomplete
        ? html`<p class="note">Cette recherche est incomplète. Une panne technique a empêché de
            chercher dans les ressources en anglais, ce n'est pas une limite du cours.
            <a href="">Réessayer</a></p>`
        : ""
    }
    ${
      !q
        ? ""
        : trouves.length
          ? html`
        <p class="sous-titre">${
          trouves.length === 1 ? "Un document proche" : `${trouves.length} documents proches`
        } de ta recherche, du plus proche au moins proche.</p>
        <div class="tuiles resultats">${trouves.map(
          (s) =>
            html`
            <a class="tuile" href="${
              s.profil === "general" ? `/eleve/sources/${s.id}` : lienTheme(s.theme_id, s.id)
            }">
              ${
                // Une ressource sans image n'a rien à montrer dans un passe-partout.
                s.image_id
                  ? html`<span class="passe-partout"><img src="/media/${s.image_id}" alt=""
                      loading="lazy"></span>`
                  : ""
              }
              <span class="tuile-titre">${s.titre}</span>
              <span class="discret">${[
                s.profil === "general" ? s.theme : nomChapitre(s.theme),
                s.date,
              ]
                .filter(Boolean)
                .join(", ")}</span>
              ${s.extrait ? html`<span class="tuile-extrait">${s.extrait}</span>` : ""}
            </a>
          `,
        )}</div>
      `
          : incomplete
            ? ""
            : html`
        <p>Rien dans le cours ne ressemble à « ${q} ». Essaie d'autres mots.</p>
        ${idee(q, false, "Poser la question à Thot")}
      `
    }
  `;
