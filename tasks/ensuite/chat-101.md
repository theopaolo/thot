---
title: CHAT-101 Give conversations independent history and scope
status: in_progress
scope: [chat, backend, frontend]
type: [feature]
---

## Depends on

- [[dom-101]]
- [[acc-102]]
- [[ing-006]]
- [[ux-201]]

## Backend

- [x] Add conversation identity, owner, title, selected course/subject scope, activity and archive
  state. Associate each message with its conversation and preserve turn order explicitly.
- [x] Migrate old exchanges into clearly named legacy conversations per account and prior scope.
  Preserve message identifiers, existing citations and retention semantics. Do not invent earlier
  topic boundaries where the stored history provides none.
- [x] Restrict history, follow-up reformulation and any later summaries to the current conversation.
  Bound model context. Give user text and retrieved documents data roles, not authority to change
  permissions or system instructions.
- [x] Store the scope used for each turn. Changing scope affects later turns and rechecks access
  to carried context. Earlier restricted content cannot leak into a broader conversation.
- [ ] Make create, rename, archive, delete, retry and citation endpoints owner-aware. Apply course
  review permissions only to the intended learner exchanges. Delete remains, with SRC-002. The
  other endpoints answer 404 to another account.
- [x] Support an idempotent send and a clear policy of one active response per conversation at
  first. Different conversations may run concurrently once JOB-103 ships.

## Interface

Conversations brief, following UX-201's design handoff acceptance. This task implements the first
delivery: one active conversation pane with a conversation list, new, rename, archive,
per-conversation scope and draft. [JOB-103](job-103.md) adds replies that finish in the
background. Side-by-side viewing comes after both.

Main action: continue one line of inquiry, or start another, without losing the first.

### Place and addresses

The learner navigation keeps « Poser une question ». It opens `/eleve/chat`, which shows the most
recently active conversation. Each conversation has its own address, `/eleve/chat/{id}`, so
refresh, back and forward restore it. `/eleve/chat/nouvelle` is a new conversation not yet stored.
Conversations have no share link.

### Composition

From 1400 px, three columns:

1. The conversation list, 16rem, a `<nav aria-label="Conversations">` on the surface background
   with a rule on its right, like the source column. « Nouvelle conversation » comes first.
   Each conversation is one link: its title on up to two lines, its scope on one discreet line, its
   last activity (« 14 h 02 », « hier », « 12 oct. ») and a status word when there is one. The open
   conversation has `aria-current="page"` and the yellow left mark used for the current place.
2. The open conversation in the existing `.chat-principal` column, 48rem at most. A header holds
   the title as `h1`, then « Renommer » and « Archiver » as `.lien` buttons. The turns follow, then
   the scope line, then the composer.
3. The existing source column, narrowed to `minmax(24rem, 34%)`.

Below 1400 px the list leaves the grid and lives on its own page, `/eleve/conversations`, with the
same items. The conversation header starts with a « Conversations » link to it and « Nouvelle ».
A link and a page work without JavaScript, so there is no toggle widget. From 1180 to 1399 px
answer and source stay side by side as today. Below 1180 px, including 390 px, one column, and
sources open in the existing bottom sheet.

### Turns

Question and answer markup stays as in `src/app/vues/eleve.ts` (`question`, `attente`,
`reponse`). A scope change adds a discreet divider between turns: « Périmètre changé : Arts
appliqués / STD2A / Bauhaus ».

### Scope line

Above the composer: « Dans : {matière} / {cours} / {thème} », or « Dans : toutes tes ressources »
without a scope, followed by « Changer ». « Changer » opens an inline form with the three selects
of the library filter (`filtre()` in `src/app/vues/domaines.ts`), limited to what the learner can
read, and the button « Appliquer aux prochaines questions ». The change applies to later turns
only. The topic select uses the grouping label from CFG-101.

### Composer and draft

The composer stays as today: label « Ta question », textarea, « Envoyer », Enter sends, Shift+Enter
adds a line, and the line « Les enseignants de tes cours lisent tes questions. » under it. Its draft
is kept per conversation in `sessionStorage`, keyed by account and conversation, and cleared on
send and on logout. `sessionStorage` survives refresh and back/forward in the same tab and goes
away with the tab, which suits shared school computers.

### Actions

- New: « Nouvelle conversation » opens `/eleve/chat/nouvelle` with the title « Nouvelle
  conversation », the last used scope and an empty composer, with suggested questions under it as
  on today's empty chat. The first question sent creates the conversation, titles it with that
  question cut at 80 characters on a word boundary, and replaces the address with
  `/eleve/chat/{id}`. No empty conversation is stored.
- Questions asked elsewhere: a question from the learner home, a topic page, a source (« Poser une
  question dessus ») or « Le saviez-vous ? » starts a new conversation with that page's scope. The
  « Pour continuer » suggestions under an answer continue the open conversation.
- Rename: « Renommer » replaces the `h1` with an inline form: « Titre de la conversation »,
  « Enregistrer », « Annuler ». Escape cancels. The list item takes the new title. The last save
  wins: a title does not justify a conflict dialog.
- Archive: « Archiver » archives at once, without confirmation, and opens the next most recent
  conversation, or the empty state, with the status « Conversation archivée. » The end of the list links to « Conversations archivées (n) ».

### States

- Empty: no conversation yet. `/eleve/chat` shows the new-conversation view and the list reads
  « Aucune conversation pour l'instant. »
- Waiting and answering: the existing stage line (`.etape`). While this conversation has an
  unfinished reply, « Envoyer » is disabled and reads « Réponse en cours… ». The textarea stays
  editable.
- Status in the list, in text and colour together: « En attente » and « Réponse en cours » in
  `--pending`, « Échec » in `--danger`. After JOB-103, « Nouvelle réponse » marks a reply that
  finished while its conversation was closed, until it is opened. Before JOB-103 a reply starts
  only while its conversation page is open, as today.
- Errors: a network failure keeps the draft and shows the existing `#erreur-reseau` alert. A failed
  reply keeps « Réessayer ». An out-of-course answer keeps its current text.
- Read-only: an archived conversation replaces the scope line and composer with « Cette
  conversation est archivée. » and « Désarchiver ».
- Unavailable scope: the learner left the course or the topic was deleted. The scope line names the
  missing level as the library filter does (« Cours indisponible »), and the composer gives way to « Ce périmètre
  n'est plus disponible. Choisis-en un autre pour continuer. » with the scope form open. Earlier
  answers keep their current evidence check.
- Conflicting edit: sending into a conversation archived in another tab, or a second question while
  a reply runs, returns HTTP 409 and keeps the draft, with « Cette conversation a été archivée dans
  un autre onglet. Ta question est conservée. » or « Une réponse est déjà en cours dans cette
  conversation. »
- Unsaved changes: nothing to confirm. Drafts persist on their own, and leaving a rename form
  discards it.
- Long labels: titles up to 120 characters wrap in full in the header and clamp to two lines in the
  list. Scope names up to 200 characters wrap.
- Many items: the list shows the 50 most recent conversations, then « Afficher les conversations
  précédentes ». A conversation emptied by the retention purge disappears.
- Legacy: conversations created by the migration are titled « Anciennes questions », with their
  prior scope on the scope line.

### Reading position

An update scrolls the conversation only when the reader is within 80 px of its end. Otherwise the
view stays still and the button « Aller à la nouvelle réponse » appears above the composer. It scrolls to the
answer and moves focus to it. The latest answer's first citation opens, as today. This replaces the unconditional scroll of
`suivreConversation()` in `src/app/client/eleve.ts`. Nothing plays automatically.

### Focus

- Choosing a conversation in the list moves focus to its `h1` (`tabindex="-1"`). A new
  conversation focuses the composer from 1180 px only, so phones do not open the keyboard unasked.
- After a send, focus stays in the composer. The existing `aria-live="polite"` on `#conversation`
  announces the answer once.

- Rename focuses the title input with its text selected. Saving or cancelling returns focus to
  « Renommer ».
- Archiving moves focus to the next conversation's `h1` and announces the status.
- Opening the scope form focuses its first select. Applying returns focus to « Changer », and the
  scope line, `aria-live="polite"`, announces the new scope.
- Citation sheets keep their current focus rules.

### Content ranges

Questions 1 to 1000 characters, as today. Titles 1 to 120 characters. From zero to a few hundred
conversations per learner within the retention period. 1 to about 200 turns per conversation.
Answers of up to five claims and 120 words, as the generation prompt sets.

### Labels and teacher side

The labels above use tu. With vous set in CFG-101 they become « Votre question », « Choisissez-en
un autre » and so on. `/prof/questions` keeps listing exchanges one by one, and conversation titles
stay private to the learner.

Later, in this order: search in the list once learners pass 50 conversations, then optional
side-by-side viewing of two conversations with separate composers, scopes and source panels, which
collapses to one pane with a switch below 1180 px. Deleting a conversation follows the deletion
rules of [SRC-002](src-002.md).

## Code touchpoints

[Message routes and history](../../src/app/routes.ts), [chat views](../../src/app/vues/eleve.ts),
[chat client](../../src/app/client/eleve.ts), [retention](../../src/app/db.ts),
[reformulation](../../src/core/modeles.ts), [answer entry](../../src/core/reponse.ts),
[migrations](../../migrations/), [application tests](../../tests/app_test.ts).

## Acceptance

- [x] Alternating questions in two conversations cannot mix previous questions or selected sources.
- [x] Refresh, duplicate submission, rename and archive preserve the correct conversation.
- [x] Switching between two conversations and refreshing keeps each draft.
- [x] An answer arriving while the reader has scrolled up leaves the view in place.
- [x] A second account cannot read a guessed conversation, message or citation identifier.
- [x] Migration retains old source links and the original account ownership.
- [ ] Side-by-side mode is accepted only after keyboard focus, scoped DOM identifiers and mobile
  collapse work without cross-pane updates.
