---
title: RECH-101 Mesurer le seuil d'affichage de la recherche élève
status: done
# pleasure: 1 2 3 5 8 13 21
scope: [eval, recherche, eleve]
---

## Notes

`/eleve/recherche` garde les documents dont le score du reclasseur atteint une part du meilleur
score (`RATIO_AFFICHAGE` dans `src/core/recherche.ts`), et au moins le seuil d'abstention. Le
quart avait été fixé en regardant quatre recherches.

## Mesure

`thot eval recherche --ratios=0,0.1,0.25,0.35,0.5,0.75` rejoue les 59 requêtes avec la même
fonction que la route (`documentsProches`) et mesure la liste affichée : un passage par source,
12 sources au plus. Le rang d'une cible ne dépend pas du ratio, le ratio coupe la fin de la liste.
Rapport : `evaluation/resultats/recherche-affichage.json`. Rappel : part des cibles montrées parmi
celles que la requête attend. Documents : nombre moyen montré.

| Famille | Ratio 0,1 : rappel / documents | 0,25 | 0,5 |
| --- | --- | --- | --- |
| E | 0,76 / 4,4 | 0,76 / 2,9 | 0,76 / 2,4 |
| F | 0,71 / 4,4 | 0,71 / 3,6 | 0,71 / 2,6 |
| A | 1,00 / 5,4 | 1,00 / 4,0 | 0,94 / 3,1 |
| C | 0,72 / 9,0 | 0,63 / 7,0 | 0,52 / 5,3 |
| Toutes | 0,72 / 4,8 | 0,69 / 3,8 | 0,64 / 2,9 |

- Le succès (E 0,93, F 0,79) et le MRR (E 0,86, F 0,75) ne changent pas de 0,1 à 0,5. Les
  cibles trouvées sont à la première ou deuxième place de la liste. Les quatre requêtes sans cible
  dans la liste (E13, F06, F11, F13) échouent déjà sans ratio (ratio 0). F11 : voir EVAL-102.
- À 0,75, F07 perd sa cible (rang 2 sur 2 documents devient 0 sur 1) et F passe à 0,71 de
  succès.
- De 0,1 à 0,25 la liste perd 1,5 document en E et 0,9 en F sans toucher une cible. De 0,25 à
  0,5 elle en perd encore 0,4 à 0,9, mais A perd 0,06 de rappel et C 0,11. C regroupe les
  requêtes qui attendent plusieurs œuvres (5 à 14 cibles).

## Choix

Le quart reste. Sur E et F le rappel est le même de 0,1 à 0,5, le ratio ne fait que raccourcir
la liste. Le quart la ramène de 4,4 à 2,9 documents en E et à 3,6 en F. Passer à 0,5 retire
encore 0,4 document en E et 0,9 en F, et coûte du rappel aux requêtes à réponses multiples (A de
1,00 à 0,94, C de 0,63 à 0,52). Aucune mesure ne justifie de changer la constante. Le seul recul à
0,25 est C (0,72 à 0,63), pour une liste de 7 documents au lieu de 9.

Reste non mesuré : les requêtes sans œuvre (« une femme qui pleure ») n'existent pas dans ce jeu,
le seuil d'abstention seul les écarte.
