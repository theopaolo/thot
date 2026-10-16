# Thot MVP

Thot transforme des documents certifiés par un enseignant en réponses vérifiables pour les
élèves. Chaque affirmation d'une réponse cite un passage exact d'une source certifiée.

Ce dépôt porte le produit. Le dépôt parent est le laboratoire de mesure : corpus pilote, caches
de modèles et rapports.

## Lancer

Il faut [Vite+](https://viteplus.dev/guide/) et `pdftotext` (Poppler). Dans ce dossier, `vp`
fournit Node.js et pnpm aux versions de `package.json`. Sans Vite+, installer ces versions à la
main : `pnpm install` refuse une autre version de Node.js. Sous Linux, il faut aussi
`/usr/bin/prlimit` (util-linux) pour borner la mémoire du convertisseur. L'image Docker les
installe.

```bash
pnpm install
cp .env.example .env                         # renseigner OPENROUTER_API_KEY
pnpm thot instance --nom="Mon Thot" --mode=shared
pnpm thot administrateur prof "M. Detienne"  # code de connexion à usage unique
pnpm dev                                     # serveur et worker, http://127.0.0.1:8000
```

- `pnpm dev` accepte n'importe quel mot de passe pour les comptes ordinaires. Un
  administrateur garde une authentification complète.
- `pnpm check` : format, lint et types (`vp check`), build, frontière `core/`/`app/`, tests
- `pnpm thot` : liste les commandes en ligne (comptes, import, certification, évaluation)
- `pnpm board` : ouvre le suivi des tâches de `tasks/` sur http://localhost:7878

Pour un usage personnel, choisir `--mode=personal` avant de créer le compte. Aucun établissement
ni aucune classe ne sont nécessaires. Le propriétaire ouvre ses documents et ses questions,
puis accède à leur gestion et à l’administration depuis la navigation.

Depuis l’administration, configurer les matières, les cours et leurs thèmes. Le profil de
l’instance, général ou arts appliqués, fournit les termes et les champs du dépôt par défaut.
L’administration règle aussi le nom, les termes, les lecteurs par défaut et les champs de chaque
matière. Une ressource peut appartenir à plusieurs cours : les membres de ces cours la lisent.

En production, suivre le [provisionnement par instance](docs/exploitation.md).

## Documentation

- [Architecture](docs/architecture.md) : règles du produit et forme du système
- [Exploitation du pilote](docs/exploitation.md) : comptes, import du corpus, données personnelles
- [Évaluation](evaluation/README.md) : jeux annotés et commandes de mesure
- [Décisions](docs/decisions/) : ADR
- [Notice aux familles](docs/notice-familles.md) : projet à valider par l'établissement
