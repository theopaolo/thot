---
title: QUIZ-001 Demander « Quelle œuvre est-ce ? »
status: in_progress
context: shallow
energy: 2
# pleasure: 1 2 3 5 8 13 21
impact: 5
duration: 1h
scope: [eleve]
type: [feature]
due: 2026-09-26
---

## Travail

- [x] sur la page de chapitre : une image, l'élève tape l'artiste ou le mouvement
- [x] comparaison sans casse ni accents avec `quiz_reponse`, saisie par l'enseignant
- [x] un mot entier de la réponse suffit (« Morris » pour « William Morris »). Réponse fausse : « Pas tout à fait. La réponse attendue : … »

## Terminé quand

- [ ] au moins une œuvre par chapitre porte une réponse de quiz
- [x] affiché sur la page de chapitre dès qu'une œuvre porte une réponse, vérifié sur une copie
- [x] commité dans b211003

## Dépend de

- [[gal-001]]
- [[src-001]]

## Notes

Premier morceau de [[revi-101]], sans rien de généré. La réponse attendue est dans la page : c'est un exercice, pas une évaluation.

Le 23/09, aucune source réelle ne porte de `quiz_reponse` : le quiz n'apparaît nulle part tant que l'enseignant n'en saisit pas.
