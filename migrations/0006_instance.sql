CREATE TABLE instance (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id TEXT NOT NULL UNIQUE,
    school_id TEXT NOT NULL,
    nom TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('shared', 'personal'))
);

ALTER TABLE comptes ADD COLUMN administrateur INTEGER NOT NULL DEFAULT 0 CHECK (administrateur IN (0, 1));
ALTER TABLE comptes ADD COLUMN renouveler_mdp INTEGER NOT NULL DEFAULT 0 CHECK (renouveler_mdp IN (0, 1));
