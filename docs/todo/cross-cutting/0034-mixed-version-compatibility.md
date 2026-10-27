# Mixed-version compatibility

Checked against `main` at `2459b05c` (2026-10-15); every item closed and
re-checked against `8454d18b` (2026-10-24).

The renderer, backend, bridges and stored data do not always run at the same
version. The hosted web client follows `main` while users' backends update on
their own schedule. The desktop app can connect to another machine's backend. A
gateway tab can outlive a backend upgrade. A container keeps running its old
bridge until it restarts. And an older backend can open a data directory that a
newer one wrote. Many features added a compatibility path "for one release",
but there was no agreed support window, so none of them could be retired. This
file held that shared decision, the renderer–backend skew decision, one
dead-code removal, and an index of compatibility paths with the todo file that
owns each.

On 2026-10-24 the window was decided and written into
[`version-compatibility.md`](../../architecture/version-compatibility.md),
which now holds the policy and the register of compatibility paths. Three paths
the window allows retiring today were retired, the dead prompt-queue claim
commands and the downgrade export were removed, and every path the backend can
see now records a persistent, content-free usage counter. Nothing is left in
this file. The one compatibility path this work created (reading claim state
older backends wrote) is owned by
[0078-legacy-prompt-queue-claim-state.md](0078-legacy-prompt-queue-claim-state.md).

## Current state

- **Support window (decided 2026-10-24).** Supported versions are every
  published release at or after the floor. The floor is the newest Stable
  release published at least 60 days ago, or v2.21.0 (the first published
  release, 2026-10-16) while no Stable release is that old. Today the floor is
  v2.21.0; it becomes v2.21.1 on 2026-12-15, v2.22.3 on 2026-12-16 and v2.23.0
  on 2026-12-18. The supported pairings, the data upgrade and downgrade rules,
  the rules for writing compatibility code and the register are in
  [`version-compatibility.md`](../../architecture/version-compatibility.md).
  `docs/README.md` lists it, `releasing.md` asks for a register check after
  each Stable release, and `remote-gateway.md` ("Version reminders") points to
  it.
- **Renderer–backend skew.**
  - `BackendVersionReminder` (`apps/web/src/components/BackendVersionReminder.tsx`)
    still compares the bundled version with the backend's `get_app_version`
    and names the older side. It warns and never blocks.
  - `toPipelineTranscript` still classifies each entry by shape
    (`apps/web/src/lib/chat/transcript-skew.ts`), and each run of entries with
    no display-row field becomes one muted "unrecognized" notice row. That
    fallback is permanent. The OpenCode envelope entry (backends before
    2.19.17) was retired on 2026-10-24, and the empty shape registry with it.
    The comment on `TranscriptSkewKind` says how to add a legacy shape again.
  - MCP apply runtimes' optional `cancelReason` is additive in both directions
    and needed no compatibility path (unchanged since 2026-10-16).
  - The authenticated `/__orkestrator/status` route still answers only
    `{ ok: true }`; there is no version handshake (see Constraints).
- **Prompt-queue claim path removed.** The commands `requeue_prompt_queue_message`,
  `claim_prompt_queue_head`, `acknowledge_prompt_queue_claim` and
  `reject_prompt_queue_claim` (`commands-registry-prompts.ts`), the
  `StorageService` methods of the same names and `assertPromptQueueBodyUnchanged`
  (`storage-prompts.ts`), the renderer wrappers (`apps/web/src/lib/backend/workflows.ts`),
  the `claimPromptQueueHead` helper and its unused types
  (`prompt-queue-persistence.ts`), and the `promptQueueClaimLeaseMs` option and
  `PROMPT_QUEUE_CLAIM_LEASE_MS` (`storage-base.ts`, `storage-shared-core.ts`)
  are gone. `savePromptQueueMutation` (`storage-prompt-queue-store.ts`) no longer takes a
  claim: it only carries forward one an older backend left. The persisted
  `outstandingClaim` is still validated, still blocks a second dispatch in
  `reservePromptQueueHeadForDispatch`, and is still restored to the head when
  it expires (`recoverExpiredPromptQueueClaims`). 0078 retires that read.
- **`export_build_pipeline_for_downgrade` removed** with
  `StorageService.exportBuildPipelineForDowngrade`, its result type and its
  two test cases. `LEGACY_BUILD_PIPELINE_SNAPSHOT_LIMIT_BYTES` stays: the
  patch budget and the save bound use it.
- **Usage counters.** `apps/backend/src/core/compatibility-path-usage.ts`
  keeps a count and the first and last use per fixed path id, merged at most
  once a minute, on read and at shutdown into the `compatibility-path-usage`
  database document (`compatibility-path-usage-store.ts`, a document store in
  `storage-stores.ts`). Read through `get_compatibility_path_usage`
  (`commands-registry-system.ts`) or `compatibilityPaths` on `/api/metrics`
  (`gateway-handlers.ts`). Recording sites: `http-bridge-catalog.ts`,
  `bridge-session-close.ts` (two), `http-bridge-progressive.ts`,
  `native-agent-transcript-projection.ts`, `http-bridge-runtime-health.ts`,
  `mcp-management/evidence.ts`, `multi-review-reviewer-transcript.ts`,
  `gateway-proxy.ts` and `storage-prompt-queue-store.ts`. The slash-catalogue legacy
  routes were retired by 0016; session-route 404 rejections now record
  `slash-catalogue.outdated-bridge`, alongside the per-agent count and
  warning, without reading a global list.

## Outstanding work

None. The items, with their evidence:

### Done

1. **Prompt-queue claim commands and wrappers removed** (2026-10-24). See
   "Current state". The drainer's reservation path still shares the claim
   *state*, so the storage methods went but the state is still read
   (decision 6). Tests that covered only the commands were deleted: the
   claim/ack/nack/requeue cases in `storage-prompt-queues.test.ts`,
   `commands-state-sync.test.ts` and `prompt-queue-persistence.test.ts`, the
   wrapper calls in `backend.test.ts`, the map entries and cases in
   `apps/backend/tests/commands-registry-coverage.test.ts`, and the Claude
   Tmux mocks (`tests/unit/components/ClaudeTmuxChatTab.test.tsx`,
   `ClaudeTmuxChatTab.parts.test.tsx`). Tests that used a claim only to set
   up state now seed one the way an older backend wrote it, through
   `seedLegacyPromptQueueClaim` (`storage-test-support.ts`): restart and
   lease-timer recovery, enqueue dedupe against a claimed id, recovery of
   several claims, deletion with a live claim, web-annotation dispatch, and
   the idempotent-enqueue tombstone case. A new case, "does not reserve the
   head while a legacy claim is live", covers the kept read.
   `AgentNativeTab.test.tsx` now asserts the steered prompt is not
   re-enqueued instead of not requeued. Done-when check: `grep -rn -E
   "requeue_prompt_queue_message|claim_prompt_queue_head|acknowledge_prompt_queue_claim|reject_prompt_queue_claim|requeuePromptQueueMessage|claimPromptQueueHead|acknowledgePromptQueueClaim|rejectPromptQueueClaim"
   apps bridges packages tests e2e` finds nothing, so no storage method is
   left without a production caller.
2. **`export_build_pipeline_for_downgrade` given an owner, then removed**
   (2026-10-24). It exported one pipeline in the schema from before the
   transcript split (#875, 2026-09-27). Every release in the window
   (v2.21.0 and later) reads the split format natively, so the export only
   served unpublished builds (decision 7). Removed from
   `commands-registry-build.ts` and `storage-build-pipelines.ts`, with its
   cases in `storage-build-pipeline-transcripts.test.ts`. The neighbouring
   oversized-pipeline test still proves the 32 MiB bound on the old inline
   form.
3. **Legacy-path use is counted in production** (2026-10-24). See "Usage
   counters" above and in the architecture doc. Ten path ids cover every
   register row the backend can observe. Rollback switches and unmigrated
   user state are not version skew and are not counted (decision 8).
   Evidence: `compatibility-path-usage.test.ts` (counts and first and last
   use without a sink; totals persisted across two backends sharing a data
   directory, and the stored document holding only ids, counts and times;
   timer flush; counts kept when the sink fails; a removed data directory
   never recreated; a replaced sink detached safely; unknown ids dropped on
   read; a real legacy DELETE close counted once).
4. **Support window decided** (the former open question). Decisions 1 to 4;
   written into `version-compatibility.md`.
5. **Compatibility paths the window allows retiring today, owned here:**
   the renderer's OpenCode envelope recognition (decision 9). 0037's
   pre-digest receipt fallback was also retired, because it was a one-line
   change whose removal semantics 0037 had already recorded (decision 10).
6. **Dependent files updated:** 0002 code item 1 is unblocked, 0015's
   pre-#827 run is no longer required and is narrowed to v2.21.0 builds, and
   0037 is finished. The register gives every other path a removal condition
   stated against the floor.

### Validation (2026-10-24, node mbp3)

- `mise run format:check`, `mise run lint` (exit 0, no new warnings in touched
  files) and `mise run typecheck` passed.
- `mise run test`: bridges (5,987 passed), root and agent-support (3,382),
  web (9,147), desktop, protocol, toolchain and web-public all passed. Backend
  10,525 passed and 14 failed: every failure is
  `conformance-execution-policy.test.ts` for OpenCode, whose managed binary on
  this node reports 1.19.4 inside the test fixture against the 1.19.0
  expectation. The same 14 fail on a clean `origin/main` worktree, so it is
  this machine's toolchain state, not this change. The CLI package had one
  timeout (`runFix > starts Claude Code in a scratch directory…`) that passed
  alone, recorded as flake
  [0765](../../tests/flaky-tests/backend-services-and-tooling/0765-cli-fix-claude-scratch-aggregate-timeout.md).
- Focused runs: the design suite and `storage-build-pipeline-transcripts.test.ts`,
  `compatibility-path-usage.test.ts`, the transcript-skew and pipeline
  transcript tests (web and root), and the prompt-queue storage, command,
  registry-coverage, renderer and Claude Tmux files touched by item 1.
- Not run: browser, Electron, Docker and CLI scenario suites. No
  browser-visible flow changed except a notice that no longer appears for
  backends outside the window.

## Constraints and rationale

- A 404 or 405 from a newer route means the other side predates it. It is never
  evidence that a session, workflow or resource is missing.
- A missing capability selects a bounded compatibility path or reports a clear
  limitation. It never silently degrades a safety property (close never deletes
  history; dispatch stays at most once).
- Support only the pairings a rolling upgrade actually produces, not a
  combinatorial matrix.
- Every gate needs an owner and a removal condition. "Kept for one release"
  without a window is how this backlog formed.
- Persisted format changes stay additive, with a recorded downgrade behaviour.
- **Renderer–backend skew is guarded by shape, not by version** (decided
  2026-10-16). Three options were considered: a version or capability check,
  per-entry shape detection, and restoring a renderer OpenCode normaliser.
  - A capability check cannot help with the backends that exist today. Older
    backends will never report a capability, so its absence would just mean
    "older than 2.19.17", which is a version comparison. Version comparisons
    misfire when a backend reports no version (dev builds, `0.0.0`), and they
    need an async read in pure display code.
  - Shape detection is exact, synchronous and free. It runs at the single
    chokepoint both views share (`toPipelineTranscript`, which feeds
    `BuildChatTab`, `MultiReviewReviewerTab` and the Multi Review inspector
    tail), and it cannot fire on what a current backend serves. A test runs
    the backend normaliser's own output through it to prove that.
  - Restoring a normaliser would undo #970's reason for moving it.
- **Unreadable entries become one notice row per run.** The rejected options
  were a banner above the view and refusing to render. The row is a muted
  system row, styled like the auto-decline record, and sits where the entries
  were. Its id comes from the run's first entry, so it keeps its identity as
  the run grows. To make the notice louder, give it the inline-error id
  prefix (`ERROR_MESSAGE_PREFIX`) instead of the system role.
- **No version handshake for now.** `/__orkestrator/status` is authenticated
  and every client already probes it, so it could later carry the app version
  and a capability revision without exposing them to anonymous callers.
  Nothing needs that yet. Revisit when a change cannot be detected from the
  payload (a behavioural rather than a shape change).

## Assumptions and decisions

Made on 2026-10-24 while closing every item.

1. **How the window is measured.**
   - Options: (a) a count of releases (the last N); (b) calendar time only
     (every build from the last N days); (c) published releases from a floor
     that is the newest Stable release at least N days old; (d) different
     windows per client.
   - Chosen: (c) with N = 60 days, one window for every client.
   - Why: releases ship several times a week (nine published between
     2026-10-16 and 2026-10-23, plus four drafts), so a release count would last days, while
     hosts update on their own schedule, a remote standalone backend can sit
     unattended, and a container keeps its bridge until it restarts. Counting
     from a Stable release ties the floor to what the "everyone" channel
     installs, and prereleases fall in by version order. 30 days was too short
     for unattended hosts and long-lived containers; 90 days would keep about
     three months of paths at the current cadence.
   - Pros: concrete and computable from the release list by anyone, moves by
     itself, and the retirement condition of every path becomes "the floor is
     at or above X". Cons: a host that has not updated in more than 60 days
     loses support without a warning beyond the version reminder, and the
     60-day figure is a judgement, not a measurement (the counters can revise
     it).
2. **Where the floor starts.**
   - Options: (a) v2.21.0, the first published release; (b) include the
     unpublished v2.19.x and v2.20.x builds the maintainers ran from source;
     (c) start with the first Stable release that has been out for 60 days
     (none yet, so nothing could retire until mid-December).
   - Chosen: (a).
   - Why: `gh release list` shows no release before v2.21.0, the npm package
     starts at v2.22.3, and the in-app updater installs only published
     releases. Pre-2.21 builds only ever ran from source.
   - Pros: the paths for pre-2.21 peers can go now. Cons: a maintainer data
     directory first written by a source build can hold pre-2.21 records,
     which is why decision 4 keeps upgrades of old data permanent.
3. **One window for every pairing.**
   - Options: one window; separate windows for the hosted client, desktop,
     iOS, bridges and data.
   - Chosen: one window, with a table of the pairings a rolling upgrade
     produces and what each side owes the other. The public CLI keeps its
     own schema handshake, and the iOS shell's native contract (status probe,
     cookie sign-in) only changes additively.
   - Why: every pairing is reached through the same release train, and
     separate windows would multiply the conditions owners must check.
   - Pros: one number to remember. Cons: a pairing that could retire sooner
     (an open browser tab is fixed by a reload) waits for the common floor.
4. **Data across the window.**
   - Options: treat data like software (support only data written inside the
     window); keep every migration and record upgrade forever and let records
     from before the floor take a safe, explicit outcome; never retire any
     data read path.
   - Chosen: the second. Downgrade is supported within the window through
     downgrade fences only, without full function.
   - Why: data outlives the software that wrote it, and losing it is never
     acceptable, but behaviour that depends on a field an old build never
     wrote can take a refusal or a notice.
   - Pros: no data loss and no permanent compatibility branches in
     behaviour. Cons: migrations accumulate.
5. **What to retire in this change.**
   - Options: retire everything the window allows; retire only paths this
     file owns; retire this file's paths plus trivial, clearly unblocked
     ones elsewhere.
   - Chosen: the third: the OpenCode envelope recognition, the downgrade
     export and the claim commands here, and 0037's one-line fallback.
     0002's legacy close (it touches the browser suite), 0050's `/transcript`
     and sync-v1 fallbacks (0050 decides them together), 0016's legacy
     catalogue routes (sessionless reads must go first) and 0039's MCP marker
     rule (Codex sends no marker) are unblocked and left to their owners.
   - Pros: each owner keeps their design decisions and tests. Cons: several
     paths the window allows still ship until their owners act.
6. **Prompt-queue claim state after the commands go.**
   - Options: keep the four storage methods (contradicts item 1); remove the
     methods and the state entirely; remove the methods but keep reading the
     state.
   - Chosen: the third, with a new todo (0078) to retire the read.
   - Why: releases up to v2.28.0-beta still have the commands and can share a
     data directory, and the reservation path refuses to dispatch while a
     claim is outstanding, so ignoring a stored claim could dispatch a prompt
     a client may already have sent. Startup and timer recovery already
     restore an expired claim, so nothing new was needed.
   - Pros: no double dispatch and no stuck queue. Cons: the claim read and
     its recovery timer stay until 0078.
7. **The downgrade export.**
   - Options: document it in `storage.md` as the downgrade aid; remove it.
   - Chosen: remove.
   - Why: it converted to the schema before #875, and #875 is in v2.21.0, so
     no supported release needs it. No client called it and no doc described
     it.
   - Pros: less code; no undocumented command reachable only by name. Cons:
     someone running a pre-#875 source build against current data has no
     export; that is outside the window.
8. **How usage is counted.**
   - Options: (a) in-memory counters only, on `/api/metrics`; (b) a log line
     per use; (c) in-memory counters merged into a database document, plus a
     command and `/api/metrics`; (d) send counts to a central service.
   - Chosen: (c), backend only, with a closed list of path ids.
   - Why: retirement needs evidence that survives restarts and upgrades,
     which (a) loses; logs rotate and per-use lines on hot paths (preview
     requests) would be noisy; (d) would send data off the machine, which
     nothing else in the product does.
   - Pros: content-free, bounded by the id list, one synchronous write at
     most a minute, and readable on any machine the maintainer can reach.
     Cons: evidence is per machine, so users' machines are only visible if
     they report it; renderer and desktop paths are not counted (none remain
     in the renderer).
   - Assumption: a sync SQLite transaction at most once a minute is
     negligible next to the backend's other writes. A missing data directory
     is never recreated; its counts stay in memory.
9. **Retiring the OpenCode envelope recognition.**
   - Options: keep it; remove the entry and keep an empty registry; remove
     the registry too and keep only the permanent "unrecognized" fallback.
   - Chosen: the third. An empty registry typed by its keys made the generic
     code `never`, and dead code for a hypothetical shape is not worth
     carrying; the comment on `TranscriptSkewKind` says how to add one.
   - Why it can go: it served backends before 2.19.17, outside the window.
   - Pros: simpler module and notices. Cons: a backend older than 2.19.17
     now shows its envelopes as display rows (mostly empty), with only the
     version-reminder toast to explain it.
10. **0037's pre-digest receipt fallback.**
    - Options: leave it to 0037; retire it here.
    - Chosen: retire it here.
    - Why: its stated condition ("the window no longer covers backends older
      than 2.21.0") is met, `receiptDigests` is in v2.21.0 (#1021), and the
      removal semantics (a missing digest is a mismatch, refused with
      `reusedCorrelation`, nothing runs) were already recorded. The change
      is one function and its callers.
    - Pros: a reused correlation id can no longer replay a receipt for a
      different input. Cons: an identical retry of a receipt settled by a
      pre-2.21 source build is refused; the client still reconciles through
      `operation_status`.
11. **The "frozen" error constant.** Removing `requeuePromptQueueMessage`
    removed the only place the backend threw `PROMPT_QUEUE_MESSAGE_FROZEN`,
    so the constant was removed. The renderer raises its own frozen error
    before it would edit a web annotation item
    (`AgentNativeTab.controller.tsx`), so no supported behaviour changed.
    `isWebAnnotationQueueItemFrozenError` (`prompt-queue-errors.ts`) still
    recognizes the backend wording, which only releases up to v2.28.0-beta
    could send, from a command no renderer calls. It was left as harmless.
12. **Assumption about external callers.** `/__orkestrator/invoke` is not a
    public contract: the public CLI uses the one versioned `public_action`
    command ([public-cli.md](../../architecture/public-cli.md)). The removed
    commands were never documented. A GitHub code search on 2026-10-24 for
    `claim_prompt_queue_head` and `export_build_pipeline_for_downgrade` found
    them only in this repository. Private scripts cannot be searched; such a
    caller now gets an unknown-command error instead of a changed result.

## Open questions

None. The support-window question is answered by decisions 1 to 4.

## Needs verification

None. Whether an external tool invoked the removed commands through
`/__orkestrator/invoke` was checked as far as it can be (decision 12).

## Related

- [`version-compatibility.md`](../../architecture/version-compatibility.md):
  the window, the rules and the register that replaced this file's index.
- [0078-legacy-prompt-queue-claim-state.md](0078-legacy-prompt-queue-claim-state.md):
  retiring the claim-state read.
- [0002-session-lifecycle-consistency.md](../agent-engines/0002-session-lifecycle-consistency.md),
  [0015-slash-command-qualification.md](../cli-and-slash-commands/0015-slash-command-qualification.md) and
  [0037-design-operation-recovery-edges.md](../design-canvas/0037-design-operation-recovery-edges.md):
  the files that waited on the window.
- [0052-remote-client-bandwidth.md](../transcripts-and-observation/0052-remote-client-bandwidth.md) and
  [0051-client-reconnect-and-freshness.md](../transcripts-and-observation/0051-client-reconnect-and-freshness.md): other
  remote-client behaviour.
- [0031-live-provider-and-platform-qualification.md](0031-live-provider-and-platform-qualification.md):
  mixed-version and old-bridge runs.

## Replaces

- `docs/2026-10-14/07-cleanup-follow-ups.md` (§1 "Left for a follow-up" and §5
  "Known limitation: renderer and backend must match")
