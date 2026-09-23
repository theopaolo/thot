---
title: RGPD-001 Préparer le pilote avec des élèves mineurs
status: in_progress
context: deep
energy: 3
# pleasure: 1 2 3 5 8 13 21
impact: 13
duration: 2h
scope: [pilote]
type: [doc, securite]
due: 2026-09-26
---

## Travail

- [x] notice aux élèves et aux familles : `docs/notice-familles.md`
- [x] purge des échanges après `THOT_RETENTION_JOURS` jours (90 par défaut), par le worker toutes les heures
- [x] requêtes aux modèles avec `zdr` et `data_collection: deny`, sans nom ni identifiant d'élève
- [x] les réponses aux élèves ne sont plus mises en cache. Seules les légendes le sont. La migration 0004 vide l'ancien cache
- [x] `THOT_OPENROUTER_URL` pour passer par le routage européen d'OpenRouter

## Terminé quand

- [ ] l'établissement complète et valide la notice : responsable, base légale, contact, durée
- [ ] fournisseurs et lieux de traitement confirmés. Routage européen activé sur le compte OpenRouter, ou transfert hors UE accepté par écrit
- [x] commité dans b211003

## Dépend de

- [[chat-001]]
- [[cpt-001]]

## Notes

Les questions d'élèves partent chez OpenRouter et ses hébergeurs. L'établissement demandera ce document avant d'ouvrir le service.
