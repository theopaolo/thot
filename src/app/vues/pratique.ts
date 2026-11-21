import { createHmac } from "node:crypto";
import { html } from "hono/html";
import {
  type Champ,
  champsQuestion,
  type Contenu,
  type Explication,
  type Option,
  type Question,
} from "../../core/activite.ts";
import { essaisMax, juste, melanger, points } from "../../core/questions.ts";
import { type Activite, corrigee, type Tentative } from "../activites.ts";
import { icone } from "../icones.ts";
import { passages, TYPES } from "./activites.ts";
import { panneauSource, reponse } from "./echange.ts";
import { type ActiviteListee, ligneActivite } from "./eleve.ts";
import { jour } from "./commun.ts";
import { enrichi, enrichiLigne, imageQuestion, lettre } from "./questions.ts";

/**
 * Les options dans l'ordre où l'élève les voit : mélangées pour lui, le même ordre à chaque
 * affichage. Le navigateur envoie la lettre affichée, pas l'identifiant de l'option, qui suit
 * souvent l'ordre où l'enseignant l'a écrite. L'élève connaît son compte et la question : la graine
 * passe par le secret de l'instance, sans lequel il ne retrouve pas l'ordre d'origine.
 */
export const optionsAffichees = (
  q: Question & { options: Option[] },
  compteId: string,
  secret: string,
) => melanger(q.options, createHmac("sha256", secret).update(`${compteId}:${q.id}`).digest("hex"));

export type Pratique = {
  a: Activite;
  contenu: Contenu;
  /** le compte qui lit la page et le secret de l'instance : ils fixent l'ordre des options */
  compteId: string;
  secret: string;
  tentative?: Tentative;
  relecteur?: string;
  /** l'aperçu de l'enseignant : la page de l'élève avant sa réponse, formulaire inactif */
  apercu?: boolean;
  /** le titre de chaque source où chercher */
  titres: Map<string, string>;
  /** une remise demandée avec des questions sans réponse : la page demande de confirmer */
  confirmer?: boolean;
  /** les réponses de la série viennent d'être enregistrées */
  enregistree?: boolean;
  /** pourquoi les réponses envoyées n'ont pas été enregistrées */
  alerte?: string;
  /**
   * Le texte d'une saisie refusée, par identifiant de question : il remplit le champ à la place de
   * la réponse enregistrée, pour que l'élève ne le retape pas.
   */
  saisie?: Record<string, string>;
};

const nombre = (n: number) => n.toLocaleString("fr-FR");
const enPoints = (n: number) => `${nombre(n)} point${n >= 2 ? "s" : ""}`;
const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? "s" : ""}`;

/** Le haut de la page élève : retour, titre, cours, qui a préparé et relu l'activité. */
const entete = (a: Activite, relecteur?: string, apercu?: boolean, contenu?: Contenu) => {
  const e = a.type === "explication" ? "e" : "";
  const parQuestion = contenu?.correction === "question";
  return html`
    ${
      apercu
        ? html`<p><a href="/prof/activites/${a.id}">Retour à l'activité</a></p>
          <p class="note">Aperçu de la page élève.${
            !contenu
              ? ""
              : parQuestion
                ? " L'élève voit les questions sans corrigé, puis le corrigé de chaque question dès qu'il l'a finie."
                : " L'élève voit les questions sans corrigé, puis le corrigé de toute la série quand il la remet."
          }</p>`
        : html`<a class="bouton retour" href="/eleve">${icone("arrow-left")}Ressources</a>`
    }
    <h1>${a.titre}</h1>
    <p class="discret"><a href="/eleve?cours_id=${a.cours_id}">${a.cours}</a>. ${
      a.audience === "prive"
        ? `${TYPES[a.type]} généré${e} par Thot à partir de tes documents. Personne d'autre que toi ne l'a relu${e}.`
        : `${TYPES[a.type]} préparé${e} par ${a.auteur}${relecteur ? `, relu${e} par ${relecteur}` : ""}.`
    }</p>
    ${
      contenu
        ? html`<p class="discret">${pluriel(contenu.questions.length, "question")}.${
            a.a_rendre_le ? ` À rendre le ${jour(a.a_rendre_le)}.` : ""
          }${
            apercu
              ? ""
              : parQuestion
                ? " Le corrigé de chaque question s'affiche dès que tu l'as finie."
                : " Le corrigé s'affiche quand tu remets la série."
          }</p>`
        : ""
    }
  `;
};

/** Les options d'un essai enregistré : un identifiant, ou des identifiants séparés par une virgule. */
const choisies = (q: Question, v?: string) =>
  new Set(v === undefined ? [] : q.type === "choix_multiple" ? v.split(",") : [v]);

/** Les champs de saisie d'une question, remplis avec `v`. `requis` : la question se valide seule. */
function saisie(
  q: Question,
  p: Pick<Pratique, "compteId" | "secret">,
  v: string | undefined,
  actif: boolean,
  requis = false,
) {
  const inactif = actif ? "" : "disabled";
  const obligatoire = requis ? "required" : "";
  if (q.type === "terme") {
    return html`<div class="champ">
      <label for="r-${q.id}">Ta réponse</label>
      <input type="text" id="r-${q.id}" name="${q.id}" value="${v ?? ""}" maxlength="200" autocomplete="off" ${obligatoire} ${inactif}>
    </div>`;
  }
  if (q.type === "redigee") {
    return html`<div class="champ">
      <label for="r-${q.id}">Ta réponse</label>
      <textarea id="r-${q.id}" name="${q.id}" maxlength="4000" rows="${q.langage ? 10 : 5}" ${
        q.langage ? html`class="code" spellcheck="false"` : ""
      } ${obligatoire} ${inactif}>${v ?? ""}</textarea>
    </div>`;
  }
  const coches = choisies(q, v);
  const type = q.type === "choix" ? "radio" : "checkbox";
  return html`<fieldset>
    <legend class="aide">${q.type === "choix" ? "Une seule réponse." : "Une ou plusieurs réponses."}</legend>
    ${optionsAffichees(q, p.compteId, p.secret).map(
      (o, i) =>
        html`<label><input type="${type}" name="${q.id}" value="${lettre(i)}" ${
          coches.has(o.id) ? "checked" : ""
        } ${type === "radio" ? obligatoire : ""} ${inactif}> ${lettre(i)}. ${enrichiLigne(o.texte.texte)}</label>`,
    )}
  </fieldset>`;
}

/** Une réponse en code, que `coloration.ts` colore. */
const code = (texte: string, langage: string) =>
  html`<pre data-langage="${langage}"><code>${texte}</code></pre>`;

/**
 * Le corrigé d'une question. Seul `pratique` l'appelle, et seulement quand `corrigee()` le
 * permet : c'est la seule fonction de la page qui écrit la réponse attendue, les critères, le
 * retour, les bonnes options, les réponses acceptées et les passages cités.
 */
function corrige(
  a: Activite,
  contenu: Contenu,
  t: Tentative,
  q: Question,
  p: Pick<Pratique, "compteId" | "secret">,
) {
  const r = t.reponses[q.id] ?? { essais: [] };
  const retour = t.retours[q.id];
  const pts = points(q, r.essais, contenu.correction, retour?.note ?? null);
  // Un champ sans passage est rédigé par l'enseignant. Une question qui n'en cite aucun le dit une fois.
  const cite = champsQuestion(q).some((ch) => ch.citations.length);
  const preuves = (ch: Champ) =>
    ch.citations.length
      ? passages(ch)
      : cite
        ? html`<p class="discret">Rédigé par l'enseignant.</p>`
        : "";
  const derniere = r.essais.at(-1);
  const note =
    retour?.note !== undefined
      ? html`<p>Note de ton enseignant : ${enPoints(retour.note)}.</p>`
      : q.type === "redigee" && r.essais.length
        ? html`<p class="discret">Ton enseignant n'a pas encore noté cette réponse.</p>`
        : "";

  let detail;
  if (q.type === "redigee") {
    detail = html`<div class="deux">
        <div>
          <h3>Ta réponse</h3>
          ${
            derniere === undefined
              ? html`<p class="discret">Pas de réponse.</p>`
              : q.langage
                ? code(derniere, q.langage)
                : html`<blockquote class="passage">${derniere}</blockquote>`
          }
        </div>
        <div>
          <h3>Réponse attendue</h3>
          ${
            q.langage && !q.attendu.texte.includes("```")
              ? code(q.attendu.texte, q.langage)
              : enrichi(q.attendu.texte)
          }
          ${preuves(q.attendu)}
        </div>
      </div>
      ${note}
      ${
        q.criteres.length
          ? html`<form method="post" action="/eleve/activites/${a.id}/tentatives/${t.id}/criteres/${q.id}">
            <fieldset>
              <legend>Coche les critères que ta réponse remplit.</legend>
              ${q.criteres.map(
                (ch, i) =>
                  html`<label><input type="checkbox" name="criteres" value="${i}" ${
                    r.criteres?.includes(i) ? "checked" : ""
                  }> ${enrichiLigne(ch.texte)}</label>${passages(ch)}`,
              )}
            </fieldset>
            ${
              r.criteres?.length
                ? html`<p class="discret">Tu as coché ${r.criteres.length} critère${
                    r.criteres.length > 1 ? "s" : ""
                  } sur ${q.criteres.length}.</p>`
                : ""
            }
            <button>Enregistrer mon auto-évaluation</button>
          </form>`
          : ""
      }`;
  } else {
    const rang = r.essais.findIndex((v) => juste(q, v));
    const verdict = !r.essais.length
      ? html`<span class="statut failed">Pas de réponse</span>`
      : rang < 0
        ? html`<span class="statut failed">Faux</span>`
        : html`<span class="statut certifiee">Juste${rang ? " au deuxième essai" : ""}</span>`;
    const essais = (montrer: (v: string) => string) =>
      r.essais.length > 1
        ? html`<p>Tes essais : ${r.essais.map(montrer).join(", puis ")}.</p>`
        : derniere !== undefined
          ? html`<p>Ta réponse : ${montrer(derniere)}.</p>`
          : "";
    if (q.type === "terme") {
      detail = html`<p>${verdict}, ${enPoints(pts ?? 0)}.</p>
        ${essais((v) => `« ${v} »`)}
        <p>Réponse attendue : ${enrichiLigne(q.accepte[0] ?? "")}</p>
        ${note}`;
    } else {
      const opts = optionsAffichees(q, p.compteId, p.secret);
      const lettres = (v: string) =>
        opts.flatMap((o, i) => (choisies(q, v).has(o.id) ? [lettre(i)] : [])).join(", ");
      const finales = choisies(q, derniere);
      detail = html`<p>${verdict}, ${enPoints(pts ?? 0)}.</p>
        ${r.essais.length > 1 ? essais(lettres) : ""}
        <ul class="options-corrigees">${opts.map(
          (o, i) =>
            html`<li>${lettre(i)}. ${enrichiLigne(o.texte.texte)}${
              o.juste ? html` <span class="statut certifiee">Bonne réponse</span>` : ""
            }${finales.has(o.id) ? html` <span class="discret">Ton choix</span>` : ""}${
              o.juste ? preuves(o.texte) : ""
            }</li>`,
        )}</ul>
        ${note}`;
    }
  }
  return html`<div class="corrige">
    ${passages(q.consigne)}
    ${detail}
    ${
      contenu.correction === "question" && q.indice && r.essais.length > 1
        ? html`<p class="discret">Indice : ${enrichiLigne(q.indice)}</p>`
        : ""
    }
    ${q.retour.texte ? html`<h3>Retour</h3>${enrichi(q.retour.texte)}${preuves(q.retour)}` : ""}
    ${
      retour?.commentaire
        ? html`<h3>Commentaire de ton enseignant</h3><blockquote class="passage">${retour.commentaire}</blockquote>`
        : ""
    }
    ${cite ? "" : html`<p class="discret">Rédigé par l'enseignant.</p>`}
  </div>`;
}

/** Ce que l'élève voit avant le corrigé, dans une série corrigée question par question. */
function essaiQuestion(p: Pratique, q: Question) {
  const r = p.tentative?.reponses[q.id] ?? { essais: [] };
  const reste = essaisMax(q, "question") - r.essais.length;
  // Une question pas finie après un essai : cet essai était faux, l'indice peut sortir.
  return html`<form method="post" action="/eleve/activites/${p.a.id}/questions/${q.id}">
    <input type="hidden" name="revision" value="${p.a.revision}">
    ${
      r.essais.length
        ? html`<p class="note">Pas tout à fait.${
            q.indice ? html` Indice : ${enrichiLigne(q.indice)}` : ""
          } Il te reste ${pluriel(reste, "essai")}.</p>`
        : ""
    }
    ${saisie(q, p, p.saisie?.[q.id] ?? r.essais.at(-1), !p.apercu, true)}
    <button class="principal" ${p.apercu ? "disabled" : ""}>${
      q.type === "redigee" ? "Envoyer ma réponse" : "Vérifier"
    }</button>
  </form>`;
}

/**
 * Le bilan d'une tentative rendue : les points des questions notées et ce qui attend l'enseignant.
 * Une tentative d'une version précédente ne compte que les questions qu'elle a finies, et garde la
 * note et le commentaire d'une question retirée depuis.
 */
function bilan(a: Activite, contenu: Contenu, t: Tentative & { rendue_le: string }) {
  const notes = contenu.questions
    .filter((q) => t.reponses[q.id]?.finie)
    .map((q) =>
      points(q, t.reponses[q.id].essais, contenu.correction, t.retours[q.id]?.note ?? null),
    );
  const notees = notes.filter((n) => n !== null);
  const attente = notes.length - notees.length;
  const retirees = Object.entries(t.retours).flatMap(([id, r]) =>
    contenu.questions.some((q) => q.id === id) ? [] : [r],
  );
  return html`<section id="bilan" class="note" aria-label="Bilan">
    <p>${contenu.correction === "serie" ? "Série remise" : "Série finie"} le ${jour(t.rendue_le)}.${
      notees.length ? ` ${enPoints(notees.reduce((x, y) => x + y, 0))} sur ${notees.length}.` : ""
    }${
      attente
        ? ` ${attente} réponse${attente > 1 ? "s rédigées attendent" : " rédigée attend"} la note de ton enseignant.`
        : ""
    }${
      t.revision === a.revision
        ? ""
        : ` Tu répondais à la version ${t.revision} de cette série, que ton enseignant a modifiée depuis.`
    }</p>
    ${retirees.map(
      (r) => html`<p>Une question à laquelle tu avais répondu n'est plus dans la série.${
        r.note === undefined ? "" : ` Note de ton enseignant : ${enPoints(r.note)}.`
      }${r.commentaire ? " Son commentaire :" : ""}</p>
      ${r.commentaire ? html`<blockquote class="passage">${r.commentaire}</blockquote>` : ""}`,
    )}
    ${
      t.a_reprendre
        ? html`<form method="post" action="/eleve/activites/${a.id}/recommencer">
          <p>Ton enseignant te propose de reprendre cette série.</p>
          <button class="principal">Recommencer</button>
        </form>`
        : ""
    }
  </section>`;
}

/**
 * La page de l'élève. Le corrigé d'une question n'y entre que lorsque `corrigee()` est vrai :
 * avant, la page porte la consigne, l'image, les options dans l'ordre de l'élève et le lien où
 * chercher. L'indice ne sort qu'après un premier essai faux, quand la correction suit chaque
 * question. Une question que la tentative remise n'a pas finie, parce qu'elle est entrée dans la
 * série après, reste sans corrigé et sans champ.
 */
export const pratique = (p: Pratique) => {
  const { a, contenu, tentative: t } = p;
  const parQuestion = contenu.correction === "question";
  const enSaisie = !parQuestion && !t?.rendue_le;
  const sansReponse = contenu.questions.filter((q) => !t?.reponses[q.id]?.essais.length).length;
  const n = contenu.questions.length;
  // Faite : finie quand le corrigé suit chaque question, enregistrée quand il suit la série.
  const faite = (q: Question) =>
    parQuestion ? !!t?.reponses[q.id]?.finie : !!t?.reponses[q.id]?.essais.length;
  const faites = contenu.questions.filter(faite).length;
  const suivante = contenu.questions.find((q) => !faite(q));
  const questions = contenu.questions.map(
    (q, i) => html`<section class="question-serie" id="q-${q.id}" aria-labelledby="t-${q.id}">
      <h2 id="t-${q.id}">Question ${i + 1}${n > 1 ? html` <span class="discret">sur ${n}</span>` : ""}</h2>
      ${imageQuestion(a.id, q.image)}
      ${enrichi(q.consigne.texte)}
      ${
        q.ou
          ? html`<p class="discret">Où chercher : <a href="/eleve/sources/${q.ou}">${
              p.titres.get(q.ou) ?? "la ressource"
            }</a></p>`
          : ""
      }
      ${
        corrigee(contenu, t, q.id)
          ? corrige(a, contenu, t!, q, p)
          : t?.rendue_le
            ? html`<p class="discret">Cette question n'était pas dans la version que tu as remise.</p>`
            : parQuestion
              ? essaiQuestion(p, q)
              : saisie(q, p, p.saisie?.[q.id] ?? t?.reponses[q.id]?.essais[0], !p.apercu)
      }
    </section>`,
  );
  return html`
    ${entete(a, p.relecteur, p.apercu, contenu)}
    ${p.alerte ? html`<p class="alerte" role="alert">${p.alerte}</p>` : ""}
    ${
      // Collée en haut de l'écran : une série de 23 questions dépasse 10 000px sur téléphone.
      t?.rendue_le || n < 2
        ? ""
        : html`<p class="avancement"><strong>${faites} ${faites > 1 ? "faites" : "faite"} sur ${n}</strong>${
            faites && suivante
              ? html` <a href="#q-${suivante.id}">Aller à la question ${contenu.questions.indexOf(suivante) + 1}</a>`
              : ""
          }</p>`
    }
    ${t?.rendue_le ? bilan(a, contenu, { ...t, rendue_le: t.rendue_le }) : ""}
    ${
      enSaisie
        ? html`<form method="post" action="/eleve/activites/${a.id}/reponses" class="serie">
          <input type="hidden" name="revision" value="${a.revision}">
          ${questions}
          <div id="remise">
            ${p.enregistree ? html`<p role="status">Tes réponses sont enregistrées.</p>` : ""}
            ${
              p.confirmer && sansReponse
                ? html`<p class="alerte">${
                    sansReponse > 1
                      ? `${sansReponse} questions n'ont pas de réponse et vaudront 0 point. Complète-les, ou remets la série quand même.`
                      : "Une question n'a pas de réponse et vaudra 0 point. Complète-la, ou remets la série quand même."
                  }</p>
                  <input type="hidden" name="confirmer" value="1">`
                : ""
            }
            <p class="aide">Enregistrer garde tes réponses pour plus tard. Remettre envoie la série : tes réponses ne changent plus, et le corrigé s'affiche.</p>
            <div class="barre">
              <button ${p.apercu ? "disabled" : ""}>Enregistrer</button>
              <button class="principal" name="remettre" value="1" ${p.apercu ? "disabled" : ""}>${
                p.confirmer && sansReponse ? "Remettre quand même" : "Remettre"
              }</button>
            </div>
          </div>
        </form>`
        : html`<div class="serie">${questions}</div>`
    }
  `;
};

/**
 * Une explication se lit comme une réponse : ses blocs, ses numéros de citation, et la feuille du
 * passage cité. Ni tentative ni corrigé.
 */
export const explication = ({
  a,
  contenu,
  relecteur,
  apercu,
}: {
  a: Activite;
  contenu: Explication;
  relecteur?: string;
  apercu?: boolean;
}) => html`
  <div class="mur-lecteur" data-feuille>
    <div>
      ${entete(a, relecteur, apercu)}
      ${reponse(
        a.id,
        { etat: "answered", affirmations: contenu.affirmations, blocs: contenu.blocs },
        null,
        [],
        false,
        `/${apercu ? "prof" : "eleve"}/activites/${a.id}/citations`,
      )}
    </div>
    <div class="colonne-source">${panneauSource()}</div>
  </div>
`;

/** Les activités publiées de l'élève, après les chapitres de son accueil. */
export const exercices = (liste: ActiviteListee[]) =>
  liste.length
    ? html`<section aria-labelledby="exercices">
      <h2 id="exercices">Exercices et explications</h2>
      <ul>${liste.map((a) => ligneActivite(a, true))}</ul>
    </section>`
    : "";
