---
title: META-101 Pré-remplir date, artiste et mouvement à l'ingestion
status: done
# pleasure: 1 2 3 5 8 13 21
scope: [ingestion, revue]
type: [feature]
---

## Travail

- [x] séparer « Artiste ou mouvement pour le quiz » (`quiz_reponse`) en deux champs, artiste et mouvement
- [x] le quiz élève accepte l'un ou l'autre
- [x] proposer date, artiste et mouvement à partir du nom de fichier et des premiers blocs de texte
- [x] l'enseignant valide ou corrige la proposition comme une légende

## Notes

Retour d'un enseignant du pilote : dans « Modifier les informations » de la page d'une source,
la date de l'œuvre et l'artiste ou mouvement sont toujours vides. Ces informations sont souvent
dans le nom du fichier ou dans le contenu.

Une valeur proposée ne doit pas passer pour validée : le quiz et les réponses ne s'en servent
qu'après validation. Ne rien proposer qui ne se lit pas dans le fichier ou son nom, comme
`CONSIGNE_LEGENDE` pour les légendes.

Essai sur 10 sources du pilote avec DeepSeek V4.1 Flash : 1 à 2,5 s par source, valeurs justes
sauf « William de Morgan (1839-1917) », où la date proposée est celle de la vie de l'artiste.
`lireInformations` écarte une valeur dont un morceau ne se lit pas dans la fiche.
