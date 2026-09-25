# Thot : diagrammes du code actuel

Ces diagrammes décrivent le code au 23/09/2026. `ARCHITECTURE.md` décrit la cible, qui
diffère encore sur plusieurs points : ni projections, ni embeddings, ni API `/v1`. L'index est
une table FTS5 dans `state.sqlite3`.

## 1. Vue d'ensemble

`src/main.ts` applique les migrations puis lance deux processus Deno depuis le même code. Si
l'un s'arrête, `main.ts` arrête l'autre.

```mermaid
flowchart LR
  subgraph Navigateur
    P[Professeur]
    E[Élève]
  end

  subgraph Conteneur["Conteneur Docker (Coolify)"]
    S["server.ts<br/>Hono + hono/html + HTMX"]
    W["worker.ts<br/>boucle d'ingestion"]
    CLI["cli.ts<br/>ingest, certifier, ask, eval"]
    DB[("state.sqlite3<br/>WAL")]
    FS[["data/content/{source}/<br/>original, document.txt,<br/>blocs.jsonl, assets/"]]
    PDF[pdftotext]
  end

  OR["OpenRouter<br/>Qwen3 VL 8B, Qwen3 Reranker 8B,<br/>GPT OSS 120B"]

  P & E -- "HTTP, SSE" --> S
  S <--> DB
  S --> FS
  W <--> DB
  W <--> FS
  W --> PDF
  W -- "légendes, suggestions" --> OR
  S -- "reclassement, réponse, reformulation" --> OR
  CLI <--> DB
  CLI <--> FS
```

Les deux processus partagent la base SQLite. Le serveur ne lance pas de travail long, à une
exception près : la réponse à une question, calculée pendant le flux SSE de l'élève.

## 2. Modules

`core/` ne dépend pas de `app/`. `deno task check` le vérifie.

```mermaid
flowchart TB
  subgraph Entrées
    main[main.ts]
    server[server.ts]
    worker[worker.ts]
    cli[cli.ts]
  end

  subgraph app["src/app : état, HTTP, vues"]
    routes[routes.ts]
    vues[vues.ts + icones.ts]
    depot[depot.ts]
    ingestion[ingestion.ts]
    suggA[suggestions.ts]
    comptes[comptes.ts]
    db[db.ts]
    config[config.ts]
  end

  subgraph core["src/core : domaine sans état"]
    pdf[pdf.ts]
    html[html.ts]
    document[document.ts]
    recherche[recherche.ts]
    reponse[reponse.ts]
    suggC[suggestions.ts]
    modeles[modeles.ts]
    texte[texte.ts]
  end

  main --> db
  server --> routes
  worker --> ingestion & suggA
  cli --> ingestion & suggA & reponse & comptes
  routes --> vues & depot & ingestion & comptes & suggA & reponse
  ingestion --> pdf & html & document & recherche
  suggA --> suggC
  suggC --> reponse
  reponse --> recherche & modeles & texte
```

## 3. Un professeur dépose un document

```mermaid
sequenceDiagram
  actor P as Professeur
  participant S as Serveur
  participant FS as data/content
  participant DB as SQLite
  participant W as Worker
  participant M as OpenRouter

  P->>S: POST /prof/depot (fichier + métadonnées)
  S->>S: valider(), controlerFichier()<br/>format lu dans les octets, 25 Mo max
  S->>FS: original/
  S->>DB: sources (statut a_relire)<br/>ingestion_jobs (received)
  S-->>P: « déposé, extraction commencée »

  loop toutes les secondes
    W->>DB: revendiquer() : plus ancien travail, verrou expirable
  end
  W->>W: extraire() : pdftotext, HTML Pearltrees ou image seule
  W->>FS: document.txt, blocs.jsonl, assets/image-n
  W->>DB: images, job enriching
  loop chaque image sans légende
    W->>M: legender() Qwen3 VL 8B
    M-->>W: légende
    W->>DB: images.legende (origine generated, unreviewed)
  end
  W->>DB: job awaiting_review, avertissements

  par pendant ce temps
    P->>S: GET /prof/lignes toutes les 3 s (HTMX)
    S-->>P: « extraction… », « légendes… », « extrait »
  end

  P->>S: GET /prof/sources/:id (texte, images, avertissements)
  P->>S: POST /prof/sources/:id/certifiee
  S->>DB: statut certifiee, puis indexer()<br/>chunks + chunks_fts

  P->>S: /prof/legendes (V valider, E éditer, R rejeter)
  S->>DB: legende_statut certified ou rejected, puis indexer()

  Note over W,M: File vide : le worker génère les questions suggérées<br/>des sources certifiées et ne garde que celles<br/>auxquelles la chaîne de réponse répond avec des citations vérifiées.
```

## 4. États d'un dépôt

Trois états se croisent : le travail d'ingestion, la source et chaque légende.

```mermaid
stateDiagram-v2
  direction LR
  state "Travail d'ingestion" as Job {
    [*] --> received
    received --> extracting: revendiquer()
    extracting --> enriching: fichiers écrits
    enriching --> awaiting_review: légendes tentées
    extracting --> failed: erreur ou tentatives épuisées
    enriching --> failed
  }
```

```mermaid
stateDiagram-v2
  direction LR
  state "Source" as Source {
    [*] --> a_relire
    a_relire --> certifiee: professeur
    a_relire --> rejetee: professeur
    certifiee --> rejetee
    rejetee --> certifiee
  }
  note right of Source
    Seule une source certifiee a des chunks dans l'index.
    Toute autre en est retirée par indexer().
  end note
```

```mermaid
stateDiagram-v2
  direction LR
  state "Légende d'image" as Legende {
    [*] --> unreviewed: générée
    unreviewed --> certified: valider ou corriger
    unreviewed --> rejected
  }
  note right of Legende
    unreviewed : sert au rappel (texte de recherche) seulement.
    certified : devient une preuve citable et s'affiche à l'élève.
  end note
```

## 5. Un élève pose une question

La question est enregistrée, puis le navigateur ouvre un flux SSE. Le premier flux qui prend le
message calcule la réponse. Une reconnexion ou un second onglet attend le résultat en base.

```mermaid
sequenceDiagram
  actor E as Élève
  participant S as Serveur
  participant DB as SQLite
  participant M as OpenRouter

  E->>S: POST /eleve/questions (texte, chapitre facultatif)
  S->>DB: messages (en_attente)
  S-->>E: bulle question + zone d'attente
  E->>S: GET /eleve/messages/:id/flux (SSE)
  S->>DB: en_attente vers en_cours (un seul preneur)

  opt question précédente dans le même chapitre
    S-->>E: étape « Mise en contexte »
    S->>M: reformuler()
  end
  S-->>E: étape « Recherche dans les documents »
  S->>DB: FTS5 racinisé, top 20, filtré par établissement et chapitre
  S->>M: reclasser() Qwen3 Reranker 8B
  alt meilleur score sous le seuil (0,023)
    S->>DB: out_of_corpus
  else
    S-->>E: étape « Rédaction »
    S->>M: generer() GPT OSS 120B, 5 extraits
    S-->>E: étape « Vérification des citations »
    S->>S: verifier() : chaque citation retrouvée mot pour mot
    opt citations invalides
      S->>M: une réparation avec la liste des erreurs
    end
    S->>DB: answered, ou failed CITATION_UNVERIFIED
  end
  S-->>E: event reponse (HTML) + idées de questions
  E->>S: GET /eleve/messages/:id/citations/:n
  S-->>E: passage surligné dans son contexte
  E->>S: POST /eleve/messages/:id/avis (utile, confus, faux)
```

## 6. Recherche, génération, vérification

`demander()` dans `src/core/reponse.ts`. Aucune exception ne sort : une panne devient `failed`,
jamais `out_of_corpus`.

```mermaid
flowchart TD
  Q[Question] --> R{Question précédente<br/>dans le chapitre ?}
  R -- oui --> RF[reformuler] --> F
  R -- non --> F[FTS5 bm25 top 20<br/>école + chapitre]
  F -- aucun résultat --> HC[out_of_corpus]
  F --> RR[Reranker Qwen3 8B]
  RR -- score < seuil --> HC
  RR -- score >= seuil --> G[GPT OSS 120B<br/>5 extraits, JSON d'affirmations]
  G --> V{verifier}
  V -- refus du modèle --> HC
  V -- tout vérifié --> IMG[rattacher une image<br/>à chaque affirmation] --> OK[answered]
  V -- erreurs, 1er essai --> G
  V -- erreurs, 2e essai --> KO[failed<br/>CITATION_UNVERIFIED]
  G -. panne, sortie vide .-> PANNE[failed<br/>code du modèle]
```

Un chunk porte deux textes. `rappel` contient le contexte, le titre, le texte et toutes les
légendes non rejetées, et sert à la recherche. `preuve` contient le texte et les légendes
certifiées, et c'est le seul texte que `verifier()` accepte comme source d'une citation.

## 7. Parcours élève dans l'interface

```mermaid
flowchart LR
  C["/connexion"] --> A["/eleve<br/>chapitres, questions suggérées,<br/>œuvre ou fait au hasard"]
  A --> CH["/eleve/chapitres/:nom<br/>mur d'œuvres + lecteur"]
  CH -- clic sur une vignette --> AP["/eleve/documents/:id/apercu<br/>(fragment HTMX)"]
  AP --> SRC["/eleve/sources/:id<br/>document complet"]
  A -- question ou idée --> CHAT["/eleve/chat"]
  CH -- question du chapitre --> CHAT
  CHAT -- citation --> CIT["panneau de citation<br/>passage surligné"]
  CIT -- lire le document --> SRC
  CHAT --> AV[avis utile, confus, faux]
  A --> D["/deconnexion<br/>invalide toutes les sessions"]
```

Côté professeur : `/prof` (sources, filtres, certification groupée), `/prof/depot`,
`/prof/sources/:id`, `/prof/legendes`, `/prof/questions` (questions des élèves, refus et avis
« faux » en tête), `/prof/eleves` (import de la classe, fiches d'identifiants).

## 8. Données

```mermaid
erDiagram
  sources ||--o| ingestion_jobs : "a un"
  sources ||--o{ images : contient
  sources ||--o{ chunks : "indexée en"
  chunks ||--|| chunks_fts : "ligne FTS5"
  sources ||--o{ suggestions : propose
  comptes ||--o{ messages : pose

  sources {
    text id
    text statut "a_relire, certifiee, rejetee"
    text metadonnees "JSON : sequence, seance, date..."
    text format "pdf, html, png, jpg"
    text suggestions_le
  }
  ingestion_jobs {
    text etat
    int tentatives
    text verrou_expire_le
    text avertissements
  }
  images {
    text legende
    text legende_origine "generated, teacher"
    text legende_statut "unreviewed, certified, rejected"
  }
  chunks {
    int debut "offset dans document.txt"
    int fin
    text rappel
    text preuve
  }
  messages {
    text etat "en_attente, en_cours, answered, out_of_corpus, failed"
    text resultat "JSON"
    text journal "candidats, scores, tentatives"
    text avis
  }
  comptes {
    text role "enseignant, eleve"
    int session_version
  }
```

`cache_modeles` garde les réponses de modèle par empreinte de requête. Le worker purge les
messages plus vieux que `THOT_RETENTION_JOURS` (90 jours par défaut) une fois par heure.
