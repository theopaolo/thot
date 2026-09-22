-- Certification: la source porte son statut, le travail d'ingestion porte le traitement.
ALTER TABLE sources ADD COLUMN statut TEXT NOT NULL DEFAULT 'a_relire';
ALTER TABLE sources ADD COLUMN statut_par TEXT;
ALTER TABLE sources ADD COLUMN statut_le TEXT;
ALTER TABLE ingestion_jobs ADD COLUMN avertissements TEXT NOT NULL DEFAULT '[]';

-- Une légende générée reste hors du texte de preuve tant qu'un enseignant ne l'a pas certifiée.
CREATE TABLE images (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources (id),
    position INTEGER NOT NULL,
    fichier TEXT NOT NULL,
    mime TEXT NOT NULL,
    checksum TEXT NOT NULL,
    legende TEXT,
    legende_origine TEXT,
    legende_statut TEXT NOT NULL DEFAULT 'unreviewed',
    modele TEXT,
    relu_par TEXT,
    relu_le TEXT,
    UNIQUE (source_id, position)
);

-- Index de recherche. Reconstructible depuis le contenu par `thot rebuild`.
CREATE TABLE chunks (
    n INTEGER PRIMARY KEY,
    id TEXT NOT NULL,
    source_id TEXT NOT NULL REFERENCES sources (id),
    school_id TEXT NOT NULL,
    titre TEXT NOT NULL,
    debut INTEGER NOT NULL,
    fin INTEGER NOT NULL,
    texte TEXT NOT NULL,
    rappel TEXT NOT NULL,
    preuve TEXT NOT NULL,
    UNIQUE (source_id, id)
);

CREATE VIRTUAL TABLE chunks_fts USING fts5 (titre, texte, tokenize = 'unicode61 remove_diacritics 2');

CREATE TABLE comptes (
    id TEXT PRIMARY KEY,
    identifiant TEXT NOT NULL UNIQUE,
    nom TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('enseignant', 'eleve')),
    sel TEXT NOT NULL,
    empreinte TEXT NOT NULL,
    cree_le TEXT NOT NULL
);

-- etat: en_attente, en_cours, answered, out_of_corpus, failed
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    compte_id TEXT NOT NULL REFERENCES comptes (id),
    question TEXT NOT NULL,
    etat TEXT NOT NULL,
    resultat TEXT,
    journal TEXT,
    cree_le TEXT NOT NULL,
    maj_le TEXT NOT NULL
);

CREATE INDEX messages_compte ON messages (compte_id, cree_le);

CREATE TABLE cache_modeles (
    cle TEXT PRIMARY KEY,
    valeur TEXT NOT NULL,
    cree_le TEXT NOT NULL
);
