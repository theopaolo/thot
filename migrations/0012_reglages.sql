-- Réglages de l'instance. Un terme vide reprend celui du profil : une base existante garde son
-- apparence. `version` détecte deux enregistrements concurrents du même formulaire.
ALTER TABLE instance ADD COLUMN niveau TEXT NOT NULL DEFAULT '';
ALTER TABLE instance ADD COLUMN regroupement TEXT NOT NULL DEFAULT '';
ALTER TABLE instance ADD COLUMN regroupements TEXT NOT NULL DEFAULT '';
ALTER TABLE instance ADD COLUMN lecteurs TEXT NOT NULL DEFAULT 'eleves'
    CHECK (lecteurs IN ('prive', 'collegues', 'eleves'));
ALTER TABLE instance ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
-- Les clés des champs du dépôt de la matière, en JSON. NULL : la liste du profil.
ALTER TABLE matieres ADD COLUMN champs TEXT;
ALTER TABLE matieres ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
-- Les valeurs restent dans `sources.metadonnees`, sous l'identifiant du champ.
CREATE TABLE champs_personnalises (
    id TEXT PRIMARY KEY,
    nom TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('text', 'date', 'tags'))
);
