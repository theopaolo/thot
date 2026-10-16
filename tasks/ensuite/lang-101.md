---
title: LANG-101 Chercher dans des sources anglaises avec une question française
status: not_started
scope: [recherche, domaines, evaluation]
type: [feature]
---

## Dépend de

- [[dom-101]]
- [[eval-103]]

## Notes

La recherche racinise tout en français (`racines()` dans `src/core/recherche.ts`). Une source
anglaise est marquée « recherche non prise en charge » au dépôt, à l'extraction et à la lecture.
Beaucoup de cours s'appuient pourtant sur un manuel ou un livre en anglais : le cours
`lire-une-codebase` des cours de développement cite *The Programmer's Brain*, le scénario REAPER
d'EVO-001 part d'un manuel anglais. L'élève pose sa question en français.

Le reclasseur `qwen3-reranker-8b` est multilingue. FTS5 ne lui passe aucun candidat anglais pour
une question française sans mot commun.

- [ ] raciniser chaque passage avec la langue de sa source, français ou anglais
- [ ] trouver des candidats anglais pour une question française, par la voie la plus simple que
  la mesure justifie : racines des deux langues, traduction de la question quand le périmètre
  contient une autre langue, ou les deux
- [ ] la réponse reste en français et cite le passage anglais mot pour mot. Le juge de soutien
  accepte une phrase française prouvée par une citation anglaise
- [ ] un jeu de mesure séparé : questions françaises sur la source anglaise, questions anglaises
  sur la même source, questions françaises sur les cours français, pièges. La recherche bilingue
  se mesure à part de la recherche dans une seule langue (EVAL-103)
- [ ] l'interface ne marque plus l'anglais comme non pris en charge une fois la mesure faite.
  Les autres langues le restent
