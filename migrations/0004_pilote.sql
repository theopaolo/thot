ALTER TABLE comptes ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN chapitre TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN avis TEXT CHECK (avis IN ('utile', 'confus', 'faux'));
CREATE INDEX messages_chapitre ON messages (chapitre, cree_le);
-- Les anciennes réponses mises en cache peuvent contenir des questions d'élèves.
DELETE FROM cache_modeles;
