---
title: CHAT-002 Répondre aux questions de relance
status: done
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

- [x] « et Matisse ? » après une question sur le fauvisme donne une réponse citée, vérifié dans Helium
- [x] commité dans b211003
- [x] commiter la correction de `reformuler`

## Dépend de

- [[ans-001]]
- [[chat-001]]

## Notes

Avant ce ticket, chaque question était traitée comme la première. Le chat laissait croire que Thot se souvenait.

Corrigé le 23/09 : `reformuler` désactivait le raisonnement, gpt-oss répond 400 à `reasoning: {enabled: false}`. Le `catch` avalait l'erreur et la recherche partait avec la question brute. « et Matisse ? » répondait quand même, parce que le générateur voit la question précédente et que « Matisse » suffit à la recherche. Passé en effort `low` avec 600 tokens : « et Matisse ? » devient « Quel rôle Matisse a-t-il joué dans le fauvisme ? » en 250 à 800 ms. Vérifié par HTTP sur une copie, pas à l'écran.
