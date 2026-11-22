import { html } from "hono/html";
import type { Catalogue } from "../domaines.ts";
import type { Libelles } from "../instance.ts";
import * as Perimetre from "./perimetre.ts";
import { champFichier, jour, nombre } from "./commun.ts";

export type Eleve = { id: string; identifiant: string; nom: string };

/** « Matière / cours », la matière seulement quand l'instance en a plusieurs. */
const nomCours = (cat: Catalogue, c: Catalogue["cours"][number]) =>
  cat.matieres.length > 1
    ? `${cat.matieres.find((m) => m.id === c.matiere_id)?.nom} / ${c.nom}`
    : c.nom;

type Cours = Catalogue["cours"][number];

/**
 * Le cours ouvert est celui des nouveaux comptes. Les autres cours de l'enseignant restent repliés.
 */
const choixCours = (cat: Catalogue, l: Libelles, actuel?: Cours) => {
  if (!actuel) return "";
  const autres = cat.cours.filter((c) => c.id !== actuel.id);
  return html`<input type="hidden" name="cours" value="${actuel.id}">${
    autres.length
      ? html`<details class="cours-ajout"><summary>Aussi dans d'autres ${l.cours_pluriel.toLowerCase()}</summary>${autres.map(
          (c) =>
            html`<label><input type="checkbox" name="cours" value="${c.id}"> ${nomCours(cat, c)}</label>`,
        )}</details>`
      : ""
  }`;
};

const reinitialiser = (e: Eleve) =>
  html`<form method="post" action="/prof/eleves/${e.id}/reinitialiser"><button aria-label="Nouveau mot de passe pour ${e.nom}">Nouveau mot de passe</button></form>`;

/** Le nom se lit, l'identifiant se recopie : chasse fixe pour distinguer l, I et 1. */
export const tableEleves = (
  liste: Eleve[],
  action: (e: Eleve) => unknown,
  cours?: (e: Eleve) => unknown,
  entete = "Élève",
) =>
  html`
    <table class="eleves">
      <thead>
        <tr>
          <th>${entete}</th>
          ${cours ? html`<th class="cours-eleve">Cours</th>` : ""}
          <th><span class="visuellement-cache">Actions</span></th>
        </tr>
      </thead>
      <tbody>${liste.map(
        (e) =>
          html`<tr>
            <td><span class="nom">${e.nom}</span> <span class="identifiant">${e.identifiant}</span></td>
            ${cours ? html`<td class="cours-eleve">${cours(e)}</td>` : ""}
            <td><div class="barre">${action(e)}</div></td>
          </tr>`,
      )}</tbody>
    </table>
  `;

export type Lien = {
  /** Absent pour qui n'est pas membre de tous les cours du lien. */
  jeton?: string;
  cle: string;
  places: number;
  expire_le: string;
  createur: string;
  cours: string[];
};

/**
 * Les liens actifs. Un cours du lien ne se nomme qu'à ses enseignants, et l'adresse du lien, dont
 * la page nomme tous ses cours, ne se copie que par les enseignants de tous ses cours.
 */
const liensActifs = (cat: Catalogue, liens: Lien[], adresse: string, actuel?: Cours) =>
  html`
    <h3 id="liens">Liens actifs</h3>
    ${
      liens.length
        ? html`<ul class="liens-actifs">${liens.map((l) => {
            const noms = cat.cours
              .filter((c) => l.cours.includes(c.id))
              .map((c) => nomCours(cat, c))
              .join(", ");
            return html`<li>
              <p>${l.places} place${l.places > 1 ? "s" : ""} restante${l.places > 1 ? "s" : ""}, expire le ${jour(l.expire_le)}.</p>
              <p class="discret">${!actuel || l.cours.length > 1 ? `${noms}. ` : ""}Créé par ${l.createur}.</p>
              ${
                l.jeton
                  ? ""
                  : html`<p class="discret">Ce lien ouvre aussi un cours dont vous n'êtes pas membre. Les enseignants de tous ses cours copient son adresse.</p>`
              }
              <div class="barre">
                ${
                  l.jeton
                    ? html`<button type="button" data-copier="${adresse}/inscription/${l.jeton}" aria-label="Copier le lien pour ${noms}">Copier le lien</button>`
                    : ""
                }
                <form method="post" action="/prof/eleves/liens/${l.cle}/revoquer">
                  <button aria-label="Révoquer le lien pour ${noms}" data-confirmer="Révoquer ce lien ? Les élèves qu'il a inscrits restent dans leurs cours.">Révoquer</button>
                </form>
              </div>
            </li>`;
          })}</ul>`
        : html`<p class="discret">Aucun lien actif.</p>`
    }
  `;

/**
 * Les trois façons d'ajouter des élèves, une seule ouverte à la fois. Hors d'un cours, on ouvre
 * d'abord celui qui les accueille : les cours qui ont des élèves d'abord, les autres repliés
 * derrière une ligne s'il y en a. Un administrateur sans cours crée des élèves sans cours. Une
 * instance personnelle n'a pas de lien d'inscription, et un lien demande un cours.
 */
const ajoutEleves = (
  cat: Catalogue,
  l: Libelles,
  groupes: { cours: Cours; eleves: Eleve[] }[],
  liens: Lien[] | undefined,
  adresse: string,
  actuel?: Cours,
) => {
  if (!actuel && cat.cours.length) {
    const ligne = (g: (typeof groupes)[number]) =>
      html`<li><a href="/prof/eleves?cours_id=${g.cours.id}">${nomCours(cat, g.cours)}</a>${
        g.eleves.length
          ? html` <span class="nombre">${nombre(g.eleves.length, "élève")}</span>`
          : ""
      }</li>`;
    const pleins = groupes.filter((g) => g.eleves.length);
    const vides = groupes.filter((g) => !g.eleves.length);
    const listeVides = html`<ul class="cours-eleves">${vides.map(ligne)}</ul>`;
    return html`
    <section class="ajout" aria-labelledby="titre-ajout">
      <h2 id="titre-ajout">Ajouter des élèves</h2>
      <p class="aide">Choisissez le cours qui accueille les élèves.</p>
      ${pleins.length ? html`<ul class="cours-eleves">${pleins.map(ligne)}</ul>` : ""}
      ${
        !vides.length
          ? ""
          : pleins.length
            ? html`<details><summary>${vides.length} ${
                vides.length > 1 ? l.cours_pluriel.toLowerCase() : l.cours.toLowerCase()
              } sans élève</summary>${listeVides}</details>`
            : listeVides
      }
      ${liens ? liensActifs(cat, liens, adresse) : ""}
    </section>
  `;
  }
  return html`
    <section class="ajout" aria-labelledby="titre-ajout">
      <h2 id="titre-ajout">Ajouter des élèves</h2>
      <details name="ajout" open>
        <summary>Un élève</summary>
        <form method="post" action="/prof/eleves/ajouter">
          <div class="champ">
            <label for="nom">Nom</label>
            <input id="nom" type="text" name="nom" required maxlength="100" autocomplete="off">
          </div>
          <div class="champ">
            <label for="identifiant">Identifiant</label>
            <p id="format-identifiant" class="aide">Minuscules, chiffres, point, tiret ou tiret bas.</p>
            <input id="identifiant" type="text" name="identifiant" required minlength="3" maxlength="40" pattern="[a-z0-9._\\-]+" autocomplete="off" spellcheck="false" aria-describedby="format-identifiant">
          </div>
          ${choixCours(cat, l, actuel)}
          <button class="principal">Créer et afficher le mot de passe</button>
        </form>
      </details>
      <details name="ajout">
        <summary>Une classe depuis un CSV</summary>
        <form method="post" action="/prof/eleves/importer" enctype="multipart/form-data">
          <div class="champ">
            <p class="aide">Un CSV UTF-8 aux colonnes <code>identifiant,nom</code>.</p>
            ${champFichier(".csv,text/csv")}
          </div>
          ${choixCours(cat, l, actuel)}
          <button class="principal">Importer et afficher les mots de passe</button>
        </form>
      </details>
      ${
        liens && actuel
          ? html`
        <details name="ajout">
          <summary>Un lien d'inscription</summary>
          <form method="post" action="/prof/eleves/liens">
            <p class="aide">L'élève qui ouvre le lien crée son compte, ou se connecte au sien, et rejoint le cours. Retirez ensuite les comptes qui ne sont pas ceux de vos élèves.</p>
            <div class="deux">
              <div class="champ">
                <label for="jours">Jours de validité</label>
                <input id="jours" type="number" name="jours" min="1" max="365" value="14" required>
              </div>
              <div class="champ">
                <label for="places">Places</label>
                <input id="places" type="number" name="places" min="1" max="1000" value="40" required>
              </div>
            </div>
            ${choixCours(cat, l, actuel)}
            <button class="principal">Créer le lien</button>
          </form>
        </details>
        ${liensActifs(cat, liens, adresse, actuel)}
      `
          : ""
      }
    </section>
  `;
};

/**
 * La page d'un cours liste ses élèves, qu'on retire du cours sans supprimer leur compte. Sans cours
 * choisi, la page liste tous les élèves avec leurs cours, et ceux sans cours pour un
 * administrateur.
 */
export const eleves = (o: {
  cat: Catalogue;
  actuel?: Cours;
  groupes: { cours: Cours; eleves: Eleve[] }[];
  sansCours?: Eleve[];
  liens?: Lien[];
  adresse: string;
  l: Libelles;
  matiere?: string;
  erreur?: string;
}) => {
  const { cat, actuel, l } = o;
  // Un élève de plusieurs cours n'a qu'une ligne, avec chacun de ses cours.
  const parEleve = new Map<string, { eleve: Eleve; cours: Cours[] }>();
  for (const g of o.groupes) {
    for (const e of g.eleves) {
      const ligne = parEleve.get(e.id) ?? { eleve: e, cours: [] };
      ligne.cours.push(g.cours);
      parEleve.set(e.id, ligne);
    }
  }
  const lignes = [...parEleve.values()].sort((a, b) =>
    a.eleve.nom.localeCompare(b.eleve.nom, "fr"),
  );
  const n = lignes.length;
  const compte = `${n} élève${n > 1 ? "s" : ""}`;
  const choix =
    cat.cours.length > 1
      ? Perimetre.filtre(
          cat,
          { matiere_id: o.matiere ?? "", cours_id: actuel?.id ?? "", theme_id: "" },
          "/prof/eleves",
          l,
          {},
          { tout: `Tous les ${l.cours_pluriel.toLowerCase()}`, themes: false },
        )
      : "";
  // Un enseignant inscrit chaque élève qu'il crée à un de ses cours. Un administrateur peut
  // créer un élève sans cours.
  if (!cat.cours.length && !o.sansCours) {
    return html`
      <h1>Élèves</h1>
      <p>Vous n'avez pas encore de cours. Créez-en un dans <a href="/prof/cours">Mes cours</a>, ou demandez à un collègue de vous ajouter aux siens, puis ajoutez-y vos élèves.</p>
    `;
  }
  const vide = html`
    <div class="vide">
      <p><strong>${actuel ? `Aucun élève dans ${nomCours(cat, actuel)}.` : "Aucun élève dans vos cours."}</strong></p>
      <p>${
        // Hors d'un cours, les formulaires attendent qu'on en choisisse un.
        !actuel && cat.cours.length
          ? "Choisissez un cours sous « Ajouter des élèves », puis créez"
          : "Créez"
      } les comptes un par un, importez la classe depuis un CSV${o.liens && (actuel || cat.cours.length) ? " ou partagez un lien d'inscription" : ""}.</p>
    </div>
  `;
  const liste = actuel
    ? tableEleves(
        lignes.map((x) => x.eleve),
        (e) => html`${reinitialiser(e)}
          <form method="post" action="/prof/eleves/${e.id}/retirer">
            <input type="hidden" name="cours_id" value="${actuel.id}">
            <button class="retirer" aria-label="Retirer ${e.nom} de ${actuel.nom}" data-confirmer="Retirer ${e.nom} de ${actuel.nom} ? L'élève garde son compte. Un lien d'inscription encore actif lui permet de revenir.">Retirer</button>
          </form>`,
      )
    : tableEleves(
        lignes.map((x) => x.eleve),
        reinitialiser,
        (e) =>
          parEleve
            .get(e.id)!
            .cours.map(
              (c, i) =>
                html`${i ? ", " : ""}<a href="/prof/eleves?cours_id=${c.id}">${nomCours(cat, c)}</a>`,
            ),
      );
  return html`
    ${choix}
    <h1>Élèves</h1>
    ${
      n
        ? html`<p class="sous-titre">${compte} ${
            actuel
              ? `dans ${nomCours(cat, actuel)}`
              : `dans ${o.groupes.filter((g) => g.eleves.length).length} ${l.cours_pluriel.toLowerCase()}`
          }.</p>`
        : ""
    }
    ${o.erreur ? html`<p role="alert">${o.erreur}</p>` : ""}
    <div class="effectifs">
      <div class="liste-eleves">
        ${n ? liste : vide}
        ${
          !actuel && o.sansCours?.length
            ? html`
            <h2>Sans cours</h2>
            <p class="aide">Ces élèves ne lisent que les ressources sans cours. Seuls les administrateurs les voient et les gèrent.</p>
            ${tableEleves(o.sansCours, reinitialiser)}
          `
            : ""
        }
      </div>
      ${ajoutEleves(cat, l, o.groupes, o.liens, o.adresse, actuel)}
    </div>
  `;
};

export const feuilleIdentifiants = (
  liste: { identifiant: string; nom: string; motDePasse: string }[],
  adresse: string,
  [retour, libelle] = ["/prof/eleves", "Retour aux élèves"],
) =>
  html`
    <div
      class="barre sans-impression"><h1>Identifiants à remettre</h1><span class="espace"></span><button type="button" data-imprimer>Imprimer</button></div>
    <p
      class="sans-impression">Les mots de passe ne seront plus affichés après cette page. Imprimez la feuille, puis fermez-la.</p>
    <div class="feuilles">${liste.map(
      (c) =>
        html`
        <section class="identifiants"><strong>Thot · ${c.nom}</strong>
          <p>Adresse : <span>${adresse}</span></p><p>Identifiant : <strong>${
            c.identifiant
          }</strong></p>
          <p>Mot de passe : <strong>${c.motDePasse}</strong></p>
        </section>
      `,
    )}</div>
    <p class="sans-impression"><a href="${retour}">${libelle}</a></p>
  `;
