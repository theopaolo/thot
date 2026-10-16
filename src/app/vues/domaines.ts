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
import type { Libelles } from "../instance.ts";
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
    ${ongletsAdministration("/administration/domaines")}
    ${erreur ? html`<p role="alert">${erreur}</p>` : ""}
    <p>L'instance garde un seul profil d'import, partagé par toutes ses matières. Il se change tant
    qu'aucune ressource n'est déposée. La recherche est prise en charge en français uniquement.</p>
    ${controleProfil}
    <p>Renommer garde les rattachements. Supprimer est refusé tant qu'une ressource ou une question
    d'élève utilise l'entrée. Une matière ou un cours emporte tout ce qu'il contient.</p>
    <h2>Matières</h2>
    ${cat.matieres.map(
      (m) =>
        html`${ligne("matiere", m.id, m.nom)}${champsDuDepot(m, champs, inscriptions.ouvert === m.id)}`,
    )}
    <form method="post" action="/administration/domaines/matiere"
      class="etroit"><label>Nouvelle matière <input type="text" name="nom" required maxlength="200"></label>${
        profil ? "" : selectionProfil()
      }<button>Créer la matière</button></form>
    <h2>Cours</h2>
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
        )}${membresDuCours(
          c,
          inscriptions.membres.get(c.id) ?? [],
          inscriptions.comptes,
          inscriptions.ouvert === c.id,
        )}`,
    )}
    <form method="post" action="/administration/domaines/cours"
      class="etroit"><label>Matière <select name="matiere_id" required>${options(
        cat.matieres,
      )}</select></label><label>Nom du cours <input type="text" name="nom" required maxlength="200"></label><label>${l.niveau} <input type="text" name="public" maxlength="200"></label><label>Objectif (facultatif) <textarea name="objectif" maxlength="4000"></textarea></label><button>Créer le cours</button></form>
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
      class="etroit"><label>Cours <select name="cours_id" required>${options(
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
              `${TYPES_CHAMP[c.type]}, ${pluriel(
                [...champs.listes.values()].filter((liste) => liste.includes(c.cle)).length,
                "matière",
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

/** Les trois listes du périmètre, communes au filtre de la bibliothèque et à celui du chat. */
export const selectsPerimetre = (cat: Catalogue, p: Scope, theme = "Thème") =>
  html`
      <label>Matière <select name="matiere_id"><option value="">Toutes les matières</option>${options(
        cat.matieres,
        p.matiere_id,
      )}</select></label>
      <label>Cours <select name="cours_id"><option value="">Tous les cours</option>${options(
        cat.cours.map((c) => ({
          id: c.id,
          nom: `${cat.matieres.find((m) => m.id === c.matiere_id)?.nom} / ${c.nom}`,
        })),
        p.cours_id,
      )}</select></label>
      <label>${theme} <select name="theme_id"><option value="">${
        TOUS[theme] ?? "Tous"
      }</option>${options(
        cat.themes.map((t) => ({
          id: t.id,
          nom: `${
            cat.matieres.find(
              (m) => m.id === cat.cours.find((c) => c.id === t.cours_id)?.matiere_id,
            )?.nom
          } / ${cat.cours.find((c) => c.id === t.cours_id)?.nom} / ${t.nom}`,
        })),
        p.theme_id,
      )}</select></label>
  `;
const TOUS: Record<string, string> = {
  Thème: "Tous les thèmes",
  Séquence: "Toutes les séquences",
};

export const filtre = (
  cat: Catalogue,
  p: Scope,
  action: string,
  q = "",
  vue = "",
  theme = "Thème",
) =>
  html`
    <form method="get" action="${action}" class="biblio-outils" aria-label="Périmètre des ressources">
      ${selectsPerimetre(cat, p, theme)}
      ${
        action === "/eleve/recherche"
          ? html`<input type="text" name="q" value="${q}" aria-label="Recherche" maxlength="300">`
          : ""
      }
      ${
        action === "/eleve"
          ? html`<label>Affichage <select name="vue"><option value="">Liste</option><option value="grille" ${
              vue === "grille" ? "selected" : ""
            }>Images</option></select></label>`
          : ""
      }
      <button>Appliquer</button>
    </form>
    <p class="discret">Périmètre : ${
      cat.matieres.find((m) => m.id === p.matiere_id)?.nom ??
      (p.matiere_id ? "Matière indisponible" : "toutes les matières")
    } / ${
      cat.cours.find((c) => c.id === p.cours_id)?.nom ??
      (p.cours_id ? "Cours indisponible" : "tous les cours")
    } / ${
      cat.themes.find((t) => t.id === p.theme_id)?.nom ??
      (p.theme_id ? `${theme} indisponible` : (TOUS[theme] ?? "Tous").toLowerCase())
    }.</p>
  `;

export const choixMatiere = (cat: Catalogue, id = "") =>
  html`
    <form method="get" action="/prof/depot"
      class="barre"><label>Matière <select name="matiere_id"><option value="">Non classée</option>${options(
        cat.matieres,
        id,
      )}</select></label><button>Choisir les champs</button></form>
  `;
export const liens = (cat: Catalogue, valeurs: Affiliation[] = [], regroupement: string) =>
  html`<fieldset><legend>Cours de rattachement</legend><input type="hidden" name="affiliations_presentes" value="1"><p class="aide">Les membres des cours cochés lisent la ressource, dans la limite de ses lecteurs. Une ressource rattachée garde au moins un cours.</p>${cat.cours.map(
    (c) =>
      html`
        <div
          class="champ"><label><input type="checkbox" name="cours" value="${
            c.id
          }" ${valeurs.some((v) => v.cours_id === c.id) ? "checked" : ""}> ${
            cat.matieres.find((m) => m.id === c.matiere_id)?.nom
          } / ${c.nom}</label><label>${regroupement} <select name="theme_${
            c.id
          }"><option value="">Directement dans le cours</option>${options(
            cat.themes.filter((t) => t.cours_id === c.id),
            valeurs.find((v) => v.cours_id === c.id)?.theme_id ?? "",
          )}</select></label></div>
      `,
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
      class="aide">Français (fr) pris en charge. Anglais (en) et autres langues : recherche non prise en charge.</p>
  `;
export const champsScope = (p: Record<string, string>) =>
  html`${Object.entries(p).map(([n, v]) => html`<input type="hidden" name="${n}" value="${v}">`)}`;
