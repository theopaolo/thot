---
title: EVAL-103 Validate new subjects formats and teaching workflows
status: not_started
scope: [evaluation, qualite, design]
type: [test]
---

## Begin before implementation

Collect small authorised or synthetic samples for arts/physics, design/philosophy, REAPER,
judicial training and sociology/anthropology. Include teacher-only material, personal material,
outdated versions and questions without sufficient evidence. Use these to define acceptance for
the linked implementation tasks rather than claiming generality from the arts benchmark alone.

## Evaluation sets

| Area | Representative checks | Evidence to retain |
| --- | --- | --- |
| Extraction | Text order, tables, slides, notes, images, equations, corrupt files | Expected blocks, locators, warnings and citation invariants |
| Retrieval | Each subject, cross-subject pairs, unequal corpus sizes, vocabulary mismatch | Recall of expected sources, coverage per selected subject, irrelevant results |
| Answers | Factual claims, comparison, disagreement, procedures, absent evidence | Exact citations, support judgments, attribution, correct refusals and partials |
| Transcription | Terminology, accents, silence, mixed speech/music, long clips | Word errors, important-term errors, segment timing and review effort |
| Isolation | Two instances and all in-instance actor relationships | Denied reads/writes, job publication after revocation, protected derivatives |
| Conversations | Concurrent threads, reload, cancellation, retries, worker restart | No history leakage, durable completion, attempt accounting |
| Rendering | Rich tables, hostile markup, diagrams, notation, media failures | Safe output, accessible fallback, desktop/mobile captures |
| Operations | Batch import, long media beside chat, migration and restore | Queue latency, processing time, memory/disk use and recoverability |

## Work

- [ ] Preserve existing benchmark inputs and results. Add distinct datasets and reports so changes
  cannot rewrite the pilot's reference measurements.
- [ ] Annotate evidence and acceptable interpretations with subject teachers. Include hard
  negatives: unsupported causal links, swapped authors, obsolete software versions, missing legal
  applicability and automatic transcripts containing a wrong technical term.
- [ ] Set per-activity release thresholds after measuring the baseline and teacher tolerance.
  Agree a release budget for answer latency, failed jobs and review burden before launch. Report
  sample size and uncertainty rather than declaring universal accuracy from a few examples.
- [ ] Recalibrate retrieval/refusal thresholds per evaluated corpus or profile where the evidence
  supports doing so. Validate cross-language retrieval separately from same-language retrieval.
- [ ] Add deterministic fixture tests for trust boundaries and new non-trivial behaviour. Use the
  existing fake-model approach for unit/integration tests. Live model calls belong in evaluation.
- [ ] Include malicious document instructions and generated markup in tests. Retrieved material
  cannot expand permissions, trigger remote uploads or alter rendering policy.
- [ ] Run the project's required check command for implementation changes. Perform targeted
  migration and browser checks when the affected tasks require them.
- [ ] Inspect shipped UI using Helium screenshots through chrome-devtools MCP, at desktop and
  mobile widths. Include keyboard, focus, captions and long-content behaviour. Validate supported
  mobile browser playback separately where Chromium cannot establish codec compatibility.

## Code touchpoints

[Evaluation guidance](../../evaluation/README.md), [test helpers](../../tests/outils.ts),
[application tests](../../tests/app_test.ts), [view tests](../../tests/vues_test.ts),
[extraction tests](../../tests/extraction_test.ts), [project checks](../../deno.json).

## Acceptance

- [ ] Each enabled subject/activity has an evaluation report against its agreed thresholds.
- [ ] Access isolation, citation location and unsafe rendering tests have no known failures.
- [ ] Quality reports distinguish retrieval coverage from answer correctness and source freshness.
- [ ] Parser/provider decisions point to their measured corpus and operating limitations.
- [ ] The existing arts pilot remains a regression case throughout the rollout.
