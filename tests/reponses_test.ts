import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Db, maintenant, purgerMessages } from "../src/app/db.ts";
import { deposer, valider } from "../src/app/depot.ts";
import { revendiquer, traiter } from "../src/app/ingestion.ts";
import { lireInstance } from "../src/app/instance.ts";
import { boucleReponses, revendiquerReponse, VERROU_MS } from "../src/app/reponses.ts";
import { BONNE, environnement, fauxModeles, publier, session } from "./outils.ts";

type Session = Awaited<ReturnType<typeof session>>;
/** Pose une question comme le composeur et rend l'identifiant de l'échange. */
const poser = async (qui: Session, texte = "Pourquoi pas de ligne droite ?") => {
  const r = await qui.requete("/eleve/questions", {
    method: "POST",
    headers: { "HX-Request": "true" },
    body: new URLSearchParams({ texte }),
  });
  return (await r.text()).match(/messages\/([\w-]+)\/flux/)![1];
};
const lire = async (qui: Session, chemin: string, methode = "GET") =>
  (await qui.requete(chemin, { method: methode })).text();
const ligne = (db: Db, id: string) => db.prepare("SELECT * FROM messages WHERE id = ?").get(id)!;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** La boucle de réponses tourne en fond : on attend ce qu'elle a écrit. */
async function attendre(condition: () => unknown) {
  for (let i = 0; i < 400 && !condition(); i++) await pause(5);
  assert(condition());
}
const citee = (texte: string) => BONNE.replace("Gaudí refuse la ligne droite.", texte);

/** Un générateur qui attend `libre`, puis rend `sortie(n)` à son n-ième appel. */
function bloque(sortie = (_n: number) => BONNE) {
  const f = fauxModeles();
  const libre = Promise.withResolvers<void>();
  const signaux: AbortSignal[] = [];
  f.modeles.generer = async (_messages, signal) => {
    signaux.push(signal!);
    const n = signaux.length;
    await libre.promise;
    return { texte: sortie(n), modele: "faux" };
  };
  return { modeles: f.modeles, libre, signaux };
}

test("une réponse se termine page fermée, la liste l'annonce jusqu'à l'ouverture", async () => {
  const { db, dir } = await environnement();
  try {
    await publier(db, "Casa Batlló");
    const eleve = await session(db, fauxModeles({ sorties: [BONNE] }).modeles, "eleve");
    const autre = await session(db, fauxModeles().modeles, "eleve");
    const id = await poser(eleve);
    // Personne ne lit le flux : la boucle du serveur répond seule.
    await attendre(() => ligne(db, id).resultat);
    const m = ligne(db, id);
    assertEquals([m.etat, m.nouvelle], ["answered", 1]);
    const journal = JSON.parse(m.journal as string);
    assertEquals(journal.revendications, 1);
    assertEquals(journal.tentatives.length, 1, "les essais du générateur restent au journal");
    assert(journal.attente_ms >= 0 && journal.traitement_ms >= 0, "attente et calcul séparés");
    const conv = m.conversation_id as string;
    assertStringIncludes(await lire(eleve, "/eleve/chat/nouvelle"), "Nouvelle réponse");
    const statut = `/eleve/conversations/${conv}/etat`;
    assertStringIncludes(await lire(eleve, statut), "Nouvelle réponse");
    assertEquals(await lire(eleve, `${statut}?ouverte=1`), "");
    assertEquals((await autre.requete(statut)).status, 404);
    const ouverte = await lire(eleve, `/eleve/chat/${conv}`);
    assertStringIncludes(ouverte, "Gaudí refuse la ligne droite.");
    assert(!ouverte.includes("Nouvelle réponse"));
    assertEquals(ligne(db, id).nouvelle, 0);
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("le flux relit l'étape enregistrée, une déconnexion n'arrête ni ne relance la réponse", async () => {
  const { db, dir } = await environnement();
  const g = bloque();
  try {
    await publier(db, "Casa Batlló");
    const eleve = await session(db, g.modeles, "eleve");
    const id = await poser(eleve);
    await attendre(() => g.signaux.length);
    const etape = "Rédaction à partir des passages trouvés";
    assertEquals(ligne(db, id).etape, etape);
    await (await eleve.requete(`/eleve/messages/${id}/flux`)).body!.cancel();
    const page = await lire(eleve, `/eleve/chat/${ligne(db, id).conversation_id}`);
    assertStringIncludes(page, etape);
    assertStringIncludes(page, `/eleve/messages/${id}/arreter`);

    const flux = (await eleve.requete(`/eleve/messages/${id}/flux`)).body!.getReader();
    const texte = new TextDecoder();
    assertStringIncludes(texte.decode((await flux.read()).value), `event: etape\ndata: ${etape}`);
    g.libre.resolve();
    let suite = "";
    for (let r = await flux.read(); !r.done; r = await flux.read()) suite += texte.decode(r.value);
    assertStringIncludes(suite, "event: reponse");
    assertStringIncludes(suite, "Gaudí refuse la ligne droite.");
    assertEquals(g.signaux.length, 1, "ni la déconnexion ni la reconnexion ne relancent l'appel");
    assert(!g.signaux[0].aborted);
    assertEquals(ligne(db, id).nouvelle, 0, "le flux a montré la réponse");
  } finally {
    g.libre.resolve();
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("« Arrêter » interrompt l'appel en cours, la question se relance, un autre compte n'arrête rien", async () => {
  const { db, dir } = await environnement();
  try {
    await publier(db, "Casa Batlló");
    const f = fauxModeles();
    const signaux: AbortSignal[] = [];
    f.modeles.generer = (_messages, signal) => {
      signaux.push(signal!);
      return signaux.length === 1
        ? new Promise((_, non) => signal!.addEventListener("abort", () => non(signal!.reason)))
        : Promise.resolve({ texte: BONNE, modele: "faux" });
    };
    const eleve = await session(db, f.modeles, "eleve");
    const autre = await session(db, f.modeles, "eleve");
    const prof = await session(db, f.modeles, "enseignant");
    const id = await poser(eleve);
    await attendre(() => signaux.length);
    const arreter = (qui: Session) => lire(qui, `/eleve/messages/${id}/arreter`, "POST");
    assertEquals(
      (await autre.requete(`/eleve/messages/${id}/arreter`, { method: "POST" })).status,
      404,
    );
    assert(!signaux[0].aborted);
    assertStringIncludes(await arreter(eleve), "Réponse arrêtée.");
    assert(signaux[0].aborted, "l'appel de modèle reçoit l'annulation");
    // L'appel interrompu se termine en panne : il ne remplace pas l'arrêt.
    await pause(20);
    const m = ligne(db, id);
    assertEquals([m.etat, JSON.parse(m.resultat as string).code], ["annule", "CANCELLED"]);
    assertStringIncludes(await lire(prof, "/prof/questions"), "Arrêtée");

    assertStringIncludes(await lire(eleve, `/eleve/messages/${id}/relancer`, "POST"), "/flux");
    assertStringIncludes(await lire(eleve, `/eleve/messages/${id}/flux`), "Gaudí refuse");
    // Un arrêt arrivé après la publication montre la réponse publiée.
    assertStringIncludes(await arreter(eleve), "Gaudí refuse la ligne droite.");
    assertEquals(ligne(db, id).etat, "answered");
  } finally {
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("redémarrage : la tentative reprise publie, l'ancienne ne l'écrase pas, Réessayer repart", async () => {
  const { db, dir } = await environnement();
  // Le serveur arrêté : son appel ne revient qu'après la reprise.
  const ancien = bloque((n) => citee(`Réponse ${n}.`));
  try {
    await publier(db, "Casa Batlló");
    const eleve = await session(db, ancien.modeles, "eleve");
    const id = await poser(eleve);
    await attendre(() => ancien.signaux.length);

    // Le serveur redémarré attend que le verrou expire, puis reprend la réponse. Son générateur
    // rendra une sortie illisible.
    const nouveau = bloque(() => "pas de JSON");
    const boucle = boucleReponses(db, nouveau.modeles);
    boucle.reveiller();
    assertEquals(ligne(db, id).tentatives, 1, "verrou encore valide");
    boucle.reveiller(Date.now() + VERROU_MS + 1000);
    await attendre(() => nouveau.signaux.length);
    assertEquals(ligne(db, id).tentatives, 2);

    // L'appel de l'ancienne tentative revient pendant la nouvelle : sa publication est refusée.
    ancien.libre.resolve();
    await pause(20);
    assertEquals([ligne(db, id).etat, ligne(db, id).resultat], ["en_cours", null]);
    nouveau.libre.resolve();
    await attendre(() => ligne(db, id).resultat);
    assertEquals(ligne(db, id).etat, "failed");
    const flux = await lire(eleve, `/eleve/messages/${id}/flux`);
    assertStringIncludes(flux, "Réessayer");
    assert(!flux.includes("Réponse 1."));

    await lire(eleve, `/eleve/messages/${id}/relancer`, "POST");
    assertStringIncludes(await lire(eleve, `/eleve/messages/${id}/flux`), "Réponse 2.");
    assertEquals(ligne(db, id).tentatives, 1, "une nouvelle demande recompte ses tentatives");
    assertEquals(JSON.parse(ligne(db, id).journal as string).revendications, 1);
  } finally {
    ancien.libre.resolve();
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("une réponse interrompue trois fois échoue avec sa cause", async () => {
  const { db, dir } = await environnement();
  const g = bloque();
  try {
    await publier(db, "Casa Batlló");
    const eleve = await session(db, g.modeles, "eleve");
    const id = await poser(eleve);
    await attendre(() => g.signaux.length);
    // Deux redémarrages reprennent la réponse, le troisième l'abandonne.
    assertEquals(revendiquerReponse(db, Date.now() + 2 * VERROU_MS)?.tentatives, 2);
    assertEquals(revendiquerReponse(db, Date.now() + 4 * VERROU_MS)?.tentatives, 3);
    assertEquals(revendiquerReponse(db, Date.now() + 6 * VERROU_MS), undefined);
    const m = ligne(db, id);
    assertEquals([m.etat, m.tentatives], ["failed", 3]);
    assertEquals(JSON.parse(m.resultat as string).code, "INTERRUPTED");
    assertStringIncludes(await lire(eleve, "/eleve/conversations"), "Échec");
    g.libre.resolve();
    await pause(20);
    assertEquals(ligne(db, id).etat, "failed", "la première tentative ne publie plus");
  } finally {
    g.libre.resolve();
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("la purge d'une conversation interrompt sa réponse, qui ne recrée rien", async () => {
  const { db, dir } = await environnement();
  const interval = globalThis.setInterval;
  try {
    await publier(db, "Casa Batlló");
    let renouveler: (() => void) | undefined;
    globalThis.setInterval = ((rappel: () => void, delai?: number) => {
      if (delai === VERROU_MS / 4) renouveler = rappel;
      return interval(rappel, delai);
    }) as typeof setInterval;
    const f = fauxModeles();
    let signal: AbortSignal | undefined;
    f.modeles.generer = (_messages, s) => {
      signal = s;
      return new Promise((_, non) => s!.addEventListener("abort", () => non(s!.reason)));
    };
    const eleve = await session(db, f.modeles, "eleve");
    const id = await poser(eleve);
    await attendre(() => signal);
    // Un calcul long garde son verrou.
    db.prepare("UPDATE messages SET verrou_expire_le = '2000-01-01T00:00:00Z'").run();
    renouveler!();
    assert((ligne(db, id).verrou_expire_le as string) > maintenant());
    assert(!signal!.aborted);
    // Le worker purge tout ce qui précède demain.
    purgerMessages(db, 1, Date.now() + 2 * 86_400_000);
    renouveler!();
    assert(signal!.aborted, "le renouvellement du verrou voit l'échange disparu");
    await pause(20);
    assertEquals(db.prepare("SELECT count(*) AS n FROM messages").get()!.n, 0);
    assertEquals(db.prepare("SELECT count(*) AS n FROM conversations").get()!.n, 0);
  } finally {
    globalThis.setInterval = interval;
    db.close();
    await rm(dir, { recursive: true });
  }
});

test("une longue légende n'attarde pas le chat, qui répond quatre questions à la fois", async () => {
  const { db, dir } = await environnement();
  const legende = Promise.withResolvers<void>();
  const porte = Promise.withResolvers<void>();
  let travail: Promise<void> | undefined;
  try {
    await publier(db, "Casa Batlló");
    // Un dépôt d'image dont la légende ne revient pas : le travail d'ingestion reste en cours.
    const v = valider({ titre: "Affiche", type_document: "sources" });
    assert("meta" in v);
    await deposer(db, {
      meta: v.meta,
      nomFichier: "affiche.png",
      format: "png",
      schoolId: lireInstance(db).school_id,
      enseignant: "Prof",
      audience: "eleves",
      reponses: true,
      octets: new Uint8Array([137, 80, 78, 71]),
    });
    const lent = fauxModeles();
    lent.modeles.legender = async () => {
      await legende.promise;
      return { texte: "Une affiche.", modele: "faux" };
    };
    travail = traiter(db, revendiquer(db)!, lent.modeles);
    await attendre(() =>
      db.prepare("SELECT etat FROM ingestion_jobs WHERE etat = 'enriching'").get(),
    );

    let ouverte = true;
    const f = fauxModeles();
    f.modeles.generer = async () => {
      if (!ouverte) await porte.promise;
      return { texte: BONNE, modele: "faux" };
    };
    const eleve = await session(db, f.modeles, "eleve");
    const debut = Date.now();
    const id = await poser(eleve);
    assertStringIncludes(await lire(eleve, `/eleve/messages/${id}/flux`), "Gaudí refuse");
    assert(Date.now() - debut < 1000, "réponse sans attendre la légende");
    assert(JSON.parse(ligne(db, id).journal as string).attente_ms < 1000);

    // Cinq conversations à la fois : quatre réponses tournent, la cinquième attend une place.
    ouverte = false;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await poser(eleve, `Question ${i} sur la façade ?`));
    const etats = () => ids.map((i) => ligne(db, i).etat as string);
    assertEquals(etats().toSorted(), [
      "en_attente",
      "en_cours",
      "en_cours",
      "en_cours",
      "en_cours",
    ]);
    const enFile = ids[etats().indexOf("en_attente")];
    const statut = await lire(
      eleve,
      `/eleve/conversations/${ligne(db, enFile).conversation_id}/etat`,
    );
    assertStringIncludes(statut, "En attente");
    assertStringIncludes(statut, 'hx-trigger="every 3s"');
    porte.resolve();
    await attendre(() => etats().every((e) => e === "answered"));
  } finally {
    legende.resolve();
    porte.resolve();
    await travail;
    db.close();
    await rm(dir, { recursive: true });
  }
});
