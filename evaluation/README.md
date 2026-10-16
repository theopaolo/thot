# Évaluation

`queries_real.py` contient les requêtes annotées de recherche, réparties en familles.
`queries_generation.py` contient des questions répondables et des pièges sans réponse dans le
corpus. Les deux fichiers sortent du banc d'essai et restent tels quels pour ne pas altérer la
vérité terrain. `python3 evaluation/exporter.py` les convertit en JSON pour `thot eval`, sans toucher aux
identifiants ni aux cibles.

```bash
pnpm thot eval recherche --img-order=../mesures/thot-real/img_order.json \
  --docs=../mesures/thot-real/docs.json [--sans-reclasseur]
pnpm thot eval recherche --img-order=../mesures/thot-real/img_order.json \
  --docs=../mesures/thot-real/docs.json --ratios=0.1,0.25,0.5
pnpm thot eval generation
pnpm thot ask "Pourquoi les cubistes ont-ils abandonné la perspective ?"
```

`--ratios` ajoute au rapport, par famille et par ratio, le succès, le MRR, le rappel des cibles et
le nombre moyen de documents de la liste de `/eleve/recherche`
([`resultats/recherche-affichage.json`](resultats/recherche-affichage.json)). Une réingestion
régénère les légendes: deux requêtes sur 59 suffisent à bouger le succès@5 de 0,03.

## Soutien des citations

`verifier()` contrôle qu'une citation existe mot pour mot. `thot eval soutien` mesure si un juge
repère une citation réelle qui ne prouve pas la phrase qu'elle accompagne.

```bash
pnpm thot eval generation --paires=../mesures/thot-real/paires-soutien.json
pnpm thot eval soutien --paires=../mesures/thot-real/paires-soutien-calibrage.json
```

Le fichier de paires contient des citations du corpus : il reste dans le dépôt de recherche.
`paires-soutien.json` garde les 103 paires d'arts appliqués. `paires-soutien-calibrage.json`
les reprend et ajoute les sorties du jeu développement et les négatifs partiels : c'est le
fichier qui fixe le seuil. Une paire porte `profil` quand le juge doit lire la consigne du
profil général, sinon il lit celle d'arts appliqués. `eval generation` écrit ce champ et refuse
d'écraser un fichier existant. L'annotation remplit `soutient` :

- `true` si la citation suffit à établir toute la phrase, sans savoir extérieur. Le titre de
  l'extrait (`titre`) et le paragraphe autour de la citation (`paragraphe`, celui que le
  panneau source montre à l'élève) peuvent donner le sujet : le mouvement, l'artiste ou
  l'œuvre. Le fait lui-même doit être dans la citation.
- `false` si la phrase ajoute, généralise, inverse ou change l'auteur de ce que dit la
  citation. Un soutien partiel compte comme `false`, car l'élève lit la phrase entière.

Les sorties réelles sont presque toutes justes. Les négatifs s'écrivent à la main : copier une
ligne, lui donner un nouvel `id`, réécrire `texte` et nommer la `famille` (`inversion`,
`généralisation`, `attribution`, `ajout`, `chiffre`, `partiel`). Un négatif `partiel` change
peu une phrase juste : un mot glisse (« textiles » devient « vêtements »), une cause s'ajoute,
une moitié de la phrase n'est pas dans la citation. Les sorties qui recopient une ligne de code
ou une commande ont la famille `code`.

Le rapport donne l'AUC, les erreurs au seuil `SEUIL_SOUTIEN` par famille, la table `seuils`
(bonnes phrases rejetées et erreurs attrapées à plusieurs seuils), le modèle qui a répondu pour
chaque paire, et ne garde que les identifiants. Le modèle jugé se change par
`THOT_MODELE_SOUTIEN`. Chaque passage écrase `soutien.json`. Pour mesurer la stabilité du juge,
lancer trois passages, copier le rapport entre deux, et compter les paires dont le verdict au
seuil change.

Les rapports produits par `thot eval` restent dans le répertoire de données de l’instance,
sous `evaluation/resultats/`. Les résultats de référence suivis dans ce dépôt restent dans
`resultats/`. Le corpus ATC et `img_order.json` restent dans le dépôt de recherche.

## Jeu développement

`dev/requetes.json` et `dev/questions.json` forment un second jeu, tiré de cinq cours de
développement web (`docker`, `rgpd`, `architecture-logicielle`, `poo-patterns-frameworks`,
`documentation`). Il vérifie que la même version de Thot sert une autre matière que les arts
appliqués. Les cours restent hors du dépôt, seuls les questions, les noms de fichiers et les
rapports y sont.

`--requetes=<fichier>` remplace le jeu du pilote dans les deux commandes `thot eval`. Une cible
nomme une source par `<dossier du cours>/<fichier>`, par exemple
`docker/index.md`, car plusieurs cours ont un `index.md`. `#<section>` exige en plus le titre
d'une section, tel que l'extraction l'écrit. Une requête réussit si
une cible figure parmi les cinq premiers passages. Une requête sans cible est un piège : elle
sort des taux et le rapport compte les pièges qui reçoivent encore un résultat
(`hors_corpus.avec_resultat`). Le rapport prend le nom du dossier du jeu en suffixe
(`recherche-fts5-dev.json`), donc il n'écrase jamais ceux du pilote.

Familles de `requetes.json` :

- `terme-exact` : un mot du cours, une option ou une commande, sans reformulation.
- `paraphrase` : la question d'un apprenant, avec un vocabulaire que le cours n'emploie pas.
- `code` : la preuve se trouve dans un bloc de code (Dockerfile, Compose, TypeScript, Gherkin).
- `definition` : une définition ou un concept (« que signifie full stack »).
- `deux-cours` : une question que deux cours traitent, les deux fichiers sont des cibles.
- `hors-corpus` : un piège sans cible, dont des voisins proches (Kubernetes, asyncio, Docker Swarm,
  une amende RGPD que le cours ne cite pas).

`questions.json` suit le format de `queries_generation.json` : 15 questions répondables avec
leurs fichiers attendus, 8 pièges classés par registre.

```bash
pnpm thot instance --nom="Thot développement" --mode=shared
pnpm thot matiere "Développement" --profil=general
pnpm thot cours <matiere_id> docker        # un cours par dossier, même nom que le dossier
pnpm thot ingest <dossier>/docker --matiere-id=<matiere_id> --cours-id=<cours_id> --langue=fr
pnpm thot traiter && pnpm thot certifier --tout --par="Évaluation"
pnpm thot eval recherche --requetes=evaluation/dev/requetes.json --sans-reclasseur
pnpm thot eval recherche --requetes=evaluation/dev/requetes.json
pnpm thot eval generation --requetes=evaluation/dev/questions.json
```

Le dossier passé à `ingest` ne contient que les fichiers `.md` du cours. Son nom devient la
séquence de la source, et les cibles du jeu en dépendent.

### Référence FTS5

[`resultats/recherche-fts5-dev.json`](resultats/recherche-fts5-dev.json), 46 sources, 552
passages, profil général, sans reclasseur. 36 requêtes ont une cible :

| Famille | n | succès@5 | MRR |
| --- | --- | --- | --- |
| terme-exact | 6 | 1,00 | 1,00 |
| paraphrase | 12 | 0,92 | 0,65 |
| code | 7 | 1,00 | 1,00 |
| definition | 6 | 1,00 | 0,92 |
| deux-cours | 5 | 1,00 | 0,74 |
| tous | 36 | 0,97 | 0,83 |

Un corpus de 552 passages est petit, FTS5 y réussit presque tout. Seule la famille `paraphrase`
sépare les moteurs. Sur ce jeu, `deux-cours` ne compte pas les deux cours : une seule cible
suffit.

Les 8 pièges `hors-corpus` ne se mesurent pas ici. FTS5 renvoie des passages pour 7 d'entre eux
(les mots courants suffisent : « amende », « configurer », « Docker »). Seul le seuil du
reclasseur (`THOT_SEUIL_ABSTENTION`) décide de les écarter.

### Reclasseur et génération

[`resultats/recherche-reclasseur-dev.json`](resultats/recherche-reclasseur-dev.json), même corpus,
seuil 0,023 : succès@5 1,00 dans toutes les familles, MRR 0,95 (paraphrase et deux-cours 0,90).
`hors_corpus.avec_resultat` compte les pièges qui passent le seuil : 2 sur 8 (N03 asyncio, N05
l'amende de Google). D'un passage à l'autre, le score d'un même piège change chez le reclasseur :
N03 passait sous le seuil dans la génération.

[`resultats/generation-dev.json`](resultats/generation-dev.json) :

| Mesure | Valeur |
| --- | --- |
| questions répondables répondues | 14 sur 15 |
| bonne source citée | 14 sur 15 |
| réponses réparées (second appel) | 5 sur 15 |
| réponses partielles | 1 sur 15 |
| réponses en blocs | 6 sur 15 (deux tableaux, des listes, des étapes) |
| réponses avec un schéma | 0 sur 15 |
| pièges refusés | 8 sur 8, 6 au seuil et 2 par le modèle |
| latence médiane | 4,4 s |

Le faux refus est G15 (« un conteneur C4, c'est la même chose qu'un conteneur Docker ? ») : le
modèle refuse, aucun extrait ne compare les deux. Deux sources qui disent la même chose donnent
encore deux affirmations (G01, G04).

Le jeu ne pose aucune question sur des liens entre notions, et aucune réponse n'a pris la forme
d'un schéma. Hors du jeu, « Quels liens y a-t-il entre image, conteneur et volume dans Docker ? »
en donne un valide. Le modèle y donne à un nœud la preuve de sa relation, et `ranger()` la laisse
à la relation au lieu de refuser le schéma.

## Langues et profils

`tests/domaines_test.ts` contient une sonde lexicale synthétique français/anglais et les contrôles
sans fournisseur des prompts génériques, du profil arts et des périmètres de recherche. Il
vérifie que les consignes du profil arts ont l'empreinte des mesures ml4. Chaque source se
racinise dans sa langue : la sonde trouve trois cibles sur quatre en français, comme avant, et
quatre sur quatre en anglais. Le pluriel irrégulier français reste une limite du moteur. La
recherche entre une question française et une source anglaise se mesure à part, dans le jeu
langues.

## Jeu langues

`langues/requetes.json` et `langues/questions.json` mesurent la recherche entre langues, à part
de la recherche dans une seule langue. L'instance a le profil général, une matière et quatre
cours de développement : `lire-une-codebase`, `architecture-logicielle`,
`poo-patterns-frameworks` et `documentation`, tous en français. Le cours `lire-une-codebase`
reçoit aussi `Programmers_brain.pdf`, une fiche de synthèse en anglais de *The Programmer's
Brain*, seule dans un dossier `programmers-brain` et déposée avec `--langue=en`. Le PDF donne
cinq passages sans section, ses cibles nomment donc le fichier. L'instance compte 52 sources et
499 passages. Le livre et ses citations restent hors du dépôt.

```bash
pnpm thot ingest <dossier>/lire-une-codebase --matiere-id=<m> --cours-id=<c> --langue=fr
pnpm thot ingest <dossier>/programmers-brain --matiere-id=<m> --cours-id=<c> --langue=en
pnpm thot eval recherche --requetes=evaluation/langues/requetes.json --sans-reclasseur
pnpm thot eval recherche --requetes=evaluation/langues/requetes.json
pnpm thot eval generation --requetes=evaluation/langues/questions.json
```

Familles de `requetes.json` :

- `fr-livre` (15) : une question française dont la réponse n'est que dans le PDF anglais.
- `en-livre` (5) : une question anglaise sur le PDF.
- `fr-cours` (5) : une question française sur une leçon française de `lire-une-codebase`.
- `hors-corpus` (5) : des pièges voisins du livre (l'hippocampe, les 10 000 heures, ESLint,
  Scratch, la complexité cyclomatique).

Avec une source anglaise dans le périmètre, `eval recherche --sans-reclasseur` appelle aussi le
modèle de traduction. Succès@5 / MRR avant (racines françaises partout, commit `6b5e710`) et
après (racines de la langue de chaque source, racines anglaises de la question, traduction) :

| Famille | n | FTS5 avant | FTS5 après | reclasseur avant | reclasseur après |
| --- | --- | --- | --- | --- | --- |
| fr-livre | 15 | 0,13 / 0,06 | 1,00 / 0,54 | 0,40 / 0,40 | 1,00 / 1,00 |
| en-livre | 5 | 1,00 / 1,00 | 1,00 / 1,00 | 1,00 / 1,00 | 1,00 / 1,00 |
| fr-cours | 5 | 0,80 / 0,70 | 0,80 / 0,67 | 1,00 / 1,00 | 1,00 / 1,00 |

Rapports : [`resultats/recherche-fts5-langues.json`](resultats/recherche-fts5-langues.json) et
[`resultats/recherche-reclasseur-langues.json`](resultats/recherche-reclasseur-langues.json).
Les pièges qui passent le seuil du reclasseur passent de 3 à 4 sur 5 : N02 (les 10 000 heures)
trouve le passage sur la pratique délibérée.

Les deux mécanismes se mesurent séparément sur `fr-livre`, chaque source racinisée dans sa
langue :

| Requête FTS5 | FTS5 | reclasseur |
| --- | --- | --- |
| racines françaises de la question | 0,13 / 0,10 | 0,33 / 0,33 |
| plus ses racines anglaises | 0,33 / 0,22 | 0,40 / 0,40 |
| racines françaises, plus la traduction | 0,80 / 0,42 | 1,00 / 0,96 |
| racines des deux langues, plus la traduction | 1,00 / 0,54 | 1,00 / 1,00 |

La traduction fait presque tout le gain. Les racines anglaises servent surtout la traduction :
racinisée en français, « memory » reste « memory » alors que l'index anglais contient
« memori ». Sans reclasseur, en repli, elles font passer `fr-livre` de 0,80 à 1,00. Avec le
reclasseur, le passage qui contient la réponse arrive premier pour les 15 questions `fr-livre`,
vérifié à la main sur les cinq passages du PDF. La traduction dure 0,37 s en médiane (0,71 s au
plus) et double au plus les candidats du reclasseur, de 20 à 40.

[`resultats/generation-langues.json`](resultats/generation-langues.json), 10 questions
répondables et 3 pièges :

| Mesure | Valeur |
| --- | --- |
| questions répondables répondues | 10 sur 10 |
| bonne source citée | 10 sur 10 |
| réponses sur le PDF qui citent le passage anglais | 8 sur 8 |
| réponses réparées (second appel) | 5 sur 10 |
| réponses partielles | 2 sur 10 |
| réponses avec « Vérification partielle » | 5 sur 10 |
| pièges refusés | 3 sur 3, 1 au seuil et 2 par le modèle |
| latence médiane | 6,8 s |

Les phrases restent en français et les citations recopient l'anglais mot pour mot :
`verifier()` ne dépend pas de la langue. Les réparations ont deux causes. La fiche anglaise
découpe ses phrases en fragments, d'où des citations de moins de trois mots et une citation qui
recolle deux zones de la page. Le juge refuse aussi des phrases qui ajoutent à leur citation
(« régulièrement », un lien de cause), et laisse passer les traductions fidèles.

Un second passage du juge reprend les 49 affirmations finales, qui ont passé le juge ou son
délai, et 8 négatifs écrits à la main. Il accepte 33 affirmations sur 37 prouvées par une
citation anglaise, et 9 sur 12 prouvées par une citation française. Ses refus suivent le même
motif dans les deux langues : la phrase nomme un sujet que la citation ne contient pas. Il
refuse les 8 négatifs (chiffre changé, ajout, inversion). Les paires restent hors du dépôt,
elles citent le livre. Les « Vérification partielle » viennent du délai de 4 s du juge, dépassé
sur des réponses de six à huit affirmations. Au second passage, 6 appels sur 37 dépassent 4 s
pour une citation anglaise, et 1 sur 12 pour une citation française.

Ce jeu mesure une seule source anglaise, courte et sans section, en un seul passage. Un manuel
anglais long (REAPER) dira si les mots courants anglais, que la liste de mots vides française ne
retire pas, gênent FTS5.

## Comparaison des modèles

[La synthèse des mesures](resultats/ml4-comparaison.json) relie les résultats et leurs limites.

Les bancs `bench_generation.ts`, `bench_soutien.py` et `bench_vision.ts` comparent les modèles
sur les jeux figés. `bench_generation.ts` crée au premier lancement une sauvegarde SQLite en
lecture seule pour les essais. Le banc de vision réutilise cette sauvegarde. Les réponses,
citations, légendes et traces complètes restent dans `data/benchmark-ml4/`, ignoré par Git.
Les rapports publiés dans `resultats/ml4-*.json` gardent les mesures et les identifiants.

```bash
node --env-file=.env evaluation/bench_generation.ts deepseek 1
node --env-file=.env evaluation/bench_generation.ts ml4 1
node --env-file=.env evaluation/bench_generation.ts ml4-json 1
node --env-file=.env evaluation/bench_generation.ts deepseek-ml4judge 1
node --env-file=.env evaluation/bench_generation.ts deepseek 1 followup
node --env-file=.env evaluation/bench_generation.ts deepseek 1 suggestions
python3 evaluation/bench_soutien.py --profiles ml4-none glm-low
node --env-file=.env evaluation/bench_vision.ts run
python3 evaluation/bench_tps.py
```

Le numéro de passage distingue les essais de génération. Une sortie existante est protégée.
Les bancs de soutien et de vision reprennent leurs résultats privés sauvegardés, sans refaire
les appels terminés. Une nouvelle mesure complète exige un nouveau dossier de résultats
privés. Les scripts Python utilisent le magasin de certificats de `certifi`.

Le débit calculé sur la requête entière inclut l'attente réseau et le traitement du prompt.
`bench_tps.py` récupère aussi le débit calculé à partir du temps de génération déclaré par
OpenRouter, avec le fournisseur et la couverture de l'échantillon. Les tokens de raisonnement
et les différences de tokenisation empêchent d'assimiler ce débit à une vitesse de lecture.

« Répond » et « bonne source » mesurent la chaîne existante, pas une annotation indépendante
de la justesse des réponses. Les dépassements du délai du juge sont comptés séparément. Les
suggestions portent sur un seul passage par source pour une comparaison à entrées égales.
Les reformulations sont testées seules, sans mesurer la recherche qui suit. Les sondes
interrompues sont signalées comme telles et ne valent pas un passage complet.
