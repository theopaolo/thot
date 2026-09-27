---
title: RECH-101 Mesurer le seuil d'affichage de la recherche élève
status: not_started
# pleasure: 1 2 3 5 8 13 21
scope: [eval, recherche, eleve]
---

## Notes

`/eleve/recherche` garde les documents dont le score du reclasseur atteint le quart du meilleur
score, et au moins le seuil d'abstention. Ce quart a été fixé en regardant quatre recherches :
« un toit coloré en vagues au-dessus d'un hall » garde 8 documents (Casa Batlló en tête),
« une chaise en tubes de métal » garde 3 chaises de Mackintosh et Voysey, « une femme qui
pleure » ne garde rien.

À faire : mesurer sur les familles E et F de `eval recherche` le rang de l'œuvre attendue et le
nombre de documents montrés, puis choisir le seuil. Voir si une recherche vaut une ligne dans
`evaluation/README.md`.
