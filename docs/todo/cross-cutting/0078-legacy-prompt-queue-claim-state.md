# Legacy prompt-queue claim state

Checked against `main` at `8454d18b` plus the 0034 branch (2026-10-24).

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
[0034-mixed-version-compatibility.md](0034-mixed-version-compatibility.md). No
client had called them since at least 2026-08-01. Releases up to v2.28.0-beta
still have them, and such a backend can share a data directory with a newer
one, so the claim state they wrote is still read. This file owns retiring that
read.

## Current state

- Nothing writes `PersistedPromptQueue.outstandingClaim` any more.
- It is still read: storage validation drops a record with a malformed claim
  (`storage-shared-core.ts`), `reservePromptQueueHeadForDispatch` refuses to
  reserve while a claim is outstanding (`storage-prompts.ts`), enqueue dedupes
  against the claimed id, web-annotation dispatch and `native-agent-service.ts`
  treat a claimed prompt as queued, and `recoverExpiredPromptQueueClaims`
  (`storage-native.ts`) puts an expired claim's prompt back at the head at
  startup and on a lease timer.
- Each restored claim counts as `prompt-queue.legacy-claim-recovered`
  ([version-compatibility.md](../../architecture/version-compatibility.md#usage-counters)).

## Outstanding work

### Code

1. **Retire the claim read once the window allows.** When the floor of the
   support window is at or above the first Stable release without the claim
   commands (the first Stable after v2.28.0-beta; the floor reaches it 60 days
   after that release is published), replace the reads above with one record
   upgrade in `storage-record-upgrades.ts` that restores any stored claim's
   prompt to the head of its queue, then drop the field, the recovery timer
   and their tests. Check the counter on reachable machines first. Done when
   no code reads `outstandingClaim` except that upgrade.

## Constraints and rationale

- Restoring the prompt to the head is what the lease expiry always did, so the
  record upgrade changes no behaviour. It must never dispatch the prompt
  directly: an older renderer may already have sent it.

## Open questions

None.

## Needs verification

None.

## Related

- [0034-mixed-version-compatibility.md](0034-mixed-version-compatibility.md)
- [`version-compatibility.md`](../../architecture/version-compatibility.md)

## Replaces

Nothing; split out of 0034 on 2026-10-24.
