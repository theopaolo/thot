import { html } from "hono/html";
import { type Audience, CLASSES, MAX_LOT, TYPES_DOCUMENT } from "../depot.ts";
import { icone } from "../icones.ts";
import { type Catalogue, MATIERES } from "../domaines.ts";
import type { Champ, Profil } from "../../core/profils.ts";
import type { Libelles } from "../instance.ts";
import * as Domaines from "./domaines.ts";
import { champ, champFichier, lecteurs, nombre } from "./commun.ts";

/** Le sort d'un fichier déposé: reçu, doublon d'une source que le compte lit, ou refusé. */
export type ResultatDepot = { nom: string } & (
  | { etat: "recu"; id: string; titre: string; format: string }
  | { etat: "doublon"; id: string; titre: string }
  | { etat: "erreur"; erreurs: Record<string, string> }
);

const bilanDepot = (d: { lot: string; resultats: ResultatDepot[] }) => {
  const n = (etat: string) => d.resultats.filter((r) => r.etat === etat).length;
  const bilan = [
    n("recu") ? nombre(n("recu"), "déposé") : "",
    n("doublon") ? nombre(n("doublon"), "doublon") : "",
    n("erreur") ? nombre(n("erreur"), "erreur") : "",
  ].filter(Boolean);
  return html`
    <section role="status" aria-labelledby="bilan-depot">
      <h2 id="bilan-depot">${bilan.join(", ")}</h2>
      <ul class="resultats">
        ${d.resultats.map(
          (r) =>
            html`
            <li>${
              r.etat === "recu"
                ? html`<span class="statut certifiee">Reçu</span> « ${r.titre} » est déposé.`
                : r.etat === "doublon"
                  ? html`<span class="statut a_relire">Doublon</span> ${r.nom} existe déjà : <a href="/prof/sources/${r.id}">${r.titre}</a>.`
                  : html`<span class="statut failed">Erreur</span> ${r.nom} : ${Object.values(r.erreurs).join(" ")}`
            }</li>
          `,
        )}
      </ul>
      ${
        n("recu")
          ? html`<p>Leur extraction a commencé. <a href="/prof?lot=${d.lot}">Suivre ce lot dans la bibliothèque</a>.</p>`
          : ""
      }
    </section>
  `;
};

/** Retour et Continuer d'une étape du dépôt. Sans JavaScript, toutes les étapes s'affichent et ces boutons restent cachés. */
const navigationEtape = (premiere: boolean, fin: unknown = "") =>
  html`<div class="barre navigation-etape">${
    premiere ? "" : html`<button type="button" data-precedent>Retour</button>`
  }${fin || html`<button type="button" class="principal" data-suivant>Continuer</button>`}</div>`;

/**
 * Le dépôt en étapes : les fichiers, leur cours, leurs lecteurs, puis des informations
 * facultatives. Avec JavaScript, une étape s'affiche à la fois. Un administrateur crée le cours,
 * et sa matière, depuis l'étape du cours. Le mode personnel n'a pas d'étape des lecteurs.
 */
export const depot = (s: {
  champs?: Record<string, string>;
  erreurs?: Record<string, string>;
  depose?: { lot: string; resultats: ResultatDepot[] };
  /** le lot du prochain envoi, généré à chaque affichage */
  lot?: string;
  personnel?: boolean;
  /** un administrateur crée un cours et sa matière depuis le dépôt */
  administrateur?: boolean;
  /** aucune matière ne fixe encore le profil de l'instance */
  sansProfil?: boolean;
  catalogue?: Catalogue;
  profil?: Profil;
  /** les champs du dépôt de la matière choisie */
  informations: Champ[];
  libelles: Libelles;
  /** les lecteurs proposés quand la saisie n'en choisit pas */
  lecteurs: Audience;
}) => {
  const c = s.champs ?? {};
  const e = s.erreurs ?? {};
  // Le profil arts propose les classes du lycée.
  const arts = s.profil === "arts-appliques" || !s.catalogue;
  const etapes = ["Fichiers", s.libelles.cours, ...(s.personnel ? [] : ["Lecteurs"]), "Déposer"];
  const etape = (n: number, titre: string, corps: unknown, fin: unknown = "") =>
    html`
      <section class="etape-depot" data-etape aria-labelledby="etape-${n}">
        <h2 id="etape-${n}" tabindex="-1">${titre}</h2>
        ${corps}
        ${navigationEtape(n === 1, fin)}
      </section>
    `;
  let n = 0;
  return html`
    <h1>Déposer des ressources</h1>
    <p class="sous-titre">Choisissez vos fichiers et leur cours. Thot en extrait le texte, puis vous
    les relisez et les certifiez dans la bibliothèque avant qu'il s'en serve.</p>
    ${s.depose ? bilanDepot(s.depose) : ""}
    <form method="post" action="/prof/depot" enctype="multipart/form-data" class="etroit" data-depot>
      ${s.lot ? html`<input type="hidden" name="lot" value="${s.lot}">` : ""}
      <ol class="etapes-depot" data-indicateur hidden>${etapes.map(
        (x) =>
          html`<li><span class="fait">${icone("check")}<span class="visuellement-cache">Fait : </span></span>${x}</li>`,
      )}</ol>
      ${etape(
        ++n,
        "Quels fichiers déposer ?",
        html`
          <div class="champ">
            <label for="fichier">Fichiers à déposer</label>
            <p class="aide">PDF, Word, PowerPoint, HTML, Markdown, PNG ou JPEG, 25 Mo au maximum par fichier, ${MAX_LOT} fichiers par lot. Chaque fichier devient une ressource.</p>
            ${champFichier(".pdf,.docx,.pptx,.html,.htm,.md,.markdown,.png,.jpg,.jpeg", true)}
            ${e.fichier ? html`<p class="erreur">${e.fichier}</p>` : ""}
          </div>
          ${champ({
            nom: "titre",
            label: "Nom du document",
            valeur: c.titre,
            erreur: e.titre,
            aide: "Vide, il reprend le titre du fichier. Avec plusieurs fichiers, chacun garde le sien.",
          })}
        `,
      )}
      ${etape(
        ++n,
        "Où les ranger ?",
        s.catalogue
          ? html`${Domaines.rangementDepot(s.catalogue, s.libelles, {
              saisie: c,
              creer: Boolean(s.administrateur),
              sansProfil: Boolean(s.sansProfil),
              personnel: s.personnel,
              erreur: e.cours ?? e.domaine,
            })}<input type="hidden" name="matiere_id" value="${c.matiere_id ?? ""}">`
          : champ({
              nom: "matiere",
              label: "Matière",
              options: MATIERES,
              valeur: c.matiere,
              erreur: e.matiere,
            }),
      )}
      ${
        s.personnel
          ? ""
          : etape(
              ++n,
              "Qui peut les lire ?",
              lecteurs(
                c.audience ?? s.lecteurs,
                c.audience === undefined || Boolean(c.reponses),
                false,
              ),
            )
      }
      ${etape(
        ++n,
        "Vérifier et déposer",
        html`
          <p data-recap hidden></p>
          <details class="ajout" ${["type_document", "classe"].some((k) => e[k]) ? "open" : ""}>
          <summary>Ajouter des informations (facultatif)</summary>
          <p class="aide">Elles valent pour tous les fichiers du dépôt et se complètent ensuite sur
          la page de chaque ressource.</p>
          <div class="deux">
            ${champ({
              nom: "type_document",
              label: "Type de document",
              requis: true,
              options: TYPES_DOCUMENT,
              valeur: c.type_document ?? "cours",
              erreur: e.type_document,
            })}
            ${champ({
              nom: "classe",
              label: s.libelles.niveau,
              options: arts ? CLASSES : undefined,
              valeur: c.classe,
              erreur: e.classe,
            })}
          </div>
          ${Domaines.langue(c.langue)}
          <div class="deux">${Domaines.informations(s.informations, c)}</div>
          ${champ({ nom: "resume", label: "Résumé", zone: true, valeur: c.resume })}
          ${champ({ nom: "objectifs", label: "Objectifs pédagogiques", zone: true, valeur: c.objectifs })}
          <div class="deux">
            ${champ({ nom: "evaluation", label: "Évaluation", valeur: c.evaluation })}
            ${champ({ nom: "sous_matiere", label: s.libelles.sousRegroupement, valeur: c.sous_matiere })}
            ${champ({ nom: "seance", label: s.libelles.seance, valeur: c.seance })}
          </div>
          </details>
        `,
        html`<button class="principal">${icone("upload-simple")}Déposer</button>`,
      )}
      <div data-lot-liste hidden>
        <h2>Fichiers choisis</h2>
        <table class="lot">
          <thead>
            <tr><th>Fichier</th><th>Titre</th><th>Format</th><th>Taille</th><th>Statut</th></tr>
          </thead>
          <tbody></tbody>
        </table>
        <p role="status" data-lot-bilan></p>
      </div>
    </form>
  `;
};
