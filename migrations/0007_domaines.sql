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
-- Le dépôt rangeait la matière sous l'identifiant de sa liste. Les élèves voient le libellé.
CREATE TEMP TABLE noms_matieres (cle TEXT PRIMARY KEY, nom TEXT NOT NULL);
INSERT INTO noms_matieres
    SELECT DISTINCT json_extract(metadonnees, '$.matiere'), json_extract(metadonnees, '$.matiere')
    FROM sources WHERE coalesce(json_extract(metadonnees, '$.matiere'), '') != '';
UPDATE noms_matieres SET nom = CASE cle
    WHEN 'arts-appliques' THEN 'Arts appliqués'
    WHEN 'histoire-geographie' THEN 'Histoire-géographie'
    WHEN 'francais' THEN 'Français'
    WHEN 'physique-chimie' THEN 'Physique-chimie'
    WHEN 'mathematiques' THEN 'Mathématiques'
    WHEN 'eps' THEN 'Éducation physique et sportive'
    ELSE nom END;
INSERT INTO matieres
    SELECT lower(hex(randomblob(16))), nom,
        CASE WHEN max(cle = 'arts-appliques') THEN 'arts-appliques' ELSE 'general' END
    FROM noms_matieres GROUP BY nom;
UPDATE sources SET matiere_id = (
    SELECT m.id FROM noms_matieres n JOIN matieres m ON m.nom = n.nom
    WHERE n.cle = json_extract(sources.metadonnees, '$.matiere')
);
UPDATE sources SET profil = coalesce(
    (SELECT profil FROM matieres WHERE id = sources.matiere_id), 'general'
);
DROP TABLE noms_matieres;
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
