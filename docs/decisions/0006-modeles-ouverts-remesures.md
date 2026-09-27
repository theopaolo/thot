# 0006. Remplacer la génération et les légendes par des modèles ouverts plus récents

Date: 26/09/2026  
Statut: accepté, remplace les lignes « Légende d'image » et « Génération courante » de 0001

## Décision

| Tâche | Avant | Après |
|---|---|---|
| Génération, reformulation, questions suggérées | `openai/gpt-oss-120b` | `deepseek/deepseek-v4.1-flash`, raisonnement coupé |
| Légende d'image | `qwen/qwen3-vl-8b-instruct` | `google/gemma-4-26b-a4b-it` |
| Juge de soutien | aucun | `zai-glm-5-3` par l'API Mistral, relève `z-ai/glm-5.3` par OpenRouter |
| Reclassement | `qwen/qwen3-reranker-8b` | inchangé |

Critères : poids ouverts, plusieurs hébergeurs à conservation nulle sur OpenRouter, et une
taille qu'un hébergement OVH ou Scaleway pourra porter après le pilote.

## Mesures

Génération, 35 questions, citations jugées par GLM 5.3 :

| modèle | répond | pièges répondus | médiane | phrases non soutenues |
|---|---|---|---|---|
| gpt-oss-120b | 0,90 | 1/15 | 1,2 s | 39/79 |
| deepseek-v4.1-flash, effort `none` | 0,85 | 0/15 | 1,7 s | 11/78 |

gpt-oss ajoute aux phrases ce que la citation ne dit pas. DeepSeek recopie le cours de près,
coûte moins cher par token et a une vingtaine d'hébergeurs ZDR. Il répond à une question de
moins sur vingt. Les questions suggérées gardées restent au même niveau (42 contre 40 sur
douze sources).

Légendes des 181 images, recherche sur les familles visuelles E et F (14 requêtes chacune),
succès@5 après reclassement :

| modèle | E | F | 59 requêtes | noms hors titre | hors 40-70 mots | hébergeurs ZDR |
|---|---|---|---|---|---|---|
| aucune légende | 0,29 | 0,29 | 0,58 | | | |
| qwen3-vl-8b-instruct | 0,71 | 0,79 | 0,86 | 5 | 7 | 1 |
| gemma-4-26b-a4b-it | 1,00 | 0,86 | 0,95 | 1 | 1 | 12 |
| deepseek-v4.1-flash | 0,93 | 0,86 | 0,93 | 3 | 8 | 22 |
| qwen3.5-9b | 0,93 | 0,93 | 0,93 | 11 | 168 | 5 |

Gemma 4 26B garde 1,00 / 0,86 / 0,95 sur un second passage. Deux passages de Qwen3 VL 8B
s'écartent de trois requêtes : sous deux requêtes d'écart, les modèles se valent. Gemma
l'emporte sur la consigne : aucune date inventée, longueur tenue, équivalent courant donné
entre parenthèses pour chaque terme technique. Sur un échantillon relu à l'œil, DeepSeek
invente un texte cyrillique entre guillemets, Qwen3 VL 8B décrit une façade de grès comme du
bois et ajoute un chapeau qui n'existe pas. Gemma 4 26B n'active que 4 milliards de paramètres,
le plus simple à héberger soi-même.

Juge de soutien, 103 paires annotées (70 sorties réelles de gpt-oss, dont 30 non soutenues,
et 33 négatifs écrits à la main), seuil 0,5 :

| juge | bonnes rejetées | erreurs réelles attrapées | médiane |
|---|---|---|---|
| glm-5.3, raisonnement bref, titre de l'extrait | 4/40 | 30/30 | 1 s |
| gpt-oss-120b, raisonnement bref, titre | 5/40 | 26/30 | 400 ms |
| deepseek-v4.1-flash, logprobs sans raisonnement | 5/40 | 24/30 | 640 ms |
| qwen3-235b-a22b-2507, logprobs sans raisonnement | 2/40 | 17/30 | 580 ms |

Le titre de l'extrait compte plus que le modèle : sans lui, GLM 5.3 rejette 12 bonnes phrases
sur 40, parce qu'une citation nomme rarement le mouvement dont elle parle. Qwen3 235B laisse
passer 13 erreurs sur 30 et OpenRouter le limite à 18 requêtes par minute. Douze annotations ont
été corrigées après lecture des verdicts de GLM, selon la règle écrite dans
`evaluation/README.md` : la correction peut favoriser ce juge.

Servi par Mistral, le juge répond en 307 ms de médiane (AUC 0,955, 3 bonnes phrases rejetées
sur 40, 2 paires fausses acceptées sur 63). Laissé au tri `throughput`, OpenRouter l'envoyait
chez Modal : 1 s de médiane et 10 s au pire pour cinq appels parallèles. Une affirmation refusée
relance la génération, ce qui double son temps. Un appel du juge au-delà de 4 s laisse passer
l'affirmation. Deux hébergeurs sur quarante appels ne rendent pas de logprobs : le verdict
écrit vaut alors 1 ou 0.

Modèles de l'API Mistral (27/09), même banc, juge branché pendant la génération :

| génération | répond | bonne source | réparées | partielles | pannes | médiane |
|---|---|---|---|---|---|---|
| deepseek-v4.1-flash | 0,85 | 0,85 | 0,45 | 0,15 | 0 | 3,6 s |
| mistral-medium-3.5 | 0,80 | 0,75 | 0,65 | 0,35 | 0 | 4,7 s |
| mistral-small-2603 | 0,75 | 0,75 | 0,95 | 0,60 | 0,20 | 5,0 s |
| mistral-large-2512 | 0,80 | 0,75 | 0,90 | 0,65 | 0,10 | 8,7 s |

Les modèles Mistral écrivent des phrases que leurs citations ne prouvent pas : le juge en renvoie
presque toutes en réparation, et une panne `CITATION_UNVERIFIED` laisse l'élève sans réponse.
En légende, Mistral Large 2512 atteint 0,93 / 0,86 / 0,92 et Medium 3.5 0,93 / 0,79 / 0,88,
sous Gemma 4 26B. Comme juge, GLM 5.3 appelé directement chez Mistral donne l'AUC la plus haute
mesurée (0,974, 277 ms). Les modèles Mistral ne rendent pas de logprobs : Medium 3.5 rejette 5
bonnes phrases sur 40, Large laisse passer 19 % des paires fausses.

Le juge passe d'abord par l'API Mistral : meilleure AUC mesurée et aucune erreur sur plus de
300 appels, mais un seul hébergeur et 100 requêtes par minute. Une erreur, un 429 ou plus de
2,5 s d'attente passent la main à OpenRouter. D'un passage à l'autre, le juge change d'avis sur
quelques paires limites : AUC entre 0,954 et 0,974, 3 à 5 bonnes phrases rejetées sur 40.

Le 27/09, les annotations admettent le sujet donné par le paragraphe autour de la citation,
celui que le panneau source montre à l'élève (43 sorties soutenues, 27 non). Trois consignes de
juge, trois passages chacune :

| juge | bonnes rejetées /43 | erreurs réelles attrapées /27 | paires qui changent d'avis |
|---|---|---|---|
| titre seul (retenu) | 6 à 9 | 25 à 26 | 3 |
| titre et paragraphe | 6 à 10 | 24 à 26 | 10 |
| paragraphe, citation entre crochets | 0 | 16 à 19 | 8 |

Avec le paragraphe, le juge accepte des faits présents seulement autour de la citation, et même
« déshumanisation du prolétariat » que le cours ne dit nulle part. Le juge garde le titre seul.

La consigne de génération demande depuis un fait par affirmation, tiré d'un seul extrait, et une
citation qui nomme son sujet quand c'est possible. Sur les 35 questions, avec DeepSeek :

| consigne | répond | bonne source | réparées | partielles | médiane |
|---|---|---|---|---|---|
| avant | 0,85 | 0,85 | 0,45 | 0,15 | 3,6 s |
| après | 0,75 | 0,75 | 0,25 | 0 | 2,8 s |

Les deux questions perdues (G13, G17) sont des refus du modèle sur des extraits minces : des
titres d'images et des listes de noms. La réponse perdue sur G13 était fausse, celle sur G17
juste.

Les synthèses Pearltrees marquent leurs parties en gras (« Les Fauves — libérer la couleur »).
L'extracteur en fait des sections depuis le 27/09 : le titre d'un extrait nomme alors le
mouvement, que la citation désigne souvent par « ils ». Sur les 20 questions rejouées, les
réponses réparées passent de 8 à 3 et les phrases refusées de 11 sur 90 à 5 sur 80. La recherche
ne bouge pas (succès@5 0,90 avant et après avec le reclasseur).

La réparation reste : une affirmation refusée repart une fois au générateur avant d'être
retirée.

## Choix écartés

- Voyage rerank-2.5-lite : poids fermés, aucun hébergeur à conservation nulle.
- GLM 5.3 Flash : raisonnement imposé chez certains hébergeurs, 3,4 s par réponse, 20 phrases
  non soutenues sur 81. En légende, le passage n'a pas abouti en vingt minutes.
- MiMo V2.6 Pro : 14,7 s par réponse, deux pannes, un seul hébergeur ZDR.
- Mistral Small 3.2 : 173 légendes sur 181 hors longueur, 16 noms propres hors titre.
- Qwen3.5 122B en génération : 0,85 de réponses mais 0,75 de bonne source contre 0,85, et plus
  lent que DeepSeek.
- Qwen3.6 35B et Qwen3.5 9B en légende : dates et noms inventés (6 et 11 à 13 légendes).

## Limites

Un seul hébergeur ZDR sert `qwen3-reranker-8b` (Fireworks) : un 503 a interrompu une mesure.
Les annotations de soutien
sont d'un seul annotateur. Les fichiers de légendes et de paires sont dans
`../mesures/thot-real/`.
