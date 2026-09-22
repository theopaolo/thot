# -*- coding: utf-8 -*-
"""Questions d'eleve pour la mesure de generation, et questions sans reponse.

Les 59 requetes de `queries_real.py` sont des requetes de RECHERCHE : des
mots-cles, pas des questions. Pour mesurer la generation il faut des questions
posees comme un eleve les pose, avec une reponse verifiable dans le corpus.

`SANS_REPONSE` est le volet abstention : des questions dont la reponse n'est
PAS dans le corpus pilote, et que le systeme doit refuser. Trois registres :
  - hors sujet complet
  - dans la discipline mais absent du corpus (le piege : le modele sait
    repondre de memoire, et il ne doit pas)
  - dans le corpus mais au-dela de ce qu'il dit (le piege le plus dur)
"""

# gold = fragment d'identifiant de document qui contient la reponse
QUESTIONS = [
    dict(qid="G01", q="Pourquoi les cubistes ont-ils arrete de peindre en perspective ?",
         gold=["Cubisme.pdf"]),
    dict(qid="G02", q="C'est quoi le rapport entre Picasso et les masques africains ?",
         gold=["Cubisme.pdf"]),
    dict(qid="G03", q="Qu'est-ce que les fauves ont change dans la facon d'utiliser la couleur ?",
         gold=["Fauvisme.pdf", "Synthese seance 1"]),
    dict(qid="G04", q="En quoi la theorie de la relativite a compte pour les peintres du debut du XXe ?",
         gold=["Cubisme.pdf"]),
    dict(qid="G05", q="Qu'est-ce que l'Art nouveau doit a Ruskin et a Morris ?",
         gold=["Arts and Crafts.pdf", "Art Nouveau.pdf"]),
    dict(qid="G06", q="Comment le suprematisme est-il passe de la peinture a l'architecture ?",
         gold=["Suprematisme.pdf"]),
    dict(qid="G07", q="Qu'est-ce que les avant-gardes ont laisse au design industriel ?",
         gold=["Neoplasticisme.pdf", "Suprematisme.pdf", "Synthese sequence"]),
    dict(qid="G08", q="Pourquoi les futuristes aimaient-ils autant les machines et la vitesse ?",
         gold=["Futurisme.pdf"]),
    dict(qid="G09", q="C'est quoi le neoplasticisme, en gros ?",
         gold=["Neoplasticisme.pdf"]),
    dict(qid="G10", q="Qu'est-ce qui distingue l'expressionnisme allemand du fauvisme francais ?",
         gold=["Exressionnisme.pdf", "Fauvisme.pdf"]),
    dict(qid="G11", q="Pourquoi l'Art nouveau s'inspire-t-il autant de la nature ?",
         gold=["Art Nouveau.pdf"]),
    dict(qid="G12", q="Qu'est-ce que le mouvement Arts and Crafts reprochait a l'industrie ?",
         gold=["Arts and Crafts.pdf"]),
    dict(qid="G13", q="A quoi servaient les vetements concus par les constructivistes russes ?",
         gold=["Suprematisme.pdf", "Neoplasticisme.pdf", "Stepanova", "Constructivisme"]),
    dict(qid="G14", q="Pourquoi Malevitch peint-il un carre noir sur fond blanc ?",
         gold=["Suprematisme.pdf", "Suprematisme Carre noir"]),
    dict(qid="G15", q="Quel est le lien entre la revolution industrielle et l'Art nouveau ?",
         gold=["Art Nouveau.pdf", "Arts and Crafts.pdf"]),
    dict(qid="G16", q="Comment Gaudi construit-il ses colonnes de la Sagrada Familia ?",
         gold=["Sagrada Familia", "Art Nouveau.pdf"]),
    dict(qid="G17", q="Qu'est-ce que la Secession viennoise ?",
         gold=["Art Nouveau.pdf", "Secession", "Olbrich"]),
    dict(qid="G18", q="Pourquoi la chaise de Rietveld est-elle rouge et bleue ?",
         gold=["Neoplasticisme.pdf", "Chaise rouge bleu"]),
    dict(qid="G19", q="Qu'est-ce que l'ecole de Glasgow a apporte a l'Art nouveau ?",
         gold=["Mackintosh", "Art Nouveau.pdf", "Glasgow"]),
    dict(qid="G20", q="Comment les avant-gardes representent-elles le mouvement dans un tableau fixe ?",
         gold=["Futurisme.pdf", "Cubisme.pdf"]),
]

SANS_REPONSE = [
    # --- hors sujet complet
    dict(qid="N01", registre="hors sujet",
         q="Quelle est la formule chimique de la photosynthese ?"),
    dict(qid="N02", registre="hors sujet",
         q="Comment calculer la derivee d'une fonction affine ?"),
    dict(qid="N03", registre="hors sujet",
         q="Qui a gagne la coupe du monde de football en 1998 ?"),
    dict(qid="N04", registre="hors sujet",
         q="Explique-moi la difference entre mitose et meiose."),
    # --- dans la discipline, absent du corpus pilote
    dict(qid="N05", registre="discipline, hors corpus",
         q="Quel role Le Corbusier a-t-il joue dans le Bauhaus ?"),
    dict(qid="N06", registre="discipline, hors corpus",
         q="Qu'est-ce que le style Memphis des annees 1980 ?"),
    dict(qid="N07", registre="discipline, hors corpus",
         q="Pourquoi Duchamp expose-t-il un urinoir en 1917 ?"),
    dict(qid="N08", registre="discipline, hors corpus",
         q="En quoi consiste le mouvement Dada a Zurich ?"),
    dict(qid="N09", registre="discipline, hors corpus",
         q="Qui etait Charlotte Perriand et qu'a-t-elle concu ?"),
    dict(qid="N10", registre="discipline, hors corpus",
         q="Quelle est l'influence du Bauhaus sur le design suedois ?"),
    # --- au-dela de ce que dit le corpus (le piege le plus dur)
    dict(qid="N11", registre="au-dela du corpus",
         q="Combien a coute la construction de la Casa Batllo de Gaudi ?"),
    dict(qid="N12", registre="au-dela du corpus",
         q="Quel pigment exact Matisse utilise-t-il pour le vert du portrait de sa femme ?"),
    dict(qid="N13", registre="au-dela du corpus",
         q="Combien de visiteurs recoit la Sagrada Familia chaque annee ?"),
    dict(qid="N14", registre="au-dela du corpus",
         q="Quelles sont les dimensions exactes en centimetres du Carre noir de Malevitch ?"),
    dict(qid="N15", registre="au-dela du corpus",
         q="Ou se trouve aujourd'hui la chaise Hill House de Mackintosh ?"),
]
