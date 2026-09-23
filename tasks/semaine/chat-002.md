---
title: CHAT-002 Répondre aux questions de relance
status: in_progress
context: deep
energy: 5
# pleasure: 1 2 3 5 8 13 21
impact: 8
duration: 2h
scope: [reponse]
type: [feature]
due: 2026-09-25
---

## Travail

- [x] `Modeles.reformuler(precedente, question)` : la relance devient une question autonome
- [x] la reformulation sert à la recherche seulement, la question de l'élève reste affichée et envoyée au générateur
- [x] une reformulation en panne ne bloque pas la question
- [x] la question précédente est cherchée dans le même chapitre

## Terminé quand

- [ ] « et Matisse ? » après une question sur le fauvisme donne une réponse citée, vérifié dans Helium
- [ ] commité

## Dépend de

- [[ans-001]]
- [[chat-001]]

## Notes

Avant ce ticket, chaque question était traitée comme la première. Le chat laissait croire que Thot se souvenait.
