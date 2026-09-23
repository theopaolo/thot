---
title: AUTH-002 Invalider la session à la déconnexion
status: done
context: shallow
energy: 2
# pleasure: 1 2 3 5 8 13 21
impact: 5
duration: 30min
scope: [auth]
type: [bug, securite]
due: 2026-09-23
---

## Travail

- [x] `/deconnexion` incrémente `session_version` : un cookie copié ou resté sur un autre appareil ne sert plus
- [x] une requête sans en-tête `Origin` refusée par `hono/csrf` rend 403, plus 500 : `onError` renvoie la réponse d'une `HTTPException`

## Terminé quand

- [x] vérifié dans Helium : l'ancien cookie rejoué après déconnexion renvoie vers `/connexion`
- [x] `POST /connexion` sans `Origin` : 403
- [x] commité

## Dépend de

- [[auth-001]]

## Notes

Se déconnecter ferme aussi les sessions de l'enseignant sur ses autres appareils.
