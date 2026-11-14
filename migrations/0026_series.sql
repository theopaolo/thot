-- Un exercice devient une série de questions (ADR 0010). Chaque exercice existant devient une
-- série d'une réponse rédigée, corrigée après la remise.
UPDATE activites SET contenu = json_object(
    'correction', 'serie',
    'questions', json_array(json_set(contenu, '$.id', 'q1', '$.type', 'redigee')))
  WHERE type = 'exercice';
-- Le titre de l'activité, d'abord l'intitulé de son objectif. Une activité archivée n'est plus
-- servie aux élèves. `a_rendre_le` : une date affichée à l'élève, qui ne bloque rien.
ALTER TABLE activites ADD COLUMN titre TEXT NOT NULL DEFAULT '';
UPDATE activites SET titre = (SELECT intitule FROM objectifs o WHERE o.id = activites.objectif_id);
ALTER TABLE activites ADD COLUMN archivee_le TEXT;
ALTER TABLE activites ADD COLUMN a_rendre_le TEXT;
-- Une activité appartient à un ou plusieurs cours. `activites.cours_id` reste le cours où elle est
-- née, celui de son objectif.
CREATE TABLE activite_cours (
    activite_id TEXT NOT NULL REFERENCES activites (id) ON DELETE CASCADE,
    cours_id TEXT NOT NULL REFERENCES cours (id) ON DELETE CASCADE,
    PRIMARY KEY (activite_id, cours_id)
);
CREATE INDEX activite_cours_cours ON activite_cours (cours_id);
INSERT INTO activite_cours SELECT id, cours_id FROM activites;
-- Une tentative garde, par question, les essais de l'élève, et les critères qu'il coche sur une
-- réponse rédigée. `rendue_le` : la série remise, ou toutes ses questions finies. `retours` : la
-- note et le commentaire de l'enseignant, par question. `a_reprendre` : l'enseignant laisse
-- l'élève recommencer.
ALTER TABLE tentatives ADD COLUMN reponses TEXT NOT NULL DEFAULT '{}';
ALTER TABLE tentatives ADD COLUMN rendue_le TEXT;
ALTER TABLE tentatives ADD COLUMN retours TEXT NOT NULL DEFAULT '{}';
ALTER TABLE tentatives ADD COLUMN a_reprendre INTEGER NOT NULL DEFAULT 0;
UPDATE tentatives SET rendue_le = cree_le, reponses = json_object('q1', json_object(
    'essais', json_array(reponse), 'finie', json('true'), 'criteres', json(criteres)));
ALTER TABLE tentatives DROP COLUMN reponse;
ALTER TABLE tentatives DROP COLUMN criteres;
