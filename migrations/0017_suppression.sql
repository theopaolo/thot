-- Un chunk supprimé sort aussi des segments de l'index. Sans cette option, FTS5 y garde ses
-- racines. La reconstruction efface celles des suppressions déjà faites.
INSERT INTO chunks_fts (chunks_fts, rank) VALUES ('secure-delete', 1);
INSERT INTO chunks_fts (chunks_fts) VALUES ('rebuild');
