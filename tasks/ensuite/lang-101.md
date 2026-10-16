---
title: LANG-101 Chercher dans des sources anglaises avec une question française
status: done
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

- [x] raciniser chaque passage avec la langue de sa source, français ou anglais
- [x] trouver des candidats anglais pour une question française, par la voie la plus simple que
  la mesure justifie : racines des deux langues, traduction de la question quand le périmètre
  contient une autre langue, ou les deux
- [x] la réponse reste en français et cite le passage anglais mot pour mot. Le juge de soutien
  accepte une phrase française prouvée par une citation anglaise
- [x] un jeu de mesure séparé : questions françaises sur la source anglaise, questions anglaises
  sur la même source, questions françaises sur les cours français, pièges. La recherche bilingue
  se mesure à part de la recherche dans une seule langue (EVAL-103)
- [x] l'interface ne marque plus l'anglais comme non pris en charge une fois la mesure faite.
  Les autres langues le restent

## Livré

- `indexerSource()` lit la langue de la source : `en` ou `en-…` prend les racines anglaises,
  toute autre langue les racines françaises. L'index des sources françaises reste identique
  octet pour octet, vérifié sur les 545 passages du jeu développement et les 494 passages
  français du jeu langues. Changer la langue d'une source la réindexe déjà.
- Quand le périmètre contient une source anglaise citable, `chercherFts()` ajoute les racines
  anglaises de la question, et `candidatsFts()` la traduit par un appel du modèle de génération
  (`traduire()`). Les candidats de la traduction s'entrelacent avec ceux de la question avant
  le reclasseur, qui lit la question d'origine. Une traduction en panne laisse la question seule.
  Sans source anglaise, aucun appel et les mêmes candidats qu'avant : le jeu développement
  rend les mêmes 44 lignes.
- Jeu langues (`evaluation/langues/`), succès@5 / MRR avec reclasseur, avant puis après :
  `fr-livre` 0,40 / 0,40 puis 1,00 / 1,00, `en-livre` et `fr-cours` 1,00 / 1,00 avant comme
  après. Sans reclasseur, `fr-livre` passe de 0,13 / 0,06 à 1,00 / 0,54. La traduction seule
  donne 1,00 / 0,96, les racines anglaises seules 0,40 / 0,40.
- Génération : 10 questions sur 10 répondues avec la bonne source, phrases en français et
  citations anglaises mot pour mot, 3 pièges sur 3 refusés. Le juge accepte les traductions
  fidèles et refuse les 8 négatifs entre langues écrits à la main.
- L'aide du dépôt, l'avertissement d'extraction et la page de lecture ne signalent plus
  l'anglais. Les autres langues restent signalées.
- Déploiement : les sources anglaises déjà indexées demandent un `thot rebuild`
  (`docs/exploitation.md`).
- Reste ouvert : la moitié des réponses sur la fiche anglaise passent par une réparation, et la
  moitié portent « Vérification partielle » parce qu'un appel du juge dépasse 4 s ([[cit-302]],
  [[ops-504]]). Un manuel anglais long n'est pas mesuré : les mots courants anglais restent dans
  la requête FTS5. Le manuel REAPER d'[[evo-001]] le mesurera.
