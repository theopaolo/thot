# 0002. Extraire une fiche de chapitre ancrée

Date: 10/09/2026  
Statut: accepté

## Décision

L'ingestion produit un artefact de plus, `fiche.json`, décrit au §7 de
`../../ARCHITECTURE.md`. Il porte des champs typés: chapitre, notions, repères,
exercices, prérequis, objectifs. Chaque champ cite un passage exact de
`document.txt` par `block_id` et offsets.

Trois règles tiennent l'artefact.

1. Un champ dont les offsets ne retombent pas exactement sur le texte canonique
   est rejeté avant écriture et compté dans le rapport d'ingestion.
2. Un champ généré non relu enrichit `retrieval_text` et rien d'autre. Il ne
   devient ni preuve, ni citation, ni contenu visible par un élève.
3. La certification d'une source et celle de sa fiche sont deux actions
   distinctes du back-office.

## Pourquoi

La pipeline s'arrêtait au texte: blocs, chunks, légendes. Les fiches et les
quiz du back-office devaient donc être demandés à un modèle sans autre
contrainte que les extraits récupérés, et la ligne « quiz et fiches » du calcul
de marge restait une estimation arithmétique.

Des champs ancrés déplacent le problème. Un quiz se construit depuis vingt
notions relues au lieu d'être rédigé de bout en bout à chaque demande. La
recherche gagne des filtres par notion. Le rappel lexical gagne le mot qu'un
élève emploie et que le document n'écrit nulle part en clair, ce que les
mesures de légendage avaient déjà montré: sur la famille visuelle, les légendes
de modèle passent de 0,50 à 0,93 en BM25 contre les légendes humaines, parce
que le modèle décrit en mots courants.

## Exemples dans la consigne

L'extraction reçoit des documents d'exemple. Les résultats publiés sur une
pipeline d'extraction de marqueurs médicaux placent le point utile autour de
trois fichiers, avec un F1 de 0,98 pour GPT-4o et 0,968 pour Claude Sonnet.
Gemini Pro y demande six fichiers pour 0,947. Le nombre d'exemples dépend donc
du modèle et reste un paramètre à mesurer, pas une constante.

Une contrainte vient de notre propre historique. La première consigne de
légendage contenait trois exemples de formulation, et ces trois formulations
étaient les cibles de trois requêtes du jeu de test. Le modèle les recopiait
dans ses 181 légendes, et le score mesurait la consigne. Les documents
d'exemple viennent donc d'un chapitre absent du jeu d'évaluation, et
`prompt_version` comme `fewshot_set_id` sont écrits dans la fiche.

## Choix écartés

- **Le consensus entre plusieurs modèles.** La même présentation le montre
  gagnant au vote minimal de 1, c'est-à-dire à l'union des extractions:
  précision 0,992 et rappel 0,981 sur trois modèles. À trois votes exigés, le
  rappel tombe à 0,767. L'union coûte donc un appel par modèle et par document.
  Rouvrable si un modèle seul reste sous la cible une fois les exemples réglés,
  seuil inscrit au §17 de l'architecture.
- **Les champs non ancrés.** Un objectif pédagogique déduit du contenu mais
  écrit nulle part est une affirmation sans passage, donc hors de l'invariant 1.
  `prerequis` et `objectifs` restent vides sur la plupart des fiches du corpus
  pilote, et c'est le comportement attendu.
- **Une ontologie partagée.** L'équivalent de SNOMED ou LOINC n'existe pas pour
  un corpus de cours, et le construire dépasse le pilote. Le vocabulaire de
  `reperes.type` est une configuration par matière.
- **L'extraction avant le découpage.** Les ancres ont besoin des blocs et de
  leurs offsets. La fiche se construit après eux.

## Mesure requise

GPT OSS 120B est mesuré en génération de réponse, pas en extraction. Vingt
documents du corpus pilote doivent être annotés avec leur fiche attendue, puis
l'extraction mesurée sans exemples et avec trois. C'est le point 5 du §18 de
l'architecture et les tickets `EVAL-101` et `EVAL-102` du backlog.

Ce travail d'annotation ne dépend d'aucun code et peut démarrer maintenant.
