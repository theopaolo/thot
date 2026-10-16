-- Un lot regroupe les fichiers d'un même dépôt web, déposés chacun par sa propre requête.
-- `cle_depot` rend un renvoi inoffensif : le même couple (propriétaire, clé) ne crée qu'une source.
ALTER TABLE sources ADD COLUMN lot_id TEXT;
ALTER TABLE sources ADD COLUMN cle_depot TEXT;
CREATE INDEX sources_lot ON sources (lot_id) WHERE lot_id IS NOT NULL;
CREATE UNIQUE INDEX sources_cle_depot ON sources (proprietaire_id, cle_depot)
    WHERE cle_depot IS NOT NULL;
