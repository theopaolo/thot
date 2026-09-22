# -*- coding: utf-8 -*-
"""Requetes ecrites contre le corpus pilote reel (ATC), avec verite terrain.

Cinq familles :
  A  lexicale       le nom de l'artiste ou de l'oeuvre est dans le titre du document
  B  reformulation  formulation d'eleve, sans le vocabulaire du corpus
  C  structure      la requete porte sur une rubrique ou une seance
  D  conceptuelle   la reponse est dans la prose des fiches ou des syntheses
  E  visuelle       la reponse n'est QUE dans l'image : ni le titre ni aucun texte
                    du corpus ne la contient

La famille E est le coeur de l'experience : elle mesure ce qu'un corpus
d'images rend accessible, ou non, selon qu'on decrit ses images ou pas.

`gold` designe soit un rang d'image (entier, cf. img_order.json), soit un
fragment d'identifiant de document (chaine).
"""

QUERIES = [
    # ---------------------------------------------------------------- A
    dict(qid="A01", type="A", q="Malevitch carré blanc sur fond blanc", gold=[118]),
    dict(qid="A02", type="A", q="Les Demoiselles d'Avignon Picasso 1907", gold=[112]),
    dict(qid="A03", type="A", q="Hector Guimard entrée de métro Paris", gold=[36, 37, 38, 39]),
    dict(qid="A04", type="A", q="Victor Horta Hôtel Tassel", gold=[72, 73]),
    dict(qid="A05", type="A", q="Rietveld chaise rouge bleu", gold=[123]),
    dict(qid="A06", type="A", q="William Morris Strawberry Thief tapisserie", gold=[79, 106]),
    dict(qid="A07", type="A", q="Tatline monument à la Troisième Internationale", gold=[132]),
    dict(qid="A08", type="A", q="Mackintosh Hill House", gold=[11, 19]),
    dict(qid="A09", type="A", q="Boccioni états d'âme les adieux", gold=[168]),
    dict(qid="A10", type="A", q="Sagrada Familia Gaudi vitraux", gold=[67]),

    # ---------------------------------------------------------------- B
    dict(qid="B01", type="B", q="le tableau qui est juste un carré noir", gold=[115]),
    dict(qid="B02", type="B", q="la maison en briques rouges construite pour Morris",
         gold=[91, 92, 93, 96]),
    dict(qid="B03", type="B", q="l'église de Barcelone jamais finie", gold=[66, 67, 68]),
    dict(qid="B04", type="B", q="le tableau avec des femmes qui dansent en rond",
         gold=[151, 154]),
    dict(qid="B05", type="B", q="la tour en spirale qui n'a jamais été construite",
         gold=[132]),
    dict(qid="B06", type="B", q="le peintre qui met du vert sur le visage de sa femme",
         gold=[159]),
    dict(qid="B07", type="B", q="l'affiche de film d'horreur allemand des années 20",
         gold=[111]),
    dict(qid="B08", type="B", q="les dessins de bestioles marines qui ont inspiré les architectes",
         gold=[30, 43, 44, 45]),

    # ---------------------------------------------------------------- C
    dict(qid="C01", type="C", q="ce qu'on a vu sur l'Art nouveau en Belgique",
         gold=[71, 72, 73, 74, 75]),
    dict(qid="C02", type="C", q="les œuvres constructivistes de Varvara Stepanova",
         gold=[140, 141, 142, 143, 144]),
    dict(qid="C03", type="C", q="l'aménagement intérieur de la Red House",
         gold=[89, 90, 94, 95, 100, 101, 102, 103, 107]),
    dict(qid="C04", type="C", q="les documents de la séance 2 futurisme suprématisme néoplasticisme",
         gold=["Synthese seance 2", "ATC Fiche Futurisme", "ATC Fiche Suprematisme",
               "ATC Fiche Neoplasticisme"]),
    dict(qid="C05", type="C", q="l'école de Glasgow", gold=[2, 11, 14, 15, 16, 17, 18,
                                                            19, 20, 21, 22, 23, 24, 25]),
    dict(qid="C06", type="C", q="Art nouveau viennois Sécession", gold=[47, 48, 27, 28,
                                                                       34, 35, 56, 57, 60]),

    # ---------------------------------------------------------------- D
    dict(qid="D01", type="D", q="pourquoi le cubisme casse la perspective de la Renaissance",
         gold=["Cubisme.pdf#02", "Cubisme.pdf#01"]),
    dict(qid="D02", type="D", q="quel rôle ont joué les masques africains chez Picasso",
         gold=["Cubisme.pdf#03"]),
    dict(qid="D03", type="D", q="qu'est-ce que les fauves ont changé dans l'usage de la couleur",
         gold=["Fauvisme.pdf#02", "Fauvisme.pdf#03", "Fauvisme.pdf#05", "Synthese seance 1"]),
    dict(qid="D04", type="D", q="en quoi la théorie de la relativité a compté pour les peintres",
         gold=["Cubisme.pdf#00", "Cubisme.pdf#03"]),
    dict(qid="D05", type="D", q="ce que l'Art nouveau doit à Ruskin et Morris",
         gold=["Arts and Crafts.pdf#02", "Art Nouveau.pdf#02", "Art Nouveau.pdf#03"]),
    dict(qid="D06", type="D", q="comment le suprématisme passe de la peinture à l'architecture",
         gold=["Suprematisme.pdf#09", "Suprematisme.pdf#04"]),
    dict(qid="D07", type="D", q="ce que les avant-gardes ont laissé au design industriel",
         gold=["Neoplasticisme.pdf#07", "Suprematisme.pdf#09", "Synthese sequence"]),

    # ---------------------------------------------------------------- E
    dict(qid="E01", type="E",
         q="l'immeuble dont toute la façade est couverte de fleurs en céramique rose",
         gold=[60, 61]),
    dict(qid="E02", type="E",
         q="le bâtiment dont les balcons ressemblent à des masques ou à des os",
         gold=[4, 5]),
    dict(qid="E03", type="E",
         q="la chaise dont le dossier est une échelle de barreaux plus haute qu'un homme",
         gold=[15]),
    dict(qid="E04", type="E",
         q="le banc tout en morceaux de carrelage cassé de toutes les couleurs",
         gold=[62, 63]),
    dict(qid="E05", type="E",
         q="la photo d'un homme assis sur une feuille de nénuphar géante",
         gold=[76]),
    dict(qid="E06", type="E",
         q="l'affiche où une femme crie avec la main en porte-voix",
         gold=[134]),
    dict(qid="E07", type="E",
         q="le tableau où un petit chien a plein de pattes en même temps",
         gold=[167]),
    dict(qid="E08", type="E",
         q="la maquette blanche en plâtre qui ressemble à une ville de gratte-ciels",
         gold=[119, 120, 121]),
    dict(qid="E09", type="E",
         q="les colonnes qui se ramifient comme des arbres au-dessus de la nef",
         gold=[68]),
    dict(qid="E10", type="E",
         q="le vêtement rayé noir et blanc avec une grande étoile rouge sur la poitrine",
         gold=[142, 143]),
    dict(qid="E11", type="E",
         q="l'escalier avec des arabesques en fer qui continuent en peinture sur le mur",
         gold=[73]),
    dict(qid="E12", type="E",
         q="le cube blanc surmonté d'une boule dorée en feuilles",
         gold=[47]),
    dict(qid="E13", type="E",
         q="les bâtiments avec des salles en forme de coins qui dépassent de la façade",
         gold=[146, 148]),
    dict(qid="E14", type="E",
         q="le tableau tout en aplats où la couleur du visage est coupée en deux",
         gold=[159]),
]


def resolve(gold, docs, order):
    """Rend l'ensemble des identifiants de documents vises."""
    out = set()
    for g in gold:
        if isinstance(g, int):
            out.add(order[g])
        else:
            out.update(d["id"] for d in docs if g.lower() in d["id"].lower())
    return out


# ---------------------------------------------------------------------------
# Famille E-bis : mêmes cibles, registre d'élève, vocabulaire délibérément
# éloigné de celui des légendes. Les légendes ont été écrites AVANT les
# requêtes, mais par la même main : la famille E d'origine surestime donc le
# gain. E-bis corrige ce biais en évitant les mots des légendes.
# ---------------------------------------------------------------------------
QUERIES_EBIS = [
    dict(qid="F01", type="F", q="l'immeuble avec des fleurs dessinées partout sur le mur",
         gold=[60, 61]),
    dict(qid="F02", type="F", q="la maison dont les balcons font peur on dirait des têtes de mort",
         gold=[4, 5]),
    dict(qid="F03", type="F", q="le siège où le dos monte tellement haut qu'on ne peut pas s'appuyer",
         gold=[15]),
    dict(qid="F04", type="F", q="le truc pour s'asseoir dans un parc fait avec des bouts de vaisselle",
         gold=[62, 63]),
    dict(qid="F05", type="F", q="le monsieur qui tient debout sur une plante qui flotte sur l'eau",
         gold=[76]),
    dict(qid="F06", type="F", q="la dame qui hurle sur l'affiche russe",
         gold=[134]),
    dict(qid="F07", type="F", q="le chien qui bouge tellement vite qu'on voit plusieurs jambes",
         gold=[167]),
    dict(qid="F08", type="F", q="les petits blocs blancs empilés comme des immeubles miniatures",
         gold=[119, 120, 121]),
    dict(qid="F09", type="F", q="les piliers de l'église qui s'ouvrent en branches vers le haut",
         gold=[68]),
    dict(qid="F10", type="F", q="l'habit avec des lignes noires et blanches et une étoile dessus",
         gold=[142, 143]),
    dict(qid="F11", type="F", q="les grandes courbes en métal qui montent le long de l'escalier",
         gold=[73]),
    dict(qid="F12", type="F", q="le bâtiment tout blanc avec une grosse sphère jaune sur le toit",
         gold=[47]),
    dict(qid="F13", type="F", q="les salles qui sortent du mur comme des tiroirs pointus",
         gold=[146, 148]),
    dict(qid="F14", type="F", q="le portrait où la figure est verte d'un côté",
         gold=[159]),
]
