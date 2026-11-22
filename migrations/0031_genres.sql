-- Le genre des termes de matière et de cours, pour les accorder dans une phrase : « un cours »,
-- « une unité ». Il ne compte que pour un terme réglé. Un terme vide garde le genre du profil.
ALTER TABLE instance ADD COLUMN matiere_genre TEXT NOT NULL DEFAULT 'f'
    CHECK (matiere_genre IN ('m', 'f'));
ALTER TABLE instance ADD COLUMN cours_genre TEXT NOT NULL DEFAULT 'm'
    CHECK (cours_genre IN ('m', 'f'));
