# 0010. Faire des activités des séries de questions

Date: 06/11/2026  
Statut: accepté  
Portée: activités, correction, accès

## Contexte

Une activité portait une seule question à réponse rédigée, et chaque champ devait citer un passage
d'une source certifiée : `modifier()` refusait un champ sans passage. Les enseignants envoient
pourtant plusieurs questions à la fois, souvent de types différents : un QCM, un petit exercice de
code, un schéma où l'élève doit trouver ce qui ne va pas. Un schéma faux n'existe dans aucune
source, et l'ADR 0009 garde les énoncés hors du corpus. Ces questions ne pouvaient donc pas
s'écrire.

L'enseignant a déjà 11 quiz dans carnet-quiz, soit 189 questions : 113 à choix unique, 32 à choix
multiple, 28 réponses à taper et 16 réponses rédigées. Aucune ne cite de passage, et presque toutes
ont un indice et une explication.

## Décision

**Une activité est une série de questions.** Une version, une relecture et une publication valent
pour toute la série. L'enseignant règle quand l'élève voit le corrigé : après chaque question ou
après la série.

**L'enseignant peut écrire un champ sans citation.** Un champ que Thot rédige garde ses passages,
vérifiés par `verifier()` puis lus par le juge de soutien. Un champ que l'enseignant écrit, ou dont
il retire tous les passages, n'en a pas besoin. La page affiche alors « Rédigé par l'enseignant » à
la place des passages, pour l'enseignant comme pour l'élève. La règle 1 de l'architecture porte sur
les affirmations de Thot, donc elle ne change pas. La relecture de l'enseignant reste la barrière
avant publication.

**Thot corrige les questions fermées, pas les réponses rédigées.** Un choix unique, un choix
multiple ou une réponse à taper se comparent aux réponses que l'enseignant a saisies. Une réponse à
taper se compare sans majuscules, sans accents et sans mots de liaison, avec une faute de frappe
tolérée dès 5 lettres et deux dès 10, comme dans carnet-quiz. Une réponse rédigée, code compris, ne
reçoit aucune note automatique : l'élève coche les critères qu'il pense remplir, puis l'enseignant
peut la noter et la commenter. Un modèle ne note pas. Les points mesurent ce qui a été pratiqué,
pas un niveau ni une préparation à un examen.

**Une activité peut appartenir à plusieurs cours.** Elle n'est servie dans un cours que si ses
citations tiennent dans le périmètre de ce cours. Un enseignant ne lit que les tentatives des
élèves de ses propres cours.

## Choix écartés

| Option | Raison |
| --- | --- |
| Exiger un passage cité pour chaque champ | Un schéma faux ou un code à corriger ne se trouvent dans aucune source. Les quiz de carnet-quiz ne s'importeraient pas. |
| Déposer les énoncés comme sources | L'ADR 0009 le refuse, parce que Thot citerait une consigne comme un fait. |
| Faire noter les réponses rédigées par un modèle | Aucun jeu annoté ne permet de mesurer ce correcteur (PED-101). |
| Dupliquer l'activité dans chaque cours | Les copies divergent dès la première modification, et l'enseignant corrige la même erreur plusieurs fois. |
| Reprendre les pièges, le chrono et le suivi des sorties de page de carnet-quiz | Ils servent une évaluation en direct en classe. Les contrôles d'examen restent hors du périmètre de PED-101, et carnet-quiz garde cet usage. |

## Conséquences

- `modifier()` accepte un champ sans passage. Dans une même question, des champs rédigés par Thot
  côtoient des champs rédigés par l'enseignant, et la page dit lequel est lequel.
- La phrase « Thot ne note pas la réponse » de l'architecture devient : Thot corrige les questions
  fermées d'après les réponses de l'enseignant et ne note pas les réponses rédigées.
- Un quiz de carnet-quiz s'importe comme une activité en brouillon.
- `activites.cours_id` laisse la place à un lien entre une activité et ses cours. L'accès, le
  périmètre des citations et la lecture des tentatives se calculent par cours.
- Les tâches [PED-102](../../tasks/ensuite/ped-102.md) à [PED-108](../../tasks/ensuite/ped-108.md)
  construisent ces règles.
