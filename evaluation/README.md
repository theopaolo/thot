# Évaluation

`queries_real.py` contient les requêtes annotées de recherche, réparties en familles.
`queries_generation.py` contient des questions répondables et des pièges sans réponse dans le
corpus. Les deux fichiers sortent du banc d'essai et restent tels quels pour ne pas altérer la
vérité terrain. `python3 evaluation/exporter.py` les convertit en JSON pour `thot eval`, sans toucher aux
identifiants ni aux cibles.

```bash
deno task thot eval recherche --img-order=../mesures/thot-real/img_order.json \
  --docs=../mesures/thot-real/docs.json [--sans-reclasseur]
deno task thot eval generation
deno task thot ask "Pourquoi les cubistes ont-ils abandonné la perspective ?"
```

## Soutien des citations

`verifier()` contrôle qu'une citation existe mot pour mot. `thot eval soutien` mesure si un juge
repère une citation réelle qui ne prouve pas la phrase qu'elle accompagne.

```bash
deno task thot eval generation --paires=../mesures/thot-real/paires-soutien.json
deno task thot eval soutien --paires=../mesures/thot-real/paires-soutien.json
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

Les résultats vont dans `resultats/`, datés dans le fichier. Le corpus ATC et `img_order.json`
restent dans le dépôt de recherche.
