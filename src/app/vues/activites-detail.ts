import { html } from "hono/html";
import {
  type Champ,
  champsQuestion,
  type Contenu,
  type Explication,
  type Question,
  TYPES_QUESTION,
} from "../../core/activite.ts";
import { SEUIL_SOUTIEN } from "../../core/reponse.ts";
import { icone } from "../icones.ts";
import { minuscule } from "../instance.ts";
import { enrichi, enrichiLigne, imageQuestion, NOMS_TYPE } from "./questions.ts";
import { avis, etat, option, passages, pluriel, typeDe } from "./activites.ts";
import { type DetailProf, formulaire } from "./activites-formulaire.ts";
import { jour } from "./commun.ts";

// Page d'une activité

const ACTIONS: Record<string, string> = {
  relue: "Relu",
  publiee: "Publié",
  modifiee: "Modifié",
  a_revoir: "Signalé à revoir",
};

type Servies = DetailProf["servies"];

const VIDE_SOURCE = "Vide : sa source a été supprimée.";

/** Le texte d'un champ, puis ses preuves. Sans passage, il est rédigé par l'enseignant. */
const champ = (ch: Champ, servies: Servies, vide: string, signer: boolean) =>
  ch.texte
    ? html`${enrichi(ch.texte)}${
        ch.citations.length
          ? html`${avis(ch)}${passages(ch, servies)}`
          : signer
            ? html`<p class="discret">Rédigé par l'enseignant</p>`
            : ""
      }`
    : html`<p class="discret">${vide}</p>${passages(ch, servies)}`;

/** Le contenu propre au type : réponse attendue et critères, options, ou réponses acceptées. */
const corpsType = (q: Question, servies: Servies, signer: boolean) => {
  if (q.type === "redigee") {
    const code = q.langage && q.attendu.texte && !q.attendu.texte.includes("```");
    return html`
      <h4>Réponse attendue</h4>
      ${
        code
          ? html`<pre data-langage="${q.langage}"><code>${q.attendu.texte}</code></pre>${
              q.attendu.citations.length
                ? html`${avis(q.attendu)}${passages(q.attendu, servies)}`
                : signer
                  ? html`<p class="discret">Rédigé par l'enseignant</p>`
                  : ""
            }`
          : champ(q.attendu, servies, "Vide.", signer)
      }
      ${
        q.criteres.length
          ? html`<h4>Critères</h4><ol>${q.criteres.map(
              (ch) => html`<li>${champ(ch, servies, VIDE_SOURCE, signer)}</li>`,
            )}</ol>`
          : ""
      }`;
  }
  if (q.type === "terme") {
    return html`<h4>Réponses acceptées</h4><ul>${q.accepte.map((x) => html`<li>${x}</li>`)}</ul>`;
  }
  // Une option fausse n'affirme rien : elle ne dit pas qui l'a rédigée.
  return html`<ol type="A">${q.options.map(
    (o) =>
      html`<li>${o.texte.texte ? enrichiLigne(o.texte.texte) : html`<span class="discret">${VIDE_SOURCE}</span>`}${
        o.juste ? html` <span class="statut certifiee">Bonne réponse</span>` : ""
      }${o.texte.citations.length ? html`${avis(o.texte)}${passages(o.texte, servies)}` : ""}</li>`,
  )}</ol>`;
};

/** Une question en lecture, avec ses actions. */
const lecture = (d: DetailProf, n: number, q: Question, i: number) => {
  const { a, servies } = d;
  // Une question sans aucun passage le dit une fois, pas sous chaque champ.
  // Une consigne vide vient d'une source supprimée, pas de l'enseignant.
  const enseignant = !!q.consigne.texte && champsQuestion(q).every((ch) => !ch.citations.length);
  return html`<section class="question-prof" id="q-${q.id}">
    <h3>Question ${i + 1} <span class="discret">${NOMS_TYPE[q.type]}${
      q.type === "redigee" && q.langage ? `, ${q.langage}` : ""
    }${enseignant ? ", rédigée par l'enseignant" : ""}</span></h3>
    ${imageQuestion(a.id, q.image)}
    ${champ(q.consigne, servies, VIDE_SOURCE, !enseignant)}
    ${corpsType(q, servies, !enseignant)}
    ${q.indice ? html`<p><strong>Indice :</strong> ${enrichiLigne(q.indice)}</p>` : ""}
    ${q.ou ? html`<p><strong>Où chercher :</strong> ${d.titres.get(q.ou) ?? "source supprimée"}</p>` : ""}
    ${
      q.retour.texte || q.retour.citations.length
        ? html`<h4>Retour</h4>${champ(q.retour, servies, VIDE_SOURCE, !enseignant)}`
        : html`<p class="discret">Pas de retour.</p>`
    }
    ${actions(d, n, q, i)}
  </section>`;
};

/**
 * Modifier, puis les autres actions dans un menu ancré sous son bouton. Le menu reste dans le
 * formulaire : ses boutons envoient la version lue. Sans ancrage CSS, il s'ouvre au centre.
 */
const actions = (d: DetailProf, n: number, q: Question, i: number) => {
  const { a } = d;
  const id = encodeURIComponent(q.id);
  const base = `/prof/activites/${a.id}/questions/${id}`;
  return html`<form method="post" class="barre actions-question">
    <input type="hidden" name="revision" value="${a.revision}">
    <a class="bouton" href="/prof/activites/${a.id}?modifier=${id}#q-${id}">${icone("pencil-simple")}Modifier</a>
    <button type="button" popovertarget="menu-${q.id}" style="anchor-name: --menu-${i}">${icone("dots-three")}Autres actions</button>
    <div id="menu-${q.id}" popover class="menu-question" style="position-anchor: --menu-${i}">
      <button formaction="${base}/dupliquer">${icone("copy")}Dupliquer</button>
      <button formaction="${base}/regenerer">${icone("arrows-clockwise")}Proposer une autre question</button>
      <button formaction="${base}/monter" class="filet" ${i === 0 ? "disabled" : ""}>${icone("arrow-up")}Monter</button>
      <button formaction="${base}/descendre" ${i === n - 1 ? "disabled" : ""}>${icone("arrow-down")}Descendre</button>
      ${
        n > 2
          ? html`<div class="deplacer">
            <label for="rang-${q.id}">Déplacer en position</label>
            <select id="rang-${q.id}" name="rang">${Array.from(
              { length: n },
              (_, k) =>
                html`<option value="${k + 1}" ${k === i ? "selected" : ""}>${k + 1}${k === i ? ", actuelle" : ""}</option>`,
            )}</select>
            <button formaction="${base}/deplacer">${icone("arrows-down-up")}Déplacer</button>
          </div>`
          : ""
      }
      <button formaction="${base}/supprimer" class="danger filet" ${n === 1 ? "disabled" : ""}
        data-confirmer="Supprimer la question ${i + 1} ? La version suivante ne l'aura plus.">${icone("trash")}Supprimer</button>
    </div>
  </form>`;
};

/**
 * Ce qu'une question demande à l'enseignant : « À revoir » quand une citation ne vise plus la
 * version servie ou que sa consigne est vide, « À vérifier » quand le juge ne soutient pas un champ.
 */
const aFaire = (q: Question, servies: Servies) =>
  !q.consigne.texte ||
  champsQuestion(q).some((ch) => ch.citations.some((c) => servies.get(c.source_id) !== c.revision))
    ? "À revoir"
    : champsQuestion(q).some(
          (ch) =>
            ch.citations.length && typeof ch.soutien === "number" && ch.soutien < SEUIL_SOUTIEN,
        )
      ? "À vérifier"
      : "";

/** L'index de la série, collé à droite des questions sur un écran large, comme le sommaire du lecteur. */
const indexQuestions = (
  d: DetailProf,
  contenu: Contenu,
) => html`<nav class="sommaire" aria-labelledby="index-questions">
  <h2 id="index-questions">${pluriel(contenu.questions.length, "question")}</h2>
  <ol>${contenu.questions.map((q, i) => {
    const etat = aFaire(q, d.servies);
    return html`<li><a href="#q-${q.id}"><span class="chiffres">${i + 1}.</span> ${NOMS_TYPE[q.type]}${
      etat ? html` <span class="statut failed">${etat}</span>` : ""
    }</a></li>`;
  })}</ol>
</nav>`;

const choixType = (nom: string, id: string) =>
  html`<select id="${id}" name="${nom}">${TYPES_QUESTION.map((t) => option(t, NOMS_TYPE[t], ""))}</select>`;

/** Les questions dans l'ordre, l'une d'elles ouverte en formulaire, puis l'ajout d'une question. */
const questions = (d: DetailProf, contenu: Contenu) => {
  const { a, edition: e } = d;
  const rejets = JSON.parse(a.rejets) as string[];
  const n = contenu.questions.length;
  const nouvelle = e && !contenu.questions.some((q) => q.id === e.id);
  return html`
    <h2>Questions</h2>
    ${
      rejets.length
        ? html`<p class="discret">${pluriel(rejets.length, "champ")} rejeté${
            rejets.length > 1 ? "s" : ""
          } à la génération : ${rejets.join(" ")}</p>`
        : ""
    }
    <div class="questions-colonnes"><div>
    ${contenu.questions.map((q, i) =>
      e?.id === q.id ? formulaire(d, e, i, q) : lecture(d, n, q, i),
    )}
    ${
      nouvelle
        ? formulaire(d, e, n)
        : html`<div class="ajout-question">
          <form method="get" action="/prof/activites/${a.id}#q-nouvelle" class="barre reglage">
            <input type="hidden" name="modifier" value="nouvelle">
            <label for="ajout-type">Ajouter une question</label>
            ${choixType("type", "ajout-type")}
            <button>Ajouter</button>
          </form>
          <form method="post" action="/prof/activites/${a.id}/questions/proposer" class="barre reglage">
            <input type="hidden" name="revision" value="${a.revision}">
            <label for="proposer-type">Faire rédiger une question par Thot</label>
            ${choixType("type", "proposer-type")}
            <button>Faire rédiger</button>
          </form>
        </div>`
    }
    </div>${indexQuestions(d, contenu)}</div>
  `;
};

/** Les phrases d'une explication et leurs preuves. L'aperçu élève les montre rangées en blocs. */
const corpsExplication = (e: Explication, servies: Servies) => html`
  ${
    e.juge_indisponible
      ? html`<p><span class="statut a_relire">Juge indisponible</span> <span class="discret">Une phrase au moins est passée sans l'avis du juge de soutien.</span></p>`
      : ""
  }
  ${
    e.partielle
      ? html`<p class="discret">Explication partielle : Thot a retiré les phrases dont la citation ne tenait pas.</p>`
      : ""
  }
  <h2>Phrases</h2>
  ${
    e.affirmations.length
      ? html`<ol>${e.affirmations.map(
          (x) =>
            html`<li><p>${x.texte}</p>${passages({ citations: [{ ...x, revision: x.revision ?? 1 }] }, servies)}</li>`,
        )}</ol>`
      : html`<p class="discret">Vide : ses sources ont été supprimées.</p>`
  }
  <p class="discret">L'aperçu élève montre les titres et le rangement en blocs, qui viennent du modèle sans preuve.</p>
`;

/**
 * Titre, date à rendre, objectif, cours et corrigé, dans un seul formulaire replié. Son résumé dit
 * les cours, le corrigé et la date. Retirer un cours passe par un formulaire à part, hors de celui-ci :
 * un bouton imbriqué deviendrait le bouton par défaut de la touche Entrée.
 */
const reglages = (d: DetailProf) => {
  const { a, contenu, libelles: l } = d;
  const serie = "questions" in contenu;
  const prive = a.audience === "prive";
  const resume = [
    prive ? "" : d.cours.map((c) => c.nom).join(", "),
    serie
      ? contenu.correction === "question"
        ? "corrigé après chaque question"
        : "corrigé après la remise"
      : "",
    a.a_rendre_le ? `à rendre le ${jour(a.a_rendre_le)}` : "",
  ].filter(Boolean);
  return html`<details class="reglages-activite" ${d.cours.some((c) => c.bloquantes.length) ? "open" : ""}>
    <summary>Réglages <span class="discret">${resume.join(", ")}</span></summary>
    <form method="post" action="/prof/activites/${a.id}/reglages">
      <input type="hidden" name="revision" value="${a.revision}">
      <div class="champ">
        <label for="titre">Titre</label>
        <input type="text" id="titre" name="titre" value="${a.titre}" maxlength="300" required>
      </div>
      <div class="champ">
        <label for="a_rendre_le">À rendre le</label>
        <input type="date" id="a_rendre_le" name="a_rendre_le" value="${a.a_rendre_le ?? ""}">
      </div>
      <div class="champ">
        <label for="objectif">Objectif</label>
        <select id="objectif" name="objectif_id">${d.objectifs.map((o) =>
          option(o.id, o.intitule, a.objectif_id),
        )}</select>
        <p class="aide">${a.reference ? `Référence : ${a.reference}. ` : ""}<a href="/prof/objectifs">Renommer ou fusionner les objectifs</a></p>
      </div>
      ${
        serie
          ? html`<div class="champ">
            <label for="correction">Corrigé</label>
            <select id="correction" name="correction">${[
              option("question", "Après chaque question", contenu.correction),
              option("serie", "Après la remise de la série", contenu.correction),
            ]}</select>
            <p class="aide">Le changer crée la version ${a.revision + 1}, à relire.</p>
          </div>`
          : ""
      }
      ${
        prive
          ? ""
          : html`<fieldset class="cours-activite">
            <legend><strong>${l.cours_pluriel}</strong></legend>
            <ul>${d.cours.map(
              (c) =>
                html`<li>${c.nom}${
                  c.bloquantes.length
                    ? html` <span class="statut failed">Ne tient plus : ${c.bloquantes.join(", ")}</span>`
                    : ""
                } ${
                  c.id === a.cours_id
                    ? html`<span class="discret">origine, porte l'objectif</span>`
                    : html`<button class="lien" form="retirer-${c.id}" aria-label="Retirer ${c.nom}">Retirer</button>`
                }</li>`,
            )}</ul>
            ${
              d.autres.length
                ? html`<label for="ajout-cours">Ajouter à un ${minuscule(l.cours)}</label>
                  <select id="ajout-cours" name="cours_id">${[
                    option("", "Aucun", ""),
                    ...d.autres.map((c) => option(c.id, c.nom, "")),
                  ]}</select>`
                : ""
            }
          </fieldset>`
      }
      <div class="barre"><button>Enregistrer</button></div>
    </form>
    ${
      prive
        ? ""
        : d.cours
            .filter((c) => c.id !== a.cours_id)
            .map(
              (c) =>
                html`<form id="retirer-${c.id}" method="post" action="/prof/activites/${a.id}/cours/${c.id}/retirer"></form>`,
            )
    }
  </details>`;
};

/** La page d'une activité : ses réglages, ses questions à modifier, ses réponses, son historique. */
export const detailProf = (d: DetailProf) => {
  const { a, contenu } = d;
  const personnel = a.audience === "prive";
  const explication = "affirmations" in contenu;
  const fautifs = d.cours.filter((c) => c.bloquantes.length);
  return html`
    <p><a href="/prof/activites">Bibliothèque</a></p>
    <h1>${a.titre}</h1>
    <p class="discret">${typeDe(a.type, explication ? null : contenu.questions.length)}, version ${a.revision} ${etat(a)}</p>
    ${d.erreur && !d.edition ? html`<p role="alert">${d.erreur}</p>` : ""}
    ${
      personnel
        ? html`<p class="note">${
            explication ? "Explication privée, générée" : "Exercice privé, généré"
          } par Thot. Votre relecture ne vaut pas relecture indépendante.</p>`
        : ""
    }
    ${
      a.etat === "a_revoir"
        ? html`<div role="alert"><p>Une source citée a une nouvelle version, n'est plus citable ou a été supprimée${
            fautifs.length
              ? `. Ne tiennent plus : ${fautifs.map((c) => `${c.bloquantes.join(", ")} dans ${c.nom}`).join(", ")}`
              : ""
          }. ${
            explication
              ? "Les élèves ne reçoivent plus cette explication. Préparez-en une autre."
              : "Les élèves ne reçoivent plus cet exercice. Cherchez ses passages dans la version actuelle des sources, modifiez les questions qui ne tiennent plus ou retirez le cours fautif."
          }</p>${
            explication
              ? ""
              : html`<form method="post" action="/prof/activites/${a.id}/reancrer">
                <input type="hidden" name="revision" value="${a.revision}">
                <button>Chercher les passages dans la version actuelle</button>
              </form>`
          }</div>`
        : ""
    }
    <div class="barre">
      ${
        a.etat === "brouillon"
          ? html`<form method="post" action="/prof/activites/${a.id}/relire">
            <input type="hidden" name="revision" value="${a.revision}">
            <button class="principal">Marquer la version ${a.revision} relue</button>
          </form>`
          : ""
      }
      ${
        a.etat === "relue"
          ? html`<form method="post" action="/prof/activites/${a.id}/publier">
            <input type="hidden" name="revision" value="${a.revision}">
            <button class="principal">${personnel ? "Publier pour m'entraîner" : "Publier aux élèves du cours"}</button>
          </form>`
          : ""
      }
      <a class="bouton" href="/prof/activites/${a.id}/apercu">Aperçu élève</a>
      ${explication ? "" : html`<a class="bouton" href="/prof/activites/${a.id}/reponses">Réponses</a>`}
      <form method="post" action="/prof/activites/${a.id}/archiver">
        <input type="hidden" name="oui" value="${a.archivee_le ? "0" : "1"}">
        ${
          a.archivee_le
            ? html`<button>Désarchiver</button>`
            : html`<button data-confirmer="Archiver cette activité ? Les élèves ne la reçoivent plus. Leurs tentatives restent lisibles.">Archiver</button>`
        }
      </form>
      ${
        d.supprimable
          ? html`<form method="post" action="/prof/activites/${a.id}/supprimer">
            <button class="danger" data-confirmer="Supprimer ce brouillon ? Il n'a jamais été publié. Rien ne le rétablit.">Supprimer le brouillon</button>
          </form>`
          : ""
      }
    </div>
    ${reglages(d)}
    ${explication ? corpsExplication(contenu, d.servies) : questions(d, contenu)}
    ${
      d.suivi && !explication
        ? html`<h2>Réponses</h2>
          <p>${pluriel(d.suivi.remis, "élève")} sur ${d.suivi.eleves} ${
            d.suivi.remis > 1 ? "ont" : "a"
          } remis une tentative, toutes versions confondues. <a href="/prof/activites/${a.id}/reponses">Lire les réponses</a></p>`
        : ""
    }
    <details>
      <summary>Historique des versions</summary>
      ${
        d.relectures.length
          ? html`<table>
            <thead><tr><th>Action</th><th>Version</th><th>Par</th><th>Date</th></tr></thead>
            <tbody>${d.relectures.map(
              (r) =>
                html`<tr><td>${ACTIONS[r.action] ?? r.action}</td><td>${r.revision}</td><td>${
                  r.nom ?? "Thot"
                }</td><td>${jour(r.le)}</td></tr>`,
            )}</tbody>
          </table>`
          : html`<p class="discret">Pas encore relu.</p>`
      }
    </details>
  `;
};
