CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    titre TEXT NOT NULL,
    metadonnees TEXT NOT NULL,
    fichier TEXT NOT NULL,
    format TEXT NOT NULL,
    checksum TEXT NOT NULL,
    octets INTEGER NOT NULL,
    enseignant TEXT NOT NULL,
    cree_le TEXT NOT NULL
);

CREATE INDEX sources_checksum ON sources (checksum);

-- Le cycle de vie vit ici, pas dans le fichier. Un travail interrompu se
-- reprend par son verrou expiré, le worker viendra le consommer (JOB-101).
CREATE TABLE ingestion_jobs (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources (id),
    etat TEXT NOT NULL,
    etape TEXT,
    progression REAL NOT NULL DEFAULT 0,
    erreur TEXT,
    tentatives INTEGER NOT NULL DEFAULT 0,
    verrou_expire_le TEXT,
    cree_le TEXT NOT NULL,
    maj_le TEXT NOT NULL
);

CREATE INDEX ingestion_jobs_etat ON ingestion_jobs (etat, verrou_expire_le);
