import { html } from "hono/html";
import type { Catalogue } from "../domaines.ts";
import type { Libelles } from "../instance.ts";
import * as Domaines from "./domaines.ts";
import { type Eleve, tableEleves } from "./prof-eleves.ts";

/**
 * Les cours de l'enseignant, tous pour un administrateur, avec leurs thèmes et leurs enseignants.
 * Un collègue rejoint d'un coup les cours cochés, aucun n'est coché d'office.
 */
export const mesCours = (
  cat: Catalogue,
  enseignants: Map<string, Eleve[]>,
  collegues: Eleve[],
  moi: string,
  l: Libelles,
  erreur?: string,
) =>
  html`
    <h1>Mes cours</h1>
    ${erreur ? html`<p role="alert">${erreur}</p>` : ""}
    <p>Les enseignants d'un cours lisent et modifient ses ressources qui ne sont pas privées, lisent les questions de ses élèves, gèrent ses élèves et ses liens d'inscription. Un administrateur crée les matières et supprime les cours.</p>
    ${
      !cat.cours.length
        ? html`<p>Vous n'avez pas encore de cours. Créez-en un, ou demandez à un collègue de vous ajouter aux siens.</p>`
        : collegues.length
          ? html`
          <h2>Ajouter un collègue</h2>
          <form method="post" action="/prof/cours/collegue">
            <div class="champ">
              <label for="collegue">Enseignant</label>
              <select id="collegue" name="compte_id" required>
                <option value="">Choisir un collègue</option>
                ${collegues.map((e) => html`<option value="${e.id}">${e.nom} (${e.identifiant})</option>`)}
              </select>
            </div>
            <fieldset>
              <legend>Cours à partager</legend>
              <p class="discret">Votre collègue lit et modifie les ressources non privées de ces cours, lit les questions de leurs élèves, gère ces élèves, mots de passe compris, et leurs liens d'inscription.</p>
              ${cat.cours.map(
                (c) =>
                  html`<label><input type="checkbox" name="cours" value="${c.id}"> ${
                    cat.matieres.find((m) => m.id === c.matiere_id)?.nom
                  } / ${c.nom}</label>`,
              )}
            </fieldset>
            <button class="principal">Ajouter aux cours cochés</button>
          </form>
        `
          : html`<p class="discret">Aucun autre compte enseignant. Un administrateur crée les comptes enseignants.</p>`
    }
    <details ${cat.cours.length ? "" : "open"}>
      <summary>Créer un cours</summary>
      ${
        cat.matieres.length
          ? html`<p class="discret">Vous devenez membre du cours créé.</p>${Domaines.nouveauCours(
              cat.matieres,
              l,
              "/prof/cours/creer",
            )}`
          : html`<p class="discret">Aucune matière. Un administrateur crée les matières.</p>`
      }
    </details>
    ${cat.cours.map((cours) => {
      const equipe = enseignants.get(cours.id) ?? [];
      return html`
        <h2 id="cours-${cours.id}">${cat.matieres.find((m) => m.id === cours.matiere_id)?.nom} / ${cours.nom}</h2>
        ${
          cours.public || cours.objectif
            ? html`<p class="discret">${[cours.public, cours.objectif].filter(Boolean).join(" : ")}</p>`
            : ""
        }
        ${Domaines.ligne("cours", cours.id, cours.nom, "", "cours", "", "/prof/cours")}
        <h3>${l.regroupements}</h3>
        ${cat.themes
          .filter((t) => t.cours_id === cours.id)
          .map((t) => Domaines.ligne("theme", t.id, t.nom, "", l.regroupement, "", "/prof/cours"))}
        <form method="post" action="/prof/cours/theme" class="barre">
          <input type="hidden" name="cours_id" value="${cours.id}">
          <input type="text" name="nom" required maxlength="200" placeholder="${l.regroupement} à créer" aria-label="${l.regroupement} à créer dans ${cours.nom}">
          <button>Créer</button>
        </form>
        <h3>Enseignants</h3>
        ${
          equipe.length
            ? tableEleves(
                equipe,
                (e) => html`
                  <form method="post" action="/prof/cours/retirer">
                    <input type="hidden" name="cours_id" value="${cours.id}"><input type="hidden" name="compte_id" value="${e.id}">
                    ${
                      e.id === moi
                        ? html`<button aria-label="Quitter ${cours.nom}" data-confirmer="Quitter ${cours.nom} ? Vous ne gérez plus ses élèves et ne lisez plus leurs questions. Un collègue du cours ou un administrateur peut vous y ajouter à nouveau.">Quitter le cours</button>`
                        : html`<button aria-label="Retirer ${e.nom} de ${cours.nom}" data-confirmer="Retirer ${e.nom} de ${cours.nom} ? Son compte et ses ressources restent.">Retirer du cours</button>`
                    }
                  </form>
                `,
                undefined,
                "Enseignant",
              )
            : html`<p class="discret">Aucun enseignant dans ce cours.</p>`
        }
      `;
    })}
  `;
