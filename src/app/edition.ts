import {
  type Champ,
  type Citation,
  type Contenu,
  CRITERES,
  type ImageQuestion,
  MAX_TEXTE,
  OPTIONS,
  type Option,
  type Question,
  TYPES_QUESTION,
  transformer,
} from "../core/activite.ts";
import { erreursQuestion } from "../core/questions.ts";
import { texte } from "../core/texte.ts";
import {
  type Activite,
  ancrerPassage,
  deposerImage,
  imagesCitables,
  MAX_IMAGE,
  sourcesCitables,
} from "./activites.ts";
import type { Db } from "./db.ts";
import { libelles } from "./termes.ts";

/** Les langages proposés pour une réponse en code, que Shiki colore. */
export const LANGAGES = [
  "html",
  "css",
  "javascript",
  "typescript",
  "json",
  "python",
  "php",
  "sql",
  "bash",
  "java",
  "csharp",
  "yaml",
] as const;

// Le formulaire d'une question, dans les deux sens. Chaque champ `cle` (consigne, attendu, retour,
// critere_0…, option_0…) a son texte sous `cle` et ses passages sous `cle_p0`, `cle_s0`… : le
// passage collé et l'identifiant de sa source.

/** Les valeurs texte d'un formulaire de question, telles que la page les réaffiche. */
export type Saisie = Record<string, string | string[]>;
/** Le corps reçu : du texte, et le fichier d'une image déposée. */
type Corps = Record<string, string | File | (string | File)[]>;

/** Passages au plus par champ. Chacun est cherché dans tout le texte de sa source. */
export const MAX_PASSAGES = 5;

/** Un identifiant court, pour une question ou une option. */
export const nouvelId = () => crypto.randomUUID().slice(0, 8);

/**
 * Une valeur texte du formulaire, vide si elle manque, est un fichier ou se répète. Le navigateur
 * envoie les fins de ligne d'une zone de texte en CRLF : elles redeviennent des LF.
 */
export const un = (b: Corps | Saisie, k: string) => {
  const v = b[k];
  return typeof v === "string" ? v.replace(/\r\n?/g, "\n") : "";
};

/** Le texte du formulaire, sans fichier, pour réafficher une saisie refusée. */
export const saisie = (b: Corps): Saisie =>
  Object.fromEntries(
    Object.entries(b).flatMap(([k, v]) => {
      const textes = [v].flat().filter((x) => typeof x === "string");
      return textes.length ? [[k, Array.isArray(v) ? textes : textes[0]]] : [];
    }),
  );

/** Le formulaire rempli avec une question enregistrée. */
export function saisieDe(q: Question): Saisie {
  const s: Saisie = {
    indice: q.indice ?? "",
    ou: q.ou ?? "",
    image_alt: q.image?.alt ?? "",
    image_media: q.image?.media ?? "",
  };
  const champ = (cle: string, ch: Champ) => {
    s[cle] = ch.texte;
    ch.citations.forEach((c, j) => {
      s[`${cle}_s${j}`] = c.source_id;
      s[`${cle}_p${j}`] = c.citation;
    });
  };
  champ("consigne", q.consigne);
  champ("retour", q.retour);
  if (q.type === "redigee") {
    champ("attendu", q.attendu);
    q.criteres.forEach((ch, i) => champ(`critere_${i}`, ch));
    s.langage = q.langage ?? "";
  } else if (q.type === "terme") {
    s.accepte = q.accepte.join("\n");
  } else {
    q.options.forEach((o, i) => {
      champ(`option_${i}`, o.texte);
      s[`option_${i}_id`] = o.id;
    });
    s.juste = q.options.flatMap((o, i) => (o.juste ? [String(i)] : []));
  }
  return s;
}

/**
 * Le champ `cle` et ses passages. Chaque passage est cherché mot pour mot dans la version servie de
 * sa source, qui doit être citable dans le cours d'origine : rien de ce que le formulaire dit d'une
 * citation, hors du texte collé et de la source, n'est repris. Un passage vidé disparaît, et un
 * champ sans texte n'en garde aucun.
 */
function champ(db: Db, a: Activite, b: Corps, cle: string, nom: string, requis: boolean): Champ {
  const t = texte(un(b, cle), nom, MAX_TEXTE, requis);
  if (!t) return { texte: "", citations: [] };
  const citations: Citation[] = [];
  for (let j = 0; j <= MAX_PASSAGES; j++) {
    const passage = un(b, `${cle}_p${j}`).trim();
    if (!passage) continue;
    if (citations.length === MAX_PASSAGES) {
      throw new Error(`${nom} : ${MAX_PASSAGES} passages au plus.`);
    }
    if (passage.length > MAX_TEXTE) throw new Error(`${nom} : un passage est trop long.`);
    const source = un(b, `${cle}_s${j}`);
    if (!source) throw new Error(`${nom} : choisissez la source du passage.`);
    citations.push(ancrerPassage(db, a, source, passage, nom));
  }
  return { texte: t, citations };
}

/**
 * L'image de la question : retirée, déposée, prise dans une source citable du cours, ou l'image
 * déjà déposée. Le formulaire ne nomme jamais un fichier : seul celui de `avant` se garde. Le dépôt
 * passe en dernier, une fois la question valide.
 */
async function image(
  db: Db,
  a: Activite,
  b: Corps,
  avant?: ImageQuestion,
): Promise<ImageQuestion | undefined> {
  if (un(b, "image_retirer")) return undefined;
  const fichier = [b.image_fichier].flat().find((f) => f instanceof File && f.size > 0) as
    | File
    | undefined;
  const media = un(b, "image_media");
  if (!fichier && !media && !avant?.fichier) return undefined;
  const alt = texte(un(b, "image_alt"), "Texte alternatif de l'image", 300, false);
  if (!alt)
    throw new Error("Image : décrivez-la dans le texte alternatif, pour qui ne la voit pas.");
  if (fichier) {
    if (fichier.size > MAX_IMAGE) throw new Error("Image : 5 Mo au plus.");
    return { fichier: await deposerImage(a.id, new Uint8Array(await fichier.arrayBuffer())), alt };
  }
  if (media) {
    const i = imagesCitables(db, a).find((x) => x.id === media);
    if (!i)
      throw new Error(
        `Image : choisissez une image d'une source citable de ${libelles(db).formes.cours.ce}.`,
      );
    return { media: i.id, source: i.source_id, alt };
  }
  return { fichier: avant!.fichier, alt };
}

/** `neuf` avec ses clés dans l'ordre de `avant` : une question inchangée garde le même JSON. */
function ordre(avant: unknown, neuf: unknown): unknown {
  if (Array.isArray(neuf)) {
    return neuf.map((x, i) => ordre(Array.isArray(avant) ? avant[i] : undefined, x));
  }
  if (!neuf || typeof neuf !== "object") return neuf;
  const a = (avant && typeof avant === "object" ? avant : {}) as Record<string, unknown>;
  const n = neuf as Record<string, unknown>;
  const cles = [...new Set([...Object.keys(a), ...Object.keys(n)])].filter((k) => k in n);
  return Object.fromEntries(cles.map((k) => [k, ordre(a[k], n[k])]));
}

/**
 * Lit le formulaire d'une question. `avant` : la question enregistrée, dont le type et les
 * identifiants d'options se gardent. Sans elle, le type vient du formulaire. Une saisie invalide
 * lève une erreur lisible. Le formulaire est la frontière de confiance : types, longueurs,
 * identifiants, indices d'options, source et image sont vérifiés ici, chaque passage réancré, et
 * aucun avis de juge n'est repris.
 */
export async function lireQuestion(
  db: Db,
  a: Activite,
  b: Corps,
  id: string,
  avant?: Question,
): Promise<Question> {
  const type = avant?.type ?? TYPES_QUESTION.find((t) => t === un(b, "type"));
  if (!type) throw new Error("Type de question inconnu.");
  const indice = texte(un(b, "indice"), "Indice", 500, false);
  const ou = un(b, "ou");
  if (ou && !sourcesCitables(db, a).some((s) => s.id === ou)) {
    throw new Error(
      `Où chercher : choisissez une source citable de ${libelles(db).formes.cours.ce}.`,
    );
  }
  const commun = {
    id,
    type,
    consigne: champ(db, a, b, "consigne", "Consigne", true),
    retour: champ(db, a, b, "retour", "Retour", false),
    ...(indice && { indice }),
    ...(ou && { ou }),
  };
  let q: Question;
  if (type === "redigee") {
    const criteres = Array.from({ length: CRITERES.max }, (_, i) =>
      un(b, `critere_${i}`).trim() ? champ(db, a, b, `critere_${i}`, `Critère ${i + 1}`, true) : [],
    ).flat();
    const langage = un(b, "langage");
    if (langage && !(LANGAGES as readonly string[]).includes(langage)) {
      if (avant?.type !== "redigee" || avant.langage !== langage) {
        throw new Error("Langage inconnu.");
      }
    }
    q = {
      ...commun,
      type,
      attendu: champ(db, a, b, "attendu", "Réponse attendue", false),
      criteres,
      ...(langage && { langage }),
    };
  } else if (type === "terme") {
    const accepte = [
      ...new Set(
        un(b, "accepte")
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    ];
    if (accepte.length > 20 || accepte.some((x) => x.length > 200)) {
      throw new Error("Réponses acceptées : 20 au plus, de 200 caractères chacune.");
    }
    q = { ...commun, type, accepte };
  } else {
    const justes = new Set([b.juste ?? []].flat().filter((x) => typeof x === "string"));
    const ids = new Set(avant && "options" in avant ? avant.options.map((o) => o.id) : []);
    const options: Option[] = [];
    for (let i = 0; i < OPTIONS.max; i++) {
      if (!un(b, `option_${i}`).trim()) continue;
      const voulu = un(b, `option_${i}_id`);
      const oid = ids.delete(voulu) ? voulu : nouvelId();
      const texteOption = champ(db, a, b, `option_${i}`, `Option ${i + 1}`, true);
      options.push({ id: oid, texte: texteOption, juste: justes.has(String(i)) });
    }
    q = { ...commun, type, options };
  }
  const erreurs = erreursQuestion(q);
  if (erreurs.length)
    throw new Error(erreurs.map((e) => e[0].toUpperCase() + e.slice(1)).join(" "));
  const i = await image(db, a, b, avant?.image);
  if (i) q.image = i;
  return ordre(avant, q) as Question;
}

/**
 * Cherche de nouveau chaque passage de la série dans la version servie de sa source, après une
 * nouvelle version de la source. Un passage qui n'y est plus lève une erreur qui nomme sa question.
 */
export function reancrer(db: Db, a: Activite, c: Contenu): Contenu {
  return {
    ...c,
    questions: c.questions.map((q, i) =>
      transformer(q, (ch) => ({
        ...ch,
        citations: ch.citations.map((x) =>
          ancrerPassage(db, a, x.source_id, x.citation, `Question ${i + 1}`),
        ),
      })),
    ),
  };
}
