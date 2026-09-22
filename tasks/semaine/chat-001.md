---
title: CHAT-001 Construire le chat élève
status: done
context: deep
energy: 5
# pleasure: 1 2 3 5 8 13 21
impact: 13
duration: 2h30
scope: [eleve]
type: [feature]
due: 2026-09-25
---

## Travail

- [x] étapes de recherche en SSE, réponse publiée en un fragment
- [x] panneau source avec le passage surligné, `hx-target` et `hx-sync`
- [x] brouillon conservé sur erreur
- [x] messages et journal enregistrés

## Terminé quand

- [x] refus hors corpus et panne ont deux messages distincts
- [x] trois clics successifs sur des citations gardent des identifiants DOM uniques

## Dépend de

- [[ans-001]]

## Notes

Point de départ : le chat de `mesures/benchmark-ui/hono/` du dépôt parent.

Fait le 22/09. Vérifié dans Helium sur ordinateur et à 390 px. Sur mobile, le panneau source défile en vue au lieu d'ouvrir une vue dédiée comme dans les maquettes.
