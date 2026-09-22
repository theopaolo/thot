---
title: AUTH-001 Ajouter les comptes et les rôles
status: done
context: deep
energy: 5
# pleasure: 1 2 3 5 8 13 21
impact: 13
duration: 1h30
scope: [auth]
type: [feature, securite]
due: 2026-09-25
---

## Travail

- [x] table `comptes` avec rôle enseignant ou élève
- [x] `thot compte ajouter`, mot de passe haché en PBKDF2
- [x] session en cookie signé, `hono/csrf`
- [x] les routes `/prof/*` exigent le rôle enseignant

## Terminé quand

- [x] une session élève reçoit 403 sur chaque route `/prof/*`, test à l'appui

## Dépend de

- [[app-002]]
