# Legacy prompt-queue claim state

Updated 2026-10-27 after review of the claim retirement.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Retire the claim read**: replace every `outstandingClaim` reader with one restore-to-head upgrade, then drop the field, the recovery timer and their tests. Status: blocked (on the support window: no Stable release without the claim commands exists yet).
2. **Correct which backends can still write a claim**: the file and the register say v2.21.0 to v2.28.0-beta, but the schema fence narrows it to v2.27.0-beta and v2.28.0-beta. Status: open.

### 1. Retire the claim read

**Problem.** A read path for a field nothing writes any more stays spread across seven backend files and one renderer type. It costs little at run time, but every new queue reader has to remember to treat a claimed prompt as queued.

**Context.** Split out of [0034](0034-mixed-version-compatibility.md) when the claim commands were removed on 2026-10-24. The removal condition is the register row in `docs/architecture/version-compatibility.md:116`: the floor must be at or above the first Stable release without the claim commands. The constraint that the upgrade must never dispatch the prompt directly still holds.

**Investigation.** The readers the file lists all still exist: validation at `apps/backend/src/core/storage-shared-core.ts:782` and `:831`; the dispatch refusal at `apps/backend/src/core/storage-prompts.ts:563`; enqueue dedupe at `storage-prompts.ts:316` and `:384`; web annotations at `apps/backend/src/core/web-annotation-dispatch.ts:194` and `:702`; `apps/backend/src/core/native-agent-service.ts:2803`; recovery at `apps/backend/src/core/storage-native.ts:1926` (counter at `:1935`), scheduled by `schedulePromptQueueClaimRecovery` at `:1901` and run at startup from `apps/backend/src/core/storage.ts:134`. Two readers are not in the file's list: `apps/backend/src/core/public-api/run-observer.ts:128` (treats a claimed id as held, added or touched by `08bd63c9` on 2026-10-26) and the renderer type `apps/web/src/types/index.ts:365`. The model comment is at `apps/backend/src/core/models.ts:832`. Tests: `storage-prompt-queues.test.ts:215` and `storage-prompt-queue-idempotent.test.ts`, seeded through `storage-test-support.ts:63`.

The window: the newest Stable tag is `v2.23.0` (2026-10-19); every release since is a beta (`v2.33.0-beta`, 2026-10-26, is the latest). The floor is still v2.21.0, and the condition cannot be met until 60 days after the first Stable release cut after the 2026-10-24 removal is published, so not before late December 2026 even if one shipped today.

A mechanical catch the file does not mention: `storage-record-upgrades.ts` upgrades run inside one numbered migration (`RECORD_SHAPE_UPGRADE_VERSION = 3`, `storage-record-upgrades.ts:133`), which existing databases already passed. The current schema is version 4 (`CHANGE_LEDGER_MIGRATION_VERSION`, `apps/backend/src/core/change-tracking/ledger-schema.ts:17`). Adding the claim upgrade to the version 3 list would never run on an existing database; it needs a new version 5 migration, and `StorageDatabaseVersionError` (`apps/backend/src/core/storage-database.ts:117`) then makes every older build refuse the database. That is a downgrade fence for every release before it, not only the claim writers.

**Decisions.**

- **How should the one-time restore run?**
  - **A version 5 migration in `storage-record-upgrades.ts`, shipped together with the next migration that is needed anyway (recommended).** Add the upgrade to whichever release next bumps the schema for another reason.
    - Pros: matches the file's plan and `docs/architecture/storage.md` ("Migrations"); costs no extra downgrade fence.
    - Cons: retirement waits on unrelated schema work; may slip past the date the window allows.
  - **A version 5 migration of its own as soon as the window allows.**
    - Pros: retires the path on schedule.
    - Cons: every release before it refuses to open the database after an upgrade, which is a heavy cost for removing a small read path.
  - **A startup pass outside the migration system (run on every open, a no-op once no claim exists).**
    - Pros: no schema bump, no downgrade fence.
    - Cons: is a legacy reader on every load, which `storage-record-upgrades.ts` exists to avoid; the reads it replaces are hardly heavier.
- **Should the restore honour `expiresAt`?**
  - **No: restore every stored claim to the head at once (recommended).** By the time the window allows it, no supported backend can hold a live claim.
    - Pros: one pass, no timer; same end state as expiry recovery.
    - Cons: a claim that a very old backend was genuinely still holding would be requeued early (outside the window, so not a supported case).
  - **Yes: keep claims not yet expired and keep the timer.**
    - Pros: exactly matches today's semantics.
    - Cons: keeps the timer and the readers the task exists to remove.
- **What evidence is enough before removing it?**
  - **Read `prompt-queue.legacy-claim-recovered` through `get_compatibility_path_usage` on every reachable machine and accept no `lastSeenAt` in the last 60 days (recommended).**
    - Pros: the procedure `version-compatibility.md` ("Usage counters") already prescribes; content-free.
    - Cons: counters are local, so unreachable users are unobserved.
  - **Rely on the window alone.**
    - Pros: no manual step.
    - Cons: ignores the one signal that would show a peer still writing claims.

### 2. Correct which backends can still write a claim

**Problem.** The file and the register row (`docs/architecture/version-compatibility.md:116`) say backends from v2.21.0 to v2.28.0-beta can still share a data directory and write claims. That overstates the exposure.

**Context.** A database newer than a build refuses to open (`docs/architecture/storage.md`, "Migrations"). Migration version 4 (the change ledger, `d9bc8b84`, 2026-10-20) is in `v2.27.0-beta` onwards and absent from `v2.21.0` and `v2.23.0` (checked with `git show <tag>:apps/backend/src/core/storage-stores.ts`).

**Investigation.** Once any build from v2.27.0-beta on opens a data directory, v2.21.0 to v2.26.x refuse it, so only `v2.27.0-beta` and `v2.28.0-beta` can write a new claim alongside a current backend. A Stable-channel user (v2.23.0) can only carry a claim written before upgrading, which the existing startup recovery already handles. This does not change the retirement condition, since the floor rule is about Stable releases, but it shrinks the realistic population to beta users of two releases.

**Decisions.**

- **Where to record the narrower range?**
  - **Correct the register row and this file's opening paragraph in the same change (recommended).**
    - Pros: accurate exposure for whoever checks the counter; both places say the same thing.
    - Cons: touches `version-compatibility.md`, which is shared with other paths.
  - **Leave both as they are.**
    - Pros: no edit; the condition and the outcome are unchanged.
    - Cons: overstates who is affected, which could argue for keeping the path longer than needed.

The prompt-queue claim commands (`claim_prompt_queue_head`,
`acknowledge_prompt_queue_claim`, `reject_prompt_queue_claim`,
`requeue_prompt_queue_message`) were removed on 2026-10-24 by
[0034-mixed-version-compatibility.md](0034-mixed-version-compatibility.md).
Backends up to v2.28.0-beta still expose them and can share this schema's
store. The absence of published renderer callers does not rule out an active
external claim holder, so lease exclusion must remain while those peers can
share the store.

## Current state

- `restoreLegacyPromptQueueClaims` (`storage-record-upgrades.ts`) runs on every
  prompt-queue load in `PromptQueueStore` (`storage-prompt-queue-store.ts`),
  including claims written by a peer after startup. Reads
  do not write the store or increment queue revisions.
- A claim with a message record, nonblank token, readable claim timestamp and
  future expiry is retained verbatim. Queue writes, including writes to an
  unrelated queue, preserve its token and message so the old holder can
  acknowledge or reject it. No new claim commands or writers are introduced.
- Live claims block dispatch and steering reservations, native and tmux queue
  drains, and tmux mail submission. Enqueue deduplicates against the held id.
  A stale whole-list save cannot insert a copy of that id or tombstone it.
- At expiry, or with malformed lease metadata, the message returns to the
  head and replaces any queued copy of the same id. A missing, blank or
  non-string id receives a deterministic recovery id derived from the message
  fingerprint, preserving the body and attachments without blocking the head.
  A claim without a message record is dropped without losing the queue tail.
- The next queue mutation persists the normalized shape. Native keyed
  scheduling keeps a sole live claim due for progress checks, so its expiry
  does not depend on a renderer, a notification or broad discovery.
- Expiry retains the previous recovery semantics: the drainer reserves the
  restored head through the ordinary durable dispatch path. It does not prove
  that an expired holder never submitted; downstream request receipts and tmux
  ambiguity handling retain their existing responsibilities.

## Decisions

The original proposal restored every claim immediately, even during a live
lease, based on the absence of published renderer callers. Review identified
that an external caller of an older backend's command can still hold the
prompt. That assumption did not justify removing exclusion. Live leases now
remain protected until settlement or expiry; only the claim-writing commands,
standalone recovery timer and old usage counter remain retired.

No schema version bump is needed. A bump would prevent supported mixed
versions and downgrades from opening the store. Per-load normalization also
covers claims that another backend writes while this one is running.

The compatibility register retains this read path until claim-writing peers
cannot share the database. There is no new recovery counter: normalization is
a read and counting reads would not count recovered claims.

## Regression coverage

- `storage-record-upgrades.test.ts`: expiry restoration, same-id replacement,
  live claim identity preservation, malformed records, stable repaired ids,
  immutable inputs and unchanged claim-free stores.
- `storage-prompt-queues.test.ts`: live lease preservation through queue edits,
  exact-expiry reservation, startup and runtime peer writes, enqueue dedupe,
  malformed lease metadata and deletion.
- `native-agent-prompt-queue-dispatcher.test.ts`: a separate backend connection
  holds and acknowledges a live claim while this backend loads, normalizes an
  unrelated queue and drains; only the holder submits, including after the
  original expiry. Recurring `listAllPromptQueues` scans dispatch expired and
  malformed-id claims once and leave no stuck head.
- `storage-prompt-queue-idempotent.test.ts`: retry dedupe, fingerprint conflicts,
  stale-save exclusion, tombstone protection and steering refusal.
- `native-agent-queue-scheduling.test.ts`: a sole legacy claim remains due.
- `prompt-queue-drainer.test.ts`: tmux drains and mail respect a live holder.

## Validation — 2026-10-27

Implementation commit: `a733e0155`.

- `mise run test:logged -- --name legacy-final-check -- mise run check`:
  passed (format, lint and all typechecks).
- `legacy-final-focused`: all nine regression owners listed above passed
  together. The logged command used `sh -c 'cd apps/backend && bun test
  --preload ../../tests/setup-node.ts <explicit owner paths> --parallel=3'`.
  The owner paths were `src/core/{storage-record-upgrades,storage-prompt-queues,
  storage-prompt-queue-idempotent,native-agent-prompt-queue-dispatcher,
  native-agent-queue-scheduling,prompt-queue-drainer,web-annotation-dispatch,
  native-agent-service-base}.test.ts` and
  `src/core/public-api/public-api-command-surface.test.ts` (expanded explicitly
  in the actual command). Exit 0, 9.4 s.
- `mise run test:logged -- --name legacy-queue-suite -- mise run test`:
  exit 1 after 1276 s, including host-capacity admission waits. Backend:
  12,042 passed, 120 skipped, 23 failed; desktop: 1,369 passed, 16 skipped,
  two failed; root: 3,525 passed, three failed; Claude bridge: 1,698 passed,
  six skipped, eight failed. Web, web-public, CLI, protocol, toolchain, the
  other four bridges and the protocol lockfile passed. No queue regression
  failed in this run.
- The full run caught a missing required `ID` field in the new flake record.
  It was corrected; `flake-index-final` passed the complete registry owner
  (`bun test ./tests/unit/flaky-tests-index.test.ts --parallel=1 --only-failures`).
- Other full-run failures are in unchanged environment/Git/watch fixtures,
  shell input-relay and Docker fixtures, and Claude CLI qualification cases
  that aborted at their deadlines. Isolated logged reruns still fail in
  `commands-integration.test.ts` (54 passed, one timeout and one late error),
  `migrate-copy.test.ts` (10 passed, two failed), and `profile-cleanup.test.ts`
  (20 passed, two failed). These were not classified as flakes or changed.
- A separate concurrent hook-counter failure passed alone and is recorded in
  [1102](../../tests/flaky-tests/native-agents-and-transcripts/1102-claude-hook-concurrent-counter-snapshot.md).

Full-run evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.UJyfMx/summary.json`
and its three failing group logs. The outer logged command's artifact is
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.syCejJ/legacy-queue-suite.log.gz`.
Isolated failure artifacts are `orkestrator-test-run.wR63Gv` (commands),
`orkestrator-test-run.LVlz6O` (copy), and `orkestrator-test-run.UUUJO1` (profiles)
under the same temporary root.

## Main merge validation — 2026-10-27

Merged `origin/main` at `511d3de8e` into `486c88627`. The resolution keeps
main's storage split: queue load/save normalization now lives in
`storage-prompt-queue-store.ts`, the queue guard in
`storage-shared-records.ts`, and delivery journals in
`storage-native-deliveries.ts`. The original ten conflicted paths and both
parent IDs are retained in local Git metadata.

- `merge-queue-focused` passed all ten owners: the nine regression owners
  above plus `storage-writer-guards.test.ts`, with the backend preload and
  `--parallel=3 --only-failures`.
- `merge-format-final`, `merge-lint` and `merge-typecheck` passed their
  repository tasks through `test:logged`.
- `merge-tests` ran `mise run test` through `test:logged` and exited 1
  after 1225.6 s. Backend: 12,356 pass, 121 skip, 46 fail; desktop:
  1,394 pass, 16 skip, 2 fail; root: 3,531 pass, 2 fail; Claude bridge:
  1,734 pass, 6 skip, 7 fail. Web, web-public, CLI, protocol, toolchain,
  the other four bridges and the protocol lockfile passed. Failures outside
  the resolution include copy fixtures, profile-cleanup Keychain-warning
  expectations, environment Git/cleanup deadlines, Claude CLI qualification
  deadlines, and undefined `sessionManagerTestHome` references in the
  unchanged Claude persistence/lifecycle tests, plus Docker identity and
  staged-input relay fixtures. These do not constitute a
  passing full-suite result.
- Individual logged reruns also failed in `migrate-copy.test.ts` (10 pass,
  2 fail), `profile-cleanup.test.ts` (20 pass, 2 fail), both Claude CLI
  qualification owners (4 pass/5 fail and 3 pass/1 fail), the Claude
  persistence owner (99 pass, 1 skip, 1 fail), its lifecycle owner
  (38 pass, 1 fail), and `commands-registry-environments.test.ts`
  (64 pass, 4 fail, 1 error). The environment-move owner also failed
  individually (14 pass, 24 fail, 22 errors), with Git/cleanup deadlines and
  follow-on missing-fixture errors. No new flake classification was made.
- Browser, Electron, Docker and iOS scenario suites were omitted: this
  resolution changes backend persistence and its documentation.

The aggregate group's failure evidence is under
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.2ZM3b9/`;
the outer `merge-tests` log and summary are under the same temporary root in
`orkestrator-test-run.54ULhq/`. Individual rerun evidence is in
`orkestrator-test-run.nDm2RN` (copy), `.QxwiCa` (profiles), `.yaYtZp`
(Claude sandbox), `.6faMjy` (Claude policy), `.nbeIfa` (persistence),
`.5tzMbJ` (lifecycle), `.qc1G3e` (environment commands) and `.7Vzxz2`
(environment move).

## Related

- [0034-mixed-version-compatibility.md](0034-mixed-version-compatibility.md)
- [version-compatibility.md](../../architecture/version-compatibility.md)
- [storage.md](../../architecture/storage.md#migrations)
