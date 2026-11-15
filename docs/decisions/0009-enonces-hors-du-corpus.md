# 0009. Laisser les énoncés d'exercice hors du corpus

Date: 17/10/2026  
Statut: accepté. Le 15/11/2026, les quiz corrigés et les étapes guidées sortent aussi du corpus, voir Décision.  
Portée: corpus, réponses, questions suggérées

## Contexte

Le cours de développement mêlait théorie et énoncés : ateliers, TP, consignes « Sur votre
projet », questions « Pour la discussion », grille d'évaluation. Sur l'instance de développement,
69 passages sur 1 194 venaient d'un énoncé. Deux défauts en sortaient.

Une consigne devenait une définition. L'atelier des user stories demande « écrivez trois user
stories : une pour choisir un atelier… ». Thot a répondu « Une user story sert à choisir un
atelier. » `verifier()` a retrouvé les mots et le juge a validé la phrase, puisque le passage la
dit. La réponse portait le badge « Réponse vérifiée ».

Les questions suggérées partaient des énoncés. `genererSuggestions()` lit les deux plus longs
passages d'une source, et un atelier est souvent le plus long. Les quatre suggestions du chapitre
sur les user stories portaient sur l'atelier de la MJC ou sur l'exemple d'Inès.

La première version de cette décision gardait les quiz avec leur corrigé, les étapes guidées et les
procédures. Les réponses de Thot ressemblaient encore à des consignes, parce que ces passages
s'adressent à l'élève qui fait l'exercice. Le chapitre sur Strategy commençait ainsi par
« Travaillez dans une copie du programme de départ `ateliers.ts` », puis demandait « Remplacez
seulement la méthode `reserver` par cette version ». Le 15/11/2026, une seconde passe sur
l'instance de développement a supprimé 3 sources faites seulement d'exercices et retiré 175 extraits
de 57 autres. L'index est passé de 1 060 à 980 passages.

## Décision

Thot sert à réviser un cours théorique. Une source porte des notions, des exemples commentés et des
procédures générales, celles qui répondent à « comment faire » pour n'importe quel projet. Les
exercices restent hors de Thot : quiz et corrigé, étape guidée sur un fichier de départ, consigne
sur le projet de l'élève, rendu attendu, questions de discussion, grille d'évaluation.

Une phrase à l'impératif ne fait pas à elle seule un énoncé. « Nommez une classe d'après son rôle »
énonce une règle générale et reste dans la source. « Remplacez la méthode `reserver` » donne une
tâche sur un fichier du cours et en sort. Un exemple commenté bâti sur le domaine fictif du cours,
comme la MJC, reste aussi, une fois retirées les phrases qui demandent à l'élève de le refaire.

L'enseignant retire les énoncés avant le dépôt. Le code ne les détecte pas.

Un exercice a sa place dans les activités du cours. Les exercices que Thot génère (activités
sourcées) restent des objets à part, qui citent la théorie et ne servent pas de preuve. Un
générateur ou une banque d'exercices pour les enseignants vivra aussi hors du corpus.

## Choix écartés

| Option | Raison |
| --- | --- |
| Décocher « Thot s'en sert pour répondre » | La source quitte les réponses et les suggestions, mais reste dans les ressources de l'élève. Un énoncé placé à la fin d'un chapitre de théorie reste cité. |
| Marquer une section comme énoncé sur la page de la source | Un drapeau par section à respecter dans l'index, les suggestions et la relecture, pour un contenu que Thot ne sert pas. |
| Détecter les énoncés par leurs titres | « Atelier », « Exercice » ou « Rendu » nomment aussi le domaine des exemples : la MJC du cours de développement propose des ateliers. Une détection fausse retire de la théorie sans que personne le voie. |

## Conséquences

- Les cours de `cours-ada` gardent leurs exercices sur carnet.ludique.dev. Thot n'en importe que
  la théorie.
- Un document déposé qui mêle cours et énoncé ramène les deux défauts. La relecture avant
  certification reste le seul contrôle.
- La seconde passe a trouvé la plupart des énoncés dans un paragraphe ou une phrase d'un chapitre
  de théorie, comme « Pour l'atelier, vérifiez… » : 126 coupes sur 175. La relecture lit donc le
  texte entier, et pas seulement les titres.
