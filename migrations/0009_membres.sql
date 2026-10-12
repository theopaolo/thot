-- Les enseignants et les élèves d'un cours lisent les ressources que ce cours partage.
CREATE TABLE membres_cours (
    cours_id TEXT NOT NULL REFERENCES cours (id) ON DELETE CASCADE,
    compte_id TEXT NOT NULL REFERENCES comptes (id) ON DELETE CASCADE,
    PRIMARY KEY (cours_id, compte_id)
);
CREATE INDEX membres_cours_compte ON membres_cours (compte_id);
-- Chaque compte rejoint chaque cours existant : personne ne perd une lecture.
INSERT INTO membres_cours SELECT c.id, a.id FROM cours c, comptes a;
