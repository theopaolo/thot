import { html } from "hono/html";
import type { Bloc } from "../../core/document.ts";
import { type Audience, AUDIENCES } from "../depot.ts";
import type { Affiliation, Catalogue } from "../domaines.ts";
import type { imagesEnAttente } from "../ingestion.ts";
import type { Champ, Profil } from "../../core/profils.ts";
import type { Libelles } from "../instance.ts";
import * as Domaines from "./domaines.ts";
import { texteDocument } from "./document.ts";
import { champ, jour, lecteurs } from "./commun.ts";
import { ETATS_JOB, JOBS_ACTIFS, STATUTS } from "./prof-lignes.ts";

export type Detail = {
  source: {
    id: string;
    titre: string;
    statut: string;
    format: string;
    fichier: string;
    statut_par: string | null;
    statut_le: string | null;
    enseignant: string;
    cree_le: string;
    profil?: Profil;
    matiere_id: string | null;
    langue?: string;
    audience: Audience;
    reponses: number;
  };
  /** le propriétaire ou un administrateur */
  modifiable?: boolean;
  /** le propriétaire ou un administrateur, pas les enseignants de ses cours */
  supprimable?: boolean;
  meta: Record<string, unknown>;
  /** les champs du dépôt de sa matière */
  informations: Champ[];
  libelles: Libelles;
  job: { etat: string; erreur: string | null; avertissements: string[] } | undefined;
  images: ImageVue[];
  /** blocs de la révision servie */
  blocs: Bloc[];
  /** une extraction plus récente, dont le texte ou les images ont changé */
  attente?: {
    n: number;
    cree_le: string;
    avertissements: string[];
    blocs: Bloc[];
    images?: ReturnType<typeof imagesEnAttente>;
  };
  /** notes de l'orateur d'une présentation, pour qui relit la source. `null` : pas encore lues */
  notes?: { diapositive: number; texte: string }[] | null;
  catalogue?: Catalogue;
  affiliations?: Affiliation[];
};

export type ImageVue = {
  id: string;
  legende: string | null;
  legende_statut: string;
  legende_origine: string | null;
  /** la section du texte où l'image apparaît */
  section?: string | null;
  modele: string | null;
};

export const statutSource = (s: Detail["source"], modifiable = true) =>
  html`
    <div id="statut-source" class="barre">
      <span class="statut ${s.statut}">${STATUTS[s.statut]}</span>
      ${
        s.statut_par
          ? html`
          <small>par ${s.statut_par}, le ${s.statut_le ? jour(s.statut_le) : ""}</small>
        `
          : ""
      }
      <span class="espace"></span>
      ${
        modifiable && s.statut !== "certifiee"
          ? html`
          <button
            class="principal certifier"
            hx-post="/prof/sources/${s.id}/certifiee"
            hx-target="#statut-source"
            hx-swap="outerHTML"
          >
            Certifier la source
          </button>
        `
          : ""
      } ${
        modifiable && s.statut !== "rejetee"
          ? html`
          <button
            hx-post="/prof/sources/${s.id}/rejetee"
            hx-target="#statut-source"
            hx-swap="outerHTML"
            hx-confirm="Rejeter cette source ? Les élèves ne la verront plus."
          >
            Rejeter
          </button>
        `
          : ""
      }
    </div>
  `;

export const detailSource = (d: Detail) => {
  // Une proposition de Thot remplit un champ encore vide. Enregistrer la valide.
  const propositions = (d.meta.propositions ?? {}) as Record<string, string>;
  const propose = (nom: string) => !d.meta[nom] && Boolean(propositions[nom]);
  // Une version qui ne change que les images reprend le texte servi : il ne s'affiche qu'une fois.
  const memeTexte = !!d.attente && JSON.stringify(d.attente.blocs) === JSON.stringify(d.blocs);
  return html`
    <p><a href="/prof">Bibliothèque</a></p>
    <h1>${d.source.titre}</h1>
    <p class="discret">${d.meta.sequence ?? ""} ${d.meta.seance ? `· ${d.meta.seance}` : ""} · ${
      d.source.format
    } · ${d.source.fichier}</p>
    <p class="discret">Déposé par ${d.source.enseignant} le ${jour(
      d.source.cree_le,
    )}. Lecteurs : ${AUDIENCES.find((a) => a.value === d.source.audience)?.label.toLowerCase()}${
      d.source.reponses ? ", cité par Thot" : ""
    }.</p>
    ${
      d.source.format === "pdf" || d.source.format === "md"
        ? html`
        <p><a href="/prof/sources/${d.source.id}/original" target="_blank">Ouvrir le ${d.source.format === "pdf" ? "PDF" : "Markdown"}</a></p>
      `
        : d.source.format === "docx" || (d.source.format === "pptx" && d.modifiable)
          ? html`
        <p><a href="/prof/sources/${d.source.id}/original">Télécharger l'original ${d.source.format === "docx" ? "Word" : "PowerPoint"}</a></p>
      `
          : ""
    }
    <div class="fiche-source">
    ${
      d.modifiable
        ? html`<form method="post" action="/prof/sources/${d.source.id}/modifier" class="etroit edition-source">
      <h2>Modifier les informations</h2>
      ${
        ["date", "artiste", "mouvement"].some(propose)
          ? html`
            <p class="note">
              Thot a lu ces informations dans le titre, le nom du fichier ou le texte. Les élèves les
              voient une fois enregistrées.
            </p>
          `
          : ""
      }
      <div class="deux">
        ${champ({ nom: "titre", label: "Titre", valeur: d.source.titre, requis: true })}
        ${Domaines.informations(d.informations, d.meta, propositions)}
      </div>
      <div class="deux">
        <div class="champ">
          <label for="ordre">Ordre de lecture</label>
          <p class="aide" id="ordre-aide">
            Les élèves lisent les ressources rangées ensemble dans cet ordre, puis par titre. Un
            Markdown le prend de la clé <code>order</code> de son front matter.
          </p>
          <input type="number" step="any" id="ordre" name="ordre" value="${String(
            d.meta.ordre ?? "",
          )}" aria-describedby="ordre-aide">
        </div>
      </div>
      ${
        d.source.profil !== "general"
          ? html`<p class="aide">Le quiz élève accepte l'artiste ou le mouvement.</p>`
          : ""
      }
      ${d.catalogue ? Domaines.liens(d.catalogue, d.libelles, d.affiliations) : ""}
      ${Domaines.langue(d.source.langue)}
      ${lecteurs(d.source.audience, d.source.reponses === 1)}
      <button>Enregistrer</button>
    </form>`
        : ""
    }
    <div class="texte-source">
    <div id="traitement-source" hx-disinherit="hx-select" ${
      d.job && JOBS_ACTIFS.includes(d.job.etat)
        ? html`hx-get="/prof/sources/${d.source.id}" hx-trigger="every 3s"
          hx-select="#traitement-source" hx-swap="outerHTML"`
        : ""
    }>
    ${statutSource(d.source, d.modifiable)} ${
      d.modifiable
        ? html`
        <p class="discret">
          Certifier la source la rend disponible à ses lecteurs. Les légendes d'images se relisent
          à part : une légende non relue n'est jamais citée.
        </p>
      `
        : ""
    }
    ${
      d.job?.etat === "failed"
        ? html`
        <p role="alert">Le traitement a échoué : ${d.job.erreur}</p>
      `
        : d.job && JOBS_ACTIFS.includes(d.job.etat)
          ? html`
        <p class="note">
          Traitement en cours : ${ETATS_JOB[d.job.etat]}.
        </p>
      `
          : ""
    } ${avertissements(d.job?.avertissements ?? [])} ${diapositivesMasquees(d)} ${
      d.attente
        ? html`
        <section aria-labelledby="revision-attente">
          <h2 id="revision-attente">Nouvelle version à relire</h2>
          <p class="note">
            ${
              memeTexte
                ? html`L'extraction du ${jour(d.attente.cree_le)} garde le texte et change les
                  images. Les lecteurs et Thot gardent les images actuelles tant que cette version
                  n'est pas certifiée.`
                : html`L'extraction du ${jour(d.attente.cree_le)} a changé le texte. Les lecteurs et
                  Thot gardent le texte actuel tant que cette version n'est pas certifiée. Les
                  réponses déjà données gardent le passage qu'elles citent.`
            }
          </p>
          ${avertissements(d.attente.avertissements)} ${
            d.modifiable
              ? html`
              <form method="post" class="barre">
                <button class="principal certifier"
                  formaction="/prof/sources/${d.source.id}/revisions/${d.attente.n}/certifiee">
                  Certifier cette version
                </button>
                <button formaction="/prof/sources/${d.source.id}/revisions/${d.attente.n}/rejetee"
                  data-confirmer="Rejeter cette version ? Elle sera supprimée, le texte actuel reste en service.">
                  Rejeter cette version
                </button>
              </form>
            `
              : ""
          }
          ${imagesAttente(d)}
          ${memeTexte ? "" : html`<div class="document">${texteDocument(d.attente.blocs)}</div>`}
        </section>
      `
        : ""
    } ${
      d.images.length
        ? html`
        <h2>Images</h2>${d.images.map(
          (i) =>
            html`
            <figure>
              <img src="/media/${i.id}" alt="Image de ${d.source.titre}" loading="lazy">
              <figcaption>
                ${i.section ? html`<small>${i.section}</small>` : ""}
                <span class="statut ${i.legende_statut}">${LEGENDES[i.legende_statut]}</span>
                ${i.legende ?? "Pas de légende."} ${
                  d.modifiable && i.legende_statut === "unreviewed"
                    ? html`
                    <a href="/prof/legendes?image=${i.id}">Relire</a>
                  `
                    : ""
                }
              </figcaption>
            </figure>
          `,
        )}
      `
        : ""
    }
    <h2>${d.attente && !memeTexte ? "Texte actuel" : "Texte extrait"}</h2>
    <div class="document">${texteDocument(d.blocs)}</div>
    </div>
    ${d.notes === undefined ? "" : notesOrateur(d.notes)}
    </div>
    ${
      d.supprimable
        ? html`<form method="post" action="/prof/sources/${d.source.id}/supprimer"
          class="etroit suppression-source">
        <h2>Supprimer la source</h2>
        <p class="discret">
          Rejeter retire la source des élèves et de Thot, et la garde. Supprimer efface l'original,
          ses versions, ses images et les passages cités dans les réponses des élèves.
        </p>
        <button class="danger" data-confirmer="Supprimer définitivement « ${d.source.titre} » ? L'original, ses versions, ses images et les passages cités dans les réponses des élèves seront effacés. Cette suppression ne s'annule pas.">
          Supprimer définitivement
        </button>
      </form>`
        : ""
    }
    </div>
  `;
};

const avertissements = (liste: string[]) =>
  liste.length
    ? html`<div class="alerte"><strong>Avertissements</strong><ul>${liste.map(
        (a) => html`<li>${a}</li>`,
      )}</ul></div>`
    : "";

/**
 * Les images que la version à relire ajoute, et le nom de celles qu'elle retire. Une image ajoutée
 * ne sort du serveur que pour ceux qui modifient la source : les autres en lisent le nombre.
 */
const imagesAttente = (d: Detail) => {
  const { ajoutees = [], retirees = [] } = d.attente?.images ?? {};
  const s = (n: number) => (n > 1 ? "s" : "");
  return html`${
    !ajoutees.length
      ? ""
      : !d.modifiable
        ? html`<p>Cette version ajoute ${ajoutees.length} image${s(ajoutees.length)}. Seuls ceux
            qui modifient la source les voient avant sa certification.</p>`
        : html`<h3>Images ajoutées</h3>${ajoutees.map(
            (i) => html`
              <figure>
                <img src="/prof/sources/${d.source.id}/revisions/${d.attente!.n}/images/${i.fichier}"
                  alt="Image ajoutée à ${d.source.titre}" loading="lazy">
                <figcaption>
                  ${i.section ? html`<small>${i.section}</small>` : ""}
                  <span class="statut unreviewed">${LEGENDES.unreviewed}</span>
                  ${i.legende ?? "Pas de légende."}
                </figcaption>
              </figure>
            `,
          )}`
  }${
    retirees.length
      ? html`<p>Certifier cette version retire ${retirees.length} image${s(retirees.length)} de
            la source :</p>
          <ul>${retirees.map(
            (i) =>
              html`<li><a href="/media/${i.id}" target="_blank">${i.legende ?? "Image sans légende"}</a></li>`,
          )}</ul>`
      : ""
  }`;
};

/** Le choix d'inclure les diapositives masquées, quand la présentation en a. */
const diapositivesMasquees = (d: Detail) => {
  const incluses = d.meta.diapositives_masquees === true;
  return d.modifiable &&
    d.job?.etat === "awaiting_review" &&
    d.job.avertissements.some((a) => a.startsWith("Diapositives masquées"))
    ? html`<form method="post" action="/prof/sources/${d.source.id}/diapositives-masquees" class="barre">
        <span>Diapositives masquées : ${incluses ? "incluses dans la dernière extraction" : "exclues du texte, de la recherche et des réponses"}.</span>
        <input type="hidden" name="inclure" value="${incluses ? "0" : "1"}">
        <button>${incluses ? "Les exclure" : "Les inclure"}</button>
      </form>`
    : "";
};

/** Les notes de l'orateur, lues par le worker à l'extraction. Elles restent hors du texte extrait. */
const notesOrateur = (notes: { diapositive: number; texte: string }[] | null) => html`
  <section aria-labelledby="notes-orateur">
    <h2 id="notes-orateur">Notes de l'orateur</h2>
    <p class="discret">
      Visibles par ceux qui relisent la source. Elles n'entrent ni dans le texte, ni dans la
      recherche, ni dans les réponses, et les élèves ne les voient pas.
    </p>
    ${
      notes === null
        ? html`<p>Les notes de cette présentation n'ont pas été lues à son extraction. Elles le seront à la prochaine.</p>`
        : notes.length
          ? notes.map(
              (n) => html`<h3>Diapositive ${n.diapositive}</h3><p class="passage">${n.texte}</p>`,
            )
          : html`<p>Aucune note.</p>`
    }
  </section>
`;

const LEGENDES: Record<string, string> = {
  unreviewed: "non relue",
  certified: "certifiée",
  rejected: "rejetée",
};
