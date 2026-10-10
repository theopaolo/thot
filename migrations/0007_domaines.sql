CREATE TABLE matieres (
    id TEXT PRIMARY KEY,
    nom TEXT NOT NULL,
    profil TEXT NOT NULL CHECK (profil IN ('general', 'arts-appliques')),
    UNIQUE (nom)
);
CREATE TABLE cours (
    id TEXT PRIMARY KEY,
    matiere_id TEXT NOT NULL REFERENCES matieres(id),
    nom TEXT NOT NULL,
    public TEXT NOT NULL DEFAULT '',
    objectif TEXT NOT NULL DEFAULT ''
);
CREATE TABLE themes (
    id TEXT PRIMARY KEY,
    cours_id TEXT NOT NULL REFERENCES cours(id),
    nom TEXT NOT NULL,
    UNIQUE (cours_id, nom),
    UNIQUE (id, cours_id)
);
ALTER TABLE sources ADD COLUMN matiere_id TEXT REFERENCES matieres(id);
ALTER TABLE sources ADD COLUMN profil TEXT NOT NULL DEFAULT 'general'
    CHECK (profil IN ('general', 'arts-appliques'));
ALTER TABLE sources ADD COLUMN langue TEXT NOT NULL DEFAULT 'fr';
CREATE TABLE source_cours (
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    cours_id TEXT NOT NULL REFERENCES cours(id),
    theme_id TEXT,
    PRIMARY KEY (source_id, cours_id),
    FOREIGN KEY (theme_id, cours_id) REFERENCES themes(id, cours_id)
);
INSERT INTO matieres
    SELECT lower(hex(randomblob(16))), json_extract(metadonnees, '$.matiere'),
        CASE WHEN json_extract(metadonnees, '$.matiere') = 'arts-appliques'
            THEN 'arts-appliques' ELSE 'general' END
    FROM sources WHERE coalesce(json_extract(metadonnees, '$.matiere'), '') != ''
    GROUP BY json_extract(metadonnees, '$.matiere');
UPDATE sources SET matiere_id = (
    SELECT id FROM matieres WHERE nom = json_extract(sources.metadonnees, '$.matiere')
), profil = CASE WHEN json_extract(metadonnees, '$.matiere') = 'arts-appliques'
    THEN 'arts-appliques' ELSE 'general' END;
INSERT INTO cours (id, matiere_id, nom)
    SELECT lower(hex(randomblob(16))), id, nom FROM matieres;
INSERT INTO themes
    SELECT lower(hex(randomblob(16))), c.id, json_extract(s.metadonnees, '$.sequence')
    FROM sources s JOIN cours c ON c.matiere_id = s.matiere_id
    WHERE coalesce(json_extract(s.metadonnees, '$.sequence'), '') != ''
    GROUP BY c.id, json_extract(s.metadonnees, '$.sequence');
INSERT INTO source_cours
    SELECT s.id, c.id, t.id FROM sources s JOIN cours c ON c.matiere_id = s.matiere_id
    LEFT JOIN themes t ON t.cours_id = c.id AND t.nom = json_extract(s.metadonnees, '$.sequence');
ALTER TABLE messages ADD COLUMN matiere_id TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN cours_id TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN theme_id TEXT NOT NULL DEFAULT '';
