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

The Git scopes (`git-scopes.ts`) are computed on first demand through the
shared admission pool and recomputed after each settled environment scan
while someone has asked for them. Their resource keys are
`<scope>/environment/<environmentId>/live` (`commit/environment/<id>@<sha>/pinned`).

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
| Bridge transport | `apps/backend/src/core/http-bridge-change-evidence.ts` (pull/ack client) |
| Bridge adapters | `bridges/<bridge>/src/**/change-evidence.ts` (Claude, Codex, Cursor, Pi, ACP/Grok) |
| OpenCode adapter | `apps/backend/src/core/opencode-change-evidence.ts` |
| Public CLI | `changes.view` / `changes.history` actions (`public-api/actions-changes.ts`), `orkestrator changes view|history` |
| Web clients | `apps/web/src/lib/changes/` (subscriptions, labels, handoff), `apps/web/src/hooks/useChangeProjection.ts`, `apps/web/src/stores/changeProjectionStore.ts`, `apps/web/src/components/changes/` |

Backend services (one composition root, `service.ts`):

| Service | File | Role |
| --- | --- | --- |
| `ChangeLedger` | `change-ledger.ts`, schema `ledger-schema.ts` (storage migration 4) | Indexed rows, fences, selections, outbox |
| `ObjectStore` | `object-store.ts` | Content-addressed Git-format objects under `<dataDir>/change-tracking/objects` |
| capture | `capture.ts` | Raw-byte capture with stability rechecks (host and container executors) |
| DiffEngine | `snapshot-diff.ts` | Manifest comparison and body rendering |
| `WorktreeRegistry` / `WorktreeChangeOwner` | `worktree-owner.ts` | Physical identity, incarnation, durable fence, serialized captures, tool windows |
| `ProviderEvidenceIngress` | `evidence-ingestion.ts` | Dedupe, lifecycle reduction, revision selection, chunks, gaps |
| `ChangeMeasurementService` | `measurement-service.ts` | Measurements, supersession, CAS selection, outbox |
| `ChangeProjectionService` | `projection-service.ts` | Server-prepared projections, pages, actions |
| `ChangeResourcePublisher` | `publisher.ts` | Outbox drain, coalesced delivery |
| `EnvironmentChangeProjector` | `environment-projector.ts` | `environment-net` from the shared scan |
| `TurnBoundaryService` | `turn-boundaries.ts` | Pre-dispatch starts, segments, end captures |
| `DiffBodyService` | `diff-bodies.ts` | Immutable bodies, live detail resolution |
| `ChangeHandoffSerializer` | `handoff.ts` | Agent handoff text |
| `ChangeRestoreService` | `restore.ts` | Conditional restore |
| `ChangeRetentionService` | `retention.ts` | Reachability GC, quotas |
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
most once per second locally (five remotely).

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
| Agent handoff | `changes_get_handoff` text per tool call; unmeasured calls say "changes: not measured" |
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
coalescing; 200 rows / 256 KiB pages; 1 GiB soft / 4 GiB hard snapshot
storage; 90-day archived retention (a maximum subject to quota, not a
guarantee). Changing a policy affects future work only.

## Restore

`changes_prepare_restore` checks every destination against the measured
after-state (content and mode) and issues a fenced, expiring token.
`changes_apply_restore` is idempotent by key, takes a recovery checkpoint,
re-checks each file at the executor immediately before writing (temporary
sibling + rename), skips anything the user changed since, and records a
partial outcome honestly. There is no blind reset and no all-or-nothing claim.

## Retention and backup

Roots: ledger references (thread baselines, turn endpoints, live pins),
active turns, open windows, pending captures and in-flight readers. Objects
are swept only after `orphanGraceMs`. Soft-budget pressure releases the
oldest archived turn endpoints; the hard budget refuses new captures with an
explicit reason. A removed body answers `body-expired` with retained counts.

Measurements are pruned too. Every re-measurement stores its whole file list
(an environment's net diff against its base can be thousands of files), so
superseded ones would otherwise grow `change_measurement_files` without bound.
`ChangeLedger.pruneSupersededMeasurements` deletes a measurement, its file
rows and diff identities once two newer ones of the same owner and scope
exist, unless a selection, an unexpired restore token or a running restore
still holds it. In-flight diff requests pin their measurement until the read
finishes, including errors. Retired identities are removed before file rows
are drained, so new requests cannot start reading a partially deleted measurement
(a handoff naming a pruned one says "not retained"). Each publication prunes
up to two of its owner's; the retention pass (two minutes after start, then hourly) prunes any backlog in batches of
at most 256 file rows, including partial deletion of a large measurement,
yielding between transactions. It then releases free pages in 128-page steps.
The publication path has the same 256-row ceiling. Existing databases created
without incremental auto-vacuum reuse freed pages but do not physically shrink;
backup headroom is calculated from live pages rather than allocated file size.

Backups must include both `orkestrator.sqlite` and
`<dataDir>/change-tracking/` (objects and evidence bodies); metadata alone
cannot serve historical bodies.

## Operator runbook

- **Identify an owner**: `changes_get_diagnostics` lists active owners, open
  windows, active turns and publisher counters (no paths or contents).
- **Inspect a capture failure**: query `change_capture_attempts` by id
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
