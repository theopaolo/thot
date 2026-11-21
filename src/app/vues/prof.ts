import { html } from "hono/html";
import type { Bloc } from "../../core/document.ts";
import { type Audience, AUDIENCES, CLASSES, MAX_LOT, TYPES_DOCUMENT } from "../depot.ts";
import { icone } from "../icones.ts";
import { type Affiliation, type Catalogue, MATIERES } from "../domaines.ts";
import type { Champ, Profil } from "../../core/profils.ts";
import type { Libelles } from "../instance.ts";
import * as Domaines from "./domaines.ts";
import { texteDocument } from "./document.ts";
import { champ, champFichier, jour, lecteurs, nombre } from "./commun.ts";
import { ETATS_JOB, JOBS_ACTIFS, STATUTS } from "./prof-lignes.ts";

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
const tableEleves = (
  liste: Eleve[],
  action: (e: Eleve) => unknown,
  cours?: (e: Eleve) => unknown,
) =>
  html`
    <table class="eleves">
      <thead>
        <tr>
          <th>Élève</th>
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
      ? Domaines.filtre(
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
      <p>Vous n'avez pas encore de cours. Un administrateur vous inscrit à un cours, puis vous y ajoutez vos élèves.</p>
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
    <p class="sans-impression"><a href="/prof/eleves">Retour aux élèves</a></p>
  `;

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
  /** une extraction plus récente, dont le texte a changé */
  attente?: { n: number; cree_le: string; avertissements: string[]; blocs: Bloc[] };
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
            L'extraction du ${jour(d.attente.cree_le)} a changé le texte. Les lecteurs et Thot
            gardent le texte actuel tant que cette version n'est pas certifiée. Les réponses déjà
            données gardent le passage qu'elles citent.
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
          <div class="document">${texteDocument(d.attente.blocs)}</div>
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
    <h2>${d.attente ? "Texte actuel" : "Texte extrait"}</h2>
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

export type ALegender = ImageVue & {
  source_id: string;
  titre: string;
  restantes: number;
  credit: string | null;
};

export const legende = (i: ALegender | undefined, file: { id: string; titre: string }[] = []) =>
  i
    ? html`
      <div id="legende" class="relecture" tabindex="-1">
        <nav class="file" aria-label="Légendes à relire">
          <p><strong>${i.restantes}</strong> à relire</p>
          <ol>${file.map(
            (f) =>
              html`
              <li><a href="/prof/legendes?image=${f.id}" title="${f.titre}" aria-current="${String(
                f.id === i.id,
              )}"><img src="/media/${f.id}" alt="${f.titre}" loading="lazy"></a></li>
            `,
          )}</ol>
        </nav>
        <div class="relecture-plan">
          <figure class="relecture-image">
            <img src="/media/${i.id}" alt="Image à légender de ${i.titre}">
          </figure>
          <form
            class="relecture-proposition"
            hx-target="#legende"
            hx-swap="outerHTML"
            hx-disabled-elt="find button"
          >
            <p class="discret">Source</p>
            <h2><a href="/prof/sources/${i.source_id}">${i.titre}</a></h2>
            <label for="texte">Légende proposée</label>
            <p class="aide">Seule une légende validée peut être citée à un élève.</p>
            <textarea id="texte" name="texte" rows="7">${i.legende ?? ""}</textarea>
            <label for="credit">Crédit</label>
            <input type="text" id="credit" name="credit" value="${i.credit ?? ""}">
            <input type="hidden" name="image" value="${i.id}">
            <div class="barre">
              <button class="principal" hx-post="/prof/legendes/certified" data-raccourci="v"
                aria-keyshortcuts="v">
                ${icone("check")}Valider <kbd aria-hidden="true">V</kbd>
              </button>
              <button hx-post="/prof/legendes/rejected" data-raccourci="r" aria-keyshortcuts="r">
                ${icone("x")}Rejeter <kbd aria-hidden="true">R</kbd>
              </button>
            </div>
            <p class="raccourcis discret">
              <span class="touche"><kbd>E</kbd> modifier la légende</span>
              <span><kbd>←</kbd> <kbd>→</kbd> changer d'image depuis une vignette</span>
              <label><input type="checkbox" id="raccourcis-actifs" checked> Raccourcis clavier V, R et E</label>
            </p>
          </form>
        </div>
      </div>
    `
    : html`
      <p id="legende">Les légendes que Thot propose pour les images de vos ressources s'affichent ici, et aucune n'attend votre relecture.</p>
    `;

export const pageLegendes = (i: ALegender | undefined, file: { id: string; titre: string }[]) =>
  html`
    <h1>Relire les légendes</h1>
    ${legende(i, file)}
  `;
