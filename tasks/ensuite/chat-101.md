---
title: CHAT-101 Give conversations independent history and scope
status: not_started
scope: [chat, backend, frontend]
type: [feature]
---

## Depends on

- [[dom-101]]
- [[acc-102]]
- [[ing-006]]
- [[ux-201]]

## Backend

- [ ] Add conversation identity, owner, title, selected course/subject scope, activity and archive
  state. Associate each message with its conversation and preserve turn order explicitly.
- [ ] Migrate old exchanges into clearly named legacy conversations per account and prior scope.
  Preserve message identifiers, existing citations and retention semantics. Do not invent earlier
  topic boundaries where the stored history provides none.
- [ ] Restrict history, follow-up reformulation and any later summaries to the current conversation.
  Bound model context. Give user text and retrieved documents data roles, not authority to change
  permissions or system instructions.
- [ ] Store the scope used for each turn. Changing scope affects later turns and rechecks access
  to carried context. Earlier restricted content cannot leak into a broader conversation.
- [ ] Make create, rename, archive, delete, retry and citation endpoints owner-aware. Apply course
  review permissions only to the intended learner exchanges.
- [ ] Support an idempotent send and a clear policy of one active response per conversation at
  first. Different conversations may run concurrently once JOB-103 ships.

## Frontend

Provide a conversation list, new conversation, rename and archive actions, and a visible processing
indicator. Preserve drafts and scroll positions separately. Browser refresh and back/forward must
restore the selected conversation. Never put private conversations into public share links.

First delivery uses one active conversation pane with background replies. After that passes,
add optional side-by-side viewing of two conversations, with separate composers, scopes and source
panels. On small screens, switch between panes instead of squeezing two unreadable columns.

## Code touchpoints

[Message routes and history](../../src/app/routes.ts), [chat views](../../src/app/vues/eleve.ts),
[chat client](../../src/app/client/eleve.ts), [retention](../../src/app/db.ts),
[reformulation](../../src/core/modeles.ts), [answer entry](../../src/core/reponse.ts),
[migrations](../../migrations/), [application tests](../../tests/app_test.ts).

## Acceptance

- [ ] Alternating questions in two conversations cannot mix previous questions or selected sources.
- [ ] Refresh, duplicate submission, rename and archive preserve the correct conversation.
- [ ] A second account cannot read a guessed conversation, message or citation identifier.
- [ ] Migration retains old source links and the original account ownership.
- [ ] Side-by-side mode is accepted only after keyboard focus, scoped DOM identifiers and mobile
  collapse work without cross-pane updates.
