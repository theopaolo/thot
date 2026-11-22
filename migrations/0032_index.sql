-- Index sur les clés étrangères et dates lues sur les pages fréquentes et la purge.
CREATE INDEX ingestion_jobs_source ON ingestion_jobs (source_id);
CREATE INDEX source_cours_cours ON source_cours (cours_id);
CREATE INDEX source_cours_theme ON source_cours (theme_id) WHERE theme_id IS NOT NULL;
CREATE INDEX relectures_activite ON relectures (activite_id);
CREATE INDEX tentatives_compte ON tentatives (compte_id, activite_id);
CREATE INDEX tentatives_cree ON tentatives (cree_le);
CREATE INDEX messages_cree ON messages (cree_le);
CREATE INDEX lectures_lu ON lectures (lu_le);
CREATE INDEX sources_ecole_statut ON sources (school_id, statut);
CREATE INDEX activites_etat ON activites (etat) WHERE archivee_le IS NULL;
