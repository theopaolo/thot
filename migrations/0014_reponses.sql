-- Une question envoyée devient un travail durable : la boucle de réponses du serveur le revendique
-- avec un verrou expirable. `generation_id` identifie la tentative qui seule peut publier, et
-- `tentatives` compte celles de la demande en cours.
ALTER TABLE messages ADD COLUMN tentatives INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN verrou_expire_le TEXT;
-- La dernière étape annoncée, relue par le flux SSE et à chaque reconnexion.
ALTER TABLE messages ADD COLUMN etape TEXT;
-- Une réponse terminée que l'élève n'a pas encore vue : « Nouvelle réponse » dans la liste.
ALTER TABLE messages ADD COLUMN nouvelle INTEGER NOT NULL DEFAULT 0;
CREATE INDEX messages_file ON messages (etat, verrou_expire_le);
-- Une génération lancée par un ancien flux n'a plus de propriétaire : elle repart de la file.
UPDATE messages SET etat = 'en_attente', generation_id = NULL WHERE etat = 'en_cours';
