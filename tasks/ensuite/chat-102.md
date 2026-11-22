---
title: CHAT-102 Ne pas répéter le nom du cours dans le périmètre
status: done
scope: [eleve]
type: [bug]
---

## Notes

Le chat affiche « Dans : Développement / Lire, comprendre et améliorer une codebase / Lire,
comprendre et améliorer une codebase ». `nomPerimetre()` dans `src/app/vues/commun.ts` joint
matière, cours et thème, et l'import du jeu développement a créé dans chaque cours un thème du
même nom que le cours.

- [x] un thème homonyme de son cours n'est pas répété dans le libellé
