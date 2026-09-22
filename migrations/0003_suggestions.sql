-- Questions proposées aux élèves. Une question n'est gardée que si Thot y répond avec des
-- citations vérifiées dans la source dont elle est tirée.
CREATE TABLE suggestions (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources (id),
    question TEXT NOT NULL,
    modele TEXT NOT NULL,
    cree_le TEXT NOT NULL
);

CREATE INDEX suggestions_source ON suggestions (source_id);

-- Date du dernier passage du générateur de suggestions, vide tant qu'il n'est pas passé.
ALTER TABLE sources ADD COLUMN suggestions_le TEXT;
