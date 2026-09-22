# -*- coding: utf-8 -*-
"""Exporte les jeux annotés en JSON pour `thot eval`, sans rien changer aux identifiants,
aux textes ni aux cibles. Relancer après toute modification des fichiers .py."""
import json
import os

import queries_generation
import queries_real

ICI = os.path.dirname(os.path.abspath(__file__))


def ecrire(nom, donnees):
    with open(os.path.join(ICI, nom), "w", encoding="utf-8") as f:
        json.dump(donnees, f, ensure_ascii=False, indent=1)
    print(f"{nom}: {len(donnees)} entrées")


ecrire("queries_real.json", queries_real.QUERIES + queries_real.QUERIES_EBIS)
ecrire("queries_generation.json", {"questions": queries_generation.QUESTIONS,
                                   "sans_reponse": queries_generation.SANS_REPONSE})
