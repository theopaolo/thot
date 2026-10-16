-- Une révision fige le texte et les blocs d'une extraction : les citations pointent dans la
-- révision qu'elles citent. La source sert sa révision `revision`. Une révision plus récente
-- attend qu'un enseignant la certifie.
CREATE TABLE revisions (
    source_id TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
    n INTEGER NOT NULL CHECK (n >= 1),
    avertissements TEXT NOT NULL DEFAULT '[]',
    cree_le TEXT NOT NULL,
    PRIMARY KEY (source_id, n)
);
-- Les fichiers du pilote, à la racine de chaque source, deviennent sa révision 1.
INSERT INTO revisions (source_id, n, cree_le) SELECT id, 1, cree_le FROM sources;
ALTER TABLE sources ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE chunks ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
