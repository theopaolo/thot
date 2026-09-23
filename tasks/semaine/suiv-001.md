---
title: SUIV-001 Montrer à l'enseignant les questions des élèves
status: in_progress
context: shallow
energy: 3
# pleasure: 1 2 3 5 8 13 21
impact: 13
duration: 2h
scope: [revue]
type: [feature]
due: 2026-09-25
---

## Travail

- [x] `/prof/questions` : questions groupées par chapitre
- [x] les refus « hors du cours » d'abord, puis les réponses signalées fausses, puis les plus récentes
- [x] le chapitre vient de la question posée dans un chapitre, sinon de la source citée
- [x] les refus « Hors cours » forment leur propre groupe en tête, sans chapitre deviné
- [x] dates écrites en français, mêmes colonnes d'un chapitre à l'autre

## Terminé quand

- [x] vérifié par HTTP le 23/09 : groupé par chapitre, refus « Hors cours » en tête, avis « Fausse » affiché
- [x] vérifié à l'écran dans Helium le 23/09, bureau et mobile
- [ ] revu sur les vraies questions du pilote
- [x] commité

## Dépend de

- [[chat-001]]

## Notes

Un refus désigne un manque dans le cours : c'est la liste la plus utile pour l'enseignant.
