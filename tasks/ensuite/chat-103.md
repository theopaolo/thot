---
title: CHAT-103 Ne pas bloquer le chat sur les questions proches d'un refus
status: not_started
scope: [eleve]
type: [bug]
---

## Notes

Trois défauts du chat, lus dans le code.

- Après un refus, `ideesPour()` dans `src/app/routes/chat.ts` attend le reclasseur sans signal
  d'arrêt. Sa seule borne est le délai de 90 s du fournisseur, essayé deux fois. La page du chat
  et l'événement SSE de la réponse attendent ce calcul : quand OpenRouter ne répond pas, `GET
  /eleve/chat` reste bloqué jusqu'à trois minutes. `questionsProches()` rend ensuite une liste
  vide pour une panne, et cette liste vide est gardée en mémoire sous l'identifiant de l'échange.
  Le refus n'affiche donc plus « Ce que ton cours couvre » jusqu'au redémarrage. La liste des
  candidates n'a pas de borne non plus.
- `relancer()` dans `src/app/conversations.ts` remet à zéro le résultat, les tentatives et le
  journal, mais garde l'avis. Un élève qui a marqué une réponse « Fausse » puis clique
  « Réessayer » voit la nouvelle réponse déjà marquée fausse, et `/prof/questions` la range en
  tête.
- Un envoi rejoué avec la même clé rend le premier échange sans comparer le texte. Le formulaire
  de question rapide d'une page de thème porte une clé fixée au rendu (`cleEnvoi()` dans
  `src/app/vues/eleve.ts`). L'élève qui envoie une question, revient en arrière et en envoie une
  autre est renvoyé vers la première conversation, et sa seconde question n'est pas enregistrée.
  À confirmer dans un navigateur.

## Travail

- [ ] les questions proches se calculent avec un délai court, et une panne n'est pas gardée en
      mémoire
- [ ] le nombre de candidates envoyées au reclasseur est borné
- [ ] relancer une réponse efface son avis
- [ ] une clé rejouée avec un autre texte crée un nouvel échange, et le formulaire tire une
      nouvelle clé au retour sur la page (`pageshow`)

## Terminé quand

- [ ] un test : un reclasseur qui ne répond pas ne retarde pas la page de plus du délai choisi
- [ ] un test : après « Réessayer », l'échange n'a plus d'avis
- [ ] un test : la même clé avec un autre texte donne deux échanges
