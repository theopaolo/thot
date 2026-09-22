# Thoth MVP: backlog

> Refait le 22/09/2026, après archivage du code SvelteKit et FastAPI  
> Stack: Deno, Hono, `hono/html`, HTMX, SQLite ([ADR 0003](docs/decisions/0003-application-deno-hono-htmx.md))  

## Objectif de la semaine

Vendredi 25/09 au soir, sur le corpus ATC, avec des comptes réels:

1. Un enseignant se connecte, dépose un PDF ou une page HTML, suit son
   traitement, lit le texte extrait, relit les légendes d'images et certifie
   la source.
2. Un élève se connecte, ouvre un chapitre certifié, pose une question et
   reçoit l'une de trois réponses: une réponse citée, un refus hors corpus ou
   un message de panne. Chaque citation ouvre le passage exact.
3. `thot eval recherche` rejoue les 59 requêtes annotées et publie succès@5 et
   MRR par famille.

Le plan jour par jour et l'ordre de coupe sont dans
[EXECUTION_PLAN.md](EXECUTION_PLAN.md).

### Deux écarts assumés avec l'architecture

- **Pas de bras dense cette semaine.** Le rapport 3 mesure FTS5 racinisé suivi
  de `qwen3-reranker-8b` à 0,97 de succès@5 sur le corpus légendé, contre 0,98
  pour la chaîne complète avec plongements et RRF. L'écart vaut une requête sur
  59. Les plongements reviennent en `RET-201`.
- **L'index vit dans `state.sqlite3`.** Les tables de recherche se
  reconstruisent par `thot rebuild` depuis les fichiers de contenu. Les
  générations de projection atomiques du §4.3 reviennent en `PRJ-201`.

Les légendes d'images restent dans la semaine. Sans elles, FTS5 et le
reclasseur tombent à 0,56 sur ce corpus, où 163 pages sur 205 n'ont que
leur titre comme texte.

## Tickets

Un fichier par ticket dans `tasks/`, suivi sur un board
[kandepo](https://github.com/theopaolo/repoboard):

- `tasks/semaine/`: les acquis et les tickets de la semaine, chacun avec sa
  date d'échéance
- `tasks/ensuite/`: la suite, sans date ni score

`deno task board` ouvre le board sur http://localhost:7878. Le statut d'un
ticket vit dans son fichier, glisser une carte le réécrit. Chaque fichier
porte le travail, les critères « terminé quand » en cases à cocher et ses
dépendances en `[[liens]]`. Pour passer un ticket de `ensuite/` à `semaine/`,
déplacer le fichier.

## Hors périmètre du pilote

- index vectoriel approximatif
- recherche contextuelle générée
- route de contexte complet
- base de données ou file distribuée
- plusieurs établissements dans une même instance
- consensus entre plusieurs modèles à l'extraction
- DOCX et PPTX avant les formats réellement déposés
- recherche web
- PWA hors ligne
