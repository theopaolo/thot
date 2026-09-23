---
title: AVIS-001 Recueillir l'avis de l'élève sur une réponse
status: in_progress
context: shallow
energy: 2
# pleasure: 1 2 3 5 8 13 21
impact: 8
duration: 1h
scope: [eleve]
type: [feature]
due: 2026-09-25
---

## Travail

- [x] boutons « utile », « peu claire », « fausse » sous chaque réponse
- [x] colonne `messages.avis`, un avis par réponse, modifiable par son auteur seulement
- [x] une réponse signalée fausse remonte en tête de `/prof/questions`

## Terminé quand

- [x] l'avis donné reste marqué après rechargement, test à l'appui
- [ ] vérifié à l'écran dans Helium
- [x] commité dans b211003
- [x] commiter la correction de `aria-pressed`

## Dépend de

- [[chat-001]]
- [[suiv-001]]

## Notes

Donne une mesure du pilote en dehors des jeux d'évaluation.

Corrigé le 23/09 : `hono/html` rend `${true}` en attribut vide. `aria-pressed` restait vide et le bouton choisi n'était jamais marqué, même juste après le clic. Même défaut sur la citation ouverte automatiquement. Les deux passent par `String()`.
