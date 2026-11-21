-- Les essais de connexion ratés d'un identifiant (`identifiant:lea`) ou d'une adresse
-- (`adresse:203.0.113.9`) depuis `debut_le`. Au-delà du seuil, `authentifier()` refuse sans
-- vérifier le mot de passe jusqu'à la fin de la fenêtre, puis la ligne se supprime.
CREATE TABLE connexions (
    cle TEXT PRIMARY KEY,
    echecs INTEGER NOT NULL,
    debut_le TEXT NOT NULL
);
