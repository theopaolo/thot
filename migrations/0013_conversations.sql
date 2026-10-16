-- Une conversation regroupe les échanges d'un élève. Son périmètre vaut pour les questions
-- suivantes, et chaque échange garde le périmètre qu'il a utilisé.
CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    compte_id TEXT NOT NULL REFERENCES comptes (id),
    titre TEXT NOT NULL,
    chapitre TEXT NOT NULL DEFAULT '',
    matiere_id TEXT NOT NULL DEFAULT '',
    cours_id TEXT NOT NULL DEFAULT '',
    theme_id TEXT NOT NULL DEFAULT '',
    archivee_le TEXT,
    active_le TEXT NOT NULL,
    cree_le TEXT NOT NULL
);
CREATE INDEX conversations_compte ON conversations (compte_id, active_le);
ALTER TABLE messages ADD COLUMN conversation_id TEXT REFERENCES conversations (id);
ALTER TABLE messages ADD COLUMN rang INTEGER;
-- Un envoi rejoué avec la même clé retrouve son premier échange au lieu d'en créer un autre.
ALTER TABLE messages ADD COLUMN cle TEXT;

-- Les échanges existants vont dans une conversation « Anciennes questions » par compte et par
-- périmètre. Rien ne marque où un sujet commençait : ils ne sont pas découpés davantage.
INSERT INTO conversations (id, compte_id, titre, chapitre, matiere_id, cours_id, theme_id, active_le, cree_le)
    SELECT lower(hex(randomblob(16))), compte_id, 'Anciennes questions', chapitre, matiere_id,
        cours_id, theme_id, max(cree_le), min(cree_le)
    FROM messages GROUP BY compte_id, chapitre, matiere_id, cours_id, theme_id;
UPDATE messages SET conversation_id = (
    SELECT id FROM conversations c WHERE c.compte_id = messages.compte_id
        AND c.chapitre = messages.chapitre AND c.matiere_id = messages.matiere_id
        AND c.cours_id = messages.cours_id AND c.theme_id = messages.theme_id
);
UPDATE messages SET rang = (
    SELECT count(*) FROM messages m WHERE m.conversation_id = messages.conversation_id
        AND (m.cree_le, m.rowid) <= (messages.cree_le, messages.rowid)
);
CREATE UNIQUE INDEX messages_rang ON messages (conversation_id, rang);
CREATE UNIQUE INDEX messages_cle ON messages (compte_id, cle);
