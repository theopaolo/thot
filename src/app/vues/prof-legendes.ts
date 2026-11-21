import { html } from "hono/html";
import { icone } from "../icones.ts";
import type { ImageVue } from "./prof-source.ts";

export type ALegender = ImageVue & {
  source_id: string;
  titre: string;
  restantes: number;
  credit: string | null;
};

export const legende = (i: ALegender | undefined, file: { id: string; titre: string }[] = []) =>
  i
    ? html`
      <div id="legende" class="relecture" tabindex="-1">
        <nav class="file" aria-label="Légendes à relire">
          <p><strong>${i.restantes}</strong> à relire</p>
          <ol>${file.map(
            (f) =>
              html`
              <li><a href="/prof/legendes?image=${f.id}" title="${f.titre}" aria-current="${String(
                f.id === i.id,
              )}"><img src="/media/${f.id}" alt="${f.titre}" loading="lazy"></a></li>
            `,
          )}</ol>
        </nav>
        <div class="relecture-plan">
          <figure class="relecture-image">
            <img src="/media/${i.id}" alt="Image à légender de ${i.titre}">
          </figure>
          <form
            class="relecture-proposition"
            hx-target="#legende"
            hx-swap="outerHTML"
            hx-disabled-elt="find button"
          >
            <p class="discret">Source</p>
            <h2><a href="/prof/sources/${i.source_id}">${i.titre}</a></h2>
            <label for="texte">Légende proposée</label>
            <p class="aide">Seule une légende validée peut être citée à un élève.</p>
            <textarea id="texte" name="texte" rows="7">${i.legende ?? ""}</textarea>
            <label for="credit">Crédit</label>
            <input type="text" id="credit" name="credit" value="${i.credit ?? ""}">
            <input type="hidden" name="image" value="${i.id}">
            <div class="barre">
              <button class="principal" hx-post="/prof/legendes/certified" data-raccourci="v"
                aria-keyshortcuts="v">
                ${icone("check")}Valider <kbd aria-hidden="true">V</kbd>
              </button>
              <button hx-post="/prof/legendes/rejected" data-raccourci="r" aria-keyshortcuts="r">
                ${icone("x")}Rejeter <kbd aria-hidden="true">R</kbd>
              </button>
            </div>
            <p class="raccourcis discret">
              <span class="touche"><kbd>E</kbd> modifier la légende</span>
              <span><kbd>←</kbd> <kbd>→</kbd> changer d'image depuis une vignette</span>
              <label><input type="checkbox" id="raccourcis-actifs" checked> Raccourcis clavier V, R et E</label>
            </p>
          </form>
        </div>
      </div>
    `
    : html`
      <p id="legende">Les légendes que Thot propose pour les images de vos ressources s'affichent ici, et aucune n'attend votre relecture.</p>
    `;

export const pageLegendes = (i: ALegender | undefined, file: { id: string; titre: string }[]) =>
  html`
    <h1>Relire les légendes</h1>
    ${legende(i, file)}
  `;
