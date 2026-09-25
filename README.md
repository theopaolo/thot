# Thot MVP

Thot transforme des documents certifiés par un enseignant en réponses vérifiables pour les
élèves. Chaque affirmation d'une réponse cite un passage exact d'une source certifiée.

Ce dépôt porte le produit. Le dépôt parent est le laboratoire de mesure : corpus pilote, caches
de modèles et rapports.

## Lancer

Il faut Deno et `pdftotext` (Poppler).

```bash
cp .env.example .env                                  # renseigner OPENROUTER_API_KEY
deno task thot compte prof "M. Detienne" enseignant   # affiche le mot de passe
deno task dev                                         # serveur et worker, http://127.0.0.1:8000
```

- `deno task check` : format, lint, types serveur et navigateur, frontière `core/`/`app/`, tests
- `deno task thot` : liste les commandes en ligne (comptes, import, certification, évaluation)
- `deno task board` : ouvre le suivi des tâches de `tasks/` sur http://localhost:7878

## Documentation

- [Architecture](docs/architecture.md) : règles du produit et forme du système
- [Exploitation du pilote](docs/exploitation.md) : comptes, import du corpus, données personnelles
- [Évaluation](evaluation/README.md) : jeux annotés et commandes de mesure
- [Décisions](docs/decisions/) : ADR
- [Notice aux familles](docs/notice-familles.md) : projet à valider par l'établissement
