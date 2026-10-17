# 0008. Garder le SQL de `node:sqlite`, sans ORM ni query builder

Date: 17/10/2026  
Statut: accepté. Complète l'accès SQL de [0003](0003-application-deno-hono-htmx.md).  
Portée: accès à la base, typage des résultats

## Contexte

Le code écrit 248 requêtes avec `db.prepare()` sur `DatabaseSync`. 88 résultats de `.get()` ou
`.all()` reçoivent un type par `as {…}` que rien ne vérifie. `prepare` refuse une table ou une
colonne inconnue dès qu'un test atteint la requête. Un alias mal écrit dans le type passe sans
erreur et donne `undefined`.

La question était de typer les requêtes avec un ORM ou un query builder. Les défauts trouvés
dans les revues d'octobre 2026 étaient des règles recopiées ou placées hors de leur transaction :
`compte_id = ?` répété 18 fois dans les routes, « une réponse à la fois » vérifiée avant
l'insertion, une relecture d'ancienne révision qui rendait une liste vide par défaut. Aucun
n'était un défaut de type.

## Décision

Les requêtes restent en SQL avec `node:sqlite`. Chaque requête vit dans le module qui porte sa
règle, avec un type de retour déclaré une fois. Un fragment partagé comme `FILTRE_ACCES` passe en
paramètres nommés (`$lecteur`), que `node:sqlite` accepte, au lieu de paramètres positionnels
dont la place dépend de toute la requête.

## Choix écartés

| Option | Raison |
| --- | --- |
| Kysely | L'exécution est asynchrone. Le code ouvre `BEGIN IMMEDIATE` sur l'unique connexion et y fait tourner du code synchrone : en asynchrone, la requête d'une autre connexion HTTP s'exécuterait dans une transaction ouverte. Le dialecte `node:sqlite` vient de paquets tiers. |
| Drizzle | Le pilote `drizzle-orm/node-sqlite` est synchrone, mais sa documentation l'installe depuis le tag `rc`. Il ajoute un schéma TypeScript à tenir à côté de `migrations/*.sql`. FTS5 (`MATCH`, `bm25`), les 19 `json_extract` et les 8 `json_each` passeraient par le gabarit `sql` brut, typé à la main. |
| ORM complet | Mêmes limites que Drizzle, et le SQL réel disparaît derrière les entités. |

## Conséquences

- Le typage des lignes reste une assertion. Un alias faux se découvre au test qui lit la valeur.
- Aucune dépendance ni génération de code en plus. Les requêtes propres à SQLite restent lisibles.
- Déplacer les 18 requêtes des routes qui recopient une règle d'accès est un travail à faire
  ([ARC-101](../../tasks/ensuite/arc-101.md)).

## Conditions de réexamen

Le pilote Drizzle pour `node:sqlite` sort en version stable, et des bugs de type sur des résultats
de requête apparaissent dans les tests ou en production.
