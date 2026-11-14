-- Une ressource que l'élève a lue jusqu'au bout. Seul ce compte voit ses lectures, et le worker
-- les supprime après `THOT_RETENTION_JOURS` jours, comme ses échanges.
CREATE TABLE lectures (
    compte_id TEXT NOT NULL REFERENCES comptes (id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    lu_le TEXT NOT NULL,
    PRIMARY KEY (compte_id, source_id)
);
