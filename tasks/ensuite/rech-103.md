---
title: RECH-103 Dire que la traduction est en panne sur la page de recherche
status: done
scope: [recherche, eleve]
type: [bug]
---

## Dépend de

- [[ans-105]]

## Notes

Depuis [[ans-105]], `chercher()` rend `panneTraduction` quand le modèle de traduction ne répond pas,
et le chat en fait un échec que l'élève relance. La page `/eleve/recherche`
(`src/app/routes/eleve.ts`) appelle `chercher()` sans lire ce champ. Dans un périmètre où seules
des sources anglaises répondent, elle affiche une liste vide, comme si le cours n'avait rien.

- [x] la page dit que la recherche est incomplète et propose de réessayer
- [x] un test : une traduction en panne sur un périmètre anglais n'affiche pas « aucun résultat »
