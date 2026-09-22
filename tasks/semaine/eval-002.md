---
title: EVAL-002 Rejouer les 59 requêtes annotées
status: done
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

- [x] script Python de `evaluation/` qui convertit `queries_real.py` en JSON
- [x] cibles résolues par nom de fichier via `img_order.json` du dépôt parent
- [x] `thot eval recherche` calcule succès@5 et MRR par famille

## Terminé quand

- [x] résultats publiés dans `evaluation/resultats/`
- [x] 0,97 atteint, ou chaque famille en écart expliquée

## Dépend de

- [[ret-001]]

## Notes

FTS5 seul, 22/09 : succès@5 0,90, MRR 0,70 (banc : 0,85 et 0,67). A, B, C 1,00, D 0,86, E 0,86, F 0,79. Reste à mesurer avec le reclasseur : il faut `OPENROUTER_API_KEY`.

Avec le reclasseur, 22/09 : succès@5 0,93, MRR 0,85 (banc : 0,97 et 0,93). A, B, C 1,00, D 0,86, E 0,93, F 0,86. Quatre échecs expliqués :
- D07 : « Futurisme : Retombées » passe devant la cible, et répond aussi à la question.
- E13 et F13 : le club Roussakov n'entre pas dans le top 20 FTS5, le reclasseur ne peut pas le remonter. C'est le cas que [[ret-201]] traite.
- F06 : une autre affiche de Rodtchenko passe devant la cible.
