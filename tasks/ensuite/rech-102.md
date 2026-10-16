---
title: RECH-102 Retrieve and compare teaching materials across subjects
status: in_progress
scope: [recherche, enseignants, reponse]
type: [feature]
---

## Depends on

- [[dom-101]]
- [[acc-101]]
- [[cfg-101]]
- [[ans-101]]

## Backend

- [x] Extend retrieval scope from a chapter to authorised course/subject selections. Filter before
  retrieval and ranking. A conversation compares two to four whole subjects. In comparison mode
  only, each extract names its subject.
- [ ] Include course, author and applicable version in evidence context.
- [x] For an explicit comparison, retrieve candidates for each selected subject and then rerank
  within a bounded total budget. Report missing evidence per subject instead of filling it from
  general model knowledge. A large course must not consume every result slot.
  The FTS5 top 20 is split equally across subjects, one rerank orders the union, and the best
  extract above the threshold of each subject keeps one of the five places.
- [x] Keep ordinary single-scope questions on the simpler search path.
- [ ] Use query reformulation or decomposition only where it improves measured cross-subject
  recall. Deferred until the cross-subject evaluation shows a recall gap.
- [ ] Evaluate vocabulary mismatches such as industrialisation/industrial labour and colour/light.
  If lexical retrieval misses relevant material, qualify the existing embedding proposal in
  [RET-201](ret-201.md) and its exact-search measurement before adding infrastructure.
  Deferred: the orchestrator runs the cross-subject evaluation on real corpora.
- [ ] Preserve author positions, disciplinary differences, jurisdiction and applicable dates.
  Treat contradictory sources as something to explain rather than merge into one answer.
  Each claim keeps its source and subject, and a table asserts no relation (ANS-101). Jurisdiction
  and dates are not modelled.
- [ ] Add optional teacher-entered teaching periods, objectives and links to progression documents
  when timing is requested. Distinguish planned, completed and unknown. Documents do not prove
  when a class was taught. Deferred: no schedule data yet.
- [ ] Generate findings and teaching proposals through ANS-101. Proposals require teacher review
  before becoming a shared lesson or published learning resource. Deferred to PED-101.

## Frontend

Provide course and subject selection near the question composer. Offer a comparison entry point
from the library and selected courses. Results group evidence by subject with precise source
links, followed by proposed connections. Show missing material and scope limits in plain language.

Do not automatically search another instance or silently broaden a learner's selected scope.
No knowledge graph is required for the first comparison workflow.

- [x] The chat's « Changer » form lists subjects as checkboxes under « Comparer des matières ». Each
  claim shows its source's subject beside its citation. « Aucun passage trouvé en {matière}. »
  names a subject without evidence.
- [ ] Comparison entry point from the library and selected courses.

## Code touchpoints

[Retrieval](../../src/core/recherche.ts), [indexed context](../../src/app/ingestion.ts),
[response verification](../../src/core/reponse.ts), [scope routes](../../src/app/routes.ts),
[teacher views](../../src/app/vues/prof.ts), [conversation views](../../src/app/vues/eleve.ts),
[retrieval evaluation](../../evaluation/README.md).

## Acceptance

- [ ] Physics/art-history and design-history/philosophy examples return relevant evidence from
  both selected subjects and mark unsupported connections as unavailable. Fixture test only
  (`tests/comparaison_test.ts`), real corpora pending.
- [x] A much larger subject cannot crowd out a small selected subject in a comparison.
- [x] Teacher-only material is usable by authorised colleagues and absent from learner requests.
- [ ] Asking about teaching dates without schedules produces no invented timeline.
- [ ] Cross-subject evaluation measures coverage, relevance, attribution and refusal separately.
