# File and LOC change tracking

The backend owns every file-change number the product shows. Provider
adapters normalize native evidence at ingress; backend services decide scope,
baselines, counts, completeness, attribution, history and actions; every
client renders the same server-prepared `ChangeProjection`. This guide is the
living reference for that system. The original design specification was
`docs/temp/orkestrator-file-change-implementation-guide.html`.

## Measurement semantics

### Scopes

A measurement answers exactly one question. Scopes are never summed into one
another: staged + unstaged is not `uncommitted-net`, and turn or tool counts
do not add up to `thread-net`.

| Scope | Endpoints / evidence | Label key |
| --- | --- | --- |
| `environment-net` | Environment baseline (ref resolved to an immutable commit) → current Git observation | `changes.scope.environment-net` |
| `turn-net` | This turn's pre-dispatch start snapshot → selected live/final snapshot | `changes.scope.turn-net` |
| `provider-turn-diff` | Provider-reported cumulative turn patch, declared endpoints | `changes.scope.provider-turn-diff` |
| `thread-net` | The thread segment's initial executed-turn start → selected live/final snapshot | `changes.scope.thread-net` |
| `tool-effect` | Captured before/after (fresh boundary) or explicit provider-reported result | `changes.scope.tool-effect` |
| `observation-window` | Prior or late observation → later observation around a tool | `changes.scope.observation-window` |
| `tool-payload` | Proposal, patch, replacement fragments or content-only payload | `changes.scope.tool-payload` |
| `operation-volume` | One selected contribution per canonical attempt (structured edits only), per turn and per thread segment | `changes.scope.operation-volume` |
| `uncommitted-net` | `HEAD` (or the empty tree when unborn) → working tree, untracked included | `changes.scope.uncommitted-net` |
| `committed-net` | the environment's own base (`environment-net`'s immutable baseline commit) → `HEAD`; unavailable until that baseline exists | `changes.scope.committed-net` |
| `staged` | `HEAD` → index | `changes.scope.staged` |
| `unstaged` | index → working tree, untracked included | `changes.scope.unstaged` |
| `commit` | the commit's first parent (or the empty tree) → the commit | `changes.scope.commit` |
| `pull-request` | merge base of the PR base branch and `HEAD` → `HEAD` (local policy, labelled) | `changes.scope.pull-request` |

The Git scopes (`git-scopes.ts`) are computed through the shared admission pool
on every read of a live resource and on the first read of a pinned one, and live
ones are recomputed after each settled environment scan for
`gitScopeDemandTtlMs` (2 min) after the last read. Their resource keys are
`<scope>/environment/<environmentId>/live` (`commit/environment/<id>@<sha>/pinned`).

A view reads a resource once and then follows its events, so reads say nothing
about whether it is still open. The first scan past the window therefore does
not recompute: it marks the resource stale and sends a `reset` event
(`ChangeProjectionEvent`). A view still open reads again, which recomputes and
renews the demand; if nothing is open, nothing answers and no later scan pays for
the scope. A view opened later recomputes on its read, as a first read does. A
missed `reset` is recovered like any other event: a resync re-reads every
registered key. A request that arrives while the scope is computing starts one
more pass after it, because the running pass may have read the tree first.

A thread endpoint includes external changes that survive between its
endpoints. A turn endpoint excludes idle changes because its start is captured
fresh, at dispatch. Neither proves exclusive authorship.

### Counting policy (CountPolicyV1)

Policy ids live in `packages/protocol/src/node/change-tracking/count-policy.ts`.

- **raw-lines-v1** (`RAW_LINES_POLICY_ID`): split on LF, each token keeps its
  terminator, compared as exact bytes. A final unterminated line counts; a
  terminal LF adds no phantom line. LF→CRLF on one line, or adding a missing
  final LF, is one removal plus one addition. Bare CR is not a separator.
  Deterministic bounded Myers edit script, fixed tie-breaking, no whitespace
  suppression. Implementation: `raw-line-diff.ts`.
- Counts and hunks have separate budgets. The Myers forward pass yields the
  edit distance D with O(N) memory, and additions/deletions follow from D and
  the two lengths, so a body too large to render still has exact counts.
  Every limit returns a labelled result (`input-bytes`, `edit-distance`,
  `cpu-budget`); nothing falls back to whole-input lengths.
- **unified-patch-v1**: one hunk-aware parser (`unified-patch.ts`) produces
  both counts and displayed hunks. Inside a hunk the first byte is an
  operation, so `+++counter;` is an addition. Truncated hunks are
  `incomplete`; combined diffs are `unsupported`.
- **Representations**: thread, turn and captured tool scopes compare raw
  captured bytes (`raw-bytes-v1`); environment scopes keep Git semantics
  (`git-representation-v1`, algorithm `git-numstat-v1/git-<version>/M50`);
  provider payloads keep `provider-payload-v1`. Representations are never
  mixed silently; the live single-file detail is labelled
  `git-baseline-vs-worktree-bytes-v1`.
- Rename pairing in raw captures is exact-content only, with deterministic
  path tie-breaking; a modified rename stays delete + add.

### Zero, unknown and partial

`LineCount` is `{ value, quality, bound }`. Zero is a recorded outcome
(`value: 0, quality: complete`). Missing data is `value: null` with
`unknown` (or `not-applicable` for binary/gitlink text). A partial subtotal is
not a lower bound unless `bound` says so. Validators reject a null with an
exact bound and an unknown with a number (`change-measurements.ts`).

### Baselines

`environment-net` keeps the existing creation-commit and integrated-target
rules (`diff-baseline.ts`) and now records the immutable commit its ref
resolved to (`baselineVersion: "<ref>@<oid>"`). A ref that could not be
resolved is labelled `ref:<name>` with reason `baseline-mutable-ref`. A failed
scan keeps the last measurement marked stale; it never publishes zero.

A user-chosen base (`Environment.diffBaseOverride`) wins over those rules.
Right-clicking (or long-pressing) the Changes tab opens a picker with a branch
and then one of its first-parent commits, listed by subject. The choice is
stored as a full SHA, so it stays put when the branch moves, and
`environmentBaselineCommit` returns it everywhere: scans, the sidebar badge, the
panel list and file revert. The typical use is to merge the target branch, then
pick its tip so only this branch's own work shows. Commands:
`list_environment_diff_base_branches`, `list_environment_diff_base_commits`,
`set_environment_diff_base` (`commands-registry-diff-base.ts`,
`diff-base-override.ts`); null `ref` and `commit` restore the automatic base.

## Module map

| Layer | Location |
| --- | --- |
| Portable contracts | `packages/protocol/src/change-evidence.ts`, `change-measurements.ts`, `change-resources.ts` |
| Shared Node algorithms | `packages/protocol/src/node/change-tracking/` (`raw-line-diff`, `unified-patch`, `evidence-measure`, `evidence-selection`, `count-policy`, `evidence-spool`, `evidence-builders`, `evidence-routes`) |
| Backend domain | `apps/backend/src/core/change-tracking/` |
| Commands | `apps/backend/src/core/commands-registry-changes.ts` |
| Bridge transport | `apps/backend/src/core/http-bridge/change-evidence.ts` (pull/ack client) |
| Bridge adapters | `bridges/<bridge>/src/**/change-evidence.ts` (Claude, Codex, Cursor, Pi, ACP/Grok) |
| OpenCode adapter | `apps/backend/src/core/opencode-change-evidence.ts` |
| Public CLI | `changes.view` / `changes.history` actions (`public-api/actions-changes.ts`), `orkestrator changes view|history` |
| Web clients | `apps/web/src/lib/changes/` (subscriptions, labels), `apps/web/src/hooks/useChangeProjection.ts`, `apps/web/src/stores/changeProjectionStore.ts`, `apps/web/src/components/changes/` |

Backend services (one composition root, `service.ts`):

| Service | File | Role |
| --- | --- | --- |
| `ChangeLedger` | `change-ledger.ts`, schema and file `ledger-schema.ts` (`change-tracking.sqlite`; storage migration 4 created the tables, migration 7 moved them out of `orkestrator.sqlite`) | Indexed rows, fences, selections, outbox |
| `ObjectStore` | `object-store.ts`, `manifest-cache.ts` | Content-addressed Git-format objects under `<dataDir>/change-tracking/objects`, staged writes, parsed-manifest cache |
| capture | `capture.ts` | Raw-byte capture with stability rechecks (host and container executors) |
| DiffEngine | `snapshot-diff.ts` | Manifest comparison and body rendering |
| `WorktreeRegistry` / `WorktreeChangeOwner` | `worktree-owner.ts` | Physical identity, incarnation, durable fence, serialized captures, tool windows |
| `ProviderEvidenceIngress` | `evidence-ingestion.ts` | Dedupe, lifecycle reduction, revision selection, chunks, gaps |
| `ChangeMeasurementService` | `measurement-service.ts` | Measurements, supersession, CAS selection, outbox |
| `ChangeProjectionService` | `projection-service.ts` | Server-prepared projections, pages, actions |
| `ChangeResourcePublisher` | `publisher.ts` | Outbox drain, coalesced delivery |
| `EnvironmentChangeProjector` | `environment-projector.ts` | `environment-net` from the shared scan |
| `TurnBoundaryService` | `turn-boundaries.ts` | Pre-dispatch starts, segments, end captures |
| `TurnEndRecoveryScheduler` | `end-recovery.ts` | Background retries of turn end captures that timed out |
| `DiffBodyService` | `diff-bodies.ts` | Immutable bodies, live detail resolution |
| `ChangeHandoffSerializer` | `handoff.ts` | Agent handoff text |
| `ChangeRestoreService` | `restore.ts` | Conditional restore |
| `ChangeRetentionService` | `retention.ts`, `reachability-cache.ts`, `ledger-retirement.ts` | Reachability GC, quotas, per-manifest object ids between passes, environment purges and age-based ledger retention |
| `ChangeTrackingPolicyRegistry` | `policy-registry.ts` | Every budget and cadence |
| shared physical work | `shared-physical-work.ts` | Alias scan joins, refcounted watchers |
| `GitScopeService` | `git-scopes.ts` | `uncommitted-net`, `committed-net`, `staged`, `unstaged`, `commit`, `pull-request` |
| compatibility | `legacy-payload.ts`, `legacy-import.ts` | Legacy payload measurement, backend-generated legacy counts, journal import |

## Physical ownership

`WorktreeRegistry.resolve` turns any alias (relative path, symlink, several
environments) into one `WorktreeIdentity`: host id + realpath root + Git dir
for local checkouts; container id + root for containers. Linked worktrees
sharing a common Git directory stay separate. The incarnation is the root
directory's inode and birth time (local) or the container's creation stamp; a
recreated directory or replaced container gets a new identity row, and the old
one is tombstoned so late events cannot resurrect it.

`DiffStatsTracking` shares physical work across aliases: equal scans join a
queued (never an already-running) scan through `SharedScanQueue`, and
watchers are reference counted per physical root and ref in
`SharedWatcherRegistry`. Logical comparisons — one per environment and
comparison ref — stay separate.

Captures reuse a file's stored object when its stat metadata is unchanged.
A watcher hint naming paths invalidates only those paths' cached stats; a
hint without paths (an overflowing burst) invalidates every reuse.

Each owner claims a durable fence (`change_worktrees.fencing_epoch`) on first
use. Publication transactions call `assertCurrent()`; a stale owner may finish
private work and leave unreferenced objects, but cannot publish, advance a
selection or authorize a restore.

## Object writes and durability

Two rules hold on every path:

- **A name under `objects/` means complete, synced content.** `has` and `reuse`
  only look at the name, so a name over a partial file would be adopted for
  good. A crash can lose a name; it cannot leave a wrong one.
- **A ledger row names an object only after a flush has resolved.** A capture
  flushes before it returns; `resolveLiveDetail` uses `put`, which flushes
  before it returns.

`ObjectStore.batch()` is the write path, and a capture uses one batch per pass:

1. `put` hashes the bytes on the event loop and, under the store lock, checks the
   budget and renews the fence of an object already stored.
2. Outside the lock it compresses (inputs from 16 KiB through the thread pool, at
   most four calls per store, smaller ones synchronously) and writes a
   temporary file under `tmp/`. Nothing is synced yet and the object has no final
   name, so `has`, `reuse` and `get` do not see it. Its bytes count against
   the hard budget, and a sweep leaves a live batch's temporaries alone.
3. `flush` fsyncs the temporaries, 16 at a time off the event loop, then renames
   them under the lock, 256 per hold so a sweep or a renewal can interleave.
4. It then fsyncs every directory with an unsynced name, store-wide, after any
   directory sync already running. So an object another writer has renamed but
   not yet synced is covered too when a capture adopts it. A new fan-out directory
   also syncs `objects/`.

A batch flushes itself at 512 objects or 64 MiB, which bounds its temporaries
and how long `close` can run. `close` publishes what is left even when a capture
was abandoned, because a capture over its deadline must leave its progress for the
retry, as it did when every object was written straight away. What cannot be
published is removed.

A failed fsync (EIO, ENOSPC) fails the capture with `capture-failed`, and a failed
directory stays listed for the next flush. Only a platform or filesystem
that does not support the sync is ignored, as before.

After a crash, unflushed temporaries are removed by the retention sweep once
older than `orphanGraceMs`, and every surviving name is intact. A new store
process queues all its fan-out directories for its first flush, because the
previous process may have stopped before syncing them.

New objects take their orphan fence from the temporary's write time, at most a
capture's deadline before the rename, so the half-grace reasoning in
[Retention and backup](#retention-and-backup) is unchanged. An object another
writer placed first has its fence renewed at the rename.

Still on the event loop: `confinedRead` and two SHA-1 passes over a large file
(about 5 to 7 ms each at 16 MiB), and the JSON work on a large manifest.

Evidence bodies (`EvidenceBodyStore.put`) follow the same rules without a
batch, because ingestion stores bodies one at a time: the temporary is synced
before its rename and the fan-out directory (and any parent `mkdir` created)
after it, both awaited off the event loop, before `put` resolves. Only then does
ingestion commit the ledger row and acknowledge, which lets the bridge release
its copy. Directory syncs are store-wide, so concurrent puts share one, and
adopting a body whose directory sync is pending or failed waits for, or retries,
that sync. A failed sync rejects the put, so the frame is not acknowledged.

## Manifest cache

`readManifest` reads through `ObjectStore.manifests`: one LRU per store of parsed
manifests by object id, bounded at 32 entries and 128 MiB estimated (twice the
serialized size, against 1.4 measured on the heap at 100,000 entries, which is
about 28 MiB for one such manifest). A manifest over the byte bound alone is
parsed on every read. A capture leaves its own manifest there.

- **Immutable.** Every reader shares one copy, so it is deep-frozen and the
  `Manifest` type is `readonly` throughout. Copy before changing anything.
- **Never an answer for a removed object.** A hit costs one `stat`, and a missing
  object answers null, so an expired snapshot still reads as `body-expired`. A
  file corrupted on disk after it was cached is not noticed on a hit; the cached
  copy was verified when it was read.
- **Retention does not fill it.** `readManifest(store, id, { scan: true })` uses a
  hit but keeps nothing, so one pass over every snapshot cannot evict what live
  views are using. Retention keeps its own, smaller cache instead (see
  [Retention and backup](#retention-and-backup)).

Entries are sorted by path bytes, as every stored manifest has been since the
first capture. `findManifestEntry` binary-searches on that order for diff pages
and restore; UTF-16 string order differs for astral paths. The whitespace-ignore
view renders each file once, with `ignoreWhitespace` passed to
`renderSnapshotBodies`, so when a diff limit is reached the file names the limit
of the diff it actually shows. It renders the whole page in one call, as the
normal view does, so the page's `maxBatchBytes` bounds both views and later
files on a large page show `changes.body.batch-limit`.

## Evidence pipeline

1. **Adapter** (bridge or backend OpenCode) decodes native events and calls
   `ChangeEvidenceRecorder` (`evidence-builders.ts`). It never counts lines.
2. **Spool** (`ChangeEvidenceSpool`): bounded, optionally persisted; appends
   are synchronous and never await the backend. Capacity loss becomes an
   explicit `stream-gap` frame.
3. **Pull**: the backend activity sweep calls `GET /change-evidence` per
   bridge connection after its activity read, fetches bodies
   (`GET /change-evidence/body`), commits them to the ledger, then
   acknowledges (`POST /change-evidence/ack`). An in-memory read is never an
   acknowledgment; bodies are released only when retained or durably
   recorded unavailable.
4. **Reduce**: one operation per native call identity (+ native attempt id);
   terminal phases never regress; a replace revision becomes selected only
   when the adapter declared it supersedes the selected one or a verified
   source sequence orders it later.
5. **Measure and select** (`MeasurementSelectionPolicyV1`): proposals and
   reported results never compete; within a claim a complete patch outranks
   result replacements, then input replacements, then reported counts. A
   captured fresh-boundary observation outranks a provider-reported effect;
   an after-start observation is an `observation-window`, never a tool
   effect. Disagreeing native counts become a discrepancy reason.
6. **Publish**: measurement, file rows, diff identity, CAS selection and
   outbox row commit in one transaction; the publisher announces after commit.

### Writing a provider adapter

- Build one `ChangeEvidenceRecorder` per bridge process with the provider's
  **resolved** capabilities; leave anything unverified as `unknown`.
- Emit a `tool` frame on every lifecycle change with the native call id.
  Replacement sides: a string is present content, `null` is established
  absence, `undefined` is unknown (with `unknownReason`). A Write whose prior
  state was not captured has an unknown before side — never `""`.
- Keep proposal (`claim: "proposal"`, `origin: "input"`) and applied results
  (`claim: "provider-reported"`) as separate evidence blocks. Keep native
  counts as `reported-counts` with their declared meaning (`linesCreated` is
  `contentLines`, not additions over an existing file).
- Report probe windows with `observation()` from `endObservation()`; the
  backend decides scope and adds cross-bridge overlap.
- Replayed history uses `mode: "history"`; it is never re-measured from
  today's disk.

## Turn and thread boundaries

`NativeAgentService.dispatchAdmittedPrompt` captures the turn start inside the
at-most-once dispatch window, immediately before `provider.send`, bounded by
`foregroundBoundaryDeadlineMs` (10 s, a cutoff not a target). A failed
capture is recorded before dispatch; by default the turn proceeds with an
explicit unavailable start (`strictCheckpoints: true` holds dispatch). Only an
accepted dispatch activates the staged segment baseline. The turn-end edge
(`onActivityTransition` to idle) first pulls the provider's pending evidence,
then captures the end and publishes `turn-net` and `thread-net`. If the
provider's terminal turn report still says `may-write`, or one of the turn's
background tasks is still running, writers have not settled: the turn is
published `interrupted` with a running-observation end, never silently final. While a turn runs, watcher hints drive provisional captures at
most once per second locally (five remotely). A provisional capture whose tree
and consistency match both the turn's and thread's latest published provisional
measurements publishes nothing:
every capture has a new snapshot id, so a publish would store the whole file
list again. Its snapshot row is unreferenced and goes with the retention sweep
after `orphanGraceMs`. A turn's end always publishes.

The end capture has `finalizationDeadlineMs` (30 s). A turn that wrote tens of
thousands of files can run past it on a busy host; it then ends on time as
`end-unavailable` (reason `capture-timeout`) with no after endpoint, so it has
nothing to restore. `TurnEndRecoveryScheduler` (`end-recovery.ts`, todo 7310, retired)
retries that capture in the background, without holding the turn: purpose
`turn-recovery` (progress priority), `endRecoveryDelayMs` (5 s) after the turn
ended and between attempts, each with `endRecoveryDeadlineMs` (5 min), at most
`endRecoveryAttempts` (3) times. A publish appends a superseding final
measurement whose after boundary is `later-recovery` and whose reason is
`end-captured-later`, as the late settlement of an interrupted turn does; the
turn row keeps its unavailable end. The retry runs only while the turn's known
writers have settled (a turn whose writers were unresolved is offered again
when they settle) and gives way for good once a later turn of the thread, or
any other turn on the worktree, has run since the turn ended, whose writes a
capture would now absorb. It re-checks that inside the publication
transaction, and a new turn's start cancels a running retry instead of queuing
behind it. When every attempt runs out the turn's reason becomes
`capture-timeout-unrecovered`; a restart re-offers the newest turns still at
`capture-timeout`. Edits made outside any turn between the end and the retry
are still absorbed; the `later-recovery` boundary says so, and restore stays
conditional on each file still holding the measured after-state.

A thread moving to a different worktree lineage opens a new segment; segments
are never compared to each other as one history.

A forked conversation (`forkProjectionSession`) records its lineage: the
child's first segment names the parent segment as `inherited_prefix_id` and
holds its own references to the parent's snapshots, so deleting the parent
never removes history the child shows. The child's own baseline is still
captured fresh at its first dispatch, and bridges emit no frames for
inherited rows, so nothing is counted twice.

Live operations (tools, provider turn reports and background tasks) are
associated with the backend turn running in their thread (`opturn:` and
`turnops:` ledger meta) for that turn's recorded edit activity and writer
settlement.

## Client contract

Commands (`commands-registry-changes.ts`):

| Command | Purpose |
| --- | --- |
| `changes_get_view` | Projection, `unchanged`, `reset` or `deleted` (conditional on generation + revision) |
| `changes_get_files` | Revision-pinned file page; `stale-cursor` across revisions |
| `changes_get_tool_presentations` | Tool presentations and summary projections for transcript rows |
| `changes_get_history` | Persisted turns of a thread, paged; no worktree scan |
| `changes_get_thread` | The thread's current segment resource |
| `changes_resolve_live_detail` | Live row of `environment-net`, `uncommitted-net` or `committed-net` → immutable file identity, or `stale-revision`; `committed-net` reads `HEAD`'s blob, never the working tree, and Git-filtered rows are refused |
| `changes_get_diff` | Backend-rendered hunks for a diff identity; `body-expired` never falls back to disk |
| `changes_refresh` | Fenced refresh; settles only on a pass started after the request |
| `changes_get_handoff` | Backend-serialized handoff text |
| `changes_prepare_restore` / `changes_apply_restore` | Conditional restore |
| `changes_get_diagnostics` | Content-free operator diagnostics |
| `changes_get_capabilities` | What this backend offers (history, restore, Git scopes, volume); clients gate actions on it |
| `changes_measure_legacy_payload` | Backend measurement of a legacy transcript payload (rows recorded before evidence existed) |

Events: `change-projection-changed` carries `projection`, `deleted`, `reset`
or `content-invalidated` (file bytes may have changed with equal counts).

A measurement past the file row cap (see
[Retention and backup](#retention-and-backup)) is `partial` with reason
`file-rows-capped`, and its totals and `changedFiles` still count every file.
`filePage.totalRows` is the rows stored, where paging ends, and
`filePage.omittedRows` is the files with no row, which no cursor reaches. The
field is optional, so an older client keeps paging to `totalRows` and reads the
reason. A diff of a capped comparison ends at the same rows. An explicit
current-file action on `environment-net` still opens a path with no row, with
its unknown side marked. A Git scope refuses one with `not-found` and the
`file-rows-capped` reason, because it cannot tell whether the path is in the
scope.

Clients format numbers and localize label keys (`apps/web/src/lib/changes/labels.ts`).
They never count lines, choose evidence, sum pages or treat a missing count as
zero. `tests/unit/change-tracking-boundaries.test.ts` enforces this for the
renderer (no line counting, diffing, provider-tool classification, provider
SDKs or two-buffer diff editors) and keeps the portable contracts free of
platform and provider imports.

### Surfaces

| Surface | Resource |
| --- | --- |
| Sidebar badge and hover | `environment-net` projection (`EnvironmentItem.tsx`); legacy store only for a backend without tracking. Another machine's rows read the same projection through the command node and its relayed events (`lib/federation/node-change-projections.ts`, see [command-nodes.md](command-nodes.md#portal-aggregated-interface)) |
| Files → Changes | rows of the same measurement, paged by snapshot token (`useEnvironmentChangeRows.ts`); no 5 s change poll while a projection exists |
| Files button dot | the environment projection's badge visibility |
| Thread header and turn list | `thread-net`, `turn-net`, `provider-turn-diff` and `operation-volume` as separate lines (`ThreadChangesHeader.tsx`, `TurnChangesHistory.tsx`) |
| Edit and shell rows | `CanonicalToolPresentation` roles (payload, effect, observation) with backend hunks (`NativeMessage.change-parts.tsx`); legacy rows measured by `changes_measure_legacy_payload` |
| Claude tmux transcript | the backend reading the JSONL stamps each `tool_use`'s path and payload sides on the line (`toolDiffs`, `tmux-transcript-tool-diffs.ts`); the store never interprets tool inputs, and counts come from `changes_measure_legacy_payload` |
| Diff tab | historical `DiffIdentity` or explicit live current-file target; backend hunks, split/unified, whitespace view (`DiffViewerTab.tsx`) |
| Restore | preview/apply dialog gated by the capability and the projection's `restore` action (`RestoreChangesButton.tsx`) |
| Agent handoff | The backend writes the same serializer's text per tool call when it builds the handoff (`agentHandoffChangeSummaries`, `agent-handoffs.ts`); unmeasured calls say "changes: not measured" |
| CLI | `orkestrator changes view <environment>` / `changes history <session>` |

Older clients that still read the legacy `toolDiff` shape receive
backend-generated CountPolicyV1 counts in it (`legacyCompatibilityCounts`); a
count the old shape cannot express exactly is omitted instead of guessed.

## Policies

All budgets live in `ChangeTrackingPolicyRegistry` (`policy-registry.ts`),
version `change-tracking-policy-v1`. Starting values: shared admission is the
existing `git-docker-scan` pool (4 jobs, 1 per target) with at most 2 remote
captures; 10 s foreground boundary; 100,000 candidates; 16 MiB/file and
256 MiB/capture retained; 1 s/5 s provisional spacing; 250 ms live-body
coalescing; 2 min Git-scope demand; 200 rows / 256 KiB pages; 2,000 file rows per measurement; 1 GiB soft / 4 GiB hard snapshot
storage; 30-day archived retention (a maximum subject to quota, not a
guarantee); restore preflight 5 ms per planned path, at least 10 s and at most
5 min; restore checkpoint and result captures the larger of that and the 30 s
finalization deadline; three background end-capture retries, 5 s apart, 5 min
each. Capture policy changes affect future work; the archive window applies
to existing history on the next retention pass.

## Restore

`changes_prepare_restore` checks every destination against the measured
after-state (content and mode) and issues a fenced, expiring token.
`changes_apply_restore` is idempotent by key, takes a recovery checkpoint,
re-checks each file at the executor immediately before writing (temporary
sibling + rename), skips anything the user changed since, and records a
partial outcome honestly. There is no blind reset and no all-or-nothing claim.
A measurement past the file row cap takes its plan from the same two manifests
(`compareManifests` with `pathsOnly`, which reads no blob), so a restore stays
complete whatever the list shows, and an expired manifest refuses as before.

The preview's destination preflight reads and hashes each planned path in
turn, so its deadline grows with the plan: 5 ms per path with a 10 s floor
and a 5 minute ceiling (`restorePreflightDeadlineMs`). A preflight that still
runs out answers `changes.restore.runtime-unavailable`, never a partly checked
plan. Measured on 2026-11-06 on an isolated profile, every plan a delete per
file ([todo 4960](../todo/cross-cutting/4960-measurement-rows-live-soak.md)):

| Files | Quieter host | Load average 50 to 63 on 18 cores |
| --- | --- | --- |
| 2,100 | 0.23 to 0.38 s | 1.5 to 2.3 s |
| 10,000 | not run | 4.4 to 15.0 s (the old fixed 10 s refused two of three) |
| 20,000 | not run | 26.8 to 35.0 s |

Past about 20,000 files under that load, and at 60,000 written at once on a
quieter host, the turn's own end capture ran out of its 30 s deadline, so the
turn had no restorable measurement. Such a turn is now captured again in the
background (see [Turn and thread boundaries](#turn-and-thread-boundaries)).

The apply's recovery checkpoint and its result capture used a fixed 10 s; a
checkpoint that does not publish refuses the apply with
`changes.restore.checkpoint-unavailable` before writing anything. The
checkpoint is what makes an apply recoverable, and the user is already
waiting on an explicit action, so both now get the larger of the turn
finalization deadline (30 s) and the preview's plan-scaled deadline
(`restoreCaptureDeadlineMs`). The apply itself writes each file through its
own conditional-write helper process after its own destination check, so it
costs about 40 ms per file under load.

`bun scripts/benchmark-change-tracking.ts --only=restore-apply` runs one turn
that writes `--restore-files` new files through the whole service on a real
repository, then times the preview and apply end to end (each plan a delete
per file). On 2026-11-09 on a shared 16-core Linux host at a load average of
48 to 60, with the worktree on disk, not tmpfs (todo 7310, retired):

| Files | Turn end | Preview | Checkpoint (deadline) | Apply | Restored |
| --- | --- | --- | --- | --- | --- |
| 10,000 | end capture published, 12.5 s | 2.1 s | 0.6 s warm (50 s) | 390.7 s, 39 ms per file | 10,000 of 10,000 |
| 20,000 | end capture published, 18.0 s | 4.7 s | 1.2 s warm (100 s) | 847.9 s, 42 ms per file | 20,000 of 20,000 |
| 10,000, finalization deadline cut to 2 s, stat cache dropped before the apply | timed out at 2.0 s; background recovery published in 6.9 s | 1.0 s | 3.3 s cold (50 s) | 442.4 s, 44 ms per file | 10,000 of 10,000 |

A warm checkpoint follows a published end capture, whose stat cache it
reuses. A cold one (`--restore-cold`, as after the idle owner was swept)
read and hashed every generated file: 3.3 s for 10,000 files is a third of the
old fixed 10 s, so 20,000 or more under heavier load would have been refused.
`--restore-finalization-ms` shortens the turn's end deadline to exercise the
recovery; at the real 30 s both sizes published on this host this time,
although 4960 saw 20,000 time out at a load average of 57 to 63.

The same restores were then driven end to end on 2026-11-10 on an isolated
`dev:test` profile (`--fixture --no-agent-credentials --agent-platforms claude
--headless`, `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`) on the same 16-core
host, by the 4960 method: a new local fixture environment per size, a real
Claude CLI and bridge answered by the loopback model in
`e2e/agent-testing/fake-anthropic-model.ts` (no billed turn), N small files
written under `generated/` while the model held the turn, then
`changes_prepare_restore` and `changes_apply_restore` through the browser
gateway, each timed from the driver. Every plan was N deletes. Capture times
come from the profile's `change_capture_attempts` rows; load is the one-minute
load average from `/proc/loadavg`.

| Files | Load (at apply → after) | Turn end capture | Preview | Checkpoint (deadline) | Apply | Restored |
| --- | --- | --- | --- | --- | --- | --- |
| 10,000 | 53 → 55 | published, 2.8 s | 0.75 s | published, 0.53 s (50 s) | 304.9 s, 30 ms per file | 10,000 of 10,000 |
| 20,000 | 57 → 8, the host emptied during the apply | published, 8.1 s | 1.9 s | published, 0.37 s (100 s) | 264.2 s, 13 ms per file | 20,000 of 20,000 |
| 10,000 | 8 → 10 | published, 1.0 s | 0.61 s | published, 0.17 s (50 s) | 144.2 s, 14 ms per file | 10,000 of 10,000 |
| 20,000 | 2 → 1 | published, 1.3 s | 0.93 s | published, 0.43 s (100 s) | 210.9 s, 11 ms per file | 20,000 of 20,000 |
| 10,000 | 1 → 46, the host filled during the apply | published, 0.56 s | 0.66 s | published, 0.49 s (50 s) | 189.1 s, 19 ms per file | 10,000 of 10,000 |

Every checkpoint and result capture published, warm, in under a second, and
no restored file was left behind in the worktree. The restore-result capture
took 0.1 to 0.16 s. The gateway held the 305 s apply request open and
answered it; whether the restore dialog or the desktop IPC path waits as long
is [todo 7555](../todo/cross-cutting/7555-restore-apply-throughput.md) task 2.
At a load of 1 to 10 the apply still cost 11 to 14 ms per file, so most of
the busy-host 30 to 40 ms is the per-file helper process, not only load.

A client that reads `changes_get_history` the moment a bulk turn's lifecycle
turns `finalized` can still be given the turn's provisional measurement: the
final one and its selection are written by the publication that follows the
end capture, 0.9 to 1.4 s later at 10,000 and 20,000 files on the quiet host.
A preview of the provisional measurement answers
`changes.restore.no-retained-endpoints`; re-reading the history gives the
final one, which restores. The restore dialog is gated by the projection's
`restore` action instead. [Todo 7554](../todo/cross-cutting/7554-history-names-provisional-measurement-after-finalize.md)
owns the gap.

Apply throughput at bulk sizes is
[todo 7555](../todo/cross-cutting/7555-restore-apply-throughput.md).

## Retention and backup

Roots: ledger references (thread baselines, turn endpoints, live pins),
active turns, open windows, pending captures and in-flight readers. Objects
are swept only after `orphanGraceMs`. Soft-budget pressure releases the
oldest archived turn endpoints; the hard budget refuses new captures with an
explicit reason. A removed body answers `body-expired` with retained counts.

An object's mtime is its orphan fence: it protects an object a capture has
adopted but no ledger row names yet. `ObjectStore.reuse` reads the fence with
one `lstatSync` and leaves it alone while it is younger than half the grace,
which leaves at least the other half for the capture's deadline and the sweep's
walk of the ledger. An older fence is renewed under the store lock, so a renewal
can never land between a sweep's `lstat` and its `rm`. The capture's closure
check skips objects it wrote or proved present in the same pass, unless
`removedObjects` shows a sweep removed something since the pass began.
`capture-orphan-fence.test.ts` races retention against a capture on both sides
of the half-grace boundary.

A sweep walks the store without the lock, collecting old unreachable objects one
fan-out directory at a time, then takes the lock per 64 candidates to `lstat`
each again and remove it. The mtime read under the lock decides, so a renewal
that lands after the walk saw an old fence keeps its object, and captures write
while a sweep walks. Abandoned temporaries are removed the same way, re-checking
that no live batch owns the name.

The store keeps its compressed byte count current: a placed object adds its
size and a sweep subtracts what it removed, so a retention pass reads the figure
(`ObjectStore.currentBytes`) rather than walking every object twice. Missing
manifests invalidate accounting immediately; a daily recount under the store
lock also reconciles external changes to reachable or young objects. Puts use
the same daily reconciliation before checking the hard budget. The store
walks once when it has no figure yet (after a restart), and again after a sweep
finds a candidate already gone, which only something outside the store can
cause.

Reachability comes from the ledger's snapshots, each manifest read once per pass
even when several snapshots share a tree. `ReachabilityCache`
(`reachability-cache.ts`) keeps the object ids each manifest names, 20 bytes
each, between passes: at most 4,096 manifests and 32 MiB. A pass reads every
manifest in the same order, which would make least-recently-used eviction miss
every time once the history outgrows the bound, so an entry is admitted only
while there is room, and one that a completed pass did not walk (no snapshot
names that tree any more) is dropped at the end of that pass. A hit still
requires the manifest object, so a manifest that is gone contributes nothing,
as a read would. `retention-store-walks.test.ts` covers the byte count, the lock
and the cache.

File rows are bounded per measurement. `measurementFileRowCap` (2,000) applies
when a snapshot pair, an environment scan or a Git scope is measured, never
afterwards, because a sealed measurement is immutable. Past it the rows with
text changes are kept first, then the rest, each by path. `status: unknown` rows
count against the cap, and each dropped file adds to `omittedFileCount` unless
the comparison already counted it there. The measurement id still digests the
full list, so a change past the cap makes a new measurement. Rows an earlier
build stored stay readable as complete and go when they are superseded, so no
migration exists. Provider-reported lists (payloads, observations, legacy
summaries) carry their own bound and are not capped here.

Measurements are pruned too. Every re-measurement stores its file list again,
so superseded ones would otherwise grow `change_measurement_files` without bound.
`ChangeLedger.pruneSupersededMeasurements` deletes a measurement, its file
rows and diff identities once two newer ones of the same owner and scope
exist, unless a selection, an unexpired restore token or a running restore
still holds it. In-flight diff requests pin their measurement until the read
finishes, including errors. Retired identities are removed before file rows
are drained, so new requests cannot start reading a partially deleted measurement
(a handoff naming a pruned one says "not retained"). Each publication prunes
up to two of its owner's, at most 256 file rows, inside its own transaction. When
that does not finish, `ChangeRetentionService.drainOwner` drains the rest right
after the commit: one drain per owner and scope, in batches of at most 256 file
rows, yielding between transactions, and it stops at shutdown. Its failure is
logged and left to the retention pass. The retention pass (two minutes after
start, then hourly) prunes any other backlog the same way: it walks the owner
index 512 owners a page (`supersededOwnersPage`, which reads only that covering
index), yielding between pages, and prunes each owner with more than it keeps
through its own index range. It then releases free pages in 128-page steps,
whoever freed them. One query over every measurement used to find the backlog;
at 85,000 measurements it took 24 s with a cold page cache, once per batch
([0741](../todo/cross-cutting/0741-backend-responsiveness-under-load.md) task 6). Existing databases created
without incremental auto-vacuum reuse freed pages but do not physically shrink;
backup headroom is calculated from live pages rather than allocated file size.

The ledger lives in its own database, `change-tracking.sqlite`, beside
`orkestrator.sqlite`, with WAL, secure delete and its own schema version.
The ledger explicitly uses `synchronous = NORMAL`; the main storage database
and other `StorageDatabase` callers default to `FULL`. NORMAL avoids syncing
the WAL after every ledger commit (checkpoints still sync). In WAL mode NORMAL
cannot corrupt the database, but the last few committed ledger transactions may
roll back after a power loss or OS crash. An application crash or SIGKILL loses
no committed transactions. See [SQLite's synchronous guarantees](https://www.sqlite.org/pragma.html#pragma_synchronous).
Nothing joins or writes across the two files.
Hourly snapshots copy `orkestrator.sqlite` only, so a small app-store change no
longer copies the ledger. The ledger has its own best-effort snapshots in
`<dataDir>/backups/`: `change-tracking-daily-<stamp>.sqlite` once a day when it
changed (the newest two kept, and the first to give way to the 16 GiB
budget), and `change-tracking-pre-migration-v<from>-<stamp>.sqlite` before its
schema migrates. See [storage.md, Snapshots](storage.md#snapshots) for
rotation and restore. The retention pass runs `PRAGMA optimize` on the ledger
after it returns free pages.

Neither snapshot holds `<dataDir>/change-tracking/` (objects and evidence
bodies), and metadata alone cannot serve historical bodies, so a full backup
of change history needs that directory as well as `change-tracking.sqlite`.
A ledger restored without it, or older than the app database, answers the
bodies and measurements it lacks as expired or not retained.

### Deleting an environment

`deleteEnvironment` calls `ChangeTrackingService.environmentDeleted`, which never
deletes a ledger row itself, so a delete does not hold the write lock for a large
ledger. It tombstones the worktrees only that environment's rows name, records
a durable `purge-env:<id>` entry and asks for a pass in 30 seconds. From then on
the service drops the environment's late scans, evidence pulls and turn starts
(`removed` still reaches clients); a restart reloads that list from the entries.

The pass deletes the environment's bindings, frames, operations, evidence,
chunks, gaps, turn boundaries, segments, windows, measurements, selections,
references, restore records and its `conv:`, `fork:`, `opturn:`, `turnops:` and
`pturn:` keys, at most 256 rows per transaction, yielding between them. It deletes
rows and references only: the sweeps then take the snapshots, objects and evidence
bodies nothing names any more. So content another environment still names stays,
and a checkout another environment uses is not tombstoned. An entry stays until
the orphan grace has passed, so a late write that was already under way when the
environment was deleted is found by the next pass. Content can therefore outlive a
delete by up to an hour past its own grace fence.

A measurement a restore or reader still needs (an unexpired token, an `applying`
operation, a pinned read) defers that environment's whole purge to a later pass;
tokens last five minutes. The sweep also keeps those measurements' endpoints
whatever released their references, so quota pressure cannot take them either.

A tombstone also retires the row's identity key, so a new environment at a kept
checkout (same path, inode and birth time) gets a fresh row instead of colliding
with it. Source keys of evidence cursors name no environment, so a purge removes
only the cursors of sources this process saw; the rest age out with the window.

`retention-deletion.test.ts` proves these boundaries. Removing a project does not
touch any of this directly; what happens to a removed project's own stores is
[5820](../todo/cross-cutting/5820-removed-project-kanban-notes-plans.md).

### Age-based retention

`archivedBodyRetentionDays` (30) is the one window, measured from `finished_at`.
Existing ledgers use the 30-day window on the first pass after the change;
turns aged between 30 and 90 days expire through the same bounded batches and
yields, with leftovers handled by later passes. No bulk migration is needed.
Past it a terminal turn loses its measurements, selections, references, capture
attempts and `turnops:` and `pturn:` keys, oldest first from a durable cursor
(`retention:turn-cursor`), so a pass never walks a retired turn again. Its boundary
row stays, because ordinals and the thread's history list read it. `getHistory`
lists the turn with a null measurement, and its view answers `unavailable` with
`changes.reason.history-expired`; an older renderer shows that reason's generic
fallback. A restore that holds a turn ends the walk until a later pass.

An operation has no time of its own, so frames set its age: they are deleted
oldest first (row order is age order, so no index is needed), and the newest
sequence deleted (`retention:expired-seq`) says which operations have had no frame
inside the window. Such an operation goes with its evidence, chunks, windows,
measurements and selections, unless its turn is still retained. Provider turn
diffs age the same way, by their newest evidence: the pass walks evidence in row
order, which is ingestion order, and stops at the first row inside the window. A transcript row whose operation
has gone reads as an untracked call. Capture attempts, gaps, restore tokens and
finished restore operations, cursors with nothing left to acknowledge and bindings
with nothing left under them go once they are past the window too.

A closed segment goes with its baseline pin once none of its turns is retained. An
open segment stays whatever its age, because its thread can take another turn and
thread-net would otherwise lose its baseline, so a very long-lived thread holds a
baseline for as long as its environment lives. Finished boundaries are not pruned
until a measured table size justifies a policy
([5821](../todo/cross-cutting/5821-ledger-retention-live-evidence.md)).

Evidence bodies are swept like objects: `EvidenceBodyStore.sweep` walks without the
store lock, and the mtime read under the lock decides. Adopting a stored body
renews its fence, and `retainBodies` fetches it again if it has gone. Reachability
comes from `change_evidence` and `change_evidence_chunks`, a page at a time. A
frame's `raw` slice has no row naming it, so it goes at the grace; no producer
sends one today and nothing reads one.

A pass works through at most 4,096 batches, so a first run on an old ledger takes
several passes. Each transaction is bounded (256 rows, 32 snapshots, 16 quota
releases, one page of diff identities) and followed by a yield. The indexes behind
purges and the age walk (`change_turn_boundaries_environment`,
`change_thread_segments_environment`, `change_turn_boundaries_age`), and three that
keep per-row checks off whole-table scans (`change_selections_measurement` for a
pruning candidate's selection, the partial `change_tool_windows_open_only` for
open windows, the partial `change_evidence_provider_turn_frames` for a purged
binding's provider turns), are created at service start without a schema
version, as `store_rows_position` is ([storage](storage.md#stores-and-layouts)),
so an older build still opens the ledger. On a ledger of 2.8M rows the three
took about 2.2 s together, once. `ledger-scan-plans.test.ts` plans every
statement a publication, a pull, a pass and a purge issue and fails on any that
walks a large table; `scripts/efficiency/ledger-scale.ts` measures the stalls at
production size ([efficiency harness](../development/efficiency-harness.md#ledger-at-production-scale)).

Backups must include both `orkestrator.sqlite` and
`<dataDir>/change-tracking/` (objects and evidence bodies); metadata alone
cannot serve historical bodies.

## Operator runbook

- **Identify an owner**: `changes_get_diagnostics` lists active owners, open
  windows, active turns and publisher counters (no paths or contents).
- **Inspect a capture failure**: query `change_capture_attempts` in `change-tracking.sqlite` by id
  (`status`, `error_code`, `purpose`); reasons are finite codes.
- **Pause new tracking**: set the policy `restoreEnabled: false` and/or
  `strictCheckpoints: false`; environment scans continue independently.
- **Recover the outbox**: undelivered rows in `change_outbox` are drained at
  startup; delivery is idempotent.
- **Verify object-store integrity**:
  `git --git-dir="<dataDir>/change-tracking/objects" fsck --no-dangling`.

## Benchmarks

`bun scripts/benchmark-change-tracking.ts` (guide §13.3 workloads). One run on
the development machine (macOS, local SSD, 5 warm runs each) on 2026-10-20 —
measurements for tuning, not guarantees:

| Workload | Result |
| --- | --- |
| 100 files, one changed | cold capture 46 ms; warm 20 ms p50; compare 0.2 ms |
| 1,000 files, one changed | cold 233 ms; warm 47 ms p50; compare 0.4 ms |
| 10,000 files, one changed | cold 2,326 ms; warm 307 ms p50/311 ms p95; compare 1.6 ms |
| ten equal-demand clients | 2 physical scans (one running, one shared fresh pass) — same as two sequential requests |
| ten environment aliases (symlinks) | 1 physical owner |
| raw-lines count, 100,000 lines ~1% changed | 50 ms p50 |

Warm captures reuse stat-identical blobs (`metadataReused` in coverage) and
store only the changed blob and the new manifest.

`--only=measurement-rows` runs one environment through the whole service on a
temporary database: a turn adds `--bulk-files` files under one directory, runs 6
provisional passes that move the tree and 6 that do not, and ends, and the
environment scan then reports the bulk list 12 times with one path changing.
One run each, on 2026-11-04 on a shared Linux host, against an export of the
base commit `e198fd4a7` and the code with the row cap. Peak and "before the
retention pass" include the backlog the hourly pass would clear.

| Measure | 20,000 files, before | 20,000 files, after | 58,051 files, before | 58,051 files, after |
| --- | --- | --- | --- | --- |
| Measurements written | 38 | 26 | 36 | 24 |
| File rows written | 760,026 | 52,000 | 2,089,860 | 48,000 |
| Peak file rows kept | 751,834 | 12,000 | 2,082,180 | 12,000 |
| Peak database file | 173.5 MiB | 3.5 MiB | 479.1 MiB | 3.5 MiB |
| File rows after the retention pass | 120,004 | 12,000 | 348,310 | 12,000 |
| Database file after the retention pass | 27.8 MiB | 3.1 MiB | 80.3 MiB | 3.1 MiB |

The 12,000 is the bound: three owners (turn, segment, environment), two kept
measurements each, 2,000 rows each. It does not grow with the bulk size. At
58,051 files two provisional passes published nothing on either side; why was
not investigated. Proof on a real busy profile is
[todo 4960](../todo/cross-cutting/4960-measurement-rows-live-soak.md).

A host capture does not read or hash a file whose stat stamp
(size, mtime, ctime, inode) matches a *settled* stat-cache entry: one whose
mtime and ctime were already `STAT_SETTLE_WINDOW_MS` (2 s) old when it was
read. A younger file is read on every capture, because a same-size rewrite
inside one filesystem timestamp tick leaves the stamp unchanged (Git's
"racily clean" case). A watcher hint for a path drops that path's entry, so
the next capture reads it whatever its stamp says. Container captures still
hash every file in place. Comparisons memoise line counts by blob pair in a
bounded LRU (`snapshot-diff.ts`; 8,192 entries, 4 MiB estimated); a hit is
used only while the store still holds both blobs, and unavailable bodies and
`cpu-budget` limits are never cached.

The efficiency report's fixtures (`--only=assets,long-turn`), measured on
2026-11-02 on a shared Linux host under heavy load (load average 25 to 34),
three interleaved runs each of the code before and after ST-1, ST-2 and
ST-4, 10 warm runs per workload, p50 range:

| Workload | Before | After |
| --- | --- | --- |
| 1,000 files, one changed: warm capture | 114–261 ms | 47–141 ms |
| 10,000 files, one changed: warm capture | 2,330–2,494 ms | 615–1,201 ms |
| 200 files + 20 × 8 MiB assets, one changed: warm capture | 281–505 ms | 13–44 ms |
| Long turn, 200 changed files compared with the turn start each pass | 149–435 ms | 6–18 ms |

The long turn's first pass still computes all 200 pairs (its p95). What
remains of a warm capture over many small files is the object store's
per-entry `reuse` (`utimes`) and the closure check (`has`), about 230 ms each
per 10,000 files in one profiling run (ST-3 in the efficiency report).

The store's write and read paths (`--only=large-blob,durable-cold,manifest`,
`--runs=7`), measured on 2026-11-04 on the shared Linux build host, btrfs, load
average 3 to 18, three interleaved runs each of the code before and after ST-5
and ST-6, p50 range unless stated. These fixtures fsync for real, so `TMPDIR` has
to point at a real disk:

| Workload | Before | After |
| --- | --- | --- |
| 16 MiB changed file captured durably: longest event-loop stall, p50 of runs | 107–143 ms | 12–13 ms |
| Same: longest stall in any run | 109–188 ms | 13–21 ms |
| Same: capture duration, p50 | 148–234 ms | 276–321 ms |
| 1,000 files, cold durable capture: duration, p50 | 3,338–4,108 ms | 632–1,130 ms |
| Same: longest event-loop stall, p50 of runs | 560–661 ms | 2.8–5.2 ms |
| Manifest of 100,000 entries: repeat read, p50 | 26.9–34.9 ms | 0.02–0.10 ms |
| Same: first read, which now freezes it | 39–46 ms | 93–140 ms |
| Same: lookups for one 20-row diff page, p50 | 6.4–11.1 ms | 0.04–0.09 ms |
| 10,000 files, one changed, not durable: warm capture, p50 | 113–200 ms | 129–177 ms |
| Long turn, 200 changed files, not durable: compare, p50 | 8.3–11.1 ms | 5.7–13 ms |

A capture of a large file takes longer in total because compression runs through
the thread pool; it no longer holds up every other client while it does. The
first read of a large manifest pays for freezing it, once.

The hourly retention pass (`--only=retention`): 400 referenced snapshots, each a
distinct tree of `--retention-files` real blobs, 8 manifests open as diff views
would leave them, nothing removable. Measured on 2026-11-05 on the macOS
development machine (temporary directory on the internal disk, load average
about 20 to 34 from other worktrees' suites), one run of the code before ST-20
and one after at 2,000 files, two (the ranges) at 10,000. Each row is the second
of two passes in a row unless stated:

| Workload | Before | After |
| --- | --- | --- |
| 2,000 files: pass duration | 565 ms | 87 ms |
| Same: manifests parsed | 392 | 0 (400 reachability hits) |
| 10,000 files: pass duration | 2,760 ms | 1,682–1,718 ms |
| Same: manifests parsed | 392 | 225 (167 reachability hits; the 32 MiB bound holds 167 such manifests) |
| Both: hits in the parsed-manifest cache | 8 of 400 | 8 of 400 |
| 10,000 files: a 64-byte put issued while a sweep runs | 400–435 ms | 0.7–2.1 ms |

The first pass after a start parses every manifest, as before. Before ST-20 the
parsed-manifest cache served only the manifests live views had open, so every
other one was parsed on every pass.

## Known limitations

Recorded so no capability is advertised beyond what is implemented:

- Tool-level shell windows are still measured by each bridge's
  `WorkspaceChangeProbe` beside the worktree (private, non-retained Git
  endpoints). Their reports become `tool-effect` (fresh boundary) or
  `observation-window` measurements with `bodyAvailability: not-retained`;
  the explicit "open current file" action is offered instead of a body.
- Cross-bridge overlap is derived from the ingestion order of tool
  lifecycle frames, which is audit order rather than execution order, and is
  labelled observational.
- The `pull-request` scope uses the local merge-base policy and says so; it
  does not read the forge's own base/head.
- Container capture requires `node` and `git` inside the container (the
  Orkestrator image has both); without them captures report unavailable.
- Each bridge detects whether it runs beside a host or container worktree
  from container markers (`/.dockerenv`, `/run/.containerenv`,
  `DEVCONTAINER`) or its launcher's state directory. Where that is
  inconclusive the capability says `unknown`; Cursor then omits observation
  reports rather than label them with a guessed executor.
- Transcript rows look up tool presentations by call id. An ACP agent that
  reuses a call id in a later turn gets a separate operation
  (`attemptId: reuse:<turn>`), but its transcript row cannot name that
  attempt yet, so the later row shows the first attempt's presentation.
- Managed-terminal windows are modelled by the owner (`openWindow` with a
  terminal kind) but no terminal session opens them yet; terminal writes are
  attributed as workspace observations.
- The environment scan (`commands-files.ts`) compares in Git's own
  representation (`git-representation-v1`), so a configured clean filter
  runs there exactly as it does for `git status`. Snapshot capture and the
  staged/unstaged/uncommitted scopes never run filters and mark filtered
  paths `git-filter-unsupported`.
- Two live identities whose counts are equal share one measurement row; the
  identity id hashes the endpoint blobs, so bodies never mix.
- A thread segment's recorded edit activity (`operation-volume`) is summed from
  the operations still retained, so a thread older than the archive window reports
  only its recent activity once it next publishes one. Its net result is
  unaffected, because that comes from the pinned baseline.
