-- Une comparaison porte sur deux matières ou plus, identifiants triés et séparés par des virgules.
-- Vide : le périmètre ordinaire de `matiere_id`, `cours_id` et `theme_id`.
ALTER TABLE conversations ADD COLUMN matieres TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN matieres TEXT NOT NULL DEFAULT '';
