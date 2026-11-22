import { html } from "hono/html";
import { CHAMPS, type Champ, champsVerrouilles, PROFILS } from "../../core/profils.ts";
import { type Catalogue, type Cours, type Matiere, TYPES_CHAMP } from "../domaines.ts";
import { icone } from "../icones.ts";
import { type Libelles, minuscule } from "../instance.ts";
import { majuscule } from "../../core/accords.ts";
import { ongletsAdministration } from "./administration.ts";
import { options, selectionProfil } from "./commun.ts";

const LIBELLES = { matiere: "matière", cours: "cours", theme: "thème", champ: "champ" };
const ADMINISTRATION = "/administration/domaines";
/** Renommer une entrée. Seule l'administration montre « Supprimer ». `ouvert` : le cours à rouvrir. */
export const ligne = (
  genre: keyof typeof LIBELLES,
  id: string,
  nom: string,
  contexte = "",
  terme = LIBELLES[genre],
  ouvert = "",
  action = ADMINISTRATION,
) => {
  const libelle = `Nom (${terme})`;
  return html`
    <form method="post" action="${action}/renommer" class="barre">
      <input type="hidden" name="genre" value="${genre}"><input type="hidden" name="id" value="${id}">
      ${ouvert ? html`<input type="hidden" name="ouvert" value="${ouvert}">` : ""}
      <input type="text" name="nom" value="${nom}" required maxlength="${
        genre === "champ" ? 60 : 200
      }" aria-label="${libelle}">
      <button>Renommer</button>
      ${
        action === ADMINISTRATION
          ? html`<button formaction="${ADMINISTRATION}/supprimer" formnovalidate>Supprimer</button>`
          : ""
      }
      ${contexte ? html`<span class="discret">${contexte}</span>` : ""}
    </form>
  `;
};
export const nouveauCours = (matieres: Matiere[], l: Libelles, action: string) =>
  html`<form method="post" action="${action}"
      class="etroit"><label>${l.matiere} <select name="matiere_id" required>${options(
        matieres,
      )}</select></label><label>Nom ${l.formes.cours.du} <input type="text" name="nom" required maxlength="200"></label><label>${l.niveau} <input type="text" name="public" maxlength="200"></label><label>Objectif (facultatif) <textarea name="objectif" maxlength="4000"></textarea></label><button>Créer ${l.formes.cours.le}</button></form>`;
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
const membresDuCours = (c: Cours, inscrits: Inscrit[], comptes: Inscrit[], l: Libelles) => {
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
                        data-confirmer="Retirer ${m.nom} de ${c.nom} ? Le compte reste, il ne lit plus les ressources de ${l.formes.cours.ce}.">Retirer</button>
                    </form>
                  </td>
                </tr>
              `,
            )}</tbody>
          </table>
        `
          : html`<p class="discret">Aucun membre. Les élèves membres lisent les ressources
            publiées ${l.formes.cours.du} et y posent leurs questions.</p>`
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
      <p class="aide">Un enseignant ${l.formes.cours.du} crée aussi ses élèves, ou partage un lien
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
      ${l.formes.matiere.ce}.</p>
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
              } avec « Déposer dans ${l.formes.cours.ce} ».</p>`
            : ""
        }
        ${c.objectif ? html`<p>${c.objectif}</p>` : ""}
        <div class="barre">
          <a class="bouton" href="/prof/depot?matiere_id=${c.matiere_id}&cours=${c.id}">${icone(
            "upload-simple",
          )}Déposer dans ${l.formes.cours.ce}</a>
          <a href="/prof?cours_id=${c.id}">Voir ses ressources</a>
        </div>
        ${personnel ? "" : membresDuCours(c, inscrits, i.comptes, l)}
        <h3>${l.regroupements}</h3>
        ${
          themes.length
            ? themes.map((t) => ligne("theme", t.id, t.nom, "", l.regroupement, c.id))
            : html`<p class="discret">Aucun. Les ressources se rangent directement dans ${l.formes.cours.le}.</p>`
        }
        <form method="post" action="/administration/domaines/theme" class="barre">
          <input type="hidden" name="cours_id" value="${c.id}"><input type="hidden" name="ouvert" value="${c.id}">
          <input type="text" name="nom" required maxlength="200" aria-label="${l.regroupement} à créer dans ${c.nom}"
            placeholder="${l.regroupement} à créer">
          <button>Ajouter</button>
        </form>
        <details class="ajout">
          <summary>Renommer ou supprimer ${l.formes.cours.ce}</summary>
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
  const { cours: fc, matiere: fm } = l.formes;
  const sonPremier = `${fc.selon("son premier", "sa première")} ${fc.nom}`;
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
        ? `Choisir ${fc.un} dans la vue élève limite vos questions à ses ressources.`
        : `Les élèves membres d'${fc.un} lisent ses ressources publiées et y posent leurs questions.`
    }</p>
    <div class="barre actions-rapides">
      ${actionRapide(
        "ajout-matiere",
        l.matiere,
        personnel
          ? `Étape 1 sur 3. Les étapes suivantes créent ${sonPremier}, puis y ajoutent des ressources.`
          : `Étape 1 sur 3. Les étapes suivantes créent ${sonPremier}, puis y ajoutent membres et ressources.`,
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
        : html`<p>${majuscule(fm.aucun)} pour l'instant. Commencez par en créer ${fm.selon("un", "une")} avec le bouton
          ci-dessus : ${fm.selon("il", "elle")} regroupera vos ${fc.noms}.</p>`
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
              ? html`<p role="status" id="etape-${m.id}">Étape 2 sur 3 : créez ${fc.selon("le premier", "la première")} ${fc.nom} de
                « ${m.nom} ».</p>${formCours(cat, l, m.id, true, "", `etape-${m.id}`)}`
              : ""
          }
          ${cours.map((c) => blocCours(c, cat, inscriptions, l, personnel))}
        </section>
      `;
    })}
    <h2 class="reglages-communs">Réglages communs</h2>
    <p>L'instance garde un seul profil d'import, partagé par ${fm.selon("tous", "toutes")} ses ${fm.noms}. Il se change tant
    qu'aucune ressource n'est déposée. La recherche est prise en charge en français uniquement.</p>
    ${controleProfil}
    ${
      personnel
        ? ""
        : html`
          <h3>Comptes enseignants</h3>
          <p>Un enseignant crée ses ${fc.noms} et y ajoute ses collègues depuis « Mes ${fc.noms} ». L'identifiant
          prend des minuscules, des chiffres, le point, le tiret ou le tiret bas. Le mot de passe du
          nouveau compte s'affiche une seule fois.</p>
          <form method="post" action="${ADMINISTRATION}/enseignant"
            class="etroit"><label>Identifiant <input type="text" name="identifiant" required minlength="3" maxlength="40" pattern="[a-z0-9._\\-]+" autocomplete="off" spellcheck="false"></label><label>Nom <input type="text" name="nom" required maxlength="100" autocomplete="off"></label><button>Créer et afficher le mot de passe</button></form>
        `
    }
    <h3>Champs personnalisés</h3>
    <p>Un champ se coche ensuite dans les champs du dépôt de chaque ${fm.nom}. Renommer garde ses
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
