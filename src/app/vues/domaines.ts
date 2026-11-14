import { html } from "hono/html";
import { CHAMPS, type Champ, champsVerrouilles, PROFILS } from "../../core/profils.ts";
import {
  type Affiliation,
  type Catalogue,
  type Cours,
  type Matiere,
  type Scope,
  TYPES_CHAMP,
} from "../domaines.ts";
import { icone } from "../icones.ts";
import { type Libelles, minuscule } from "../instance.ts";
import { ongletsAdministration } from "./page.ts";

const options = (liste: { id: string; nom: string }[], valeur = "") =>
  liste.map(
    (m) => html`<option value="${m.id}" ${m.id === valeur ? "selected" : ""}>${m.nom}</option>`,
  );
export const selectionProfil = (valeur = "general") =>
  html`<label>Profil <select name="profil">${Object.entries(PROFILS).map(
    ([id, p]) => html`<option value="${id}" ${id === valeur ? "selected" : ""}>${p.nom}</option>`,
  )}</select></label>`;
const LIBELLES = { matiere: "matière", cours: "cours", theme: "thème", champ: "champ" };
const ligne = (
  genre: keyof typeof LIBELLES,
  id: string,
  nom: string,
  contexte = "",
  terme = LIBELLES[genre],
) => {
  const libelle = `Nom (${terme})`;
  return html`
    <form method="post" action="/administration/domaines/renommer" class="barre">
      <input type="hidden" name="genre" value="${genre}"><input type="hidden" name="id" value="${id}">
      <input type="text" name="nom" value="${nom}" required maxlength="${
        genre === "champ" ? 60 : 200
      }" aria-label="${libelle}">
      <button>Renommer</button>
      <button formaction="/administration/domaines/supprimer" formnovalidate>Supprimer</button>
      ${contexte ? html`<span class="discret">${contexte}</span>` : ""}
    </form>
  `;
};
export type Inscrit = { id: string; identifiant: string; nom: string; role: string };
export type Inscriptions = { membres: Map<string, Inscrit[]>; comptes: Inscrit[]; ouvert: string };
const ROLES: Record<string, string> = { enseignant: "enseignant", eleve: "élève" };
const membresDuCours = (c: Cours, inscrits: Inscrit[], comptes: Inscrit[], ouvert: boolean) => {
  const dehors = comptes.filter((a) => !inscrits.some((m) => m.id === a.id));
  const groupe = (role: string, libelle: string) => {
    const liste = dehors.filter((a) => a.role === role);
    return liste.length
      ? html`<optgroup label="${libelle}">${liste.map(
          (a) => html`<option value="${a.id}">${a.nom} (${a.identifiant})</option>`,
        )}</optgroup>`
      : "";
  };
  return html`
    <details id="membres-${c.id}" ${ouvert ? "open" : ""}>
      <summary>Membres : ${inscrits.length}</summary>
      ${
        inscrits.length
          ? html`
          <table>
            <tbody>${inscrits.map(
              (m) =>
                html`
                <tr>
                  <td>${m.nom} <span class="discret">${m.identifiant}, ${ROLES[m.role]}</span></td>
                  <td>
                    <form method="post" action="/administration/domaines/desinscrire">
                      <input type="hidden" name="cours_id" value="${
                        c.id
                      }"><input type="hidden" name="compte_id" value="${m.id}">
                      <button aria-label="Retirer ${m.nom} de ${c.nom}">Retirer</button>
                    </form>
                  </td>
                </tr>
              `,
            )}</tbody>
          </table>
        `
          : html`<p class="discret">Aucun membre.</p>`
      }
      ${
        dehors.length
          ? html`
          <form method="post" action="/administration/domaines/inscrire" class="barre">
            <input type="hidden" name="cours_id" value="${c.id}">
            <select name="compte_id" required aria-label="Compte à ajouter à ${c.nom}">
              <option value="">Ajouter un compte</option>${groupe(
                "enseignant",
                "Enseignants",
              )}${groupe("eleve", "Élèves")}
            </select>
            <button>Ajouter</button>
          </form>
        `
          : ""
      }
    </details>
  `;
};
/**
 * `listes` : les clés cochées de chaque matière. `saisie` : les clés envoyées avec une version
 * périmée, rendues telles quelles. `ressources` : le nombre de ressources qui remplissent le champ.
 */
export type ChampsDepot = {
  catalogue: (Champ & { ressources: number })[];
  listes: Map<string, string[]>;
  saisie?: { id: string; cles: string[] };
  enregistre: boolean;
};
const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? "s" : ""}`;
const nombre = (n: number, singulier: string, pluriels: string) =>
  `${n} ${minuscule(n > 1 ? pluriels : singulier)}`;
/** Une case par champ du catalogue. Une matière arts garde cochés les champs que le quiz lit. */
const champsDuDepot = (m: Matiere, d: ChampsDepot, ouvert: boolean) => {
  const conflit = d.saisie?.id === m.id;
  const coches = conflit ? d.saisie!.cles : (d.listes.get(m.id) ?? []);
  const figes = champsVerrouilles(m.profil);
  const caseChamp = (c: Champ) => {
    const fige = figes.includes(c.cle);
    return html`<label><input type="checkbox" name="champs" value="${c.cle}" ${
      fige || coches.includes(c.cle) ? "checked" : ""
    } ${fige ? html`disabled aria-describedby="figes-${m.id}"` : ""}> ${c.label}</label>`;
  };
  const personnalises = d.catalogue.filter((c) => !Object.hasOwn(CHAMPS, c.cle));
  return html`
    <details id="champs-${m.id}" ${ouvert || conflit ? "open" : ""}>
      <summary>Champs du dépôt : ${d.listes.get(m.id)?.length ?? 0}</summary>
      ${
        conflit
          ? html`<p role="alert" tabindex="-1" autofocus>Ces réglages ont changé pendant votre saisie. Vos valeurs sont conservées.</p>`
          : ouvert && d.enregistre
            ? html`<p role="status" tabindex="-1" autofocus>Réglages enregistrés.</p>`
            : ""
      }
      <form method="post" action="/administration/domaines/champs" class="etroit reglages">
        <input type="hidden" name="matiere_id" value="${m.id}"><input type="hidden" name="version" value="${m.version}">
        <fieldset>
          <legend>Champs prédéfinis</legend>
          <div class="deux">${d.catalogue.filter((c) => Object.hasOwn(CHAMPS, c.cle)).map(caseChamp)}</div>
          ${figes.length ? html`<p class="aide" id="figes-${m.id}">Utilisé par le quiz et les propositions de Thot.</p>` : ""}
        </fieldset>
        <fieldset>
          <legend>Champs personnalisés</legend>
          ${
            personnalises.length
              ? html`<div class="deux">${personnalises.map(caseChamp)}</div>`
              : html`<p class="discret">Aucun champ personnalisé.</p>`
          }
        </fieldset>
        <div class="barre">
          <button class="principal">Enregistrer les champs</button>
          <button type="reset">Annuler</button>
          <a href="/prof/depot?matiere_id=${m.id}">Voir le formulaire de dépôt</a>
        </div>
      </form>
    </details>
  `;
};
export const gestion = (
  cat: Catalogue,
  erreur: string,
  figee: boolean,
  inscriptions: Inscriptions,
  champs: ChampsDepot,
  l: Libelles,
) => {
  const profil = cat.matieres[0]?.profil;
  const controleProfil = !profil
    ? ""
    : figee
      ? html`<p>Profil de l'instance : <strong>${
          PROFILS[profil].nom
        }</strong>. Des ressources sont déposées, il ne change plus.</p>`
      : html`
      <form method="post" action="/administration/domaines/profil"
        class="barre">${selectionProfil(
          profil,
        )}<button data-confirmer="Changer le profil ? Les termes et les champs jamais modifiés prennent les valeurs du profil choisi.">Changer le profil de l'instance</button></form>
    `;
  const personnalises = champs.catalogue.filter((c) => !Object.hasOwn(CHAMPS, c.cle));
  return html`
    <h1>Administration</h1>
    ${ongletsAdministration("/administration/domaines", l)}
    ${erreur ? html`<p role="alert">${erreur}</p>` : ""}
    <p>L'instance garde un seul profil d'import, partagé par toutes ses matières. Il se change tant
    qu'aucune ressource n'est déposée. La recherche est prise en charge en français uniquement.</p>
    ${controleProfil}
    <p>Renommer garde les rattachements. Supprimer est refusé tant qu'une ressource ou une question
    d'élève utilise l'entrée. Une matière ou un cours emporte tout ce qu'il contient.</p>
    <h2>${l.matieres}</h2>
    ${cat.matieres.map(
      (m) =>
        html`${ligne("matiere", m.id, m.nom, "", l.matiere)}${champsDuDepot(
          m,
          champs,
          inscriptions.ouvert === m.id,
        )}`,
    )}
    <form method="post" action="/administration/domaines/matiere"
      class="etroit"><label>${l.matiere} à créer <input type="text" name="nom" required maxlength="200"></label>${
        profil ? "" : selectionProfil()
      }<button>Créer</button></form>
    <h2>${l.cours_pluriel}</h2>
    <p>Un nouveau cours démarre sans membre, et seuls ses membres, les administrateurs et les
    propriétaires lisent les ressources qu'il partage.</p>${cat.cours.map(
      (c) =>
        html`${ligne(
          "cours",
          c.id,
          c.nom,
          `${cat.matieres.find((m) => m.id === c.matiere_id)?.nom}${
            c.public ? `, ${c.public}` : ""
          }${c.objectif ? ` : ${c.objectif}` : ""}`,
          l.cours,
        )}${membresDuCours(
          c,
          inscriptions.membres.get(c.id) ?? [],
          inscriptions.comptes,
          inscriptions.ouvert === c.id,
        )}`,
    )}
    <form method="post" action="/administration/domaines/cours"
      class="etroit"><label>${l.matiere} <select name="matiere_id" required>${options(
        cat.matieres,
      )}</select></label><label>${l.cours} à créer <input type="text" name="nom" required maxlength="200"></label><label>${l.niveau} <input type="text" name="public" maxlength="200"></label><label>Objectif (facultatif) <textarea name="objectif" maxlength="4000"></textarea></label><button>Créer</button></form>
    <h2>${l.regroupements}</h2>${cat.themes.map((t) =>
      ligne(
        "theme",
        t.id,
        t.nom,
        `${
          cat.matieres.find((m) => m.id === cat.cours.find((c) => c.id === t.cours_id)?.matiere_id)
            ?.nom
        } / ${cat.cours.find((c) => c.id === t.cours_id)?.nom}`,
        l.regroupement,
      ),
    )}
    <form method="post" action="/administration/domaines/theme"
      class="etroit"><label>${l.cours} <select name="cours_id" required>${options(
        cat.cours.map((c) => ({
          id: c.id,
          nom: `${cat.matieres.find((m) => m.id === c.matiere_id)?.nom} / ${c.nom}`,
        })),
      )}</select></label><label>${l.regroupement} <input type="text" name="nom" required maxlength="200"></label><button>Créer</button></form>
    <h2>Champs personnalisés</h2>
    <p>Un champ se coche ensuite dans les champs du dépôt de chaque matière. Renommer garde ses
    valeurs. Son type ne change plus après sa création.</p>
    ${
      personnalises.length
        ? personnalises.map((c) =>
            ligne(
              "champ",
              c.cle,
              c.label,
              `${TYPES_CHAMP[c.type]}, ${nombre(
                [...champs.listes.values()].filter((liste) => liste.includes(c.cle)).length,
                l.matiere,
                l.matieres,
              )}, ${pluriel(c.ressources, "ressource")}`,
            ),
          )
        : html`<p class="discret">Aucun champ personnalisé.</p>`
    }
    <form method="post" action="/administration/domaines/champ"
      class="etroit"><label>Nouveau champ <input type="text" name="nom" required maxlength="60"></label><label>Type <select name="type">${Object.entries(
        TYPES_CHAMP,
      ).map(
        ([v, libelle]) => html`<option value="${v}">${libelle}</option>`,
      )}</select></label><button>Créer le champ</button></form>
  `;
};

/**
 * Les listes du périmètre, communes au filtre de la bibliothèque et à celui du chat. Sans thème
 * dans les cours du compte, la liste des thèmes disparaît.
 */
export const selectsPerimetre = (cat: Catalogue, p: Scope, l: Libelles) =>
  html`
      <label>${l.matiere} <select name="matiere_id"><option value="">Tout</option>${options(
        cat.matieres,
        p.matiere_id,
      )}</select></label>
      <label>${l.cours} <select name="cours_id"><option value="">Tout</option>${options(
        cat.cours.map((c) => ({
          id: c.id,
          nom: `${cat.matieres.find((m) => m.id === c.matiere_id)?.nom} / ${c.nom}`,
        })),
        p.cours_id,
      )}</select></label>
      ${
        cat.themes.length
          ? html`<label>${l.regroupement} <select name="theme_id"><option value="">Tout</option>${options(
              cat.themes.map((t) => ({
                id: t.id,
                nom: `${
                  cat.matieres.find(
                    (m) => m.id === cat.cours.find((c) => c.id === t.cours_id)?.matiere_id,
                  )?.nom
                } / ${cat.cours.find((c) => c.id === t.cours_id)?.nom} / ${t.nom}`,
              })),
              p.theme_id,
            )}</select></label>`
          : ""
      }
  `;

/** Un terme réglé n'a pas de genre : « tous les cours » ne s'accorderait pas avec « matière ». */
const TOUT = "Toutes les ressources";
/**
 * Le choix du cours : un bouton ouvre la grille des cours, rangés par matière, chaque thème sous
 * son cours. Un lien applique le choix. `garder` : les paramètres de la page que le choix garde.
 */
export const filtre = (
  cat: Catalogue,
  p: Scope,
  action: string,
  l: Libelles,
  garder: Record<string, string> = {},
) => {
  const lien = (champs: Record<string, string>) => {
    const q = new URLSearchParams(Object.entries(garder).filter(([, v]) => v));
    for (const [k, v] of Object.entries(champs)) q.set(k, v);
    return `${action}?${q}`;
  };
  const actuel = (vrai: boolean) => html`aria-current="${String(vrai)}"`;
  const c = cat.cours.find((x) => x.id === p.cours_id);
  const t = cat.themes.find((x) => x.id === p.theme_id);
  const choisi = p.theme_id
    ? t
      ? `${cat.cours.find((x) => x.id === t.cours_id)?.nom}, ${t.nom}`
      : `${l.regroupement} indisponible`
    : p.cours_id
      ? (c?.nom ?? `${l.cours} indisponible`)
      : p.matiere_id
        ? (cat.matieres.find((m) => m.id === p.matiere_id)?.nom ?? `${l.matiere} indisponible`)
        : TOUT;
  const plusieurs = cat.matieres.length > 1;
  const vue = garder.vue ?? "";
  const portee = Object.fromEntries(Object.entries(p).filter(([, v]) => v));
  return html`
    <div class="biblio-outils">
      ${
        cat.cours.length || choisi !== TOUT
          ? html`
        <button type="button" class="choix-cours" popovertarget="grille-cours">
          <span class="discret">${l.cours}</span> ${choisi} ${icone("caret-down")}
        </button>
        <nav id="grille-cours" popover aria-label="${l.cours_pluriel}">
          <a href="${lien({ cours_id: "" })}" ${actuel(
            !p.matiere_id && !p.cours_id && !p.theme_id && !p.matieres,
          )}>${TOUT}</a>
          ${cat.matieres.map((m) => {
            const cours = cat.cours.filter((x) => x.matiere_id === m.id);
            return cours.length
              ? html`
              ${
                plusieurs
                  ? html`<a class="matiere" href="${lien({ matiere_id: m.id })}" ${actuel(
                      p.matiere_id === m.id && !p.cours_id && !p.theme_id,
                    )}>${m.nom}</a>`
                  : ""
              }
              <ul>${cours.map(
                (x) => html`
                <li>
                  <a href="${lien({ cours_id: x.id })}" ${actuel(
                    p.cours_id === x.id && !p.theme_id,
                  )}>${x.nom}${x.public ? html`<small>${x.public}</small>` : ""}</a>
                  ${cat.themes
                    .filter((y) => y.cours_id === x.id)
                    .map(
                      (y) =>
                        html`<a class="theme" href="${lien({ cours_id: x.id, theme_id: y.id })}" ${actuel(
                          p.theme_id === y.id,
                        )}>${y.nom}</a>`,
                    )}
                </li>
              `,
              )}</ul>
            `
              : "";
          })}
        </nav>
      `
          : ""
      }
      ${
        action === "/eleve"
          ? html`<nav class="segments" aria-label="Affichage">${(
              [
                ["", "Liste", "list"],
                ["grille", "Images", "squares-four"],
              ] as const
            ).map(
              ([v, nom, i]) =>
                html`<a href="${lien({ ...portee, vue: v })}" title="${nom}" ${actuel(
                  v === vue,
                )}>${icone(i)}<span class="visuellement-cache">${nom}</span></a>`,
            )}</nav>`
          : ""
      }
    </div>
  `;
};

export const choixMatiere = (cat: Catalogue, l: Libelles, id = "") =>
  html`
    <form method="get" action="/prof/depot"
      class="barre"><label>${l.matiere} <select name="matiere_id"><option value="">Non classée</option>${options(
        cat.matieres,
        id,
      )}</select></label><button>Choisir les champs</button></form>
  `;
/** Les cours rangés par matière. Le thème d'un cours ne s'affiche qu'une fois le cours coché. */
export const liens = (cat: Catalogue, l: Libelles, valeurs: Affiliation[] = []) =>
  html`<fieldset class="rattachement"><legend><strong>${l.cours_pluriel} de rattachement</strong></legend><input type="hidden" name="affiliations_presentes" value="1"><p class="aide">Les membres des cours cochés lisent la ressource, dans la limite de ses lecteurs. Une ressource rattachée garde au moins un cours.</p>${cat.matieres.map(
    (m) => {
      const cours = cat.cours.filter((c) => c.matiere_id === m.id);
      return cours.length
        ? html`<fieldset><legend>${m.nom}</legend>${cours.map((c) => {
            const lien = valeurs.find((v) => v.cours_id === c.id);
            const themes = cat.themes.filter((t) => t.cours_id === c.id);
            return html`
              <div class="lien-cours"><label><input type="checkbox" name="cours" value="${
                c.id
              }" ${lien ? "checked" : ""}> ${c.nom}</label>${
                themes.length
                  ? html`<label class="theme-cours">${l.regroupement} <select name="theme_${
                      c.id
                    }" aria-label="${l.regroupement} dans ${c.nom}"><option value="">Sans ${minuscule(
                      l.regroupement,
                    )}</option>${options(themes, lien?.theme_id ?? "")}</select></label>`
                  : ""
              }</div>
            `;
          })}</fieldset>`
        : "";
    },
  )}</fieldset>`;
export const informations = (
  liste: Champ[],
  meta: Record<string, unknown>,
  propositions: Record<string, string> = {},
) =>
  html`${liste.map((c) => {
    const propose = !meta[c.cle] && Boolean(propositions[c.cle]);
    return html`
      <div
        class="champ"><label for="${c.cle}">${c.label}</label>${
          propose ? html`<p class="aide" id="${c.cle}-aide">Proposé par Thot, à vérifier.</p>` : ""
        }<input id="${c.cle}" name="${c.cle}" type="${
          c.type === "date" ? "date" : "text"
        }" value="${String(meta[c.cle] || propositions[c.cle] || "")}" maxlength="120" ${
          propose ? html`aria-describedby="${c.cle}-aide"` : ""
        }></div>
    `;
  })}`;
export const langue = (valeur = "fr") =>
  html`
    <label>Langue de la source <input type="text" name="langue" value="${valeur}" maxlength="30"></label><p
      class="aide">Français (fr) et anglais (en) pris en charge : une question en français trouve aussi les passages en anglais. Autres langues : recherche non prise en charge.</p>
  `;
export const champsScope = (p: Record<string, string>) =>
  html`${Object.entries(p).map(([n, v]) => html`<input type="hidden" name="${n}" value="${v}">`)}`;
