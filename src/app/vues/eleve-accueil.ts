import { html } from "hono/html";
import { icone } from "../icones.ts";
import type { Libelles } from "../instance.ts";
import {
  type ChapitreVue,
  cleEnvoi,
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
