# Thoth MVP: architecture technique

> Version 2.0, 28/08/2026  
> Statut: architecture du MVP  
> Déploiement initial: une instance par établissement

> Version 2.1, 22/09/2026 : §2 et §3 décrivent la stack Deno de
> l'[ADR 0003](docs/decisions/0003-application-deno-hono-htmx.md) et la
> frontière de l'[ADR 0004](docs/decisions/0004-monolithe-modulaire-core-app.md).
> Les extraits de code des autres sections sont du pseudo-code.

## 1. Invariants du produit

1. Toute affirmation destinée à un élève doit être reliée à un passage exact et certifié.
2. Une fiche, un quiz, un exercice ou une page Wiki générés restent invisibles aux élèves jusqu'à leur certification par un enseignant.
3. Le corpus reste lisible et exportable sans faire tourner l'application.
4. La suppression d'une projection de recherche ne supprime ni le corpus, ni le Wiki, ni l'historique de validation.
5. Une panne de modèle, une sortie vide ou un échec de vérification n'est jamais présenté comme une abstention pédagogique.
6. Une réponse de chat peut être diffusée sans revue humaine seulement si chaque affirmation passe la vérification contre des passages certifiés. Elle ne devient pas un contenu certifié réutilisable.
7. Les choix de modèle mesurés sont des paramètres d'infrastructure. Ils ne traversent pas le domaine.

## 2. Forme du système

Le MVP est un monolithe modulaire TypeScript sur Deno. Deux processus tournent
depuis le même code et le même conteneur.

```text
Navigateur professeur ou élève
  HTML + CSS + HTMX + JS local
               |
           HTTP / SSE
               |
      serveur Deno + Hono + hono/html
               |
       state.sqlite3 et contenu
               |
         worker Deno séparé
               |
    pdftotext / modèles HTTP / OCR optionnel
```

Le serveur rend les pages et les fragments, et traite les actions courtes et
les réponses de chat. Le worker lit une file persistante dans SQLite et traite
l'extraction, les légendes, les embeddings et les reconstructions. Aucun Redis,
Celery ou moteur de workflow n'est requis pour le pilote.

Les vues lisent l'état par les fonctions de `app/`. Aucune vue n'ouvre un
fichier de contenu ou la base directement.

## 3. Dépôt et modules

```text
deno.json
migrations/
src/
  core/      ingestion, recherche, réponse ancrée, accès aux modèles
  app/       routes, vues, worker, comptes, certification
  server.ts
  worker.ts
  cli.ts     thot ingest / thot ask / thot rebuild / thot eval
static/      htmx, extension SSE, CSS, JS local
tests/
evaluation/  jeux annotés et scripts Python de comparaison
docs/decisions/
```

`core/` n'importe rien de `app/`. `deno task check` le vérifie. `core/` reçoit
ses dépendances et le périmètre des sources consultables en paramètre, jamais
une session ou une requête HTTP.

## 4. Trois catégories de stockage

Le MVP sépare le contenu, l'état opérationnel et les projections. Cette séparation permet de reconstruire l'index sans mettre en danger les comptes, les validations ou les sessions.

| Catégorie         | Autorité                            | Sauvegarde  |
| ----------------- | ----------------------------------- | ----------- |
| Contenu           | fichiers sous `/data/content`       | obligatoire |
| État opérationnel | `/data/state.sqlite3`               | obligatoire |
| Projection active | `/data/projections/{generation_id}` | régénérable |

### 4.1 Contenu canonique

```text
/data/content/
  sources/{source_id}/
    source.json
    revisions/{revision_id}/
      original/
      document.txt
      document.md
      blocks.jsonl
      chunks.jsonl
      images.jsonl
      fiche.json
      assets/
  wiki/{wiki_id}/
    revisions/{revision_id}.md
    current.json
```

Une réingestion crée une révision. Elle ne remplace pas la version citée par un ancien message. `document.txt` est le système de coordonnées des citations.
Pour chaque bloc, l'invariant suivant doit rester vrai.

```python
document_text[block.char_start:block.char_end] == block.text
```

Les identifiants de source ne changent pas. Les identifiants de révision, blocs, chunks et images sont déterministes à partir du contenu normalisé et des versions de traitement.

### 4.2 État opérationnel

`state.sqlite3` contient ce qui ne peut pas être reconstruit depuis les fichiers.

- comptes, rôles, classes et droits d'accès
- événements de certification et de rejet
- travaux d'ingestion et tentatives
- sessions de chat et journaux de citations
- contenus de révision et leur cycle de validation
- progression des élèves
- génération de projection active

Les migrations SQL sont versionnées. Les sauvegardes utilisent l'API de backup SQLite et incluent le journal WAL.

### 4.3 Projection de recherche

Chaque génération de projection est un répertoire immuable.

```text
/data/projections/{generation_id}/
  catalog.sqlite3
  vectors.npy
  vector_rows.jsonl
  manifest.json
/data/projections/active.json
```

`catalog.sqlite3` contient le catalogue certifié, les filtres et FTS5. Le fichier de vecteurs contient les embeddings Qwen3. `manifest.json` enregistre les versions des parseurs, du chunker, des modèles, de la consigne d'extraction et de son jeu d'exemples, les checksums et les comptes.

Une reconstruction écrit une nouvelle génération, vérifie les invariants et remplace `active.json` avec une opération atomique. Une requête conserve le même `generation_id` jusqu'à sa fin. L'ancienne génération est supprimée après le délai de grâce et seulement si aucune requête ne l'utilise.

## 5. Dépôt d'un fichier par un enseignant

### 5.1 Contrat HTTP

1. `POST /v1/uploads` reçoit le fichier et ses métadonnées.
2. Le serveur valide la taille, le type détecté, le checksum et les droits.
3. Il copie l'original dans une zone temporaire, crée un `ingestion_job` et répond `202 Accepted` avec son identifiant.
4. `GET /v1/ingestion-jobs/{id}` expose l'étape, la progression, les avertissements et l'erreur éventuelle.
5. SSE pousse les mêmes changements à la file de traitement du back-office.

Les métadonnées minimales sont l'établissement, l'auteur, la matière, le niveau, le chapitre, le type pédagogique et la visibilité souhaitée. Le type MIME vient du contenu, pas de l'extension fournie.

### 5.2 Cycle du travail

```text
received -> extracting -> enriching -> awaiting_review
    |           |             |
    +-----------+-------------+--> failed

awaiting_review -> certified -> indexing -> available
        |
        +--> rejected
```

Le worker prend un verrou avec expiration. Chaque étape est idempotente selon le checksum d'entrée et les versions des outils. Au redémarrage, il reprend les travaux dont le verrou a expiré. Une relance crée une tentative dans le même travail et conserve l'erreur précédente.

Un fichier n'entre dans la projection élève qu'après `certified`. Le professeur peut inspecter le texte normalisé, les avertissements, les images et les légendes avant cette action.

## 6. Pipeline d'ingestion

```text
original
   |
   +--> HTML: structure du balisage + nettoyage déterministe
   |
   +--> PDF: pdftotext
   |       +--> structure insuffisante: OCR configuré
   |       +--> moins de 200 caractères par page: rendu PNG + Qwen3 VL 32B
   |
   +--> image: Qwen3 VL 8B
   |
   v
document.txt + blocs + images
   |
   v
chunks par section
   |
   v
fiche de chapitre, champs ancrés
   |
   v
contrôles et rapport pour l'enseignant
```

`pdftotext` est le premier passage pour tous les PDF à couche texte. Un gabarit connu peut fournir ses règles de titres. Un dépôt inconnu dont la structure est insuffisante passe par l'adaptateur OCR configuré. Si cet adaptateur transmet le document à un service distant, la configuration de l'établissement doit l'autoriser. Sans cette autorisation, le travail passe en revue manuelle.

Le seuil de 200 caractères par page détecte les PDF muets. La page est rendue en image et confiée à Qwen3 VL 32B. Le seuil reste configurable et couvert par des fixtures.

Le chunker suit les sections. Il ne découpe pas sur un simple compte de mots. Ses paramètres sont versionnés et une modification déclenche une nouvelle projection.

## 7. Extraction structurée du chapitre

Le découpage en blocs et en chunks produit du texte. Il ne produit pas de champs. Un travail supplémentaire lit la révision et écrit une **fiche de chapitre**: des champs typés, chacun ancré sur un passage exact du texte canonique.

Trois usages en dépendent. Le back-office construit fiches et quiz depuis ces champs au lieu de les demander à un modèle sans contrainte. La recherche gagne des filtres par notion. Le rappel lexical gagne du vocabulaire: le libellé d'une notion est souvent le mot qu'un élève emploie et que le document n'écrit nulle part en clair.

### 7.1 Artefact

```text
/data/content/sources/{source_id}/revisions/{revision_id}/fiche.json
```

```json
{
  "schema_version": 1,
  "revision_id": "rev_...",
  "model_id": "openai/gpt-oss-120b",
  "prompt_version": "fiche-1",
  "fewshot_set_id": "fs-atc-1",
  "chapitre": {
    "titre": "Art nouveau",
    "resume": "...",
    "anchors": [{ "block_id": "blk_...", "char_start": 0, "char_end": 184 }]
  },
  "notions": [
    {
      "libelle": "trencadís",
      "definition": "...",
      "anchors": [{ "block_id": "blk_...", "char_start": 1204, "char_end": 1310 }],
      "origin": "generated",
      "status": "unreviewed"
    }
  ],
  "reperes": [
    {
      "type": "oeuvre",
      "libelle": "Casa Batlló",
      "attributs": { "auteur": "Antoni Gaudí", "date": "1904-1906" },
      "anchors": [{ "block_id": "blk_...", "char_start": 980, "char_end": 1043 }],
      "origin": "generated",
      "status": "unreviewed"
    }
  ],
  "exercices": [
    {
      "enonce_anchors": [{ "block_id": "blk_...", "char_start": 2210, "char_end": 2388 }],
      "corrige_anchors": [],
      "origin": "generated",
      "status": "unreviewed"
    }
  ],
  "prerequis": [],
  "objectifs": []
}
```

`reperes` porte ce qu'un élève cherche par son nom: une œuvre, un auteur, une date, une technique, un mouvement. Le vocabulaire de `type` est une configuration par matière, pas une énumération du domaine. Les arts appliqués emploient `oeuvre`, `auteur`, `mouvement`, `date`, `technique`. Les mathématiques emploieront `definition`, `propriete`, `formule`. Ouvrir une matière n'ouvre pas le code du domaine.

`prerequis` et `objectifs` restent souvent vides. Les fiches du corpus pilote ne les écrivent presque jamais, et un champ non écrit ne s'ancre pas.

### 7.2 Règle d'ancrage

Un champ sans ancre valide n'entre pas dans la fiche. La vérification est celle des citations.

```python
document_text[a.char_start:a.char_end] == a.text
```

Un champ dont les offsets ne retombent pas exactement est rejeté et compté dans le rapport d'ingestion. L'ancrage borne l'invention, il ne la supprime pas: un modèle peut ancrer le bon passage et en tirer une définition fausse. C'est la relecture enseignante qui attrape ce cas, pas la vérification d'offsets.

Une fiche vide est un résultat valide. Sur le corpus pilote, 163 pages sur 205 ne contiennent qu'un titre. Un chapitre sans notion extractible ne produit ni erreur ni avertissement bloquant.

### 7.3 Statut et visibilité

`origin` et `status` reprennent la règle des légendes du §8. Un champ généré et non relu peut rejoindre `retrieval_text`. Il ne peut ni devenir `evidence_text`, ni être cité dans une réponse, ni paraître dans l'interface élève.

Certifier une source ne certifie pas sa fiche. Relire un texte normalisé et relire vingt notions extraites sont deux gestes distincts, et un seul bouton pour les deux ferait certifier les notions sans les lire. La revue de fiche réutilise la file de validation du Wiki et ses raccourcis clavier.

### 7.4 Consigne et fichiers d'exemple

L'extraction fonctionne avec des exemples. Deux règles, tirées d'une erreur déjà commise sur la consigne de légendage.

1. Les documents d'exemple viennent d'un chapitre absent du jeu d'évaluation. Une consigne dont les exemples reprennent les cibles des requêtes de test fabrique son propre score.
2. `prompt_version` et `fewshot_set_id` sont écrits dans la fiche et dans le manifeste de projection. Modifier l'un des deux rejoue l'évaluation d'extraction.

Le nombre d'exemples est un paramètre à mesurer. Le point de départ est trois documents.

### 7.5 Consensus entre modèles

Écarté pour le pilote. Le gain publié sur ce montage vient du vote minimal à 1, c'est-à-dire de l'union des extractions de plusieurs modèles, qui multiplie le coût d'ingestion par leur nombre. À trois votes exigés, le rappel tombe. La question se rouvre si le rappel d'un modèle seul reste sous la cible une fois les exemples réglés, et ce seuil figure au §17.


## 8. Provenance et certification des images

Une image et sa légende ont des provenances distinctes.

```json
{
  "image_id": "img_...",
  "source_revision_id": "rev_...",
  "caption": "...",
  "caption_origin": "generated",
  "caption_status": "unreviewed",
  "model_id": "qwen/qwen3-vl-8b-instruct",
  "credit": null
}
```

`caption_origin` vaut `source`, `generated` ou `teacher`. `caption_status` vaut
`unreviewed`, `certified` ou `rejected`.

Une légende générée non relue peut enrichir les textes de rappel. Elle ne peut pas être envoyée au générateur comme preuve, être citée dans une réponse, servir d'alt public ou apparaître dans l'interface élève. Le paquet de contexte garde donc deux champs distincts: `retrieval_text` et `evidence_text`.

Le back-office affiche toujours l'origine, le modèle et le statut. Après correction ou validation par l'enseignant, la légende rejoint `evidence_text`. L'origine générée reste conservée dans l'audit.

## 9. Construction et activation de l'index

Une certification ou une nouvelle révision ajoute un événement de projection. Le worker regroupe les événements pendant une courte fenêtre, puis construit une génération complète pour le pilote. Le rebuild incrémental attendra une mesure montrant qu'il est nécessaire.

La construction suit cet ordre.

1. Lire uniquement les révisions certifiées et autorisées.
2. Valider les checksums, offsets, références d'images et citations Wiki.
3. Construire le catalogue et FTS5.
4. Calculer ou reprendre du cache les embeddings Qwen3 par checksum de chunk.
5. Écrire le mapping entre lignes vectorielles et chunks.
6. Exécuter les requêtes de santé et comparer les comptes au manifeste.
7. Activer la génération par remplacement atomique de `active.json`.

Un échec laisse la génération active intacte. Le back-office voit la nouvelle source comme certifiée mais « indexation en échec » jusqu'à une reprise réussie.

## 10. Recherche et abstention

```text
question + périmètre autorisé
   |
   +--> FTS5 racinisé, top 20
   +--> Qwen3 Embedding 8B, top 20 exact
   |
   v
RRF, union limitée à 20
   |
   v
Qwen3 Reranker 8B
   |
   +--> score sous le seuil: réponse hors corpus
   +--> score au-dessus: cinq extraits vers la génération
```

Les filtres d'établissement, matière, niveau, chapitre, visibilité et certification s'appliquent avant le classement. Le seuil d'abstention est une configuration versionnée avec le corpus d'étalonnage, sa date, le modèle et les métriques obtenues. Il n'est pas une constante écrite dans le domaine.

Le moteur publie les classements FTS5, dense, RRF et reclassé dans les traces d'évaluation. Le contexte complet n'existe pas dans l'API du MVP.

## 11. Génération et vérification des citations

Le générateur reçoit cinq extraits certifiés avec des identifiants opaques. Il retourne une réponse structurée en affirmations et références d'extraits. Le serveur résout lui-même les titres, chemins et offsets affichés.

```text
top 5 certifié
   |
   v
génération structurée
   |
   v
validation de forme et sortie non vide
   |
   v
validation déterministe des ancres
   |
   v
vérification du support de chaque affirmation
   |
   +--> tout est supporté: diffusion SSE et journal final
   |
   +--> échec: une réparation, puis refus si l'échec persiste
```

### 11.1 Contrôles déterministes

- la complétion existe et contient au moins un caractère utile
- chaque affirmation factuelle a au moins une citation
- chaque citation appartient aux cinq extraits fournis
- la source, la révision et le bloc sont certifiés et autorisés
- les offsets retombent exactement sur `document.txt`
- une légende ou un champ de fiche non certifié ne peut pas devenir une preuve

Une sortie vide produit `MODEL_EMPTY_RESPONSE`. Elle ne produit jamais
`OUT_OF_CORPUS`.

### 11.2 Vérification du support

Le port `ClaimVerifier` reçoit une affirmation et uniquement les extraits qu'elle cite. Il retourne `supported`, `unsupported` ou `contradicted`, avec une raison conservée dans le journal. Le choix du vérificateur reste à mesurer. Aucun score de qualité n'est inventé dans l'architecture.

Le MVP autorise une seule passe de réparation avec les violations et les mêmes extraits. Si une affirmation échoue encore, la réponse complète est remplacée par un refus prudent. Retirer une phrase isolée sera étudié après des tests de cohérence linguistique.

### 11.3 États publics

L'API distingue trois résultats.

- `answered`: réponse vérifiée et citations résolues
- `out_of_corpus`: seuil de reclassement insuffisant
- `failed`: panne de fournisseur, sortie vide ou vérification impossible

Cette distinction empêche une panne technique de ressembler à une limite du cours.

## 12. Modèles et frontière réseau

Les identifiants mesurés sont figés dans la configuration d'infrastructure. Une configuration de production ajoute la révision des poids, leur checksum, la quantification et le runtime.

| Usage            | Valeur par défaut du MVP     | Exécution                  |
| ---------------- | ---------------------------- | -------------------------- |
| Plongement       | `qwen/qwen3-embedding-8b`    | locale visée               |
| Reclassement     | `qwen/qwen3-reranker-8b`     | locale visée               |
| Légendes         | `qwen/qwen3-vl-8b-instruct`  | locale visée               |
| Sauvetage PDF    | `qwen/qwen3-vl-32b-instruct` | locale visée               |
| Réponse courante | `openai/gpt-oss-120b`        | fournisseur configurable   |
| Fiche de chapitre | `openai/gpt-oss-120b`       | fournisseur configurable   |
| Refus strict     | `z-ai/glm-5.3-flash`         | fournisseur configurable   |
| OCR de structure | `mistral-ocr-latest`         | distant, avec autorisation |

Les modèles locaux ont été mesurés via OpenRouter. Avant le pilote, un spike doit mesurer RAM, latence, débit et coût sur le matériel cible. Si le matériel ne les tient pas, les mêmes ports peuvent appeler un hébergeur autorisé. Le changement de lieu d'exécution ne change pas le modèle ni les tests de qualité.

GPT OSS 120B est mesuré en génération de réponse, pas en extraction de fiche. C'est une valeur de départ, pas un choix tranché, et le §18 porte la mesure qui la confirmera ou la remplacera.

Les modèles à réflexion reçoivent un budget couvrant réflexion et réponse. Le budget, le modèle, la latence, les tokens et la cause d'arrêt sont journalisés.

## 13. API publique du MVP

Les premiers contrats HTTP sont les suivants.

```text
POST /v1/uploads
GET  /v1/ingestion-jobs/{id}
GET  /v1/sources
GET  /v1/sources/{id}
POST /v1/sources/{id}/certify
POST /v1/sources/{id}/reject

GET  /v1/images
PATCH /v1/images/{id}
POST /v1/images/{id}/certify-caption

GET  /v1/sources/{id}/fiche
PATCH /v1/fiche-fields/{id}
POST /v1/sources/{id}/certify-fiche

GET  /v1/wiki/review-queue
PATCH /v1/wiki/{id}
POST /v1/wiki/{id}/certify
POST /v1/wiki/{id}/reject

POST /v1/chat/sessions
POST /v1/chat/sessions/{id}/messages
GET  /v1/chat/sessions/{id}/events
GET  /v1/citations/{id}
```

Les commandes CLI appellent les mêmes cas d'usage. Elles ne contournent pas les règles de certification.

## 14. Autorisation et isolation

Le pilote déploie une instance par établissement. `school_id` reste présent sur les entités et dans tous les filtres pour éviter une migration de domaine plus tard, mais l'interface ne permet pas de changer d'établissement.

Les rôles initiaux sont `teacher`, `student` et `operator`. Seuls les enseignants peuvent déposer, corriger, certifier ou rejeter. Le dépôt de recherche applique les droits. Masquer un contenu dans une vue ne constitue pas un contrôle d'accès.

Les fichiers uploadés sont considérés non fiables. Les parseurs tournent avec des limites de taille, de temps et de mémoire. Les noms de fichier ne deviennent jamais des chemins. Les archives et formats actifs ne sont pas acceptés dans le premier pilote.

## 15. Observabilité et audit

Chaque requête de réponse conserve les éléments suivants.

- génération de projection et versions de modèle
- question et périmètre demandé, selon la politique de conservation
- candidats, scores et seuil d'abstention
- extraits réellement fournis
- affirmations, citations et résultat de vérification
- tokens, latences, tentative de réparation et erreur éventuelle

Le journal n'expose pas les raisonnements internes des modèles. Les écrans
montrent les étapes de traitement et les preuves, pas une « trace de pensée ».

## 16. Sauvegarde, restauration et suppression

Une sauvegarde cohérente contient `/data/content`, une sauvegarde de `state.sqlite3`, la configuration sans secrets et l'identifiant de la projection active. Les projections peuvent être omises si le test de rebuild passe.

Une restauration se fait dans un répertoire temporaire, reconstruit une projection, compare les checksums et ouvre une requête de santé avant activation.

La suppression d'une source crée d'abord une révision archivée et retire la source de la prochaine projection. La purge physique suit la politique de conservation de l'établissement et doit aussi traiter les journaux qui la référencent.

## 17. Seuils de changement d'architecture

| Mesure                                      | Changement envisagé                         |
| ------------------------------------------- | ------------------------------------------- |
| Rebuild complet hors budget du pilote       | projection incrémentale                     |
| Recherche exacte hors budget de latence     | index approximatif derrière `VectorIndex`   |
| File SQLite incapable d'absorber les dépôts | file de travaux dédiée                      |
| Écritures concurrentes bloquées             | base opérationnelle serveur                 |
| Plusieurs instances API nécessaires         | stockage partagé et coordination distribuée |
| FTS5 inutile après reclassement             | retrait de RRF et du bras lexical principal |
| Rappel d'extraction sous cible après réglage des exemples | consensus entre plusieurs modèles |

Aucun de ces seuils n'est franchi aujourd'hui.

## 18. Mesures encore requises

1. RAM, latence et débit des quatre modèles Qwen sur le matériel cible.
2. Packaging de SQLite Vec1 sur macOS et Linux face au fallback NumPy exact.
3. Durée d'une reconstruction complète et d'un basculement de génération.
4. Qualité du `ClaimVerifier` sur les 35 questions de génération, dont les 15
   questions hors corpus.
5. Rappel et précision de l'extraction de fiche sur vingt documents annotés,
   sans exemples puis avec trois exemples.
6. Vingt légendes Qwen3 VL relues par un enseignant.
7. Trente vraies questions d'élèves ajoutées à l'évaluation après le pilote.
