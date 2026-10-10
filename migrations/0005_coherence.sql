ALTER TABLE messages ADD COLUMN generation_id TEXT;

-- Les anciennes clés ne distinguent pas les légendes des jugements issus des échanges élèves.
DELETE FROM cache_modeles;
