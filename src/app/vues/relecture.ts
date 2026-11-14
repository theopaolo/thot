import { html } from "hono/html";
import type { Bloc } from "../../core/document.ts";
import type { Attente } from "../relecture.ts";
import { texteDocument } from "./document.ts";
import { jour } from "./prof.ts";

/** Un titre de groupe par cours : une ressource de plusieurs cours se range sous le premier. */
const groupes = (liste: Attente[]) =>
  [...Map.groupBy(liste, (a) => a.cours[0] ?? "Sans cours")].map(([cours, items]) => ({
    cours,
    items,
  }));

export const pageRelecture = (liste: Attente[], choisie?: Attente, blocs: Bloc[] = []) =>
  !choisie
    ? html`
        <h1>Relecture</h1>
        <p>Rien à relire.</p>
        <p><a href="/prof">Retour à la bibliothèque</a></p>
      `
    : html`
        <h1 class="visuellement-cache">Relecture</h1>
        <div class="relecture">
          <nav class="relecture-liste" aria-label="Ressources à relire">
            <p class="discret"><a href="/prof">Bibliothèque</a>, ${liste.length} à relire</p>
            ${groupes(liste).map(
              (g) => html`
                <h2>${g.cours}</h2>
                <ul>
                  ${g.items.map(
                    (a) => html`
                      <li>
                        <a href="/prof/relecture?id=${a.id}"
                          aria-current="${String(a.id === choisie.id)}">
                          <span class="titre">${a.titre}</span>
                          <span class="discret"><span class="chiffres">${a.format}</span>,
                            ${jour(a.cree_le)}${
                              a.statut === "a_relire" ? "" : html`, nouvelle version`
                            }</span>
                        </a>
                      </li>
                    `,
                  )}
                </ul>
              `,
            )}
          </nav>
          <article class="relecture-lecture">
            <h2>${choisie.titre}</h2>
            <p class="discret">
              <span class="chiffres">${choisie.format}</span>, déposé par ${choisie.enseignant}
              le ${jour(choisie.cree_le)}${
                choisie.cours.length ? html`, ${choisie.cours.join(", ")}` : ""
              }
            </p>
            ${
              choisie.statut === "a_relire"
                ? html`
                    <form method="post" class="barre">
                      <button class="principal certifier"
                        formaction="/prof/relecture/${choisie.id}/certifiee">Certifier</button>
                      <button formaction="/prof/relecture/${choisie.id}/rejetee">Rejeter</button>
                      <a href="/prof/sources/${choisie.id}">Ouvrir la fiche</a>
                    </form>
                  `
                : html`
                    <p class="barre">
                      <a href="/prof/sources/${choisie.id}">Relire la nouvelle version</a>
                      <a href="/prof/sources/${choisie.id}">Ouvrir la fiche</a>
                    </p>
                  `
            }
            <div class="document">${texteDocument(blocs)}</div>
          </article>
        </div>
      `;
