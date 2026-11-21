import { html } from "hono/html";
import type { Bloc } from "../../core/document.ts";
import { estAnglais } from "../../core/recherche.ts";
import { icone } from "../icones.ts";
import type { Champ, Profil } from "../../core/profils.ts";
import type { Libelles } from "../instance.ts";
import { sections, texteDocument } from "./document.ts";
import { cleEnvoi, lienTheme, nomChapitre } from "./eleve-commun.ts";
import { type ActiviteListee, ligneActivite } from "./eleve-ressources.ts";

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
export const cartel = (
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
