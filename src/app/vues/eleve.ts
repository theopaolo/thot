import { html } from "hono/html";
import type { Bloc } from "../../core/document.ts";
import { estAnglais } from "../../core/recherche.ts";
import { icone } from "../icones.ts";
import type { Champ, Profil } from "../../core/profils.ts";
import { type Catalogue, idsMatieres, type Scope } from "../domaines.ts";
import type { Libelles } from "../instance.ts";
import { type Activite, type Avancement, couvre } from "../activites.ts";
import { champsScope, selectsPerimetre } from "./domaines.ts";
import { sections, texteDocument } from "./document.ts";
import { type Etape, dossier, fichier, fil } from "./bureau.ts";
import { nomPerimetre } from "./commun.ts";
import { attente, panneauSource, question, reponse } from "./echange.ts";
import {
  type ChapitreVue,
  cleEnvoi,
  fermer,
  idee,
  lienTheme,
  nomChapitre,
  type SourceChapitre,
} from "./eleve-commun.ts";

export type FaitVue = {
  phrase: string;
  titre: string;
  source_id: string;
  debut: number;
  fin: number;
};

export const accueilEleve = (
  prenom: string,
  chapitres: ChapitreVue[],
  fait: FaitVue | undefined,
  oeuvre: SourceChapitre | undefined,
  personnel: boolean,
  mention: string,
  l: Libelles,
) =>
  html`
    <h1>Bonjour ${prenom}</h1>
    <form method="post" action="/eleve/questions" class="question-rapide">
      ${cleEnvoi()}
      <label for="texte">Qu'aimerais-tu comprendre aujourd'hui ?</label>
      <div class="saisie">
        <input type="text" id="texte" name="texte" required maxlength="1000"
          placeholder="Pose ta question sur les ressources">
        <button class="principal">${icone("arrow-up")}Demander</button>
      </div>
      ${mention ? html`<small>${mention}</small>` : ""}
    </form>
    <div class="accueil-grille">
      <section aria-labelledby="tes-chapitres">
        <h2 id="tes-chapitres">${personnel ? "Mes documents" : l.regroupements}</h2>
        ${
          chapitres.length
            ? html`
            <ul class="chapitres">${chapitres.map(
              (c) =>
                html`
                <li class="chapitre">
                  <div class="chapitre-tete">
                    <h3><a href="${lienTheme(c.themeId)}">${nomChapitre(
                      c.nom || "Autres documents",
                    )}</a></h3>
                    <span class="discret">${c.sources.length} documents${
                      chapitres.some((autre) => autre.nom === c.nom && autre.coursId !== c.coursId)
                        ? ` / ${c.cours}`
                        : ""
                    }</span>
                  </div>
                  <div class="apercu-oeuvres">${c.sources
                    .filter((s) => s.image_id)
                    .slice(0, 4)
                    .map(
                      (s) =>
                        html`
                        <a class="passe-partout"
                          href="${lienTheme(c.themeId, s.id)}"><img src="/media/${
                            s.image_id
                          }" alt="${s.titre}" loading="lazy"></a>
                      `,
                    )}</div>
                  ${
                    c.questions.length
                      ? html`
                      <div class="idees">${c.questions
                        .slice(0, 2)
                        .map((q) => idee(q, false, q, c.themeId))}</div>
                    `
                      : ""
                  }
                  <a class="bouton" href="${lienTheme(c.themeId)}" aria-label="Ouvrir ${nomChapitre(c.nom || "Autres documents")}">${icone(
                    "arrow-right",
                  )}Ouvrir</a>
                </li>
              `,
            )}</ul>
          `
            : html`
            <p>${
              personnel
                ? html`
                Aucun document n'est encore prêt pour l'étude. <a
                  href="/prof/depot">Déposer un document</a>, puis le relire dans la bibliothèque.
              `
                : "Aucun document n'est encore publié par tes enseignants."
            }</p>
          `
        }
      </section>
      ${
        oeuvre
          ? html`<aside class="saviez-vous" aria-labelledby="saviez-vous">
          <h2 id="saviez-vous">Le saviez-vous ?</h2>
          <a class="passe-partout" href="/eleve/sources/${oeuvre.id}"><img src="/media/${oeuvre.image_id}" alt="${oeuvre.titre}" loading="lazy"></a>
          <p><strong>${oeuvre.titre}</strong>${oeuvre.date ? ` · ${oeuvre.date}` : ""}</p>
          ${idee(
            `Qu'est-ce que tu sais de cette œuvre : ${oeuvre.titre} ?`,
            false,
            "Qu'est-ce que tu sais de cette œuvre ?",
          )}
        </aside>`
          : fait
            ? html`
          <aside class="saviez-vous" aria-labelledby="saviez-vous">
            <h2 id="saviez-vous">Le saviez-vous ?</h2>
            <blockquote>${fait.phrase}</blockquote>
            <p class="discret">
              Tiré de « ${fait.titre} ».
              <a href="/eleve/sources/${fait.source_id}?debut=${fait.debut}&fin=${fait.fin}#passage"
              >Lire le passage</a>
            </p>
            ${idee(`Explique-moi : ${fait.phrase}`, false, "M'en dire plus")}
          </aside>
        `
            : ""
      }
    </div>
  `;

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
export const recherche = (q: string, trouves: Trouve[] = [], p?: Scope) =>
  html`
    <a class="bouton retour" href="/eleve">${icone("arrow-left")}Ressources</a>
    <h1>Chercher une ressource</h1>
    ${formRecherche(q, p)}
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
          : html`
        <p>Rien dans le cours ne ressemble à « ${q} ». Essaie d'autres mots.</p>
        ${idee(q, false, "Poser la question à Thot")}
      `
    }
  `;

/** « 2 sur $ »: compteur de diapositive resté dans deux exports HTML, sans valeur pour un élève. */
export const COMPTEUR_DIAPO = /^\d+ sur \$\d*$/;

export type SourceLue = {
  id: string;
  titre: string;
  enseignant: string;
  profil?: Profil;
  matiere_id: string | null;
  langue?: string;
  metadonnees?: string;
  /** le thème dans un cours du lecteur, vide sans thème */
  theme_id: string;
  theme: string;
  seance: string;
  date: string;
  /** la révision servie */
  revision: number;
};

/** Cartel de musée: seulement les champs connus, rien d'inventé. */
const cartel = (
  d: {
    seance: string;
    theme: string;
    date: string;
    enseignant: string;
    profil?: Profil;
  },
  l: Libelles,
) =>
  html`
    <dl class="cartel">
      ${
        d.date
          ? html`
          <dt>Date</dt>
          <dd>${d.date}</dd>
        `
          : ""
      }
      ${
        d.seance
          ? html`
          <dt>Séance</dt>
          <dd>${d.seance}</dd>
        `
          : ""
      }
      ${
        d.theme
          ? html`
          <dt>${l.regroupement}</dt>
          <dd>${d.profil === "general" ? d.theme : nomChapitre(d.theme)}</dd>
        `
          : ""
      }
      <dt>Publié par</dt><dd>${d.enseignant}</dd>
    </dl>
  `;

/** Ce que le lecteur montre d'un document choisi dans le mur. */
export type Apercu = {
  id: string;
  titre: string;
  enseignant: string;
  profil?: Profil;
  theme_id: string;
  theme: string;
  seance: string;
  date: string;
  image_id: string | null;
  legende: string | null;
  credit: string | null;
  images: number;
  extrait: string;
};

export const lecteur = (d: Apercu | undefined, l: Libelles) =>
  d
    ? html`
      <aside id="lecteur" class="feuille" aria-labelledby="lecteur-titre">
        <div class="feuille-tete">
          <h2 id="lecteur-titre" tabindex="-1">${d.titre}</h2>
          ${fermer}
        </div>
        <div class="defile">
          ${
            d.image_id
              ? html`
              <figure class="oeuvre-grande">
                <img src="/media/${d.image_id}" alt="${d.legende ?? d.titre}">
                ${
                  d.legende || d.credit
                    ? html`<figcaption>${d.legende}${
                        d.credit ? html`<span class="credit">${d.credit}</span>` : ""
                      }</figcaption>`
                    : ""
                }
              </figure>
            `
              : ""
          }
          ${cartel(d, l)}
          ${d.images > 1 ? html`<p class="discret">${d.images} images dans le document.</p>` : ""}
          ${d.extrait ? html`<p class="extrait">${d.extrait}</p>` : ""}
        </div>
        <div class="feuille-pied">
          <a class="bouton principal" href="/eleve/sources/${d.id}">${icone(
            "file-text",
          )}Lire le document</a>
          <form method="post" action="/eleve/questions">
            ${cleEnvoi()}
            <input type="hidden" name="texte" value="Que dit le cours sur « ${d.titre} » ?">
            <input type="hidden" name="theme_id" value="${d.theme_id}">
            <button>${icone("chat-circle")}Poser une question dessus</button>
          </form>
        </div>
      </aside>
    `
    : html`
      <aside id="lecteur" class="feuille" aria-label="Document">
        <p class="discret">Choisis une œuvre dans le mur pour l'ouvrir ici.</p>
      </aside>
    `;

const tuile = (s: SourceChapitre, choisi: boolean, themeId?: string) =>
  html`
    <a
      class="tuile"
      href="${lienTheme(themeId, s.id)}"
      aria-current="${String(choisi)}"
      hx-get="/eleve/documents/${s.id}/apercu"
      hx-target="#lecteur"
      hx-swap="outerHTML"
      hx-sync="closest .mur-lecteur:replace"
      hx-push-url="${lienTheme(themeId, s.id)}"
      data-ouvrir-feuille
    >
      <span class="passe-partout">${
        s.image_id
          ? html`<img src="/media/${s.image_id}" alt="" loading="lazy">`
          : html`<span class="sans-image">${icone("file-text")}</span>`
      }</span>
      <span class="tuile-titre">${s.titre}</span>
      ${s.date ? html`<span class="discret">${s.date}</span>` : ""}
    </a>
  `;

export const pageChapitre = (
  nom: string,
  sources: SourceChapitre[],
  questions: string[],
  choisi: Apercu | undefined,
  themeId: string | undefined,
  perimetre: string,
  mention: string,
  l: Libelles,
) => {
  const quiLit = mention ? html`<small>${mention}</small>` : "";
  const surQuoi = (titre: string) =>
    titre ? `Une question sur ${titre} ?` : "Une question sur ces documents ?";
  if (sources.every((s) => s.profil === "general")) {
    return html`
      <p><a href="/eleve">Ressources</a></p><h1>${
        nom || "Ressources non classées"
      }</h1><p class="discret">${perimetre}</p>
          <form method="post" action="/eleve/questions"
        class="question-rapide">${cleEnvoi()}<label for="texte">${surQuoi(nom)}</label><div class="saisie"><input type="text" id="texte" name="texte" required maxlength="1000"><input type="hidden" name="theme_id" value="${
          themeId ?? ""
        }"><button>Demander</button></div>${quiLit}</form>
          <ul>${sources.map(
            (s) => html`<li><a href="/eleve/sources/${s.id}">${s.titre}</a></li>`,
          )}</ul>${
            questions.length
              ? html`<div class="idees">${questions.map((q) => idee(q, false, q, themeId))}</div>`
              : ""
          }
    `;
  }
  const oeuvre = sources.find((s) => s.image_id && s.quiz_reponse);
  const seances = Map.groupBy(sources, (s) => s.seance || "Autres documents");
  return html`
    <div class="mur-lecteur" data-feuille>
      <div class="mur">
    <a class="bouton retour" href="/eleve">${icone("arrow-left")}${l.regroupements}</a>
    <h1>${themeId ? nom : nomChapitre(nom || "Autres documents")}</h1>
    <p class="sous-titre">${
      sources.length
    } documents publiés par tes enseignants, rangés par séance.</p>
    <form method="post" action="/eleve/questions" class="question-rapide">
      ${cleEnvoi()}
      <label for="texte">${surQuoi(themeId ? nom : nomChapitre(nom))}</label>
      <div class="saisie">
        <input type="text" id="texte" name="texte" required maxlength="1000"
          placeholder="Pose ta question">
        <input type="hidden" name="theme_id" value="${themeId ?? ""}">
        <button class="principal">${icone("arrow-up")}Demander</button>
      </div>
      ${quiLit}
    </form>
    ${
      questions.length
        ? html`<div class="idees">${questions
            .slice(0, 3)
            .map((q) => idee(q, false, q, themeId))}</div>`
        : ""
    }
        ${[...seances].map(
          ([seance, docs]) =>
            html`
            <section class="seance" aria-labelledby="seance-${docs[0].id}">
              <h2 id="seance-${docs[0].id}">${seance} <span class="discret">${
                docs.length
              }</span></h2>
              <div class="tuiles">${docs.map((s) => tuile(s, s.id === choisi?.id, themeId))}</div>
            </section>
          `,
        )}
      </div>
      <div class="colonne-lecteur">${lecteur(choisi, l)}</div>
    </div>
    ${
      oeuvre
        ? html`
        <section class="quiz">
          <h2>Quelle œuvre est-ce ?</h2>
          <img src="/media/${oeuvre.image_id}" alt="Œuvre à identifier" loading="lazy">
          <label for="quiz-reponse">Quel artiste ou mouvement ?</label>
          <div class="saisie">
            <input id="quiz-reponse" type="text" autocomplete="off">
            <button type="button" data-answer="${oeuvre.quiz_reponse}"
              data-verifier-quiz>${icone("check")}Vérifier</button>
          </div>
          <p id="quiz-resultat" role="status"></p>
        </section>
      `
        : ""
    }
  `;
};

export const lectureSource = (
  s: SourceLue,
  images: { id: string; legende: string | null; credit: string | null }[],
  blocs: Bloc[],
  informations: Champ[],
  l: Libelles,
  marque?: [number, number],
  /** les blocs viennent d'une révision qui ne sert plus */
  ancienne = false,
  /** les ressources du thème dans l'ordre de lecture, `s` comprise */
  voisins: { id: string; titre: string }[] = [],
  /** les activités publiées qui citent la ressource ou y renvoient */
  activites: ActiviteListee[] = [],
  /** le cours d'une ressource sans thème : il titre la liste des voisines */
  cours?: { id: string; nom: string },
) => {
  const texte = blocs.filter((b, n) => !(n === 0 && b.texte === s.titre));
  const plan = sections(texte, s.titre);
  const rang = voisins.findIndex((v) => v.id === s.id);
  const precedente = rang > 0 ? voisins[rang - 1] : undefined;
  const suivante = rang >= 0 ? voisins[rang + 1] : undefined;
  return html`
    <a class="bouton retour" href="${
      s.profil === "general" ? "/eleve" : lienTheme(s.theme_id, s.id)
    }">${icone(
      "arrow-left",
    )}${s.profil === "general" ? "Ressources" : nomChapitre(s.theme || "Autres documents")}</a>
    <div class="lecture-colonnes">
    ${
      voisins.length > 1
        ? html`
          <nav class="ressources-theme" aria-labelledby="ressources-theme-titre">
            <h2 id="ressources-theme-titre">${
              cours
                ? html`<a href="/eleve?cours_id=${cours.id}">${cours.nom}</a>`
                : html`<a href="${lienTheme(s.theme_id)}">${s.theme || "Ressources non classées"}</a>`
            }</h2>
            <ol>${voisins.map(
              (v) =>
                html`<li><a href="/eleve/sources/${v.id}" aria-current="${
                  v.id === s.id ? "page" : "false"
                }">${v.titre}</a></li>`,
            )}</ol>
          </nav>
        `
        : ""
    }
    <article class="document">
      <h1>${s.titre}</h1>
      ${
        s.langue && s.langue !== "fr" && !estAnglais(s.langue)
          ? html`<p class="note">Langue non prise en charge pour la recherche : ${s.langue}</p>`
          : ""
      }
      ${
        ancienne
          ? html`<p class="note">
              Version citée par une réponse précédente. Le texte du document a changé depuis.
              <a href="/eleve/sources/${s.id}">Lire la version actuelle</a>
            </p>`
          : ""
      }
      ${
        s.metadonnees
          ? html`<dl class="cartel">${informations.map((c) => {
              const valeur = JSON.parse(s.metadonnees!)[c.cle];
              return valeur
                ? html`
                <dt>${c.label}</dt>
                <dd>${String(valeur)}</dd>
              `
                : "";
            })}</dl>`
          : ""
      }
      <div class="document-tete">
        ${cartel(s, l)}
        <form method="post" action="/eleve/questions">
          ${cleEnvoi()}
          <input type="hidden" name="texte" value="Que dit le cours sur « ${s.titre} » ?">
          <input type="hidden" name="theme_id" value="${s.theme_id}">
          <button>${icone("chat-circle")}Poser une question dessus</button>
        </form>
      </div>
      ${images.map(
        (i) =>
          html`
          <figure class="oeuvre-grande"><img src="/media/${i.id}" alt="${i.legende ?? s.titre}">${
            i.legende || i.credit
              ? html`
              <figcaption>${i.legende}${
                i.credit ? html`<span class="credit">${i.credit}</span>` : ""
              }</figcaption>
            `
              : ""
          }</figure>
        `,
      )} ${texteDocument(texte, marque, 2, s.titre)}
      <div data-fin-lecture="/eleve/sources/${s.id}/lu"></div>
      ${
        activites.length
          ? html`<section aria-labelledby="s-entrainer">
            <h2 id="s-entrainer">S'entraîner</h2>
            <ul>${activites.map((a) => ligneActivite(a))}</ul>
          </section>`
          : ""
      }
      ${
        precedente || suivante
          ? html`
            <nav class="suite-lecture" aria-label="Ressource précédente et suivante">
              ${
                precedente
                  ? html`<a href="/eleve/sources/${precedente.id}" rel="prev"><span>Précédente</span>${precedente.titre}</a>`
                  : ""
              }
              ${
                suivante
                  ? html`<a href="/eleve/sources/${suivante.id}" rel="next"><span>Suivante</span>${suivante.titre}</a>`
                  : ""
              }
            </nav>
          `
          : ""
      }
    </article>
    ${
      plan.length > 1
        ? html`
          <nav class="sommaire" aria-labelledby="sommaire-titre">
            <h2 id="sommaire-titre">Sommaire</h2>
            <ol>${plan.map((p) => html`<li><a href="#${p.ancre}">${p.titre}</a></li>`)}</ol>
          </nav>
        `
        : ""
    }
    </div>
  `;
};

export type MessageVue = {
  id: string;
  question: string;
  etat: string;
  /** la dernière étape annoncée d'une réponse en cours */
  etape?: string | null;
  resultat: string | null;
  avis: string | null;
  /** le périmètre de cet échange, quand il diffère de celui de l'échange précédent */
  perimetre?: string;
};

export type ConversationVue = {
  id: string;
  titre: string;
  perimetre: string;
  active_le: string;
  /** état du dernier échange */
  etat: string | null;
  /** une réponse terminée que l'élève n'a pas encore ouverte */
  nouvelle?: number;
};

const JOUR_ISO = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" });
const HEURE = new Intl.DateTimeFormat("fr-FR", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Europe/Paris",
});
const DATE_COURTE = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  timeZone: "Europe/Paris",
});
/** « 14 h 02 » le jour même, « hier » la veille, « 12 oct. » avant. */
export const quand = (iso: string, maintenant = Date.now()) => {
  const date = new Date(iso);
  const jour = JOUR_ISO.format(date);
  if (jour === JOUR_ISO.format(maintenant)) return HEURE.format(date).replace(":", " h ");
  if (jour === JOUR_ISO.format(maintenant - 86_400_000)) return "hier";
  return DATE_COURTE.format(date);
};

const ETATS: Record<string, [string, string]> = {
  en_attente: ["En attente", "en-cours"],
  en_cours: ["Réponse en cours", "en-cours"],
  failed: ["Échec", "failed"],
};

/**
 * Le statut d'une conversation dans la liste. Une réponse en file ou en cours se relit toutes les
 * 3 s. La conversation ouverte affiche sa réponse elle-même : elle n'a pas de « Nouvelle réponse ».
 */
export const statutConversation = (
  c: Pick<ConversationVue, "id" | "etat" | "nouvelle">,
  ouverte: boolean,
) => {
  const [mot, classe] =
    ETATS[c.etat ?? ""] ?? (c.nouvelle && !ouverte ? ["Nouvelle réponse", "nouvelle"] : []);
  if (!mot) return "";
  return classe === "en-cours"
    ? html`<span class="statut en-cours" hx-get="/eleve/conversations/${c.id}/etat${
        ouverte ? "?ouverte=1" : ""
      }" hx-trigger="every 3s" hx-swap="outerHTML transition:false">${mot}</span>`
    : html`<span class="statut ${classe}">${mot}</span>`;
};

/** Les résultats seuls : la recherche HTMX remplace ce bloc, pas le champ. */
export const resultatsConversations = (
  liste: ConversationVue[],
  courante = "",
  archivees = 0,
  suite = "",
  q = "",
) =>
  html`
    <div id="resultats-conversations" aria-live="polite">
      ${
        liste.length
          ? html`<ul class="conversations">${liste.map(
              (c) =>
                html`<li><a href="/eleve/chat/${c.id}" aria-current="${
                  c.id === courante ? "page" : "false"
                }"><span class="conversation-titre">${c.titre}</span><span class="discret">${
                  c.perimetre || "Toutes tes ressources"
                }</span><span class="discret">${quand(c.active_le)} ${statutConversation(
                  c,
                  c.id === courante,
                )}</span></a></li>`,
            )}</ul>`
          : html`<p class="discret">${
              q
                ? html`Aucune conversation ne correspond à « ${q} ».`
                : html`Aucune conversation pour l'instant.`
            }</p>`
      }
      ${suite ? html`<p><a href="${suite}">Afficher les conversations précédentes</a></p>` : ""}
      ${
        archivees
          ? html`<p><a href="/eleve/conversations/archivees">Conversations archivées (${archivees})</a></p>`
          : ""
      }
    </div>
  `;

const listeConversations = (
  liste: ConversationVue[],
  courante = "",
  archivees = 0,
  suite = "",
  q = "",
  archive = false,
) => {
  const action = archive ? "/eleve/conversations/archivees" : "/eleve/conversations";
  return html`
    <a class="bouton" href="/eleve/chat/nouvelle">Nouvelle conversation</a>
    ${
      liste.length || q
        ? html`<form class="recherche-conversations" role="search" method="get" action="${action}"
            hx-get="${action}" hx-trigger="input changed delay:300ms, submit"
            hx-target="#resultats-conversations" hx-swap="outerHTML transition:false">
            ${courante ? html`<input type="hidden" name="courante" value="${courante}">` : ""}
            <input type="search" name="q" value="${q}" maxlength="100"
              aria-label="Chercher dans tes conversations" placeholder="Chercher une conversation">
          </form>`
        : ""
    }
    ${resultatsConversations(liste, courante, archivees, suite, q)}
  `;
};

/** La liste seule, sous 1400 px, et celle des conversations archivées. */
export const pageConversations = (
  archive: boolean,
  liste: ConversationVue[],
  archivees: number,
  suite: string,
  q = "",
) =>
  html`
    <section class="page-conversations">
      ${archive ? html`<p><a href="/eleve/conversations">Conversations</a></p>` : ""}
      <h1>${archive ? "Conversations archivées" : "Conversations"}</h1>
      ${listeConversations(liste, "", archivees, suite, q, archive)}
    </section>
  `;

export type Fil = {
  /** compte qui écrit : ses brouillons ne se mêlent pas à ceux d'un autre compte du navigateur */
  compte: string;
  /** absente : nouvelle conversation, rien n'est enregistré avant la première question */
  conversation?: { id: string; titre: string; archivee: boolean };
  messages: MessageVue[];
  idees: string[];
  liste: ConversationVue[];
  archivees: number;
  suite: string;
  perimetre: Scope;
  catalogue: Catalogue;
  libelles: Libelles;
  indisponible: boolean;
  statut?: string;
  personnel?: boolean;
  mention?: string;
};

export const chat = (f: Fil) => {
  const conv = f.conversation;
  // Le titre donné d'office reprend la première question, affichée juste dessous : il reste
  // pour les lecteurs d'écran, et reparaît une fois la conversation renommée.
  const titreRepete =
    !!conv && !!f.messages[0]?.question.replace(/\s+/g, " ").startsWith(conv.titre);
  const derniere = f.messages.findLastIndex((m) => m.etat === "answered");
  const enCours = f.messages.some((m) => !m.resultat);
  const nom = nomPerimetre(f.catalogue, f.perimetre, f.libelles) || "toutes tes ressources";
  const changer = conv
    ? html`method="post" action="/eleve/chat/${conv.id}/perimetre"`
    : html`method="get" action="/eleve/chat/nouvelle"`;
  const comparees = idsMatieres(f.perimetre.matieres);
  const composer = html`
    <form
      id="envoi"
      class="question-form"
      method="post"
      action="/eleve/questions"
      ${
        conv
          ? html`hx-post="/eleve/questions" hx-target="#conversation" hx-swap="beforeend"
            hx-disabled-elt="find button.principal"`
          : html`hx-boost="true" hx-replace-url="true" data-focus="#texte"`
      }
      data-brouillon="${f.compte}:${conv?.id ?? "nouvelle"}"
    >
      ${conv ? "" : champsScope(f.perimetre)}${cleEnvoi()}
      <label for="texte">Ta question</label>
      <div class="saisie">
        <textarea
          id="texte"
          name="texte"
          required
          maxlength="1000"
          rows="2"
          placeholder="${conv ? "Pose une autre question…" : "Pose ta question…"}"
        ></textarea>
        <button class="principal" ${enCours ? "disabled" : ""}>${icone("arrow-up")}<span>${
          enCours ? "Réponse en cours…" : "Envoyer"
        }</span></button>
      </div>
    </form>
  `;
  const notice = html`<small>${
    f.personnel
      ? "Thot répond seulement avec les documents que tu as relus et rendus disponibles pour l'étude."
      : "Thot répond seulement avec les documents publiés par tes enseignants."
  } ${f.mention ?? ""}</small>`;
  return html`
    <div class="chat" data-feuille>
      <nav class="liste-conversations" aria-label="Conversations"><div>${listeConversations(
        f.liste,
        conv?.id,
        f.archivees,
        f.suite,
      )}</div></nav>
      <section class="chat-principal" aria-labelledby="titre-chat">
        <div class="tete-conversation">
          <p class="liens-conversations">
            <a href="/eleve/conversations">Conversations</a>
            <a href="/eleve/chat/nouvelle">Nouvelle</a>
          </p>
          ${f.statut ? html`<p role="status">${f.statut}</p>` : ""}
          <h1 id="titre-chat" tabindex="-1" ${
            titreRepete ? html`class="visuellement-cache"` : ""
          }>${conv?.titre ?? "Nouvelle conversation"}</h1>
          ${
            conv && !conv.archivee
              ? html`
              <form class="renommer" method="post" action="/eleve/chat/${conv.id}/renommer" hidden
                data-focus="[data-renommer]">
                <label for="titre-conversation">Titre de la conversation</label>
                <div class="saisie">
                  <input type="text" id="titre-conversation" name="titre" value="${conv.titre}"
                    required maxlength="120">
                  <button class="principal">Enregistrer</button>
                  <button type="button" data-annuler-renommer>Annuler</button>
                </div>
              </form>
              <div class="actions-conversation">
                <button type="button" class="lien" data-renommer>Renommer</button>
                <form method="post" action="/eleve/chat/${conv.id}/archiver">
                  <button class="lien">Archiver</button>
                </form>
              </div>
            `
              : ""
          }
          ${conv ? html`<input type="hidden" name="conversation" value="${conv.id}" form="envoi">` : ""}
        </div>
        <div
          id="conversation"
          ${conv ? html`data-memoire="${f.compte}:${conv.id}"` : ""}
          aria-live="polite"
          aria-relevant="additions"
        >
          ${f.messages.map(
            (m, i) =>
              html`
              ${
                m.perimetre === undefined
                  ? ""
                  : html`<p class="changement-perimetre">Périmètre changé : ${
                      m.perimetre || "toutes tes ressources"
                    }</p>`
              }
              ${question(m.question)}${
                m.resultat
                  ? reponse(
                      m.id,
                      JSON.parse(m.resultat),
                      m.avis,
                      i === f.messages.length - 1 ? f.idees : [],
                      i === derniere,
                    )
                  : attente(m.id, m.etape)
              }
            `,
          )}
        </div>
        <div class="pied-chat">
          ${
            conv?.archivee
              ? html`
              <p>Cette conversation est archivée.</p>
              <form method="post" action="/eleve/chat/${conv.id}/desarchiver">
                <button>Désarchiver</button>
              </form>
            `
              : html`
              <div class="composeur">
                <button type="button" class="lien" data-aller-reponse hidden>Aller à la nouvelle réponse</button>
                <div class="perimetre">
                  <p id="perimetre" aria-live="polite">Dans : ${nom}</p>
                  <details ${f.indisponible ? "open" : ""}>
                    <summary>Changer</summary>
                    <form ${changer} data-focus=".perimetre summary">
                      ${selectsPerimetre(f.catalogue, f.perimetre, f.libelles)}
                      <button>Appliquer aux prochaines questions</button>
                    </form>
                    ${
                      f.catalogue.matieres.length > 1
                        ? html`
                        <form ${changer} data-focus=".perimetre summary">
                          <fieldset>
                            <legend>${f.libelles.matieres} à comparer</legend>
                            ${f.catalogue.matieres.map(
                              (m) =>
                                html`<label><input type="checkbox" name="matieres" value="${m.id}" ${
                                  comparees.includes(m.id) ? "checked" : ""
                                }> ${m.nom}</label>`,
                            )}
                          </fieldset>
                          <button>Comparer dans les prochaines questions</button>
                        </form>
                      `
                        : ""
                    }
                  </details>
                </div>
                ${f.indisponible ? "" : composer}
              </div>
              ${
                f.indisponible
                  ? html`<p>Ce périmètre n'est plus disponible. Choisis-en un autre pour continuer.</p>`
                  : notice
              }
              ${
                !conv && f.idees.length
                  ? html`<div class="idees">${f.idees.map((q) =>
                      idee(q, false, q, "", f.perimetre),
                    )}</div>`
                  : ""
              }
            `
          }
        </div>
      </section>
      <div class="colonne-source">${panneauSource()}</div>
    </div>
  `;
};
