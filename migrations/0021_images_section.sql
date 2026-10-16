-- La section du texte où une image apparaît : une diapositive, un titre d'un document Word.
-- Sa légende accompagne le premier passage de cette section. NULL pour les autres formats.
ALTER TABLE images ADD COLUMN section TEXT;
