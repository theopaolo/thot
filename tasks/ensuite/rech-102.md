---
title: RECH-102 Retrieve and compare teaching materials across subjects
status: not_started
scope: [recherche, enseignants, reponse]
type: [feature]
---

## Depends on

- [[dom-101]]
- [[acc-101]]
- [[cfg-101]]
- [[ans-101]]

## Backend

- [ ] Extend retrieval scope from a chapter to authorised course/subject selections. Filter before
  retrieval and ranking. Include subject, course, author and applicable version in evidence context.
- [ ] For an explicit comparison, retrieve candidates for each selected subject and then rerank
  within a bounded total budget. Report missing evidence per subject instead of filling it from
  general model knowledge. A large course must not consume every result slot.
- [ ] Keep ordinary single-scope questions on the simpler search path. Use query reformulation
  or decomposition only where it improves measured cross-subject recall.
- [ ] Evaluate vocabulary mismatches such as industrialisation/industrial labour and colour/light.
  If lexical retrieval misses relevant material, qualify the existing embedding proposal in
  [RET-201](ret-201.md) and its exact-search measurement before adding infrastructure.
- [ ] Preserve author positions, disciplinary differences, jurisdiction and applicable dates.
  Treat contradictory sources as something to explain rather than merge into one answer.
- [ ] Add optional teacher-entered teaching periods, objectives and links to progression documents
  when timing is requested. Distinguish planned, completed and unknown. Documents do not prove
  when a class was taught.
- [ ] Generate findings and teaching proposals through ANS-101. Proposals require teacher review
  before becoming a shared lesson or published learning resource.

## Frontend

Provide course and subject selection near the question composer. Offer a comparison entry point
from the library and selected courses. Results group evidence by subject with precise source
links, followed by proposed connections. Show missing material and scope limits in plain language.

Do not automatically search another instance or silently broaden a learner's selected scope.
No knowledge graph is required for the first comparison workflow.

## Code touchpoints

[Retrieval](../../src/core/recherche.ts), [indexed context](../../src/app/ingestion.ts),
[response verification](../../src/core/reponse.ts), [scope routes](../../src/app/routes.ts),
[teacher views](../../src/app/vues/prof.ts), [conversation views](../../src/app/vues/eleve.ts),
[retrieval evaluation](../../evaluation/README.md).

## Acceptance

- [ ] Physics/art-history and design-history/philosophy examples return relevant evidence from
  both selected subjects and mark unsupported connections as unavailable.
- [ ] A much larger subject cannot crowd out a small selected subject in a comparison.
- [ ] Teacher-only material is usable by authorised colleagues and absent from learner requests.
- [ ] Asking about teaching dates without schedules produces no invented timeline.
- [ ] Cross-subject evaluation measures coverage, relevance, attribution and refusal separately.
