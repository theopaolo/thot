# Thoth MVP

Ce dépôt porte le produit. Le dépôt parent reste le laboratoire de mesure et
contient le corpus pilote, les caches de modèles et les rapports.

Le MVP transforme des documents certifiés par un enseignant en réponses
vérifiables. Une réponse destinée à un élève ne peut contenir que des
affirmations reliées à un passage certifié.

## Lancer

Il faut Deno 2.6 et `pdftotext` (Poppler).

```bash
cp .env.example .env               # renseigner OPENROUTER_API_KEY
deno task thot compte prof "M. Detienne" enseignant    # affiche le mot de passe
deno task thot compte lea "Léa" eleve
deno task dev                      # serveur et worker, http://127.0.0.1:8000
```

Mot de passe enseignant oublié : `deno task thot reinitialiser prof` affiche un nouveau mot
de passe et invalide les sessions ouvertes.

Après la création du compte enseignant, `/prof/eleves` importe les élèves depuis un
CSV UTF-8 à deux colonnes :

```csv
identifiant,nom
lea.martin,Léa Martin
noe.petit,Noé Petit
```

La page affiche une feuille d'identifiants imprimable une seule fois. Elle permet aussi de
réinitialiser un mot de passe oublié. Le nouveau mot de passe invalide les sessions ouvertes.
`/prof/questions` regroupe les questions par chapitre, avec les refus et les avis « fausse »
en tête.

Les échanges sont supprimés automatiquement après `THOT_RETENTION_JOURS` (90 jours par défaut).
Les appels aux modèles demandent une conservation nulle et refusent la collecte par les
fournisseurs. L'adresse OpenRouter par défaut ne garantit pas un traitement dans l'Union
européenne. Le routage régional peut être configuré avec `THOT_OPENROUTER_URL` si le compte
OpenRouter y a accès. Avant un pilote avec des mineurs, faire valider la durée, le fournisseur,
les transferts et le [projet de notice aux familles](docs/notice-familles.md) par l'établissement.

Importer le corpus pilote, sans passer par le formulaire:

```bash
deno task thot ingest ../corpus/   # une source par fichier, chapitre = dossier
                                   # le worker extrait et légende en arrière-plan
```

Les légendes du banc d'essai ont été produites par le même modèle avec la même
consigne. Les reprendre évite 181 appels de vision:

```bash
deno task thot legendes-importer ../mesures/thot-real/legendes-modele-qwen3-vl-8b.json
```

Dès qu'une source est certifiée, le worker en tire des questions pour l'accueil élève. Une
question n'est gardée que si Thot y répond avec une citation vérifiée de cette source.
`deno task thot suggestions --tout` les recalcule.

Un enseignant certifie ensuite les sources dans `/prof` et relit les légendes
dans `/prof/legendes` (touches V, R, E). Une source non certifiée reste
invisible aux élèves. Une légende non relue aide la recherche mais n'est jamais
citée.

Vérifier et mesurer:

```bash
deno task check                    # fmt, lint, types, frontière core/app, tests
deno task thot eval recherche --img-order=../mesures/thot-real/img_order.json \
  --docs=../mesures/thot-real/docs.json [--sans-reclasseur]
deno task thot eval generation     # 20 questions d'élève et 15 pièges
deno task thot ask "Pourquoi les cubistes ont-ils abandonné la perspective ?"
```

`deno task thot` sans argument liste toutes les commandes.

## État au 22/09/2026

Le parcours complet tourne: dépôt, extraction PDF et HTML, légendes, revue et
certification, recherche FTS5 et reclassement, réponse citée et vérifiée, chat
élève avec panneau source. Mesures du 22/09 sur le corpus ATC certifié:

| mesure | Thot | banc d'essai |
|---|---|---|
| recherche, succès@5 sur 59 requêtes, FTS5 seul | 0,90 | 0,85 |
| recherche, succès@5, FTS5 et reclasseur | 0,93 | 0,97 |
| 20 questions d'élève: réponse avec la bonne source | 0,85 | |
| 20 questions d'élève: faux refus | 0,10 | |
| 15 pièges refusés | 14 | 0,93 |
| latence médiane d'une réponse | 1 s | |

Détail dans `evaluation/resultats/` et dans les tickets EVAL-002 et EVAL-003.

La stack est Deno, Hono, `hono/html` et HTMX, avec SQLite et un worker Deno
séparé ([ADR 0003](docs/decisions/0003-application-deno-hono-htmx.md)).

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
qu'ils sortent du banc d'essai. `python3 evaluation/exporter.py` les convertit en
JSON pour `thot eval`, sans toucher aux identifiants ni aux cibles. Les résultats
vont dans `evaluation/resultats/`. Le corpus réel ne fait pas partie de ce dépôt.

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
