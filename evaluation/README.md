# Jeux d'évaluation

`queries_real.py` contient 59 requêtes annotées de récupération, réparties en
six familles. `queries_generation.py` contient 20 questions répondables et 15
questions sans réponse dans le corpus.

Ces fichiers viennent du banc d'essai du 28/08/2026. Ils sont conservés tels
quels pour ne pas altérer la vérité terrain. Le futur chargeur du produit devra
les convertir vers son propre schéma sans modifier les identifiants, les textes
ou les cibles.

Le corpus ATC et `img_order.json` restent dans le dépôt de recherche. Les tests
du produit utiliseront des fixtures autorisées et un adaptateur de résolution
explicite.
