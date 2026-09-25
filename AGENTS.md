# Consignes pour les agents

## Documentation

Le code est la documentation de référence. Un document écrit à côté ne garde que ce que le code
ne dit pas : une règle du produit, une raison, une contrainte extérieure.

- Ne pas recopier ce qui se lit dans le dépôt : versions de dépendances, arborescence, routes,
  schéma SQL, noms de modèles, valeurs par défaut, extraits de code. Renvoyer au fichier.
- Pas de date ni d'« état au … » dans un document vivant. L'historique vit dans les messages de
  commit et `git blame`. Seules les ADR de `docs/decisions/` sont datées, parce qu'elles
  enregistrent une décision à un moment donné.
- Un document décrit le code tel qu'il est. Une cible pas encore construite devient une tâche.
- Le suivi des tâches vit dans `tasks/`, un fichier par tâche (board kandepo : `deno task board`).
  Une question ouverte, un risque ou un écart entre la doc et le code devient une tâche, pas un
  backlog ou un plan en Markdown.
- Court et à jour vaut mieux que complet. Un changement de code qui contredit `README.md` ou
  `docs/` met ces fichiers à jour dans le même commit.

Emplacements : `README.md` pour lancer le projet, `docs/architecture.md` pour les règles du
produit, `docs/exploitation.md` pour faire tourner le pilote, `evaluation/README.md` pour les
mesures, `docs/decisions/` pour les ADR.
