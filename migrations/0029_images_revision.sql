-- La table `images` ne porte que les images servies. Chacune garde la révision qui l'a apportée,
-- et son fichier vit dans le dossier de cette révision : `assets/` à la racine de la source pour
-- la révision 1, `revisions/{n}/assets/` ensuite. Les images d'une révision en attente restent
-- dans son dossier, hors de la table, jusqu'à sa certification.
-- Les images déjà enregistrées ont toutes leur fichier à la racine, d'où la valeur 1.
ALTER TABLE images ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
