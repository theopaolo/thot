---
title: EVAL-102 Expliquer la baisse de la recherche depuis le 22/09
status: done
# pleasure: 1 2 3 5 8 13 21
scope: [eval, recherche]
---

## Notes

`eval recherche` avec le reclasseur donnait 0,93 de succès@5 le 22/09 et donne 0,90 le 27/09,
déjà avant la réextraction des synthèses (mesuré sur la sauvegarde de la base). Requêtes perdues :
B03 (« l'église de Barcelone jamais finie ») et F11 (« les grandes courbes en métal qui montent
le long de l'escalier »).

## Cause

Les légendes de deux images ont changé. Aucun code de recherche n'est en cause.

La cible de B03 est `Sagrada Familia … interieur`, celle de F11 `Victor Horta, Hotel Tassel
(1892) Interieur`. Les deux sources sont certifiées, avec un passage chacune. Les légendes
viennent de `qwen3-vl-8b`, qui ne redonne pas le même texte à chaque ingestion :

| Image | Légende du 28/08 (banc d'essai) | Légende de l'instance |
| --- | --- | --- |
| Sagrada interieur | « une **église** à piliers massifs » | « un grand intérieur à colonnes, comme dans une **cathédrale** » |
| Hotel Tassel interieur | « rampe de **escalier** en bois et **métal** » | « une rampe en fer forgé s'enroule autour d'un pilier » |

La requête dit « église », « escalier », « métal ». La nouvelle légende n'a aucun de ces mots,
donc FTS5 ne sort plus la cible dans ses 20 candidats.

| Mesure | Rang de la cible B03 | Rang de la cible F11 |
| --- | --- | --- |
| Rapport du 22/09, FTS5 seul | 5 | 4 |
| Rapport du 22/09, reclasseur | 3 | 3 |
| Rapport du 27/09, FTS5 seul | absente | absente |
| Rapport du 27/09, reclasseur | absente | absente |
| Instance actuelle, FTS5 top 20 | absente | absente |
| Instance actuelle avec les légendes du 28/08 remises dans ces deux passages, FTS5 | 4 | 4 |
| Idem, après reclasseur | 3 (score 0,07) | 1 (score 0,87) |

Les rapports du 22/09 ont été produits à 23 h 29 et 23 h 52, le 22/09. Les fichiers de
`data/content/` de l'instance datent du 23/09 à 00 h 03. Le corpus a donc été réingéré après le
premier rapport, et les légendes ont été régénérées. Je n'ai pas la base du 22/09, donc je ne peux
pas montrer ses légendes. La remise des légendes du 28/08 suffit à retrouver les deux requêtes.

## Autres pistes

- Code de recherche : `chercherFts` et `chercher` ont changé entre les deux rapports (filtre de
  périmètre, de public), pas le classement `bm25(chunks_fts, 3.0, 1.0)` ni le reclassement. Les
  deux cibles sont certifiées et lisibles par le système, le filtre ne les écarte pas.
- Variation du reclasseur : deux passages complets identiques donnent les mêmes 59 rangs et les
  mêmes six échecs. Les scores bougent de 0,02 à 0,03 sur quelques passages (Parc Güell 0,2451
  puis 0,2695 sur F11), ce qui change l'ordre de quelques ex æquo dans le top 5 (C04, C05, E13,
  F08) sans toucher un seul rang de cible. Le reclasseur ne perd pas les requêtes.
- FTS5 seul : 6 rangs diffèrent entre le rapport suivi du 27/09 et l'instance actuelle (B01, C01,
  C05, D06, E10, F02), l'extraction ayant changé depuis. B03 et F11 restent absentes dans les
  deux.

## Conclusion

Une réingestion régénère les légendes, et une requête qui ne tient qu'à un mot de la légende
(« église », « escalier ») s'y perd. Une requête vaut 1/59, soit 0,017 de succès@5. Deux requêtes
valent donc les 0,03 de baisse. Le banc ne distingue pas un recul de la recherche d'un tirage
différent du modèle de vision. Un écart de 0,03 après réingestion n'est pas un signal.

Pas de correctif de code.
