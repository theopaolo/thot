# Évaluation

`queries_real.py` contient les requêtes annotées de recherche, réparties en familles.
`queries_generation.py` contient des questions répondables et des pièges sans réponse dans le
corpus. Les deux fichiers sortent du banc d'essai et restent tels quels pour ne pas altérer la
vérité terrain. `python3 evaluation/exporter.py` les convertit en JSON pour `thot eval`, sans toucher aux
identifiants ni aux cibles.

```bash
pnpm thot eval recherche --img-order=../mesures/thot-real/img_order.json \
  --docs=../mesures/thot-real/docs.json [--sans-reclasseur]
pnpm thot eval generation
pnpm thot ask "Pourquoi les cubistes ont-ils abandonné la perspective ?"
```

## Soutien des citations

`verifier()` contrôle qu'une citation existe mot pour mot. `thot eval soutien` mesure si un juge
repère une citation réelle qui ne prouve pas la phrase qu'elle accompagne.

```bash
pnpm thot eval generation --paires=../mesures/thot-real/paires-soutien.json
pnpm thot eval soutien --paires=../mesures/thot-real/paires-soutien.json
```

Le fichier de paires contient des citations du corpus : il reste dans le dépôt de recherche.
`eval generation` refuse d'écraser un fichier existant. L'annotation remplit `soutient` :

- `true` si la citation suffit à établir toute la phrase, sans savoir extérieur. Le titre de
  l'extrait (`titre`) et le paragraphe autour de la citation (`paragraphe`, celui que le
  panneau source montre à l'élève) peuvent donner le sujet : le mouvement, l'artiste ou
  l'œuvre. Le fait lui-même doit être dans la citation.
- `false` si la phrase ajoute, généralise, inverse ou change l'auteur de ce que dit la
  citation. Un soutien partiel compte comme `false`, car l'élève lit la phrase entière.

Les sorties réelles sont presque toutes justes. Les négatifs s'écrivent à la main : copier une
ligne, lui donner un nouvel `id`, réécrire `texte` et nommer la `famille` (`inversion`,
`généralisation`, `attribution`, `ajout`). Le rapport donne l'AUC, les erreurs au seuil 0,5 par
famille, et ne garde que les identifiants. Le modèle jugé se change par `THOT_MODELE_SOUTIEN`.

Les rapports produits par `thot eval` restent dans le répertoire de données de l’instance,
sous `evaluation/resultats/`. Les résultats de référence suivis dans ce dépôt restent dans
`resultats/`. Le corpus ATC et `img_order.json` restent dans le dépôt de recherche.

## Langues et profils

`tests/domaines_test.ts` contient une sonde lexicale synthétique français/anglais et les contrôles
sans fournisseur des prompts génériques, du profil arts et des périmètres de recherche. Il
vérifie que les consignes du profil arts ont l'empreinte des mesures ml4. La sonde
trouve trois cibles sur quatre en français et une sur quatre en anglais avec la racinisation
actuelle. Le pluriel irrégulier français et les formes anglaises montrent les limites du moteur.
Ce petit jeu ne mesure ni la recherche bilingue entre documents et questions ni la qualité des
modèles. L'anglais reste non pris en charge dans l'interface. Aucun changement de tokenisation ni
reindexage automatique n'est introduit.

## Comparaison des modèles

[La synthèse des mesures](resultats/ml4-comparaison.json) relie les résultats et leurs limites.

Les bancs `bench_generation.ts`, `bench_soutien.py` et `bench_vision.ts` comparent les modèles
sur les jeux figés. `bench_generation.ts` crée au premier lancement une sauvegarde SQLite en
lecture seule pour les essais. Le banc de vision réutilise cette sauvegarde. Les réponses,
citations, légendes et traces complètes restent dans `data/benchmark-ml4/`, ignoré par Git.
Les rapports publiés dans `resultats/ml4-*.json` gardent les mesures et les identifiants.

```bash
node --env-file=.env evaluation/bench_generation.ts deepseek 1
node --env-file=.env evaluation/bench_generation.ts ml4 1
node --env-file=.env evaluation/bench_generation.ts ml4-json 1
node --env-file=.env evaluation/bench_generation.ts deepseek-ml4judge 1
node --env-file=.env evaluation/bench_generation.ts deepseek 1 followup
node --env-file=.env evaluation/bench_generation.ts deepseek 1 suggestions
python3 evaluation/bench_soutien.py --profiles ml4-none glm-low
node --env-file=.env evaluation/bench_vision.ts run
python3 evaluation/bench_tps.py
```

Le numéro de passage distingue les essais de génération. Une sortie existante est protégée.
Les bancs de soutien et de vision reprennent leurs résultats privés sauvegardés, sans refaire
les appels terminés. Une nouvelle mesure complète exige un nouveau dossier de résultats
privés. Les scripts Python utilisent le magasin de certificats de `certifi`.

Le débit calculé sur la requête entière inclut l'attente réseau et le traitement du prompt.
`bench_tps.py` récupère aussi le débit calculé à partir du temps de génération déclaré par
OpenRouter, avec le fournisseur et la couverture de l'échantillon. Les tokens de raisonnement
et les différences de tokenisation empêchent d'assimiler ce débit à une vitesse de lecture.

« Répond » et « bonne source » mesurent la chaîne existante, pas une annotation indépendante
de la justesse des réponses. Les dépassements du délai du juge sont comptés séparément. Les
suggestions portent sur un seul passage par source pour une comparaison à entrées égales.
Les reformulations sont testées seules, sans mesurer la recherche qui suit. Les sondes
interrompues sont signalées comme telles et ne valent pas un passage complet.
