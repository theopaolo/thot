import { lireFrontMatter } from "../../core/markdown.ts";

/** Fichiers envoyés en même temps. Chacun a sa requête, la mémoire du serveur n'en porte que trois. */
const SIMULTANES = 3;

type Etat = "attente" | "envoi" | "recu" | "doublon" | "erreur";
type Ligne = {
  fichier: File;
  titre: string;
  /** la clé identifie le fichier: renvoyer la même requête ne crée pas une seconde source */
  cle: string;
  etat: Etat;
  message: string;
  id?: string;
  format: string;
  tr: HTMLTableRowElement;
};

const STATUTS: Record<Etat, [classe: string, texte: string]> = {
  attente: ["", "En attente"],
  envoi: ["en-cours", "Envoi…"],
  recu: ["certifiee", "Reçu"],
  doublon: ["a_relire", "Doublon"],
  erreur: ["failed", "Erreur"],
};

let lignes: Ligne[] = [];

const taille = (n: number) =>
  n < 1024 * 1024
    ? `${Math.max(1, Math.round(n / 1024))} Ko`
    : `${(n / 1024 / 1024).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`;

const sansExtension = (nom: string) => nom.replace(/\.[^.]+$/, "");

/** Le titre du front matter d'un Markdown, sinon le nom du fichier: la règle du serveur. */
async function titreDe(f: File) {
  const md = /\.(md|markdown)$/i.test(f.name);
  const titre = md ? lireFrontMatter(await f.slice(0, 16_384).text()).titre : undefined;
  return (titre ?? sansExtension(f.name)).replace(/\s+/g, " ").trim().slice(0, 200);
}

function cellule(tr: HTMLTableRowElement, ...enfants: (Node | string)[]) {
  const td = tr.insertCell();
  td.append(...enfants);
  return td;
}

function bouton(texte: string, nom: string, l: Ligne) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "lien";
  b.textContent = texte;
  b.dataset[nom] = "";
  b.setAttribute("aria-label", `${texte} ${l.fichier.name}`);
  return b;
}

function bilan(liste: HTMLElement) {
  const n = (etat: Etat) => lignes.filter((l) => l.etat === etat).length;
  const parties = [
    [n("recu"), "reçu", "reçus"],
    [n("doublon"), "doublon", "doublons"],
    [n("erreur"), "erreur", "erreurs"],
    [n("envoi") + n("attente"), "en attente", "en attente"],
  ]
    .filter(([k]) => k)
    .map(([k, un, plusieurs]) => `${k} ${k === 1 ? un : plusieurs}`);
  const sortie = liste.querySelector<HTMLElement>("[data-lot-bilan]")!;
  sortie.replaceChildren(parties.join(", "));
  const lot = liste.closest("form")?.querySelector<HTMLInputElement>("[name=lot]")?.value;
  if (lot && n("recu")) {
    const a = document.createElement("a");
    a.href = `/prof?lot=${encodeURIComponent(lot)}`;
    a.textContent = "Suivre ce lot dans la bibliothèque";
    sortie.append(". ", a, ".");
  }
}

/** Réécrit la ligne d'un fichier selon son état. */
function afficher(l: Ligne) {
  const liste = l.tr.closest<HTMLElement>("[data-lot-liste]")!;
  const [classe, texte] = STATUTS[l.etat];
  const statut = document.createElement("span");
  statut.className = `statut ${classe}`;
  statut.textContent = l.etat === "erreur" ? `${texte} : ${l.message}` : texte;
  const actions: (Node | string)[] = [statut];
  if (l.etat === "attente") actions.push(" ", bouton("Retirer", "retirer", l));
  if (l.etat === "erreur") actions.push(" ", bouton("Réessayer", "reessayer", l));
  if (l.etat === "doublon" || l.etat === "recu") {
    const a = document.createElement("a");
    a.href = `/prof/sources/${l.id}`;
    a.textContent = l.etat === "doublon" ? `Voir « ${l.message} »` : "Voir";
    actions.push(" ", a);
  }
  l.tr.cells[2].textContent = l.format;
  l.tr.cells[4].replaceChildren(...actions);
  l.tr.querySelector("input")!.readOnly = l.etat !== "attente" && l.etat !== "erreur";
  bilan(liste);
}

async function remplir(form: HTMLFormElement, fichiers: File[]) {
  const liste = form.querySelector<HTMLElement>("[data-lot-liste]")!;
  const corps = liste.querySelector("tbody")!;
  corps.replaceChildren();
  lignes = [];
  for (const fichier of fichiers) {
    const tr = corps.insertRow();
    const l: Ligne = {
      fichier,
      titre: await titreDe(fichier),
      cle: crypto.randomUUID(),
      etat: "attente",
      message: "",
      format: fichier.name.match(/\.([^.]+)$/)?.[1].toLowerCase() ?? "",
      tr,
    };
    const titre = document.createElement("input");
    titre.type = "text";
    titre.value = l.titre;
    titre.maxLength = 200;
    titre.setAttribute("aria-label", `Titre de ${fichier.name}`);
    titre.addEventListener("input", () => (l.titre = titre.value));
    cellule(tr, fichier.name);
    cellule(tr, titre);
    cellule(tr, "");
    cellule(tr, taille(fichier.size));
    cellule(tr);
    lignes.push(l);
    afficher(l);
  }
  liste.hidden = !lignes.length;
  // La liste porte les titres: le champ commun ne vaut plus que sans JavaScript.
  form
    .querySelector("#titre")
    ?.closest<HTMLElement>(".champ")
    ?.toggleAttribute("hidden", !!fichiers.length);
}

async function deposer(form: HTMLFormElement, l: Ligne) {
  l.etat = "envoi";
  afficher(l);
  const donnees = new FormData(form);
  donnees.delete("fichier");
  donnees.set("fichier", l.fichier);
  donnees.set("titre", l.titre);
  donnees.set("cle", l.cle);
  l.etat = "erreur";
  try {
    const r = await fetch(form.action, {
      method: "POST",
      body: donnees,
      headers: { accept: "application/json" },
    });
    if (r.redirected) l.message = "session expirée, reconnectez-vous.";
    else if (r.headers.get("content-type")?.includes("application/json")) {
      const d = await r.json();
      l.etat = d.etat;
      l.id = d.id;
      l.format = d.format ?? l.format;
      // Un doublon garde le titre de la source existante pour le lien.
      l.message = d.etat === "doublon" ? d.titre : Object.values(d.erreurs ?? {}).join(" ");
    } else l.message = r.status === 413 ? "fichier trop lourd." : `réponse ${r.status}.`;
  } catch {
    l.message = "réseau indisponible.";
  }
  afficher(l);
}

async function envoyer(form: HTMLFormElement) {
  const aFaire = lignes.filter((l) => l.etat === "attente" || l.etat === "erreur");
  const envoi = form.querySelector<HTMLButtonElement>("button.principal")!;
  envoi.disabled = true;
  let suivant = 0;
  const travailleur = async () => {
    while (suivant < aFaire.length) await deposer(form, aFaire[suivant++]);
  };
  await Promise.all(Array.from({ length: Math.min(SIMULTANES, aFaire.length) }, travailleur));
  envoi.disabled = false;
}

export function installerDepot() {
  document.addEventListener("change", (event) => {
    const champ = event.target;
    const form = champ instanceof HTMLInputElement && champ.form;
    if (form && form.matches("[data-depot]") && champ.type === "file") {
      void remplir(form, [...(champ.files ?? [])]);
    }
  });

  document.addEventListener("submit", (event) => {
    if (!(event.target instanceof HTMLFormElement) || !event.target.matches("[data-depot]")) return;
    event.preventDefault();
    void envoyer(event.target);
  });

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const form = event.target.closest<HTMLFormElement>("form[data-depot]");
    const ligne = lignes.find((l) => l.tr.contains(event.target as Node));
    if (!form || !ligne) return;
    if (event.target.closest("[data-retirer]")) {
      const suivante = ligne.tr.nextElementSibling ?? ligne.tr.previousElementSibling;
      lignes = lignes.filter((l) => l !== ligne);
      ligne.tr.remove();
      bilan(form.querySelector("[data-lot-liste]")!);
      suivante?.querySelector("button")?.focus();
    } else if (event.target.closest("[data-reessayer]")) void deposer(form, ligne);
  });
}
