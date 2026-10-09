---
title: INST-101 Isolate and provision each Thot deployment
status: done
scope: [ops, configuration]
type: [feature]
---

## Outcome

An operator provisions a school, department or personal Thot from the same release. Each owns its
data and processing policy. Subject boundaries inside an instance are handled by DOM-101.

## Backend and operations

- [x] Define a minimal instance identity and shared/personal operating mode. Keep deployment
  settings separate from educational settings stored in the database.
- [x] Isolate database, content, revisions, generated assets, temporary extraction, jobs, caches,
  session secrets and backups. Give each deployment its own origin and persistent volume.
- [x] Keep cookies scoped to their instance. Bootstrap an administrator through the operator CLI
  with a one-time credential and a recovery path. Never expose an unauthenticated setup screen on
  an already initialised instance.
- [x] Preserve the existing environment identifier as a compatibility input during migration.
  Changing a display name must not move data or create a new instance identity.
- [x] Document provisioning, upgrades, resource limits and restore per instance. A Docker volume
  alone is not a process isolation or backup policy. State what the chosen deployment isolates.
- [x] Expose provider availability and processing location as explicit operator-supplied settings.
  A local inference option can be added only when it is supported and measured.

## Interface

Show the instance name consistently in the application shell and sign-in screen. A personal
instance opens on the learner's materials and conversations. Administration remains accessible
to its owner without exposing classroom management as the primary workflow.

## Code touchpoints

[Configuration](../../src/app/config.ts), [database lifecycle](../../src/app/db.ts),
[accounts](../../src/app/comptes.ts), [CLI](../../src/cli.ts), [process startup](../../src/main.ts),
[Docker image](../../Dockerfile), [environment example](../../.env.example),
[application shell](../../src/app/vues/page.ts), [operations](../../docs/exploitation.md).

## Acceptance

- [x] Start two deployments with synthetic overlapping document titles and account identifiers.
  A session, document URL or cache entry from one cannot disclose data from the other.
- [x] Restore one deployment while the other remains unaffected.
- [x] Existing pilot data and login behaviour survive the migration.
- [x] A fresh personal instance can be configured without a school or a cohort.

## Delivered

The CLI provisions an explicit administrator and persists the instance name and shared/personal
mode. Administrator bootstrap and recovery codes work once, then require a password change.
Ordinary pilot teacher and learner accounts retain their existing behaviour. Upgrading requires
users to sign in again because session cookies now carry the instance identity.

A personal owner lands on materials and questions, can manage documents and inspect administration,
and can upload without a class. Existing review and publication rules still apply. Subject profiles,
fine-grained permissions and conversion of a populated instance belong to DOM-101, ACC-101 and
CFG-101. Source revision storage belongs to ING-006, no revision feature is introduced here.

Application data, model caches, temporary files and evaluation reports stay in the deployment's
data directory. The operations guide covers separate origins, volumes, process limits, cold backups
and restore. Provider switches and declared processing locations are operator settings. No local
inference support is claimed.

## Verification

- `deno task check`: 45 passed, no failures. The existing optional test against the external pilot
  PDFs is skipped because that corpus is absent from this worktree.
- `tests/instance_test.ts` starts two actual server/worker deployments with matching account IDs,
  login names, document titles and model-cache keys. Passwords, copied sessions and document URLs
  do not cross the boundary. Restoring one deployment preserves its identity and content while
  the other remains available.
- Migration from the previous pilot schema preserves sources, passwords, message history and
  caches. Repeated migrations and display-name changes preserve identity. Existing teachers gain
  administrator authority only through explicit CLI promotion.
- Personal bootstrap, one-time-code consumption, forced password replacement, recovery, ordinary
  teacher denial of administration and upload without a class are tested. Mode configuration is
  observed by an already-started empty application. HTTPS cookies and proxy form origins are tested.
- Helium screenshots cover sign-in, password replacement, personal home, administration, document
  management and optional-class upload. Desktop and mobile layouts, the collapsed navigation and
  browser console were checked.
- Diff reviewed. Corrected temporary-directory side effects, stale mode reads, proxy CSRF handling,
  password-screen navigation and instance-name overflow in the collapsed rail.

No acceptance criterion remains unmet in the native deployment checks. Docker image construction,
container resource enforcement, live-provider routing and migration of the live pilot volume were
not exercised. The Docker daemon is unavailable, and production data was left untouched.

Next eligible implementation task: DOM-101, whose only prerequisite is INST-101.
