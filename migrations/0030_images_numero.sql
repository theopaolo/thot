-- Le numéro de la prochaine image d'une source, dans son identifiant `{source}-{numéro}`. Il ne
-- redescend pas quand une image sort : une activité garde l'identifiant de l'image qu'elle montre,
-- et ne doit pas en recevoir une autre sous le même. Il part du plus grand numéro encore servi.
ALTER TABLE sources ADD COLUMN images_numero INTEGER NOT NULL DEFAULT 0;
UPDATE sources SET images_numero = (
    SELECT coalesce(max(CAST(substr(i.id, length(sources.id) + 2) AS INTEGER)), -1) + 1
    FROM images i WHERE i.source_id = sources.id
);
