-- Un objectif d'apprentissage appartient à un cours. Sa référence (référentiel, compétence et
-- version) reste un texte libre : rien n'en déduit qu'un document couvre l'objectif.
CREATE TABLE objectifs (
    id TEXT PRIMARY KEY,
    cours_id TEXT NOT NULL REFERENCES cours (id),
    intitule TEXT NOT NULL,
    reference TEXT NOT NULL DEFAULT '',
    cree_le TEXT NOT NULL
);
-- Un exercice sourcé. `contenu` porte la consigne, la réponse attendue, les critères et le retour,
-- chacun avec ses citations : source, révision et offsets. `revision` compte les versions de
-- l'exercice : une modification en crée une, et la relecture d'une version ne vaut pas pour la
-- suivante. `rejets` garde les motifs des champs rejetés à la génération.
CREATE TABLE activites (
    id TEXT PRIMARY KEY,
    cours_id TEXT NOT NULL REFERENCES cours (id),
    objectif_id TEXT NOT NULL REFERENCES objectifs (id),
    auteur_id TEXT NOT NULL REFERENCES comptes (id),
    audience TEXT NOT NULL CHECK (audience IN ('cours', 'prive')),
    etat TEXT NOT NULL DEFAULT 'brouillon'
        CHECK (etat IN ('brouillon', 'relue', 'publiee', 'a_revoir')),
    revision INTEGER NOT NULL DEFAULT 1,
    contenu TEXT NOT NULL,
    rejets TEXT NOT NULL DEFAULT '[]',
    modele TEXT NOT NULL DEFAULT '',
    cree_le TEXT NOT NULL,
    maj_le TEXT NOT NULL
);
-- Qui a relu, publié ou modifié quelle version, et quand. Un compte vide : Thot a signalé
-- l'exercice à revoir.
CREATE TABLE relectures (
    activite_id TEXT NOT NULL REFERENCES activites (id),
    revision INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('relue', 'publiee', 'modifiee', 'a_revoir')),
    compte_id TEXT REFERENCES comptes (id),
    le TEXT NOT NULL
);
-- Une réponse d'élève garde la version de l'exercice à laquelle elle répond. `criteres` : les
-- indices des critères que l'élève dit avoir remplis.
CREATE TABLE tentatives (
    id TEXT PRIMARY KEY,
    activite_id TEXT NOT NULL REFERENCES activites (id),
    compte_id TEXT NOT NULL REFERENCES comptes (id),
    revision INTEGER NOT NULL,
    reponse TEXT NOT NULL,
    criteres TEXT NOT NULL DEFAULT '[]',
    cree_le TEXT NOT NULL
);
CREATE INDEX tentatives_eleve ON tentatives (activite_id, compte_id, revision);
