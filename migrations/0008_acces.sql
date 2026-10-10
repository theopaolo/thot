-- Le nom affiché ne désigne un compte que s'il est le seul enseignant à le porter.
-- Sans propriétaire, seuls les administrateurs gèrent la source.
ALTER TABLE sources ADD COLUMN proprietaire_id TEXT REFERENCES comptes (id);
ALTER TABLE sources ADD COLUMN audience TEXT NOT NULL DEFAULT 'prive'
    CHECK (audience IN ('prive', 'collegues', 'eleves'));
ALTER TABLE sources ADD COLUMN reponses INTEGER NOT NULL DEFAULT 0 CHECK (reponses IN (0, 1));
-- Tout enseignant lisait chaque source : aucune ne devient privée.
UPDATE sources SET
    audience = CASE WHEN EXISTS (
        SELECT 1 FROM json_each(metadonnees, '$.publics') WHERE value = 'eleves'
    ) THEN 'eleves' ELSE 'collegues' END,
    reponses = EXISTS (SELECT 1 FROM json_each(metadonnees, '$.publics') WHERE value = 'thot'),
    proprietaire_id = (
        SELECT min(id) FROM comptes WHERE role = 'enseignant' AND nom = sources.enseignant
        HAVING count(*) = 1
    );
UPDATE sources SET metadonnees = json_remove(metadonnees, '$.publics');
