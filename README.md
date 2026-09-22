# Thoth MVP

Ce dépôt porte le produit. Le dépôt parent reste le laboratoire de mesure et
contient le corpus pilote, les caches de modèles et les rapports.

Le MVP transforme des documents certifiés par un enseignant en réponses
vérifiables. Une réponse destinée à un élève ne peut contenir que des
affirmations reliées à un passage certifié.

## État au 22/09/2026

La stack est Deno, Hono, `hono/html` et HTMX, avec SQLite et un worker Deno
séparé ([ADR 0003](docs/decisions/0003-application-deno-hono-htmx.md)). Le code
applicatif reste à écrire. Le ticket APP-001 crée `deno task dev` et
`deno task check`.

La première implémentation, SvelteKit et FastAPI, est archivée dans
`archive/thot-mvp-python-sveltekit/` du dépôt parent. Elle couvrait le dépôt
d'un fichier jusqu'à l'état `received`. Son schéma SQL est repris dans
`migrations/`, ses tests servent de spécification au portage.

L'objectif de la semaine du 22/09 est le parcours complet sur le corpus ATC:
dépôt, relecture, certification, question d'élève, réponse citée.

- [Backlog](BACKLOG.md): objectif de la semaine et écarts assumés
- `tasks/`: un fichier par ticket. `deno task board` ouvre le board sur http://localhost:7878
- [Plan d'exécution](EXECUTION_PLAN.md), avec l'ordre de coupe
- [Architecture](ARCHITECTURE.md)

## Décisions

- [0001. Pile RAG mesurée](docs/decisions/0001-pile-rag-mesuree.md)
- [0002. Fiche de chapitre ancrée](docs/decisions/0002-fiche-de-chapitre-ancree.md)
- [0003. Application Deno, Hono, hono/html et HTMX](docs/decisions/0003-application-deno-hono-htmx.md)
- [0004. Monolithe modulaire, core et app](docs/decisions/0004-monolithe-modulaire-core-app.md)
- [0005. Vues HTML après comparaison des prototypes](docs/decisions/0005-vues-html-apres-benchmark-ui.md)

## Évaluation

Les deux jeux de requêtes annotées sont dans `evaluation/`, en Python, tels
qu'ils sortent du banc d'essai. EVAL-002 les branche sur `thot eval`. Le corpus
réel ne fait pas partie de ce dépôt.

## Périmètre du premier pilote

- une instance par établissement
- un back-office enseignant et une interface élève rendus par Hono et `hono/html`
- HTMX et du JavaScript local pour les interactions
- un serveur Deno et un worker Deno séparé
- SQLite pour l'état applicatif et la recherche
- FTS5 racinisé et `qwen3-reranker-8b`, puis `qwen3-embedding-8b` après la
  première semaine
- génération sur cinq extraits reclassés
- vérification des citations avant publication de la réponse

Le contexte complet, l'index vectoriel approximatif, le moteur de recherche
séparé et le multi-établissement dans une même instance sont hors périmètre.
