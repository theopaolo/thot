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

Les résultats vont dans `resultats/`, datés dans le fichier. Le corpus ATC et `img_order.json`
restent dans le dépôt de recherche.
