# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Apprenants adultes en reconversion.** Ce sont les étudiants en développement web de
l'enseignant qui construit Thot, servis par une instance au profil général. Ils travaillent
surtout sur ordinateur, en cours et chez eux. Ils lisent la théorie d'un cours, posent leurs
questions avec leurs mots, vérifient chaque réponse contre le passage cité et s'exercent avec les
activités.

**L'enseignant de ces cours.** Il dépose et certifie les ressources, écrit les activités, gère les
élèves et relit leurs questions. Il travaille à son bureau.

**Des enseignants testeurs.** Chacun reçoit sa propre instance en mode personnel. Il y dépose ses
documents et les étudie avec le même compte, pour juger Thot avant d'ouvrir une classe.

**Public prévu : le pilote STD2A.** Des lycéens STD2A révisent sur téléphone, et un enseignant
certifie les sources. Le pilote n'a pas commencé. Le profil arts appliqués reste dans le code pour
lui.

## Product Purpose

Thot transforme des documents certifiés par un enseignant en réponses vérifiables. Chaque
affirmation d'une réponse cite un passage exact d'une source certifiée.

Thot réussit quand un apprenant pose une question avec ses mots et vérifie chaque phrase de la
réponse contre son passage en un clic, sans enseignant présent. Côté enseignant, il réussit quand
l'enseignant sait ce que ses élèves lisent et ce que Thot peut citer.

## Positioning

Deux mécanismes qu'un produit voisin ne peut pas revendiquer honnêtement :

1. Thot vérifie la limite du corpus à chaque réponse. Il retrouve chaque passage cité mot pour
   mot dans une source certifiée, puis un juge contrôle que ce passage prouve la phrase. Une
   question que le cours ne couvre pas reçoit la réponse « hors du cours ».
2. Un contenu pédagogique généré n'atteint un élève qu'après la certification d'un enseignant.
   Une réponse du chat lui parvient seulement si chacune de ses affirmations cite un passage
   certifié. Thot ne suggère que les questions auxquelles il répond avec des citations
   vérifiées.

Les règles exactes vivent dans `docs/architecture.md`, section « Règles du produit ».

## Operating Context

- Une instance sert un établissement, un département ou un usage personnel. Son profil, général ou
  arts appliqués, fixe les termes et les champs du dépôt.
- L'interface est en français. Elle tutoie l'élève et vouvoie l'enseignant. Les termes viennent de
  `docs/vocabulaire.md`.
- Le corpus est théorique. Un énoncé d'exercice reste hors du corpus
  ([ADR 0009](docs/decisions/0009-enonces-hors-du-corpus.md)).
- Une activité est une série de questions que l'enseignant relit et publie
  ([ADR 0010](docs/decisions/0010-series-de-questions.md)).
- L'enseignant crée les comptes élèves, importe une classe en CSV ou partage un lien d'inscription.

## Capabilities and Constraints

Le code décrit ce qui existe. `README.md` dit comment le lancer, `docs/architecture.md` donne les
règles et ce qui reste hors du périmètre du pilote.

Pas construits, et sans promesse : flashcards, révisions espacées, XP, séries de jours, notes de
l'élève, profil, fiches générées. Un besoin confirmé devient une tâche dans `tasks/`.

Questions ouvertes : la date du pilote STD2A.

## Brand Commitments

- Le nom est Thot.
- Une panne ne ressemble pas à une limite du cours. Un échec reste visible avec sa cause.
- Repris du `PRODUCT.md` du laboratoire (`../PRODUCT.md`) comme contre-modèles : le chatbot
  généraliste avec son avertissement « l'IA peut se tromper », et l'ENT gris et institutionnel
  (Moodle).

## Evidence on Hand

- Les 13 cours de développement web dans `var/dev`, et le cours Three.js dans `var/creative`. Ce
  sont deux instances locales, hors du dépôt.
- Les 11 quiz de l'enseignant, soit 189 questions, décrits par l'ADR 0010.
- Les jeux annotés et les mesures de `evaluation/`.
- Trois chapitres STD2A réels dans `../corpus/`, hors du dépôt.
- `docs/notice-familles.md` : un projet de notice que l'établissement doit encore valider.

Il n'existe encore ni résultats d'élèves, ni données d'usage, ni témoignages, ni retours écrits
des testeurs, ni prix, ni licence. Aucun travail ne doit en inventer.

## Product Principles

1. **La contrainte est le produit.** Chaque écran rend la question « d'où vient cette phrase ? »
   facile à trancher. Une citation ouvre son passage en un clic, au même rang que le texte.
2. **Généré n'est pas certifié.** L'écart entre ce que Thot propose et ce que l'enseignant a
   certifié se voit sur chaque écran qui montre les deux.
3. **Dire ce qui se passe.** Un état vide dit pourquoi il est vide, une erreur nomme sa cause et la
   façon d'en sortir.
4. **Deux surfaces, un système.** L'élève lit et pratique, l'enseignant dépose et relit. Les deux
   surfaces partagent les mêmes composants et les mêmes termes.
5. **Pas de fonction sans données.** Une fonction se construit quand du contenu réel la demande.

## Accessibility & Inclusion

- WCAG AA au minimum. Le contraste se vérifie sur le fond crème.
- Un statut porte un libellé en plus de sa couleur.
- La surface enseignant se parcourt entièrement au clavier.
- Une image de contenu porte un texte alternatif tiré de sa légende ou du titre de sa ressource.
- Les pages élève tiennent dès 320px de large, la surface enseignant vise le bureau.
- Les animations respectent `prefers-reduced-motion`.
