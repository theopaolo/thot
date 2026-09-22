# 0001. Figer la pile RAG mesurée

Date: 28/08/2026  
Statut: accepté

## Décision

Le MVP utilise les composants suivants.

| Tâche | Composant | Identifiant mesuré | Résultat retenu |
|---|---|---|---|
| Recherche lexicale | SQLite FTS5 racinisé | SQLite | succès@5 0,85, environ 0,1 ms |
| Plongement | Qwen3 Embedding 8B | `qwen/qwen3-embedding-8b` | succès@5 0,98 |
| Reclassement | Qwen3 Reranker 8B | `qwen/qwen3-reranker-8b` | succès@5 0,98, MRR 0,95 |
| Abstention | score du reclasseur | même modèle | AUC 0,952 |
| Légende d'image | Qwen3 VL 8B Instruct | `qwen/qwen3-vl-8b-instruct` | 0,95, 1,4 s par image |
| PDF avec couche texte | `pdftotext` | binaire système | 94 % de structure, 38 ms |
| PDF muet et dense | Qwen3 VL 32B Instruct | `qwen/qwen3-vl-32b-instruct` | 3 881 caractères récupérés |
| Génération courante | GPT OSS 120B | `openai/gpt-oss-120b` | citation 1,00, abstention 0,93 |
| Génération à refus strict | GLM 5.3 Flash | `z-ai/glm-5.3-flash` | fondement 1,00, abstention 1,00 |

Les images Qwen et les poids Qwen sont sous licence Apache 2.0. Les révisions
exactes des poids et leurs checksums devront être ajoutés à la configuration de
production après la mesure sur le matériel cible.

## Chaîne retenue

```text
FTS5 top 20 + dense top 20
            |
            v
       fusion RRF
            |
            v
Qwen3 Reranker 8B sur les 20 candidats
            |
     +------+------+
     |             |
 score bas      score haut
 abstention     top 5 vers génération
                      |
                      v
             vérification des claims
```

RRF reste dans la première version pour préserver les correspondances exactes
de FTS5. L'évaluation doit aussi publier le résultat du bras dense seul. Si
FTS5 n'améliore aucun résultat après reclassement sur le corpus du pilote, RRF
et le bras lexical sortent du chemin principal.

## Choix écartés

- La route « contexte complet » coûte 29 fois plus de tokens et 16 fois plus de
  latence pour une qualité au mieux égale.
- `mistral-embed` obtient 0,81 contre 0,98 pour Qwen3 Embedding 8B. Son cosinus
  a une AUC d'abstention de 0,452.
- L'index approximatif n'est pas utile avant une croissance mesurée du corpus.
- L'OCR systématique perd de la structure sur les PDF ATC et coûte 40 fois plus
  de temps que `pdftotext`.
- La récupération contextuelle n'ajoute rien à la hiérarchie déjà présente
  dans le corpus pilote.

## Source

Les mesures, protocoles et limites sont dans
`../mesures/thot-real/RAPPORT-3-mesures-completees.md` dans le dépôt de recherche. Les
jeux annotés de `evaluation/` sont la copie conservée pour le produit.

