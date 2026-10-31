# Legacy prompt-queue claim state

## Task analysis

Analysed 2026-10-28 against `main` at `79f3bc97`. Rechecked 2026-10-31 against
`main` at `931e5541`: the schema is now version 5, which changes task 2's answer
and gives task 1 a decision to take (see each).

### Tasks

1. **Retire the live-claim read**: once no supported backend can write a claim into a shared database, restore every stored claim to the head and drop the `outstandingClaim` guards. Status: open (blocked on the support window: no Stable release without the claim commands exists yet; see the 2026-10-31 decision below on whether schema 5 lifts that).
2. **Correct which backends can still write a claim**: the register row said "through v2.28.0-beta", but the commands shipped through v2.29.0-beta, and the schema now shuts out every one of those releases. Status: done (2026-10-31).

The 2026-10-27 work (per-load normalization, retiring the standalone recovery
timer and its counter) is done; see Current state.

### 1. Retire the live-claim read

**Problem.** Queue readers still have to treat a live legacy claim as holding
its prompt: dispatch, steering, native and tmux drains, tmux mail, enqueue
dedupe, web-annotation observation, admission and deduplication, and the public
run observer each check `outstandingClaim`. Nothing
current writes a claim, so every new queue reader carries a rule for data only
an older backend produces.

**Context.** The claim commands (`claim_prompt_queue_head`,
`acknowledge_prompt_queue_claim`, `reject_prompt_queue_claim`,
`requeue_prompt_queue_message`) were removed on 2026-10-24 by
todo 0034 (`a3111c7c6`, #1207). An external
caller of an older backend's command can still hold a prompt, so a live lease
keeps excluding other writers until it settles or expires. The register row in
[version-compatibility.md](../../architecture/version-compatibility.md#register)
gives the condition: claim-writing peers can no longer share the database.
"Migrations and record upgrades are permanent" (the same document, "What must
work across the window"), so the shape upgrade itself never goes away.

**Investigation.** On `main` at `79f3bc97`:
- Normalization is `restoreLegacyPromptQueueClaims`
  (`apps/backend/src/core/storage-record-upgrades.ts:140`), called on every
  load by `storage-prompt-queue-store.ts:134`. The shape guard is
  `storage-shared-records.ts:74`; the model field is `models.ts:835`.
- The `outstandingClaim` readers: `native-agent-prompt-queue-dispatcher.ts`
  (`:400`, `:416`, `:543`), `native-agent-queue-scheduling.ts:46`,
  `native-agent-service.ts` (`:2933`, `:3164`, `:3266`),
  `prompt-queue-drainer.ts` (`:140`, `:159` after the post-await queue refetch,
  `:213`, `:232`, `:280`),
  `web-annotation-dispatch.ts` (`:189` claim observation, `:439` destination
  holds, `:705` same-body deduplication, `:1058` admission blocked reason),
  `storage-prompts.ts` (`:229`, `:320`, `:388`, `:563`),
  `storage-native-deliveries.ts:374`, `public-api/run-observer.ts:121` and
  `storage-prompt-queue-store.ts` (`:61`, `:79`, `:108`), all under
  `apps/backend/src/core/`.
- The recovery timer (`schedulePromptQueueClaimRecovery`) and the
  `prompt-queue.legacy-claim-recovered` counter are gone: neither appears in
  the tree.
- The window: the newest Stable tag is still `v2.23.0` (2026-10-19); every
  release since is a prerelease (`v2.34.3-beta` is the latest). The first
  release without the commands is `v2.30.0-beta`. The floor reaches a release
  at or above it only 60 days after the first Stable release from `v2.30.0`
  on is published, so not before late December 2026 even if one shipped
  today.
- **Rechecked 2026-10-31: schema 5.** `retireLoopedReviewsMigration`
  (`storage-retired-features.ts:72`, `e1865cf5e`, #1417, 2026-10-29) made the
  schema version 5. It is in `v2.34.4-beta` and absent from `v2.34.3-beta`. So
  every claim-writing release now refuses a database a current backend has
  opened (`storage-database.ts:338`). What is left is a claim carried across the
  upgrade, or a backend that opened the database before version 5 and is still
  running: the version is checked only at open.

**Decisions.**

- **Does schema 5 lift the block before the window would? (2026-10-31, not taken: this batch was told to leave task 1.)**
  - **Yes: treat the register's "can no longer share the database" as met once version 5 has shipped, and do task 1 after the next Stable release carries it (recommended).**
    - Pros: the register row's condition is about sharing a database, and the schema now decides that; removes every `outstandingClaim` reader without waiting 60 days from that Stable release; the downgrade rule already accepts an older release refusing newer data.
    - Cons: a claim held by an old backend still running across the migration would go back to the head while its holder may yet submit it, so it could run twice; that is a single-host, single-restart race but it touches at-most-once dispatch, and it departs from the window's floor rule.
  - **No: keep waiting for the floor, late December 2026 at the earliest.**
    - Pros: follows the window rule as written; no new reasoning about running peers.
    - Cons: keeps 40 references across 13 backend files for a writer that can no longer open the database.
- **What does retirement remove?**
  - **Keep `restoreLegacyPromptQueueClaims` as a load pass that restores every claim to the head, and delete the live-lease branch and every `outstandingClaim` reader (recommended).**
    - Pros: honours "record upgrades are permanent", so a database that still holds a claim loads without loss; no schema bump; queue readers lose the extra rule.
    - Cons: one cheap pass stays on every queue load.
  - **Move the restore into a new numbered migration (version 6 now that 5 is taken) and delete the load pass.**
    - Pros: no legacy code on the load path.
    - Cons: it misses a claim a peer writes after the migration ran. The original objection, that every earlier release would then refuse the database, no longer separates the options for claim writers, which version 5 already refuses, but it would add a fence for `v2.34.4-beta` onwards.
  - **Delete the field and the pass entirely.**
    - Pros: least code.
    - Cons: a stored claim's message is silently dropped, which the window rules forbid.
- **What evidence is enough?**
  - **The window alone (recommended).** The 2026-10-27 change retired the recovery counter, and every claim writer that can still open a current database is a prerelease (task 2).
    - Pros: no manual step; no new counter on a read path.
    - Cons: an external caller still on an old beta goes unobserved.
  - **Add a counter for loads that see a live claim, and wait for 60 quiet days.**
    - Pros: direct evidence on machines you can reach.
    - Cons: it counts loads, not claims; it is new compatibility code added only to delete other compatibility code.

### 2. Correct which backends can still write a claim

Done 2026-10-31, with a different answer from the one recorded below; see "Assumptions and decisions".

**Problem.** The register row said the path serves "claim-writing backends
through v2.28.0-beta". That is wrong at the top and broader than it needs to be
at the bottom.

**Context.** A backend refuses a database whose schema version is newer than
it supports (`apps/backend/src/core/storage-database.ts:118`, and already in
`v2.23.0` at `:118`). The change-ledger migration makes the schema version 4
(`change-tracking/ledger-schema.ts:17`).

**Investigation.** Checked with `git show <tag>:…` and `git grep … <tag>`:
- `claim_prompt_queue_head` is registered in
  `commands-registry-prompts.ts` up to and including `v2.29.0-beta`
  (2026-10-24) and absent from `v2.30.0-beta` on.
- `CHANGE_LEDGER_MIGRATION_VERSION = 4` is in every tag from
  `v2.24.0-alpha` on; `v2.23.0` supports version 3 at most
  (`RECORD_SHAPE_UPGRADE_VERSION = 3`). The previous analysis said version 4
  began in `v2.27.0-beta`; that was wrong.
- v2.24.0-alpha to v2.26.0-alpha were drafts never published (the support
  window section of `version-compatibility.md`), so they are not covered.

So the supported releases that can write a claim into a database a current
backend has opened are `v2.26.1-alpha` to `v2.29.0-beta`, all prereleases. A
Stable user (v2.23.0 or older) can only bring a claim written before
upgrading, which normalization already restores. The retirement condition in
task 1 is unchanged, because the floor rule follows Stable releases.

**Decisions.**

- **Where is the narrower range recorded?**
  - **Correct the register row's "Serves" cell to "published claim-writing releases v2.26.1-alpha to v2.29.0-beta (earlier releases refuse a schema-4 database), including external callers", and keep this file's investigation as the evidence (recommended).**
    - Pros: whoever checks the register sees the real population; one line.
    - Cons: touches `version-compatibility.md`, which other paths share.
  - **Leave the row as it is.**
    - Pros: no edit; the condition does not change.
    - Cons: the row names a wrong last release and overstates who is affected.

## Current state

- `restoreLegacyPromptQueueClaims` runs on every prompt-queue load in
  `PromptQueueStore`, including claims a peer writes after startup. Reads
  neither write the store nor bump queue revisions.
- A claim with a message record, a non-blank token, a readable claim time and
  a future expiry is kept verbatim. Queue writes, including writes to an
  unrelated queue, preserve its token and message so the old holder can
  acknowledge or reject it. No new claim commands or writers exist.
- Live claims block dispatch and steering reservations, native and tmux queue
  drains, and tmux mail submission. Web annotations observe held ids, report
  destination holds, deduplicate the held body and block admission. Enqueue
  deduplicates against the held id. A stale whole-list save cannot insert a
  copy of that id or tombstone it.
- At expiry, or with malformed lease metadata, the message returns to the
  head and replaces any queued copy of the same id. A missing, blank or
  non-string id gets a deterministic recovery id derived from the message
  fingerprint, keeping the body and attachments without blocking the head. A
  claim without a message record is dropped without losing the queue tail.
- The next queue mutation persists the normalized shape. Native keyed
  scheduling keeps a sole live claim due for progress checks, so its expiry
  does not depend on a renderer, a notification or broad discovery.
- Expiry keeps the earlier recovery semantics: the drainer reserves the
  restored head through the ordinary durable dispatch path. It does not prove
  that an expired holder never submitted; request receipts and tmux ambiguity
  handling keep their existing responsibilities.
- Regression coverage, all under `apps/backend/src/core/`:
  `storage-record-upgrades.test.ts` (expiry restore, same-id replacement, live
  claim identity, malformed records, stable repaired ids, unchanged inputs and
  claim-free stores); `storage-prompt-queues.test.ts` (live leases through
  queue edits, exact-expiry reservation, startup and runtime peer writes,
  enqueue dedupe, malformed lease metadata, deletion);
  `native-agent-prompt-queue-dispatcher.test.ts` (a second backend connection
  holds and acknowledges a live claim while this backend drains; recurring
  scans dispatch expired and malformed-id claims once);
  `storage-prompt-queue-idempotent.test.ts`;
  `native-agent-queue-scheduling.test.ts`; `prompt-queue-drainer.test.ts`;
  `storage-writer-guards.test.ts`.

## Outstanding work

### Code

1. Retire the live-claim read (task 1), once the window allows it.

## Constraints and rationale

- A live lease must keep excluding other writers while a claim-writing peer
  can share the database. The first proposal restored every claim at once,
  even during a live lease, because no published renderer called the
  commands; review showed an external caller of an older backend's command
  can still hold the prompt, so exclusion stays until settlement or expiry.
- No schema version bump for this path: per-load normalization also covers
  claims another backend writes while this one runs. The other reason given
  here, that a bump would stop older releases opening the store, stopped applying
  when an unrelated migration took the schema to version 5.
- No recovery counter: normalization is a read, and counting reads would not
  count recovered claims.
- The restore must never dispatch the prompt itself; it only returns the
  message to the head for the ordinary dispatch path.

## Assumptions and decisions

### What the register row says (2026-10-31, task 2)

- **Options.** (a) The text recommended above: "published claim-writing releases
  v2.26.1-alpha to v2.29.0-beta (earlier releases refuse a schema-4 database)".
  (b) Name the top of the range and say what schema 5 leaves.
- **Choice: (b).**
- **Why.** On `main` the schema is 5, so (a) is out of date as to which backends
  can share the database. Its lower bound also stops mattering: a backend of any
  claim-writing release, Stable included (the commands are in `v2.21.0` and
  `v2.23.0`), may have left a claim, or still be running from before the
  migration. `storage.md` carried the same "up to v2.28.0-beta" claim and was
  corrected with it.
- **Pros.** True on current `main`, and points the reader at what task 1 must
  still consider. **Cons.** A longer cell than the rest of the table.
- **Noted, not changed.** (a)'s "published" was doubtful too. GitHub now lists
  `v2.26.1-alpha` as a draft, but gives it a publish time (2026-10-22) and so does
  every alpha from `v2.24.0-alpha`: `release:publish` hides each older alpha when
  the next ships (`releasing.md`). So "drafts that were never published" in
  `version-compatibility.md`'s support window section looks wrong. Whether those
  alphas count as covered is a policy call, so it was left for the user.

### Keep the file (2026-10-28, tasks 1 and 2)

The coordinator asked whether this file was finished. It is not: task 1 is
still blocked on the window and task 2 was never done, and the folder index
already said Finished: No. The file was brought into the Task analysis
format, with the code references rechecked at `79f3bc97`.

### Correct task 2's range instead of copying it (2026-10-28, task 2)

The earlier analysis gave `v2.27.0-beta` to `v2.28.0-beta`. Checking the tags
showed the commands lasted until `v2.29.0-beta` and schema version 4 began in
`v2.24.0-alpha`, so task 2 now records `v2.26.1-alpha` to `v2.29.0-beta`. The
register row was left alone: this change only retires finished todo files, so
the edit stays task 2's.

### Drop the 2026-10-27 validation logs (2026-10-28)

The "Validation" and "Main merge validation" sections recorded command runs
and temporary artifact paths for the merged change (#1330, `8c63e6b44`). They
supported that merge, not any remaining work, and the paths are temporary, so
they were removed; they stay in git history. The list of regression owners
moved into Current state.

## Related

- [version-compatibility.md](../../architecture/version-compatibility.md)
- [storage.md](../../architecture/storage.md#migrations)

## Replaces

Nothing; split from 0034 on 2026-10-24.
