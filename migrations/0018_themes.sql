-- Le thème devient le seul regroupement. Une source rattachée à un cours sans thème rejoint le
-- thème du nom de sa séquence dans ce cours : l'accueil de l'élève la rangeait déjà sous ce nom.
INSERT OR IGNORE INTO themes
    SELECT lower(hex(randomblob(16))), sc.cours_id, json_extract(s.metadonnees, '$.sequence')
    FROM source_cours sc JOIN sources s ON s.id = sc.source_id
    WHERE sc.theme_id IS NULL AND coalesce(json_extract(s.metadonnees, '$.sequence'), '') != ''
    GROUP BY sc.cours_id, json_extract(s.metadonnees, '$.sequence');
UPDATE source_cours SET theme_id = (
    SELECT t.id FROM themes t JOIN sources s ON s.id = source_cours.source_id
    WHERE t.cours_id = source_cours.cours_id AND t.nom = json_extract(s.metadonnees, '$.sequence')
) WHERE theme_id IS NULL;

-- Le chapitre d'une conversation ou d'une question devient le thème où sont rangées les sources de
-- cette séquence, dans un cours du compte d'abord. Le même choix que `themeDuChapitre()`. La
-- colonne `chapitre` reste pour l'historique, le code ne la lit plus.
UPDATE conversations SET theme_id = coalesce((
    SELECT sc.theme_id FROM source_cours sc JOIN sources s ON s.id = sc.source_id
        JOIN themes t ON t.id = sc.theme_id
    WHERE json_extract(s.metadonnees, '$.sequence') = conversations.chapitre
    GROUP BY sc.theme_id
    ORDER BY EXISTS (SELECT 1 FROM membres_cours m WHERE m.cours_id = t.cours_id
        AND m.compte_id = conversations.compte_id) DESC, count(*) DESC
    LIMIT 1), '')
WHERE chapitre != '' AND theme_id = '';
UPDATE messages SET theme_id = coalesce((
    SELECT sc.theme_id FROM source_cours sc JOIN sources s ON s.id = sc.source_id
        JOIN themes t ON t.id = sc.theme_id
    WHERE json_extract(s.metadonnees, '$.sequence') = messages.chapitre
    GROUP BY sc.theme_id
    ORDER BY EXISTS (SELECT 1 FROM membres_cours m WHERE m.cours_id = t.cours_id
        AND m.compte_id = messages.compte_id) DESC, count(*) DESC
    LIMIT 1), '')
WHERE chapitre != '' AND theme_id = '';
