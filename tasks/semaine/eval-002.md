---
title: EVAL-002 Rejouer les 59 requêtes annotées
status: not_started
context: deep
energy: 5
# pleasure: 1 2 3 5 8 13 21
impact: 8
duration: 2h
scope: [eval]
type: [mesure]
due: 2026-09-24
---

## Travail

- [ ] script Python de `evaluation/` qui convertit `queries_real.py` en JSON
- [ ] cibles résolues par nom de fichier via `img_order.json` du dépôt parent
- [ ] `thot eval recherche` calcule succès@5 et MRR par famille

## Terminé quand

- [ ] résultats publiés dans `evaluation/resultats/`
- [ ] 0,97 atteint, ou chaque famille en écart expliquée

## Dépend de

- [[ret-001]]
