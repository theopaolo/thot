---
title: EVAL-003 Rejouer les 35 questions de génération
status: done
context: shallow
energy: 2
# pleasure: 1 2 3 5 8 13 21
impact: 8
duration: 1h
scope: [eval]
type: [mesure]
due: 2026-09-27
---

## Travail

- [x] 20 questions d'élève et 15 pièges par `thot ask --json`

## Terminé quand

- [x] taux de réponse fondée, d'abstention et de faux refus publiés par registre

## Dépend de

- [[ans-001]]

Fait le 22/09 avec `thot eval generation`. Dans le corpus (20) : 0,90 répondues, 0,85 avec la source attendue, 0,10 de faux refus (G16, G19, refus du modèle malgré un score haut), 0 panne. Pièges (15) : 14 refusés, 1 réponse fondée mais partielle (N10, Bauhaus et design suédois, cite la fiche Néoplasticisme). Latence médiane 1 s avec le routage OpenRouter vers l'hébergeur le plus rapide.
