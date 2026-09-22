# 0005. Confirmer les vues `hono/html` après comparaison des prototypes

Date: 12/09/2026  
Statut: accepté, application lors de la migration  
Portée: rendu des interfaces professeur et élève, composition des vues et vérification

## Décision

Thot conserve Hono + `hono/html` + HTMX pour les interfaces du pilote.
Les vues sont des fonctions TypeScript aux paramètres typés. Elles
composent des gabarits `html` et reçoivent un objet lorsque des paramètres
nommés rendent l'appel plus lisible. JSX et SvelteKit ne sont pas retenus
pour ces interfaces.

Cette décision confirme et précise le choix de rendu de l'[ADR
0003](0003-application-deno-hono-htmx.md). Deno, SQLite, le worker séparé
et la frontière entre `core/` et `app/` de l'[ADR
0004](0004-monolithe-modulaire-core-app.md) restent inchangés. L'acceptation
du choix ne signifie pas que la migration applicative est terminée.

## Contexte et banc d'essai

Trois prototypes sont conservés dans le dépôt de recherche, `mesures/benchmark-ui/` :

- [Hono avec gabarits HTML](../../../mesures/benchmark-ui/hono/vues.ts).
- [Hono avec vues JSX](../../../mesures/benchmark-ui/hono-jsx/vues.tsx).
- [SvelteKit](../../../mesures/benchmark-ui/sveltekit/).

Ils utilisent le même store en mémoire et la même feuille de style. Ils
couvrent la validation de fiches, la révision par cartes et le chat avec
progression SSE, réponse publiée en une fois et panneau de sources.
Ces parcours correspondent aux interactions prévues dans les maquettes.

Le [rapport du benchmark](../../../mesures/benchmark-ui/RAPPORT.md) contient les
commandes de lancement, les mesures et les scénarios vérifiés dans Helium.
Il rapporte les trois parcours pour Hono HTML et SvelteKit, puis la
validation et le chat pour la variante JSX. Les vérifications statiques
des prototypes Hono et SvelteKit passent. Le build SvelteKit passe aussi.

### Mesures retenues

| Mesure rapportée | Hono HTML + HTMX | SvelteKit |
| --- | --- | --- |
| Lignes applicatives, trois parcours | 135 | 193 |
| Fichiers comptés | 3 | 13 |
| Build frontend | aucun | Vite, 2,8 s sur le banc |
| JavaScript navigateur, gzip | HTMX 16 Ko + extension SSE 2 Ko | 35 Ko avant le chat |

| Mesure rapportée | `hono/html` | `hono/jsx` |
| --- | --- | --- |
| Lignes de vues | 82 | 101 |
| Lignes de routes | 53 | 54 |
| Lignes de configuration | 4 | 11 |

Les comptes excluent le store et le CSS partagés. Ils décrivent ces
implémentations, avec leur formatage, et ne mesurent pas la maintenabilité.
Les tailles de JavaScript n'ont pas été relevées sur un parcours complet
identique. La durée du build ne mesure pas la latence pour l'utilisateur.

Le benchmark montre que les mises à jour partielles et le chat prévu
tiennent dans Hono et HTMX sans gestion d'état client étendue. Il ne
démontre ni une supériorité générale de Hono ni une fiabilité de production.
Le store est en mémoire, les latences sont simulées et les prototypes
n'exercent pas SQLite, les sessions, le worker ou les vrais modèles.

## Comparaison des options

### `hono/html`, retenu

Les gabarits gardent la syntaxe HTML et les attributs HTMX tels qu'ils
apparaissent dans sa documentation. Une fonction peut en appeler une
autre, recevoir des données typées et être réutilisée dans une page ou
un fragment. Par exemple, `liste({ fiches, actif: n?.id })` donne des
paramètres nommés sans syntaxe JSX ni abstraction supplémentaire.

Les interpolations échappent les textes. `raw()` reste réservé à du HTML
de confiance ou assaini selon l'ADR 0003. Les types TypeScript vérifient
les appels de fonctions, mais pas le balisage contenu dans les gabarits.

### `hono/jsx`, non retenu

La variante garde les mêmes parcours HTTP et HTMX. Elle rend du HTML
côté serveur sans imposer React, une hydratation ou un bundler frontend.
Elle ajoute une syntaxe de composants, la vérification des balises
équilibrées et des props, ainsi que des types pour certains attributs
HTML connus.

Les fautes introduites dans le benchmark donnent les résultats suivants :

| Faute | `hono/html` | `hono/jsx` |
| --- | --- | --- |
| Ouverture `<sumary>`, fermeture `</summary>` | non détectée | détectée |
| `<sumary>…</sumary>` | non détectée | non détectée |
| Attributs `typ="text"` et `nam="titre"` sur un input | non détectés | non détectés |
| `hx-taget="#detail"` | non détecté | non détecté |
| Prop `fich` au lieu de `fiche` sur `Detail` | appel différent, fonction typée | détectée |

Les types JSX de Hono acceptent des balises et attributs inconnus. Le
gain de vérification est donc partiel. Aucun des deux rendus ne vérifie
qu'un sélecteur HTMX désigne la bonne zone après un remplacement.

JSX demande aussi une variante d'écriture pour les événements, par
exemple `hx-on-htmx-after-swap` au lieu de `hx-on::after-swap`. Le doctype
via `raw()` et le CSS inline via `dangerouslySetInnerHTML` restent des
détails du layout. Ils ne motivent pas à eux seuls le rejet de JSX.
À fonctionnalités égales, la lecture du HTML direct est préférée et les
garanties supplémentaires de JSX ne justifient pas le changement.

### SvelteKit, non retenu

SvelteKit apporte une vérification des gabarits, des données transmises
par `load` et une gestion du cycle de vie et de l'état client. Dans le
prototype, ces mécanismes demandent davantage de fichiers et de code pour
les parcours exercés, notamment pour le flux SSE. Ce coût dépend aussi
des choix d'implémentation, il n'est pas une limite intrinsèque de Svelte.

Le pilote reste connecté au serveur. Ses réponses de chat sont publiées
après vérification, en un seul fragment. Les interactions locales
observées ne suffisent pas à justifier SvelteKit pour l'ensemble de l'app.

## Outillage et vérification

`deno check` reste le contrôle des types. Les diagnostics rouges d'un
éditeur sur un prototype qui passe cette commande doivent être examinés
comme un problème d'outillage possible. Ils ne départagent pas les rendus.
L'activation Deno doit être adaptée au dossier et à son `deno.json`.
La coloration des gabarits `html` peut être fournie par lit-html.

La coloration, l'autocomplétion et le lint sont des garanties distinctes.
Un outil HTML/HTMX existant pourra être retenu après vérification de sa
prise en charge des gabarits dans les fichiers `.ts`. Aucun linter maison
ni contrôle HTMX complet n'est supposé disponible dans cette décision.

Les vérifications de migration doivent couvrir les limites que le banc
ne résout pas :

- Remplacer la bonne zone et conserver des identifiants DOM uniques,
  notamment lors des ouvertures successives du panneau source.
- Maintenir la sélection de la liste en accord avec la fiche affichée.
- Conserver brouillon et focus sur échec, y compris lors d'une vraie
  coupure réseau. Le bouton de panne du banc provoque une erreur serveur
  après un délai, ce qui ne reproduit pas une perte de connexion.
- Reconnecter le flux SSE sans générer ou enregistrer une seconde réponse
  et signaler une interruption sans laisser une attente permanente.
- Éviter les doubles soumissions et préserver le défilement lorsque
  l'utilisateur consulte des messages précédents.

Ces contrôles portent sur les parcours et les contrats de fragments.
Changer la syntaxe des vues ne les remplace pas.

## Conséquences et réexamen

Les interfaces utilisent une seule convention de rendu serveur. Les
interactions locales restent du JavaScript ciblé ou des éléments HTML
natifs. Les prototypes restent des références de comparaison, sans devenir
trois interfaces à maintenir pour le produit.

Le choix pourra être réexaminé si un besoin réel de synchronisation hors
ligne, d'édition riche ou d'état client coordonné rend cette approche
plus coûteuse à maintenir. Une répétition d'erreurs de balisage malgré
l'outillage et les contrôles pourra justifier de revoir le moteur de vues.
Le réexamen portera sur la difficulté constatée, sans rouvrir par défaut
les choix de runtime, de stockage ou de moteur RAG.
