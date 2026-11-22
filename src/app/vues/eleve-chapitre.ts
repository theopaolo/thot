import { html } from "hono/html";
import { icone } from "../icones.ts";
import type { Profil } from "../../core/profils.ts";
import type { Libelles } from "../instance.ts";
import {
  cleEnvoi,
  fermer,
  idee,
  lienTheme,
  nomChapitre,
  type SourceChapitre,
} from "./eleve-commun.ts";
import { cartel } from "./eleve-lecture.ts";

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
            <input type="hidden" name="texte" value="Que dit ${l.formes.cours.le} sur « ${d.titre} » ?">
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
