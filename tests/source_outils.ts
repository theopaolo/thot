import { revendiquer, traiter } from "../src/app/ingestion.ts";
import { fauxModeles, session } from "./outils.ts";

export const CHAMPS = {
  titre: "Art nouveau, panorama",
  type_document: "cours",
  matiere: "arts-appliques",
  classe: "2nde",
  sequence: "ATC Art Nouveau",
};

/** Suit la redirection d'une ancienne adresse de séquence vers la page de son thème. */
export const suivre = async (
  s: { requete: (chemin: string) => Promise<Response> | Response },
  chemin: string,
) => {
  const r = await s.requete(chemin);
  return r.status === 302 ? s.requete(r.headers.get("location")!) : r;
};

export type Acces = { audience: "prive" | "collegues" | "eleves"; reponses: boolean };

export const formulaire = (
  champs: Record<string, string>,
  fichier: Uint8Array,
  nom = "fiche.pdf",
  acces: Acces = { audience: "eleves", reponses: true },
) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.append(k, v);
  f.append("audience", acces.audience);
  if (acces.reponses) f.append("reponses", "1");
  f.append("fichier", new File([fichier as Uint8Array<ArrayBuffer>], nom));
  return f;
};

export const enc = (s: string) => new TextEncoder().encode(s);
/** Les mêmes octets feraient un doublon: chaque dépôt d'un test prend sa variante. */
export const variante = (octets: Uint8Array, n: string) =>
  enc(`${new TextDecoder().decode(octets)}<!-- ${n} -->`);
/** Un administrateur : ces tests portent sur la sélection, pas sur les cours du lecteur. */
export const ELEVE = { id: "", enseignant: false, administrateur: true };

// Une page HTML suffit à exercer extraction, légende, certification et recherche sans pdftotext.
export const PAGE = enc(`<html><head><title>t</title></head><body><h1>Casa Batlló, Antoni Gaudí</h1>
<img src="data:image/jpeg;base64,/9j/wAARCAACAAIDAREAAhEAAxEA/9kA" />
<p>La façade de la Casa Batlló est couverte de céramique irisée et ses balcons évoquent des masques.</p>
<p>Gaudí refuse la ligne droite dans toute la façade.</p>
<p>Le toit en écailles de céramique rappelle le dos d'un dragon, et les cheminées torsadées prolongent le mouvement de la façade jusqu'au ciel de Barcelone.</p></body></html>`);

export async function sourceTraitee(
  db: Parameters<typeof traiter>[0],
  legende = "Façade ondulée aux balcons en forme de masques.",
  acces?: Acces,
  // Le compte qui dépose possède la source: lui seul (ou un administrateur) peut ensuite la modifier.
  prof?: Awaited<ReturnType<typeof session>>,
) {
  const { requete } = prof ?? (await session(db, fauxModeles().modeles, "enseignant"));
  await requete("/prof/depot", {
    method: "POST",
    body: formulaire(CHAMPS, PAGE, "casa.html", acces),
  });
  const job = revendiquer(db)!;
  await traiter(db, job, fauxModeles({ legende }).modeles);
  return db.prepare("SELECT id FROM sources").get()!.id as string;
}

export const REPONSE_CITEE = JSON.stringify({
  affirmations: [
    {
      texte: "Gaudí refuse la ligne droite.",
      extrait: 1,
      citation: "Gaudí refuse la ligne droite dans toute la façade",
    },
  ],
});

export async function poserQuestion(
  requete: Awaited<ReturnType<typeof session>>["requete"],
  texte = "ligne droite",
) {
  const r = await requete("/eleve/questions", {
    method: "POST",
    headers: { "HX-Request": "true" },
    body: new URLSearchParams({ texte }),
  });
  return (await r.text()).match(/messages\/([\w-]+)\/flux/)![1];
}
