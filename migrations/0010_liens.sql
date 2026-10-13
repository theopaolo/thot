-- Un lien d'inscription fait rejoindre ses cours à l'élève qui l'ouvre, tant qu'il lui reste des
-- places et qu'il n'a ni expiré ni été révoqué. `places` compte les places restantes.
CREATE TABLE liens (
    jeton TEXT PRIMARY KEY,
    createur_id TEXT NOT NULL REFERENCES comptes (id) ON DELETE CASCADE,
    places INTEGER NOT NULL CHECK (places >= 0),
    expire_le TEXT NOT NULL,
    revoque_le TEXT,
    cree_le TEXT NOT NULL
);
CREATE TABLE liens_cours (
    jeton TEXT NOT NULL REFERENCES liens (jeton) ON DELETE CASCADE,
    cours_id TEXT NOT NULL REFERENCES cours (id) ON DELETE CASCADE,
    PRIMARY KEY (jeton, cours_id)
);
