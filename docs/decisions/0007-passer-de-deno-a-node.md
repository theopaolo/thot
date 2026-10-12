# 0007. Passer de Deno à Node.js et Vite+

Date: 12/10/2026  
Statut: accepté. Remplace le runtime et l'outillage de [0003](0003-application-deno-hono-htmx.md).
Hono, `hono/html`, HTMX, SQLite et le worker séparé restent.  
Portée: runtime, outillage, tests, image Docker

## Contexte

Le 9/10/2026, l'équipe Deno rejoint Cloudflare ([annonce](https://deno.com/blog/cloudflare)).
Le runtime reçoit un an de versions mensuelles de correctifs et de sécurité, puis l'équipe arrête
son développement. Le code reste open source. Aucun fork communautaire n'est annoncé. Deno Deploy
ferme dans six mois. JSR continue sur l'infrastructure de Cloudflare.

Thot n'utilise pas Deno Deploy. Le pilote livre une image Docker par établissement, et un
chercheur installe sa propre instance avec la même image. Le runtime doit durer plus longtemps
que le pilote et tourner hors de toute plateforme.

Le code attend du runtime :

- deux processus longs, le serveur Hono et le worker, qui partagent `state.sqlite3` en WAL par
  `node:sqlite`
- des sous-processus `pdftotext` et `prlimit`
- des fichiers locaux : contenu, projections, vecteurs chargés en mémoire (77 Mo en dimension
  4 096)
- un bundle navigateur, des tests, le format, le lint et la vérification des types

Deno fournissait les quatre derniers points avec un seul binaire. Sur Node, il faudrait pnpm, tsc,
esbuild et un outil de format et de lint, chacun avec sa version et sa configuration.

## Décision

Thot passe sur Node.js 26 avec Vite+ et pnpm. Node 26 est LTS du 28/10/2026 au 30/04/2029. Node
exécute le TypeScript sans build en retirant les types, une fonction stable depuis Node 25.2.
`node:sqlite` est en release candidate (stabilité 1.2) depuis Node 25.7.

Vite+ 1.0, publié par VoidZero sous licence MIT, réunit l'outillage derrière la commande `vp`.
Sa configuration tient dans `vite.config.ts`.

| Deno | Node et Vite+ |
|---|---|
| `deno fmt` | `vp check`, Oxfmt |
| `deno lint`, `deno check` | `vp check`, Oxlint et tsgolint (TypeScript 7) |
| `deno test`, `Deno.test` | `vp test`, Vitest. `@std/assert` reste, installé depuis JSR |
| `deno bundle` | `vp build`, Rolldown |
| `deno task` | scripts de `package.json`, lancés par pnpm |
| version de Deno | `devEngines.runtime` pour Node et `packageManager` pour pnpm, dans `package.json`. `vp env` fournit ces versions. pnpm refuse d'installer sous une autre version de Node, image Docker comprise |
| `Deno.serve`, `serveStatic` de `hono/deno` | `@hono/node-server` |
| `Deno.Command` | `node:child_process` |
| `Deno.readTextFile` et voisins | `node:fs` et `node:fs/promises` |
| `Deno.env`, `Deno.args`, `Deno.exit`, `Deno.addSignalListener` | `process` |
| `@std/path`, `parseArgs` de `@std/cli` | `node:path`, `node:url`, `parseArgs` de `node:util` |
| `-RWNE --allow-run=pdftotext,…` | `--permission`, lecture du code et des données, écriture des données, `--allow-net`. Le worker reçoit aussi `--allow-child-process` |

## Essai

L'essai a porté tout le code, les tests et les commandes du README. Mesures sur la même machine,
depuis le commit `a711322` :

| | Deno 2.9.7 | Node 26.11.1 et Vite+ 1.1.0 |
|---|---|---|
| Tests | 81 réussis, 1 ignoré | 81 réussis, 1 ignoré |
| Vérification complète | 19,8 s, tests fichier par fichier | 7,5 s, tests en parallèle |
| `app.js` | 6 168 octets | 6 117 octets |

Le test des PDF du corpus ATC passe avec le dossier `corpus/`. De bout en bout, le worker lance
`pdftotext` sous `--permission` et conduit un PDF réel jusqu'à `awaiting_review`. Le serveur sert
les pages et les fichiers statiques. `SIGTERM` arrête les trois processus, et tuer le worker
arrête le serveur.

L'essai a relevé ces écarts :

- Oxfmt reformate le HTML des gabarits `html\`\``, ce qui change la page servie. Cinq tests ont
  échoué, dont un espace ajouté autour du `<mark>` d'une citation.
  `embeddedLanguageFormatting: "off"` garde les gabarits intacts.
- Le premier passage d'Oxfmt réécrit 38 fichiers (+2 355, −1 795 lignes). Le commit est isolé et
  listé dans `.git-blame-ignore-revs`.
- `Response.json()` rend `unknown` dans les types de Node, `any` dans ceux de Deno. Trois lectures
  de réponses de modèle le déclarent.
- Une requête dont le corps est un flux demande `duplex: "half"` sous Node.
- `snowball-stemmers` n'a pas de types. `src/core/snowball.d.ts` les déclare.
- `env` de `node:child_process` remplace l'environnement du parent, alors que Deno le complétait.
  Les lancements le recopient.
- Sous `--permission`, le serveur ne peut pas lancer de processus et le worker ne peut pas
  écrire hors du dossier de données avec `node:fs`. `node:sqlite` ignore cette limite : une base
  hors du dossier s'ouvre et s'écrit. Deno donnait `-W` sans chemin, l'écriture n'était donc
  pas bornée avant.
- Node 26 marque `--allow-net` comme expérimental et avertit à chaque `--allow-child-process`.
- Les règles typées d'Oxlint donnaient 61 avertissements. Trois règles visaient des usages voulus,
  dont 44 `String(champ)` sur un champ de formulaire qu'Hono type `string | File`.
  `vite.config.ts` les coupe avec leur raison. Les autres avertissements sont corrigés.

L'image se construit en 22 s et n'installe en production que `hono`, `@hono/node-server` et
`snowball`. Lancé avec les options de l'[exploitation](../exploitation.md) (`--cap-drop=ALL`,
`no-new-privileges`), le conteneur extrait un PDF réel sous `prlimit` et `--permission`. Tuer le
worker arrête le conteneur en erreur, et la politique de redémarrage relance l'ensemble.
`docker stop` arrête les trois processus en moins d'une seconde. `main.ts` sort en 0 après un arrêt
demandé, alors que la version Deno sortait en 1 parce que le serveur meurt du signal.

Une base créée par la version Deno s'ouvre sous Node sans migration, garde ses comptes et ses
travaux, et passe `integrity_check`. Un mot de passe créé sous Deno ouvre une session sous Node.
Sur une copie des données du pilote, une question réelle reçoit sa réponse en 3,4 s avec cinq
affirmations citées. Sous `--permission`, un appel réseau sans `--allow-net` est refusé.

## Choix écartés

| Option | Motif |
|---|---|
| Rester sur Deno et attendre un fork | Possible pendant un an. Personne n'a annoncé de fork, et des établissements feront tourner l'image plusieurs années |
| Node avec pnpm, tsc, esbuild et Biome | Viable. Quatre outils, quatre configurations et quatre versions à suivre, là où Vite+ en demande un |
| Cloudflare Workers | Un Worker ne lance pas `pdftotext` et n'a ni système de fichiers ni fichier SQLite partagé entre deux processus. Il faudrait D1 ou des Durable Objects, R2 et Queues. Un isolat dispose de 128 Mo et les vecteurs en occupent 77. L'instance ne s'installerait plus chez un établissement ou un chercheur |
| Fastly Compute | WebAssembly sans système de fichiers, sans sous-processus et sans SQLite |
| celld | Le projet de l'équipe Deno fait tourner des applications Workers sur ses propres machines, avec une base SQLite par Durable Object. En version 0.4, il garde la limite de 128 Mo par isolat, ne documente pas les sous-processus et demande un bucket S3 dès qu'il y a plusieurs nœuds. Thot y serait réécrit en application Workers |
| Bun | Hono et le TypeScript y tournent sans changement. Un seul éditeur le porte, Anthropic depuis décembre 2025. Son SQLite natif est `bun:sqlite`, et le support de `node:sqlite` reste à vérifier |

## Conséquences

- VoidZero est une entreprise financée par du capital-risque, comme Deno l'était. Le risque est
  plus petit : Vite+ assemble des projets MIT séparés, Vitest, Oxlint, Oxfmt et Rolldown. Si
  Vite+ s'arrête, chacun se configure seul, et le runtime reste Node.
- `--allow-run` nommait les exécutables permis. `--allow-child-process` permet tout exécutable.
  Le serveur ne reçoit pas ce droit, et `prlimit` reste la borne mémoire de `pdftotext`.
- `--allow-fs-write` borne `node:fs`, pas `node:sqlite`. Le chemin de la base vient de
  `THOT_DATA_DIR`, fixé par l'opérateur.
- Les sanitizers de `deno test` disparaissent. Un minuteur ou un fichier laissé ouvert par un
  test ne fait plus échouer la suite.
- Vitest isole chaque fichier de test et les lance en parallèle. Un test qui partage un état
  global entre fichiers casse là où Deno passait.
- Node refuse la syntaxe TypeScript qui produit du code. `erasableSyntaxOnly` dans
  `tsconfig.json` la signale.
- `node:sqlite` n'est pas encore marqué stable. Node 26 a renommé `DatabaseSync` en `Database` et
  garde l'ancien nom en alias déprécié. `db.ts` concentre l'accès SQL.
- Passer d'une LTS à la suivante tous les deux ans entre dans l'exploitation.

## Conditions de réexamen

- `node:sqlite` casse une API utilisée sans alias.
- Vite+ cesse d'être maintenu. Les outils qu'il assemble se configurent alors séparément.
- celld ou workerd lance des sous-processus et lève la limite de mémoire par isolat.
