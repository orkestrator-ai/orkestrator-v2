# Legacy prompt-queue claim state

Checked against `main` at `863b5782` (2026-10-27). Originally written against
`8454d18b` plus the 0034 branch (2026-10-24).

The prompt-queue claim commands (`claim_prompt_queue_head`,
`acknowledge_prompt_queue_claim`, `reject_prompt_queue_claim`,
`requeue_prompt_queue_message`) were removed on 2026-10-24 by
[0034-mixed-version-compatibility.md](0034-mixed-version-compatibility.md).
Releases up to v2.28.0-beta still have them, and such a backend can share a
data directory with a newer one, so the claim state they wrote was still read.
This file retired that read on 2026-10-27.

## Current state

- Nothing in this build writes or reads `PersistedPromptQueue.outstandingClaim`
  except one record upgrade, `restoreLegacyPromptQueueClaims`
  (`apps/backend/src/core/storage-record-upgrades.ts`). It runs on every load
  of the prompt queues (`loadPromptQueues`, `storage-native.ts`), not as a
  migration: it puts each claimed message back at the head of its queue,
  replacing a queued copy with the same id, and drops the claim. A claim with
  no message record has nothing to restore and is just dropped. A load writes
  nothing; the queue's next save persists the restored shape. It never
  dispatches: the drainer reserves the restored head like any other.
- Gone: the claim validator (`isPersistedPromptQueueClaim`) and its clause in
  `isPersistedPromptQueue` (`storage-shared-core.ts`); the field on
  `PersistedPromptQueue` (`models.ts`, `apps/web/src/types/index.ts`); the
  reservation and steer refusals while a claim is outstanding, and the enqueue
  dedupe and idempotent-enqueue lookups against the claimed id
  (`storage-prompts.ts`, `storage-native.ts`); the claim branches in
  web-annotation dispatch (`claimHoldsId`, `queuedWithSameBody`), the public
  run observer (`run-observer.ts`) and the turn-outcome classifier
  (`native-agent-service.ts`); the carry-forward of a claim and its tombstone
  exemption in `savePromptQueueMutation`; the startup recovery
  (`StorageService.init`), the lease timer
  (`schedulePromptQueueClaimRecovery`, `recoverExpiredPromptQueueClaims`) and
  the `prompt-queue.legacy-claim-recovered` usage counter
  (`compatibility-path-usage.ts`).
- The register row in
  [version-compatibility.md](../../architecture/version-compatibility.md#register)
  moved to "Retired"; [storage.md](../../architecture/storage.md#migrations)
  describes the per-load upgrade.

## Outstanding work

None. The item, with its evidence:

### Done

1. **Claim read retired** (2026-10-27). The reads listed above were replaced
   by the per-load record upgrade, and the field, the recovery timer and their
   tests were dropped (decisions 1 to 4). Tests:
   - `storage-record-upgrades.test.ts`, "restores a legacy prompt-queue claim
     to the head without touching its input": restore and same-id
     replacement, a claim with no message dropped, input never mutated,
     unclaimed queues and a claim-free store returned as the same objects.
   - `storage-prompt-queues.test.ts`: "reserves a legacy claimed head as soon
     as it is loaded, whatever its lease" (a live-lease claim is reserved and
     the reservation's write persists the queue without the claim);
     "restores every claim on load, at startup or written while running"
     (a claim written by another process after this backend started is
     restored on the next read, and a read writes nothing); "restores a claim
     whose lease fields are malformed, and drops one with no message"
     (replaces "drops a whole record whose stored claim is malformed");
     "deleting a queue discards its legacy claim with it"; the enqueue dedupe
     case now finds the restored id in `messages`.
   - `storage-prompt-queue-idempotent.test.ts`, "restored legacy claims and
     dispatch reservations are never tombstoned".
   - `web-annotation-dispatch.test.ts`: an item an older backend claimed now
     observes as `queued`, not `dispatching`, and never as a removal.
   - `e2e/agent-testing/web-annotations-electron.spec.ts` no longer asserts on
     the field.
   - Removed with the timer: "recovers and announces an expired sole legacy
     claim during backend restart", "live lease timer restores and announces
     a sole legacy claimed head", "does not reserve the head while a legacy
     claim is live" and the counter assertions.

   Done-when check: `rg -n outstandingClaim apps packages bridges tests e2e`
   finds only `storage-record-upgrades.ts`, the test seeder
   `seedLegacyPromptQueueClaim` (`storage-test-support.ts`, which writes the
   old shape) and test assertions that the field is gone.

   Counter check: the live data directory on this machine
   (`~/Library/Application Support/orkestrator-v2/orkestrator.sqlite`, read
   with `sqlite3` in `mode=ro` on 2026-10-27, nothing written) has no
   `prompt-queue.legacy-claim-recovered` entry (its only counted path is
   `bridge-transcript.messages-fallback`), and no stored row or document
   contains `outstandingClaim`.

### Validation (2026-10-27)

- `mise run format:check`, `mise run typecheck` and `mise run lint` (exit 0;
  no warning in a touched file) passed.
- Focused: `storage-record-upgrades`, `storage-prompt-queues`,
  `storage-prompt-queue-idempotent`, `web-annotation-dispatch`,
  `compatibility-path-usage` and every `src/core/public-api/` test: 701
  passed, 0 failed.
- `mise run test`: bridges, web (9,941), CLI (329) and the Codex protocol
  lockfile passed. Backend 12,002 passed and 47 failed, desktop 2 failed,
  root 3,526 passed and 2 failed. Every failure is in a git- or
  filesystem-heavy file this change does not touch
  (`environment-move.test.ts`, `commands-environment-worktree-location.test.ts`,
  `diff-stats-tracking.test.ts`, `mcp-management/service-overlay.test.ts`,
  `multi-review-service.test.ts`, `opencode-host-start.test.ts`,
  `worktree-snapshots-git.test.ts`, desktop `scripts/dev/profile-cleanup.test.ts`,
  root `tests/unit/migrate-copy.test.ts`), most at the 5 s timeout. The same
  files fail the same way on a clean `origin/main` worktree at `863b5782` on
  this machine (backend 408 passed, 38 failed; desktop and root the same two
  each), so they predate this change; they are consistent here, not flaky,
  so no flaky-test entry was added.
- Not run: Electron, browser, Docker and CLI scenario suites. The only e2e
  change drops an assertion on the removed field.

## Constraints and rationale

- Restoring the prompt to the head is what the lease expiry always did. It
  must never dispatch the prompt directly: an older renderer may already have
  sent it.
- Data is never lost: a claim from any version, source builds before
  v2.21.0 included, still loads with its message back in the queue.
- No schema version bump: a new migration would make every release up to this
  one refuse the database, breaking downgrade within the window and a desktop
  app and `orkestrator serve` of different versions sharing one data
  directory.

## Assumptions and decisions

Made on 2026-10-27.

1. **Retire now instead of waiting for the floor.**
   - Options: (a) wait until the floor reaches the first Stable release after
     v2.28.0-beta (none is published yet; the newest Stable is v2.23.0, so at
     least 60 days away); (b) retire now.
   - Chosen: (b).
   - Why: the window measures when a peer that needs a path is gone. The only
     writer of a claim is the `claim_prompt_queue_head` command, and no
     published renderer ever called it: in v2.21.0 and v2.28.0-beta the
     command wrappers (`workflows.ts`) and `claimPromptQueueHead`
     (`prompt-queue-persistence.ts`) have no caller outside their own tests,
     the drainer reserved through storage, and no package, bridge or CLI
     called the command (`git grep` on both tags). 0034 removed the commands
     themselves on the same evidence ("no client since 2026-08-01") and found
     no external caller of `/__orkestrator/invoke` (its decision 12). So the
     peers the claim read served, published backends v2.21.0 to v2.28.0-beta,
     never write a claim in practice; the only sources are source builds from
     before 2026-08-01 and a hand-made command call, and the permanent
     upgrade covers both without loss. This machine's counter and data agree.
   - Pros: the field, timer, counter and every read site go now instead of in
     two or more months; the queue code no longer has a second "being
     delivered" state. Cons: it departs from the register's stated condition,
     and a hypothetical client that claims through an older backend sharing
     the database loses the lease's protection (decision 3).
2. **Where the upgrade runs.**
   - Options: (a) a new migration (schema version 5) in `RECORD_UPGRADES`;
     (b) a one-off startup pass replacing `recoverExpiredPromptQueueClaims`;
     (c) on every load of the prompt queues.
   - Chosen: (c), with the pure function in `storage-record-upgrades.ts` as
     the item asked.
   - Why: (a) runs once and then makes every release up to v2.33.0-beta
     refuse the database, so downgrades within the window and mixed
     desktop/CLI versions on one data directory would break.
     (b) misses a claim written by an older backend while this one runs, and
     the next save of that queue would then drop the claim with its message.
     (c) sees every claim whenever it was written, needs no write in a read
     path, and costs one pass over the queues per load that allocates nothing
     when no claim exists.
   - Pros: no schema bump, no timer, no data loss, one place reads the field.
     Cons: the stored document keeps a claim until that queue's next save, so
     an older backend reading the database meanwhile still sees it; and the
     module comment had to note that this upgrade is the exception to "runs
     once at open".
3. **Live leases.**
   - Options: (a) restore only expired claims and keep blocking a live one
     (which needs the reservation, steer and dedupe reads to stay); (b)
     restore every claim at once, whatever its lease.
   - Chosen: (b).
   - Why: (a) keeps exactly the reads the item retires. With (b) a claim's
     message can be dispatched by this backend while the client that claimed
     it is still within its lease; that is the double dispatch 0034
     decision 6 guarded against, but decision 1 shows no published client
     claims, so it cannot happen with any released software.
   - Pros: no lease bookkeeping. Cons: a private script that claims through
     an older backend's `/__orkestrator/invoke` while this backend shares the
     database could see its claimed prompt sent twice.
4. **Malformed claims, and the counter.**
   - Malformed: options were (a) drop the whole queue record, as validation
     did, or (b) restore any claim whose `message` is a record, ignoring its
     token and lease times, and otherwise just drop the claim. Chosen (b):
     the lease fields no longer matter, and dropping the queue lost every
     queued prompt with it. Pros: strictly less loss. Cons: a corrupt claim
     with a readable message is now restored rather than discarded.
   - Counter: options were keeping `prompt-queue.legacy-claim-recovered` at
     the load site, or removing it. Chosen: remove it, per
     `compatibility-path-usage.ts` ("remove it with the path"). The upgrade is
     permanent, so a count would answer no retirement question, and counting
     at a load would count reads, not claims. A count already stored by
     another backend stays in its document (`normalizeCompatibilityPathUsage`
     keeps unknown ids on merge) and is just not shown by this one. Pros: no
     dead telemetry. Cons: no local signal if some peer does still claim.

## Open questions

None.

## Needs verification

- The usage counter on the user's other backends: no `prompt-queue.legacy-claim-recovered` entry is
  expected. This worker could only read this machine's data directory. A
  count would not change the data outcome (claims are restored either way),
  but a recent one would mean some client still claims through an older
  backend, and that user should update (decision 3).

## Related

- [0034-mixed-version-compatibility.md](0034-mixed-version-compatibility.md)
- [`version-compatibility.md`](../../architecture/version-compatibility.md)
- [`storage.md`](../../architecture/storage.md#migrations)
- [0214-storage-files-over-size-limit.md](../backend-structure/0214-storage-files-over-size-limit.md):
  `storage-native.ts` shrank under the size limit with this change.

## Replaces

Nothing; split out of 0034 on 2026-10-24.
