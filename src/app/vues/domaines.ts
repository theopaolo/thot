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
import { ongletsAdministration } from "./administration.ts";

const options = (liste: { id: string; nom: string }[], valeur = "") =>
  liste.map(
    (m) => html`<option value="${m.id}" ${m.id === valeur ? "selected" : ""}>${m.nom}</option>`,
  );
export const selectionProfil = (valeur = "general") =>
  html`<label>Profil <select name="profil">${Object.entries(PROFILS).map(
    ([id, p]) => html`<option value="${id}" ${id === valeur ? "selected" : ""}>${p.nom}</option>`,
  )}</select></label>`;
const LIBELLES = { matiere: "matière", cours: "cours", theme: "thème", champ: "champ" };
/** `ouvert` : le cours que la page rouvre après l'envoi. */
const ligne = (
  genre: keyof typeof LIBELLES,
  id: string,
  nom: string,
  contexte = "",
  terme = LIBELLES[genre],
  ouvert = "",
) => {
  const libelle = `Nom (${terme})`;
  return html`
    <form method="post" action="/administration/domaines/renommer" class="barre">
      <input type="hidden" name="genre" value="${genre}"><input type="hidden" name="id" value="${id}">
      ${ouvert ? html`<input type="hidden" name="ouvert" value="${ouvert}">` : ""}
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
/**
 * `ouvert` : le cours ou la matière que la page déplie. `etape` : l'étape suivante de la création
 * guidée, après une matière (`cours`) ou après un cours (`membres`). `ressources` : le nombre de
 * ressources rattachées à chaque cours.
 */
export type Inscriptions = {
  membres: Map<string, Inscrit[]>;
  comptes: Inscrit[];
  ouvert: string;
  etape?: "cours" | "membres";
  ressources?: Map<string, number>;
};
const ROLES: Record<string, string> = { enseignant: "enseignant", eleve: "élève" };
const membresDuCours = (c: Cours, inscrits: Inscrit[], comptes: Inscrit[]) => {
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
      <h3>Membres : ${inscrits.length}</h3>
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
                      <button aria-label="Retirer ${m.nom} de ${c.nom}"
                        data-confirmer="Retirer ${m.nom} de ${c.nom} ? Le compte reste, il ne lit plus les ressources de ce cours.">Retirer</button>
                    </form>
                  </td>
                </tr>
              `,
            )}</tbody>
          </table>
        `
          : html`<p class="discret">Aucun membre. Les élèves membres lisent les ressources
            publiées du cours et y posent leurs questions.</p>`
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
      <p class="aide">Un enseignant du cours crée aussi ses élèves, ou partage un lien
      d'inscription, depuis la page <a href="/prof/eleves">Élèves</a>.</p>
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
/**
 * Les réglages d'une matière, repliés sous son titre : son nom, puis les informations que le dépôt
 * demande pour elle, une case par champ du catalogue. Une matière arts garde cochés les champs que
 * le quiz lit.
 */
const reglagesMatiere = (m: Matiere, d: ChampsDepot, ouvert: boolean, l: Libelles) => {
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
    <details class="ajout" id="champs-${m.id}" ${ouvert || conflit ? "open" : ""}>
      <summary>Réglages de ${m.nom}</summary>
      <h3>Nom</h3>
      ${ligne("matiere", m.id, m.nom, "", l.matiere)}
      <p class="aide">Renommer garde les rattachements. Supprimer est refusé tant qu'une ressource ou
      une question d'élève l'utilise.</p>
      <h3>Informations demandées au dépôt : ${d.listes.get(m.id)?.length ?? 0}</h3>
      <p class="aide">Les champs que l'étape « Ajouter des informations » du dépôt propose pour
      cette matière.</p>
      ${
        conflit
          ? html`<p role="alert" tabindex="-1" autofocus>Quelqu'un a modifié ces réglages pendant votre saisie. Vos valeurs sont conservées : enregistrez pour remplacer les siennes.</p>`
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
/**
 * Le formulaire d'un nouveau cours. Sans `matiereId`, il demande la matière. `decrit` : l'id du
 * message d'étape qui décrit le champ du nom.
 */
const formCours = (
  cat: Catalogue,
  l: Libelles,
  matiereId = "",
  focus = false,
  fin: unknown = "",
  decrit = "",
) =>
  html`
    <form method="post" action="/administration/domaines/cours" class="etroit">
      ${
        matiereId
          ? html`<input type="hidden" name="matiere_id" value="${matiereId}">`
          : html`<label>${l.matiere} <select name="matiere_id" required>${options(
              cat.matieres,
            )}</select></label>`
      }
      <label>${l.cours} à créer <input type="text" name="nom" required maxlength="200" ${
        focus ? "autofocus" : ""
      } ${decrit ? html`aria-describedby="${decrit}"` : ""}></label>
      <label>${l.niveau} (facultatif) <input type="text" name="public" maxlength="200"></label>
      <label>Objectif (facultatif) <textarea name="objectif" maxlength="4000"></textarea></label>
      <div class="barre"><button class="principal">Créer et continuer</button>${fin}</div>
    </form>
  `;

/**
 * Une action rapide : un bouton ouvre son formulaire dans un panneau, sans script. `corps` reçoit
 * le bouton qui referme le panneau.
 */
const actionRapide = (
  id: string,
  terme: string,
  etape: string,
  corps: (annuler: unknown) => unknown,
) =>
  html`
    <button type="button" popovertarget="${id}">${icone("plus")}<span><span
      class="visuellement-cache">Ajouter : </span>${terme}</span></button>
    <div id="${id}" popover class="panneau" role="dialog" aria-label="Ajouter : ${terme}">
      ${etape ? html`<p class="discret">${etape}</p>` : ""}
      ${corps(
        html`<button type="button" popovertarget="${id}" popovertargetaction="hide">Annuler</button>`,
      )}
    </div>
  `;

/**
 * Un cours déplié montre son nom, ses membres, ses thèmes et ses liens vers le dépôt et la
 * bibliothèque. Le mode personnel n'a qu'un compte : il n'affiche pas les membres.
 */
const blocCours = (c: Cours, cat: Catalogue, i: Inscriptions, l: Libelles, personnel: boolean) => {
  const inscrits = i.membres.get(c.id) ?? [];
  const themes = cat.themes.filter((t) => t.cours_id === c.id);
  const ouvert = i.ouvert === c.id;
  const resume = [
    c.public,
    personnel ? "" : pluriel(inscrits.length, "membre"),
    pluriel(i.ressources?.get(c.id) ?? 0, "ressource"),
    themes.length ? nombre(themes.length, l.regroupement, l.regroupements) : "",
  ].filter(Boolean);
  return html`
    <details class="cours" id="cours-${c.id}" ${ouvert ? "open" : ""}>
      <summary><strong>${c.nom}</strong> <span class="discret">${resume.join(", ")}</span></summary>
      <div class="cours-corps">
        ${
          ouvert && i.etape === "membres"
            ? html`<p role="status" tabindex="-1" autofocus>Étape 3 sur 3 : ${
                personnel ? "ajoutez ses ressources" : "ajoutez ses membres, puis ses ressources"
              } avec « Déposer dans ce cours ».</p>`
            : ""
        }
        ${c.objectif ? html`<p>${c.objectif}</p>` : ""}
        <div class="barre">
          <a class="bouton" href="/prof/depot?matiere_id=${c.matiere_id}&cours=${c.id}">${icone(
            "upload-simple",
          )}Déposer dans ce cours</a>
          <a href="/prof?cours_id=${c.id}">Voir ses ressources</a>
        </div>
        ${personnel ? "" : membresDuCours(c, inscrits, i.comptes)}
        <h3>${l.regroupements}</h3>
        ${
          themes.length
            ? themes.map((t) => ligne("theme", t.id, t.nom, "", l.regroupement, c.id))
            : html`<p class="discret">Aucun. Les ressources se rangent directement dans le cours.</p>`
        }
        <form method="post" action="/administration/domaines/theme" class="barre">
          <input type="hidden" name="cours_id" value="${c.id}"><input type="hidden" name="ouvert" value="${c.id}">
          <input type="text" name="nom" required maxlength="200" aria-label="${l.regroupement} à créer dans ${c.nom}"
            placeholder="${l.regroupement} à créer">
          <button>Ajouter</button>
        </form>
        <details class="ajout">
          <summary>Renommer ou supprimer ce cours</summary>
          ${ligne("cours", c.id, c.nom, "", l.cours, c.id)}
        </details>
      </div>
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
  personnel = false,
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
  const { ouvert, etape } = inscriptions;
  const nouvelle = etape === "cours" ? cat.matieres.find((m) => m.id === ouvert) : undefined;
  const formMatiere = (annuler: unknown) => html`
    <form method="post" action="/administration/domaines/matiere" class="etroit">
      <label>${l.matiere} à créer <input type="text" name="nom" required maxlength="200" ${
        etape ? "" : "autofocus"
      }></label>
      ${profil ? "" : selectionProfil()}
      <div class="barre"><button class="principal">Créer et continuer</button>${annuler}</div>
    </form>
  `;
  return html`
    <h1>Administration</h1>
    ${ongletsAdministration("/administration/domaines", l)}
    ${erreur ? html`<p role="alert">${erreur}</p>` : ""}
    <p class="sous-titre">Les ressources se rangent sur trois niveaux : ${l.matiere}, puis ${minuscule(
      l.cours,
    )}, puis ${minuscule(l.regroupement)}. ${
      personnel
        ? "Choisir un cours dans la vue élève limite vos questions à ses ressources."
        : "Les élèves membres d'un cours lisent ses ressources publiées et y posent leurs questions."
    }</p>
    <div class="barre actions-rapides">
      ${actionRapide(
        "ajout-matiere",
        l.matiere,
        personnel
          ? "Étape 1 sur 3. Les étapes suivantes créent son premier cours, puis y ajoutent des ressources."
          : "Étape 1 sur 3. Les étapes suivantes créent son premier cours, puis y ajoutent membres et ressources.",
        formMatiere,
      )}
      ${
        cat.matieres.length
          ? actionRapide(
              "ajout-cours",
              l.cours,
              personnel
                ? "L'étape suivante y ajoute des ressources."
                : "Les étapes suivantes y ajoutent membres et ressources.",
              (annuler) => formCours(cat, l, "", !etape, annuler),
            )
          : ""
      }
    </div>
    ${
      cat.matieres.length
        ? ""
        : html`<p>Aucune matière pour l'instant. Commencez par en créer une avec le bouton
          ci-dessus : elle regroupera vos cours.</p>`
    }
    ${cat.matieres.map((m) => {
      const cours = cat.cours.filter((c) => c.matiere_id === m.id);
      return html`
        <section class="matiere" id="matiere-${m.id}" aria-labelledby="titre-${m.id}">
          <div class="matiere-tete">
            <h2 id="titre-${m.id}">${m.nom}</h2>
            <span class="discret">${nombre(cours.length, l.cours, l.cours_pluriel)}</span>
            <span class="espace"></span>
            ${actionRapide(`ajout-cours-${m.id}`, `${l.cours} dans ${m.nom}`, "", (annuler) =>
              formCours(cat, l, m.id, !etape, annuler),
            )}
          </div>
          ${reglagesMatiere(m, champs, ouvert === m.id && etape === undefined, l)}
          ${
            nouvelle?.id === m.id
              ? html`<p role="status" id="etape-${m.id}">Étape 2 sur 3 : créez le premier cours de
                « ${m.nom} ».</p>${formCours(cat, l, m.id, true, "", `etape-${m.id}`)}`
              : ""
          }
          ${cours.map((c) => blocCours(c, cat, inscriptions, l, personnel))}
        </section>
      `;
    })}
    <h2 class="reglages-communs">Réglages communs</h2>
    <p>L'instance garde un seul profil d'import, partagé par toutes ses matières. Il se change tant
    qu'aucune ressource n'est déposée. La recherche est prise en charge en français uniquement.</p>
    ${controleProfil}
    <h3>Champs personnalisés</h3>
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
 * `tout` nomme le choix sans cours, `themes: false` ne propose que les cours.
 */
export const filtre = (
  cat: Catalogue,
  p: Scope,
  action: string,
  l: Libelles,
  garder: Record<string, string> = {},
  { tout = TOUT, themes = true } = {},
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
        : tout;
  const plusieurs = cat.matieres.length > 1;
  const vue = garder.vue ?? "";
  const portee = Object.fromEntries(Object.entries(p).filter(([, v]) => v));
  return html`
    <div class="biblio-outils">
      ${
        cat.cours.length || choisi !== tout
          ? html`
        <div class="champ-cours">
          <span class="etiquette" id="etiquette-cours">${l.cours}</span>
          <button type="button" class="choix-cours" id="bouton-cours" popovertarget="grille-cours" aria-labelledby="etiquette-cours bouton-cours">
            ${choisi} ${icone("caret-down")}
          </button>
        </div>
        <nav id="grille-cours" popover aria-label="${l.cours_pluriel}">
          <a href="${lien({ cours_id: "" })}" ${actuel(
            !p.matiere_id && !p.cours_id && !p.theme_id && !p.matieres,
          )}>${tout}</a>
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
                  ${(themes ? cat.themes : [])
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
                ["grille", "Dossiers", "squares-four"],
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

/**
 * L'étape « Où les ranger ? » du dépôt : un cours du compte, avec son thème, ou un cours qu'un
 * administrateur crée avec le dépôt, dans une matière existante ou nouvelle. Le thème et les champs
 * du nouveau cours ne s'affichent que sous le choix coché (CSS `:has`). Un seul cours, ou `?cours=`,
 * est coché d'office.
 */
export const rangementDepot = (
  cat: Catalogue,
  l: Libelles,
  o: {
    saisie: Record<string, string>;
    creer: boolean;
    sansProfil: boolean;
    personnel?: boolean;
    erreur?: string;
  },
) => {
  const v = o.saisie;
  const choisi = v.cours ?? (cat.cours.length === 1 ? cat.cours[0].id : "");
  const nouveau = o.creer && (choisi === "nouveau" || !cat.cours.length);
  const cours = (c: Cours) => {
    const themes = cat.themes.filter((t) => t.cours_id === c.id);
    return html`
      <div class="lien-cours">
        <label><input type="radio" name="cours" value="${c.id}" required ${
          choisi === c.id ? "checked" : ""
        } data-chemin="${cat.matieres.find((m) => m.id === c.matiere_id)?.nom} / ${c.nom}"> ${c.nom}${c.public ? html` <span class="discret">${c.public}</span>` : ""}</label>
        ${
          themes.length
            ? html`<label class="theme-cours">${l.regroupement} <select name="theme_${
                c.id
              }" aria-label="${l.regroupement} dans ${c.nom}"><option value="">Sans ${minuscule(
                l.regroupement,
              )}</option>${options(themes, v[`theme_${c.id}`])}</select></label>`
            : ""
        }
      </div>
    `;
  };
  return html`
    ${o.erreur ? html`<p role="alert">${o.erreur}</p>` : ""}
    ${
      cat.cours.length
        ? html`<p class="aide">${
            o.personnel
              ? ""
              : "Les membres du cours lisent ses ressources, dans la limite des lecteurs de l'étape suivante. "
          }D'autres cours s'ajoutent ensuite sur la page de la ressource.</p>`
        : o.creer
          ? html`<p class="aide">Aucun cours pour l'instant. Créez le premier : il rangera ces
            ressources.</p>`
          : html`<p>Vous n'êtes membre d'aucun cours. Un administrateur crée les cours et vous y
            inscrit. En attendant, ces ressources restent non classées.</p>`
    }
    <fieldset class="rangement">
      <legend class="visuellement-cache">${l.cours}</legend>
      ${cat.matieres.map((m) => {
        const liste = cat.cours.filter((c) => c.matiere_id === m.id);
        return liste.length ? html`<p class="matiere-depot">${m.nom}</p>${liste.map(cours)}` : "";
      })}
      ${
        o.creer
          ? html`
          <div class="nouveau-cours">
            <label><input type="radio" name="cours" value="nouveau" required ${
              nouveau ? "checked" : ""
            }> ${icone("plus")}Créer un cours</label>
            <div class="nouveau-cours-champs">
              ${
                cat.matieres.length
                  ? html`<label>${l.matiere} <select name="nouveau_matiere">${options(
                      cat.matieres,
                      v.nouveau_matiere,
                    )}<option value="nouvelle" ${
                      v.nouveau_matiere === "nouvelle" ? "selected" : ""
                    }>Créer une matière</option></select></label>`
                  : html`<input type="hidden" name="nouveau_matiere" value="nouvelle">`
              }
              <div class="nouvelle-matiere ${cat.matieres.length ? "selon-choix" : ""}">
                <label>${l.matiere} à créer <input type="text" name="nouvelle_matiere"
                  maxlength="200" value="${v.nouvelle_matiere ?? ""}" data-requis></label>
                ${o.sansProfil ? selectionProfil(v.profil) : ""}
              </div>
              <label>${l.cours} à créer <input type="text" name="nouveau_cours" maxlength="200"
                value="${v.nouveau_cours ?? ""}" data-requis></label>
            </div>
          </div>
        `
          : ""
      }
    </fieldset>
  `;
};
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
