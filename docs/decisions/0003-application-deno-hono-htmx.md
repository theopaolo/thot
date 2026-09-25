# 0003. Unifier l'application avec Deno, Hono, `hono/html` et HTMX

Date: 12/09/2026  
Statut: accepté. Le 22/09/2026, le code SvelteKit et FastAPI est archivé avant portage, dans `archive/thot-mvp-python-sveltekit/` du dépôt de recherche. Le dépôt ne contient plus que la cible. Le 25/09/2026, le JavaScript navigateur passe en TypeScript compilé par `deno bundle`, voir Livraison.  
Portée: application du pilote, espaces professeur et élève

## Contexte

Le pilote livre une instance par établissement: un conteneur qui lance le
serveur web et son worker, un volume pour ses données. L'opérateur héberge
ces conteneurs sur son serveur européen. La même image sert à un
établissement ou à un chercheur qui installe sa propre instance. Le runtime
ne décide ni du lieu d'hébergement ni de l'autorisation d'envoyer des
documents à un fournisseur.

Les parcours professeur sont le dépôt, la consultation et la validation de
documents et de contenus générés. Les parcours élève sont la lecture de
fiches, les révisions, les exercices et le chat avec consultation des
sources. Les maquettes demandent du HTML, des formulaires et des mises à jour
partielles. Le pilote suppose une connexion au serveur. Les séances hors
ligne avec synchronisation sont hors de cette décision.

Le développeur principal maîtrise mieux JavaScript et TypeScript. Python
avait été choisi pour l'écosystème IA des bancs d'essai. Les appels de
modèles passent par HTTP et l'extraction des PDF texte par `pdftotext`. Ces
opérations n'imposent pas un serveur Python. La recherche vectorielle locale
reste à porter et à mesurer.

À la date de cette décision, le produit implémente le dépôt d'un fichier et
le suivi du travail à l'état `received`: un formulaire SvelteKit transmet le
fichier à FastAPI. L'ingestion, le worker, la recherche et la certification
restent à écrire. La migration porte donc sur un premier parcours, avec un
délai de réécriture inconnu.

## Décision

Thot devient une application TypeScript sur Deno. Hono sert les pages et les
actions HTTP. Les vues sont des fonctions TypeScript qui rendent du HTML
avec `hono/html`. HTMX remplace les zones de page qui changent. Du
JavaScript local couvre les interactions qui doivent répondre sans
aller-retour.

SQLite reste la base. Un second processus Deno traite la file de travaux
persistante. Les deux processus partagent le code et le stockage local.
Python reste pour les évaluations et, si un besoin d'OCR le justifie, comme
outil appelé par le worker.

Cette décision remplace SvelteKit, FastAPI et le worker Python des §2 et §3
de l'[architecture v2](https://github.com/theopaolo/thot/blob/29048a9/ARCHITECTURE.md). Elle adapte le transport HTTP
du §13 et les vérifications de runtime du §18. Les
[choix RAG mesurés](0001-pile-rag-mesuree.md), la
[fiche de chapitre ancrée](0002-fiche-de-chapitre-ancree.md) et les
invariants de certification restent en vigueur.

### Organisation

```text
Navigateur professeur ou élève
  HTML + CSS + HTMX + JS local
               |
           HTTP / SSE
               |
      Deno + Hono + hono/html
               |
       state.sqlite3 et contenu
               |
         worker Deno séparé
               |
    pdftotext / modèles HTTP / OCR optionnel
               |
       nouvelles projections de recherche
```

Le serveur traite les actions interactives et les réponses de chat. Le
worker traite l'ingestion et les reconstructions. Une connexion SSE fermée
ne supprime pas un travail persistant.

Le départ tient en un fichier d'entrée par processus, un module d'accès
SQLite, des vues et des migrations SQL. Les fonctions métier sont appelées
directement, sans les couches et protocoles prévus dans l'arborescence
Python. La seule frontière imposée dès le départ sépare `core/` de `app/`,
voir le [monolithe modulaire](0004-monolithe-modulaire-core-app.md).

### Rendu et interactions

Une vue est une fonction TypeScript qui reçoit des données typées et rend
un gabarit `html\`...\`` de
[`hono/html`](https://hono.dev/docs/helpers/html). Les valeurs interpolées
par `${}` sont échappées. Un gabarit imbriqué dans un autre passe sans
réencodage, et `raw()` insère du HTML produit par le serveur. Un texte de
modèle ou d'enseignant passe donc par `${}`, sans exception. Le HTML des
gabarits n'est pas vérifié à la compilation: une balise non fermée ou un
attribut mal écrit se voit à l'exécution. L'extension lit-html de l'éditeur
colore et complète le HTML dans ces gabarits. Les routes servent les pages,
les fragments et les actions des parcours. Une API JSON générale
attend un second consommateur. Les contrats d'upload en place restent servis
pendant la migration.

Dans le chat, la conversation, la saisie et le panneau source sont trois
zones. Ouvrir une citation remplace le panneau seul, avec
[`hx-target`](https://htmx.org/attributes/hx-target/) et
[`hx-sync`](https://htmx.org/attributes/hx-sync/) pour ordonner les
requêtes.

Le navigateur gère le retournement des cartes, le chronomètre affiché, les
brouillons, le focus et le défilement. Le serveur valide les résultats, les
droits et les échéances. Un web component reste possible pour un
comportement réutilisé.

SSE affiche l'avancement de la recherche. La réponse part en un seul
fragment, après vérification des affirmations et des citations, sans
diffusion jeton par jeton. Un texte généré est une entrée non fiable. Si
Markdown est rendu avec Marked, le HTML est assaini ensuite, car
[Marked ne le fait pas](https://marked.js.org/). Les attributs actifs, HTMX
compris, sont retirés de ce contenu.

### SQLite, worker et fichiers

L'accès SQL utilise `node:sqlite`, des requêtes paramétrées et des
migrations versionnées. `DatabaseSync` est synchrone et bloque le processus
pendant chaque requête. Les requêtes et les attentes de verrou restent
courtes côté serveur
([documentation](https://docs.deno.com/api/node/sqlite/)).

Serveur et worker ont chacun leur connexion à `state.sqlite3`, avec WAL,
clés étrangères et `busy_timeout`. WAL autorise les lectures pendant une
écriture, garde un seul écrivain à la fois et exige un stockage sur la même
machine. Sans `busy_timeout`, une écriture du serveur pendant une écriture
du worker échoue en `SQLITE_BUSY` au lieu d'attendre. Le second processus ne
justifie pas à lui seul PostgreSQL
([WAL](https://www.sqlite.org/wal.html)).

Le worker revendique un travail dans une transaction courte, avec un verrou
à expiration, puis fait les appels externes hors transaction. La reprise
après panne garde les tentatives et évite de doubler les artefacts. Les
migrations tournent une fois, avant le démarrage des deux processus.

Les fichiers canoniques restent exportables. L'état opérationnel fait
autorité et est sauvegardé. Les projections restent reconstruisibles, avec
activation atomique d'une génération et maintien de celle qu'une requête en
cours utilise. Une sauvegarde SQLite passe par l'API de backup ou
`VACUUM INTO`, avec le contenu et la configuration. Copier le fichier
principal d'une base active donne une copie incohérente
([backup](https://www.sqlite.org/backup.html)).

### Recherche et outils Python

Le pilote garde FTS5 racinisé, recherche dense exacte, RRF et reclassement.
Rien ne montre encore qu'une boucle `Float32Array` égale NumPy en latence.
Le banc a mesuré 19 Mo de vecteurs en dimension 1 024. `qwen3-embedding-8b`
produit 4 096 dimensions: 4 729 chunks font 77 Mo en float32, en mémoire
dans le processus de l'établissement. Le format des vecteurs et leur lecture
depuis Deno sont à valider sur cette dimension, filtres d'accès appliqués
avant classement. Un changement de `vectors.npy` est versionné dans le
manifeste de projection.

Les évaluations Python restent la référence de comparaison. L'OCR Python
optionnel reçoit des arguments et des chemins contrôlés, échange par JSON ou
par fichiers, rend un code de sortie et a un délai maximal. Ses dépendances
sont verrouillées et aucun environnement n'est résolu ou téléchargé pendant
un travail. Une bibliothèque Python requise à chaque question, avec un
chargement coûteux, rouvrirait cette frontière.

### Livraison

HTMX et le CSS sont servis tels quels. Le JavaScript local est écrit en
TypeScript dans `src/app/client/`, et `deno bundle` le compile en un fichier
`static/dist/app.js`, généré et hors de Git. Deno et les dépendances sont
verrouillés.

Ce build date du 25/09/2026. Les scripts du navigateur avaient grandi jusqu'à
trois modules et 219 lignes, et le TypeScript vérifie leurs accès au DOM
avec `deno check`. Bun a d'abord fait la compilation. `deno bundle` produit
le même fichier de 5 Ko avec l'outil déjà installé, ce qui retire une
version de Bun à verrouiller et une étape de l'image Docker.

L'unité de livraison est une image Docker. Elle contient Deno, le code, les
assets, les migrations, Poppler et, si l'OCR local est activé, Python et ses
dépendances verrouillées. Un entrypoint lance le serveur et le worker dans le
même conteneur. Il est le processus principal: il transmet `SIGTERM` aux
deux, et si l'un sort de façon inattendue, il arrête l'autre et sort en
erreur. La politique de redémarrage du conteneur relance l'ensemble. Sans
cette règle, un worker mort laisse le serveur accepter des dépôts que
personne ne traite. Un volume porte `state.sqlite3`, le contenu et les
projections. Un reverse proxy route un sous-domaine par établissement vers
son conteneur. Ajouter un établissement revient à créer un conteneur et un
volume. La compilation en exécutable reste une option secondaire
([`deno compile`](https://docs.deno.com/runtime/reference/cli/compile/)).

Hono fournit la protection CSRF (`hono/csrf`) et les cookies signés
(`hono/cookie`). Les sessions, les rôles et la validation des formulaires
restent à écrire, car les types TypeScript ne valident rien à l'exécution.
Les limites d'upload et les contrôles d'accès aux sources font partie du
même travail.

Les permissions Deno limitent les accès du processus. Un sous-processus
n'en hérite pas. Le déploiement doit donc aussi restreindre les droits
système des outils appelés
([permissions](https://docs.deno.com/runtime/fundamentals/security/)).

## Comparaison avec la stack précédente

| Aspect                   | SvelteKit + FastAPI/Python                              | Choix retenu                                          |
| ------------------------ | ------------------------------------------------------- | ----------------------------------------------------- |
| Parcours web             | Composants Svelte, actions serveur et API Python        | Pages et actions dans Hono, fragments HTML avec HTMX  |
| Langages                 | TypeScript et Python                                    | TypeScript, Python pour les outils spécialisés        |
| Validation               | Pydantic côté API, contrat transmis au frontend         | Validation aux entrées HTTP et aux sorties de modèles |
| État dans le navigateur  | Réactivité et cycle de vie Svelte                       | DOM rendu par le serveur, JS local ciblé              |
| Traitements longs        | Worker Python prévu                                     | Worker Deno séparé                                    |
| Stockage                 | Fichiers canoniques, SQLite, projections par génération | Identique                                             |
| Outillage                | Vite, SvelteKit, environnement Python                   | Deno, dépendances verrouillées, JS et CSS statiques   |
| Bibliothèques IA locales | Appel direct depuis Python                              | Sous-processus pour les traitements batch             |

Le gain attendu est la suppression du relais entre serveur SvelteKit et API
FastAPI, et une seule façon de construire les deux interfaces. La décision
ne repose ni sur une performance supérieure de TypeScript ni sur un nombre
de lignes visé.

## Alternatives considérées

| Option                                   | Motif de non-sélection pour ce pilote                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conserver SvelteKit + FastAPI            | Viable et déjà commencé, mais deux langages et un relais HTTP pour les écrans prévus                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SvelteKit seul avec endpoints TypeScript | Proche. Utile avec beaucoup d'état local. Les parcours retenus demandent du HTML serveur, sans bundler                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Django + templates + HTMX                | Authentification, formulaires et migrations intégrés. Python, que le développeur écrit plus lentement, et les écrans métier demandent des vues spécifiques de toute façon                                                                                                                                                                                                                                                                                                                                                         |
| Go + templates + HTMX                    | Compatible avec les parcours. Un langage de plus à apprendre sans besoin mesuré                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Deno + Fresh                             | Les îlots restent une option. Aucun écran ne justifie d'ajouter Preact aux vues                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Bun + Hono                               | Viable. Deno est retenu pour son outillage intégré et ses permissions explicites, sans gain mesuré de stabilité ou de vitesse                                                                                                                                                                                                                                                                                                                                                                                                     |
| PostgreSQL + pgvector                    | Un conteneur par établissement isole par le système de fichiers, sans règles d'accès par ligne. `school_id` reste sur les entités et dans les filtres (§14 de l'architecture). Aucun besoin mesuré ne justifie PostgreSQL pour le pilote. Les performances de pgvector n'ont pas été comparées: le banc a confronté NumPy et `sqlite-vec` et situe l'intérêt d'un index approximatif vers 500 000 vecteurs. À réexaminer si un processus doit servir plusieurs établissements ou si plusieurs machines écrivent dans la même base |

### Rendu des vues

Le choix est confirmé et détaillé par l'[ADR 0005](0005-vues-html-apres-benchmark-ui.md),
qui compare les prototypes Hono HTML, Hono JSX et SvelteKit et précise
les limites des vérifications statiques.

Les trois options échappent les valeurs interpolées. La différence est entre
du HTML lisible et du balisage vérifié à la compilation.

| Option | Ce qu'on écrit | Vérification du HTML | Motif |
|---|---|---|---|
| `hono/html` | du HTML dans un gabarit `html\`\``, vues en fonctions TS aux entrées typées | aucune, erreur visible à l'exécution | retenu: le HTML reste du HTML, les attributs `hx-*` se lisent comme dans la documentation htmx, aucune configuration |
| `hono/jsx` | du JSX, sans React ni hydratation | balises équilibrées, props et certains attributs connus typés. Les noms inconnus restent permis | composition comparable aux fonctions typées, configuration JSX, préférence de lecture pour le HTML direct |
| Moteur externe (Eta, Nunjucks, Handlebars) | des fichiers de gabarit avec leur syntaxe | aucune | une syntaxe de plus, coupée des types TS, dépendance npm dont la compatibilité Deno est à vérifier, sans second auteur de vues qui la justifie |

## Conséquences

- Un seul langage applicatif, un seul outillage, un seul processus de
  rendu. Le relais SvelteKit vers FastAPI disparaît.
- Les sessions, les rôles, la validation des formulaires et les limites
  d'upload sont à écrire. Django ou FastAPI en fournissaient une partie.
- La recherche vectorielle doit être portée et mesurée de nouveau. Le
  résultat NumPy ne se transfère pas.
- Les offsets de citation comptent des points de code Unicode. Les chaînes
  JavaScript comptent des unités UTF-16. Chaque lecture d'offset doit
  convertir, et un oubli déplace les citations sur les caractères hors du
  plan multilingue de base.
- Le HTML des gabarits `hono/html` n'est pas vérifié à la compilation.
  Une balise non fermée passe la CI et casse l'écran.
- Chaque interaction qui doit répondre sans aller-retour demande du JS
  écrit à la main. Au-delà de quelques scripts, Svelte redevient moins cher.
- `deno bundle` est marqué expérimental dans Deno 2.9. Un changement de
  ses options peut casser `deno task build` lors d'une mise à jour de Deno.
  Le code client n'a pas de dépendance, donc esbuild appelé directement
  ou des modules ES servis sans build restent des replis simples.
- Le code SvelteKit et FastAPI déjà écrit est jeté. Il est petit, 369
  lignes côté backend, et c'est la raison de décider maintenant.

## Passage à la nouvelle stack

Le code actuel reste SvelteKit + FastAPI jusqu'à son remplacement vérifié.
Les commandes du README restent celles de cette implémentation.

1. Porter le dépôt existant vers Hono: erreurs par champ, conservation de la
   saisie, suivi du travail. Réutiliser le schéma SQLite et garder les
   identifiants et fichiers déjà déposés.
2. Vérifier une tranche avec worker séparé: dépôt, reprise après
   interruption, progression SSE, consultation du résultat. Tester les deux
   connexions SQLite et les migrations sur une copie des données.
3. Vérifier le chat avec sources sur ordinateur et mobile: focus, brouillon
   conservé, clics successifs sur des citations, erreur réseau.
4. Porter et mesurer la recherche sur les jeux d'évaluation. Tester les
   offsets sur des caractères hors du plan multilingue de base avant de
   réutiliser des citations.
5. Vérifier sauvegarde, restauration, dépendances système et lancement des
   deux rôles dans le conteneur cible.
6. Retirer les chemins SvelteKit et FastAPI remplacés. Mettre à jour
   architecture, plan d'exécution, backlog et commandes au fil de la
   migration.

Le critère de réussite est la conservation des comportements et des
garanties du produit, avec moins de code d'intégration.

## Conditions de réexamen

- Des séances hors ligne avec synchronisation, un éditeur riche ou beaucoup
  d'état local coordonné rendent le JS manuel plus coûteux que Svelte.
- Une dépendance Python doit rester chargée pour répondre aux questions et
  impose un service permanent de plus.
- Les mesures montrent que la recherche exacte ou SQLite bloquent les
  interactions malgré des requêtes et transactions courtes.
- Plusieurs machines doivent écrire dans la même base, ou une offre
  mutualisée exige une autre organisation des données.

Un réexamen porte sur la limite constatée. Il ne remplace pas en même temps
le rendu web, le runtime, la base et les contrats du corpus.
