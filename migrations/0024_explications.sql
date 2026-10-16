-- Une activité est un exercice à réponse courte ou une explication d'étude. Le `contenu` d'une
-- explication garde les affirmations vérifiées et leurs blocs, comme une réponse.
ALTER TABLE activites ADD COLUMN type TEXT NOT NULL DEFAULT 'exercice'
    CHECK (type IN ('exercice', 'explication'));
