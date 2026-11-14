-- Les termes de matière et de cours, comme ceux de niveau et de regroupement : vide, le terme du
-- profil.
ALTER TABLE instance ADD COLUMN matiere TEXT NOT NULL DEFAULT '';
ALTER TABLE instance ADD COLUMN matieres TEXT NOT NULL DEFAULT '';
ALTER TABLE instance ADD COLUMN cours TEXT NOT NULL DEFAULT '';
ALTER TABLE instance ADD COLUMN cours_pluriel TEXT NOT NULL DEFAULT '';
