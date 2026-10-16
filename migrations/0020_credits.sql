-- Crédit d'une image, saisi à la relecture. Affiché sous l'image, jamais indexé ni envoyé aux modèles.
ALTER TABLE images ADD COLUMN credit TEXT;
