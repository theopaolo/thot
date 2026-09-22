# Thoth MVP: plan d'exécution

> Version 2, 22/09/2026  
> Horizon: du mardi 22 au vendredi 25 septembre, week-end en marge  
> Point de départ: aucun code applicatif. Le schéma SQL du dépôt existe.

## Résultat de la semaine

Vendredi soir, une instance lancée par une commande tourne sur le corpus ATC.
Un enseignant dépose, relit et certifie. Un élève pose une question et reçoit
une réponse citée, un refus hors corpus ou un message de panne, et ouvre chaque
citation sur le passage exact. Les tickets sont dans `tasks/`, un fichier
par ticket, sur le board de `deno task board`.

Chaque journée se termine par un critère vérifiable. Un critère manqué décale
la journée suivante, il ne se reporte pas en silence.

## Mardi 22. Socle et dépôt

APP-001, APP-002, APP-003, DEP-001, JOB-001.

Le prototype `mesures/benchmark-ui/hono/` du dépôt de recherche donne la forme
des routes, des vues et du SSE. Le code archivé donne le schéma, les messages
d'erreur et les tests du dépôt.

Critère: `deno task dev` lance serveur et worker sans clé de modèle. Un dépôt
par le formulaire crée un travail `received`. Tuer le worker pendant un
travail puis le relancer reprend ce travail une seule fois.

## Mercredi 23. Ingestion et revue enseignant

ING-001, ING-002, ING-003, ING-004, REV-001, IMG-001.

Critère: `thot ingest ../corpus/` traite le corpus ATC. Les 9 PDF ATC passent
l'invariant d'offset. Les 181 images ont une légende générée. Un enseignant
certifie une source et valide ses légendes au clavier.

## Jeudi 24. Recherche et abstention

IDX-001, RET-001, EVAL-002.

Critère: `thot eval recherche` publie succès@5 par famille. Le chiffre attendu
est 0,97. Sous 0,90, la journée de vendredi commence par l'analyse des familles
en échec. Le générateur ne voit que les cinq extraits retenus par la recherche.

## Vendredi 25. Réponse citée et parcours élève

ANS-001, CHAT-001, ELV-001, AUTH-001.

Critère: avec un compte élève, une question de `queries_generation.py` reçoit
une réponse dont chaque citation ouvre le bon passage. Une question du registre
« hors sujet » reçoit le refus hors corpus. Une clé OpenRouter invalide produit
le message de panne, pas le refus.

## Week-end. Livraison

OPS-001, OPS-002, EVAL-003.

Critère: l'image Docker démarre sur un volume vide et refait le parcours de
vendredi. Une sauvegarde restaurée répond avec les mêmes citations.

## Ordre de coupe

En retard, retirer dans cet ordre. Le parcours de bout en bout passe avant la
finition de chaque étape.

1. OPS-001: lancer par `deno task` au lieu de Docker.
2. EVAL-003: rejouer les 35 questions la semaine suivante.
3. ELV-001: l'élève arrive directement sur le chat.
4. ING-004: déposer par le formulaire les seuls fichiers des chapitres de la
   démonstration. `corpus/` compte 220 fichiers, dont 205 pages HTML.

Ne se coupent pas: la relecture des légendes (IMG-001), la vérification des
citations (ANS-001) et la séparation entre refus et panne. Sans elles, le
produit ne tient plus ses invariants 1 et 5, ni la règle des légendes du §8
de l'architecture.

## Risques à lever tôt

- **Racinisation française sous Deno.** FTS5 n'a pas de stemmer français. Le
  banc utilisait `snowballstemmer` en Python. Vérifier mardi qu'un paquet
  Snowball npm donne les mêmes racines sur un échantillon du corpus. Sinon
  indexer sans racinisation et mesurer la perte jeudi.
- **Disponibilité d'OpenRouter.** Le reclasseur, les légendes et le générateur
  passent par ce fournisseur. Un appel qui échoue doit finir en panne visible.
  Mettre les réponses en cache par checksum pour que l'évaluation ne repaie
  rien.
- **Offsets UTF-16.** Les offsets de citation comptent des points de code. Les
  chaînes JavaScript comptent des unités UTF-16. La conversion vit dans une
  seule fonction de `core/`, testée mardi, et aucun autre code ne découpe
  `document.txt`.
- **HTML des gabarits non vérifié.** `deno check` ne voit pas une balise mal
  fermée. Chaque route a un test qui charge la page et vérifie la présence des
  identifiants HTMX qu'elle cible.

## Après la semaine

Les jalons suivants reprennent l'ancien plan sur douze semaines, dans l'ordre
où ils améliorent le pilote.

1. Plongements et RRF (RET-201), puis mesure de la recherche exacte depuis
   Deno (RET-203).
2. Vérification des affirmations par `ClaimVerifier`, mesurée sur les 35
   questions (CIT-302).
3. PDF muets et OCR sous autorisation (ING-107, ING-108).
4. Générations de projection atomiques et progression SSE de l'ingestion
   (PRJ-201, JOB-102).
5. Fiche de chapitre ancrée, puis révisions et quiz tirés des champs certifiés
   (FIC-101, FIC-102, REVI-101).
6. Mesure des modèles Qwen sur le matériel cible et décision d'auto-hébergement
   (OPS-502).
7. Pilote: légendes relues, trente questions réelles annotées (PILOT-501,
   PILOT-502).

## Règles de passage

- Une étape ne masque pas un échec en le transformant en warning générique.
- Chaque changement de parseur, chunker, modèle ou seuil rejoue l'évaluation
  concernée.
- Les modèles ne sont pas appelés dans les tests unitaires.
- Une sortie de modèle n'atteint l'élève qu'après les contrôles du serveur.
- Les fixtures du produit sont petites et autorisées. Le corpus de
  l'établissement reste hors du dépôt.
