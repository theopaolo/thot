import { html } from "hono/html";
import { icone } from "../icones.ts";

/**
 * La vue « Dossiers » range la bibliothèque comme un bureau : un dossier par cours, puis un par
 * thème, et les ressources en fichiers posés à côté.
 */
export type Dossier = { href: string; nom: string; detail: string; signal?: string };

export type Fichier = {
  href: string;
  titre: string;
  /** l'extension de la ressource, absente pour une activité */
  format?: string;
  image_id?: string | null;
  activite?: boolean;
  /** la case de sélection de l'enseignant */
  avant?: unknown;
  /** ce qui s'écarte de l'ordinaire : à relire, échec, statut d'une activité */
  apres?: unknown;
  classe?: string;
};

export type Etape = { nom: string; href: string };

/** Le chemin du dossier ouvert, la dernière étape sans lien. */
export const fil = (etapes: Etape[]) =>
  etapes.length > 1
    ? html`<nav class="fil" aria-label="Emplacement"><ol>${etapes.map((e, i) =>
        i === etapes.length - 1
          ? html`<li aria-current="location">${e.nom}</li>`
          : html`<li><a href="${e.href}">${e.nom}</a></li>`,
      )}</ol></nav>`
    : "";

export const dossier = (d: Dossier) =>
  html`<li class="dossier"><a href="${d.href}"><span class="pictogramme">${icone(
    "folder-simple-fill",
  )}</span><span class="nom">${d.nom}</span><span class="detail">${d.detail}</span></a>${
    d.signal ? html`<span class="statut a_relire">${d.signal}</span>` : ""
  }</li>`;

const pictogramme = (f: Fichier) =>
  f.image_id
    ? html`<span class="pictogramme"><img src="/media/${f.image_id}" alt="" loading="lazy"></span>`
    : f.activite
      ? html`<span class="pictogramme">${icone("exam")}</span>`
      : html`<span class="pictogramme">${icone("file-fill")}${icone("file-text")}${
          f.format ? html`<span class="extension" data-format="${f.format}">${f.format}</span>` : ""
        }</span>`;

export const fichier = (f: Fichier) =>
  html`<li class="document ${f.activite ? "activite" : ""} ${f.classe ?? ""}">${f.avant ?? ""}<a href="${f.href}">${pictogramme(
    f,
  )}<span class="nom">${f.titre}</span></a>${f.apres ?? ""}</li>`;
