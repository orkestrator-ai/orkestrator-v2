# Efficiency review follow-ups

## Task analysis

Analysed 2026-11-01 against `main` at `0bd214ee`.

Every outstanding item from
[the 2026-10-27 efficiency report](../../reports/2026-10-27-efficiency.md).
Finding IDs (ST-7, WEB-2, ...) are the report's; its "Detailed findings"
section gives the file and line for each, and its "Invariants every fix must
keep" section applies to every task here. The report measured nothing, so its
impact ratings are reasoned from the code.

Items already owned elsewhere stay there and are not repeated: compression and
WebSocket deflate (GW-2, GW-7) in
[0052](../transcripts-and-observation/0052-remote-client-bandwidth.md), joined
history pages (TX-10) in 0232, recurring-work live evidence in
[0048](../transcripts-and-observation/0048-recurring-work-qualification.md),
container resource budgets in
[0022](../containers-and-environments/0022-container-resource-budgets-and-performance.md)
and Multi Review drift checks (BG-10) in
[0027](../coordinator-and-multi-review/0027-multi-review-scale-and-cost.md).

The maintainer's decisions of 2026-11-01 are recorded in the task each one
governs, marked "Decided".

### Tasks

1. **Baseline and before-and-after numbers**: capture the report's measurements for the work already done and before each structural task. Status: open.
2. **Storage keyed reads and writes**: the lease-held native session mutations, one shared decoded snapshot, the agent mail remainder, keyed-array row writes and the position index (TX-4 rest, BG-5, ST-9 rest, ST-10, ST-11). Status: open (ST-7 and ST-8 done).
3. **Renderer re-renders and refetches**: WEB-4 to WEB-19 and GW-13, plus WEB-2's narrower subscriptions. Status: open (WEB-2 and WEB-3 done).
4. **Live agent view requests**: discovery out of the 500 ms round, a combined read, then bridge state ETags and transcript deltas (WEB-1, GW-1, GW-3, TX-5, TX-6). Status: open.
5. **Transcript pipeline**: delta-base ring, unlimited post-dispatch reads, memoised fingerprints and the smaller items (TX-1 to TX-3, TX-7 to TX-9, TX-11 to TX-18). Status: open.
6. **Bridge hot paths**: Codex config reads, cached transcript measurement, tool-card fast paths, Claude part identity, stream framing and shared helpers (BR-2, BR-4 to BR-16). Status: open (BR-1 and BR-3 done, without new tests).
7. **Change tracking and git scans**: stamp short-circuit, count memo, manifest cache, off-loop zlib and the git scan costs (ST-1 to ST-6, ST-13 to ST-21). Status: open.
8. **tmux and container polling**: the rest of BG-1, BG-2 and BG-8, plus BG-7, BG-14 and BG-15. Status: open (first halves of BG-1, BG-2 and BG-8 done).
9. **PR monitor cost**: batched queries, then activity backoff (BG-6, BG-13). Status: open.
10. **Other background jobs**: the rest of BG-3, plus BG-9, BG-11 and BG-12. Status: open (BG-3's messaging-disabled gate done).
11. **Gateway and preview proxy**: GW-5, GW-6, GW-8 to GW-12 and GW-14 to GW-16. Status: open (GW-4 done; GW-2 done in 0052).
12. **Local desktop transport**: local windows on the filtered gateway transport, and the IPC payload costs (DK-1, DK-2, DK-5, DK-6). Status: open.
13. **Toolchain startup and downloads**: stamp-based verification and resumable downloads (DK-3, DK-4). Status: open.
14. **Docker image size**: layer order, the second Bun, npm caches, the leftover apt layer and the second Claude binary (DK-7 to DK-11). Status: open.
15. **Container data transfer**: in-volume clone move, a per-project mirror, agent-home input stamps and same-device moves (DK-12 to DK-15). Status: open.
16. **CLI and logging**: conditional `--follow` reads, transport buffering and the log sink (DK-16 to DK-18). Status: open.

### 1. Baseline and before-and-after numbers

**Problem.** Nine report items landed on 2026-11-01 with no measurement either side, and the larger tasks below are gated on numbers.

**Context.** Decided 2026-11-01: hybrid. Small fixes whose mechanism is plain ship without waiting; structural tasks (4, 5's TX-1 and TX-2, 12, 13, 15 and the co-process half of 8) need a baseline first, except that the maintainer chose to do the container work in tasks 8 and 15 now.

**Investigation.** The instruments exist (the report's "Measuring before changing"): `get_recurring_work_diagnostics` and the `recurringWork` metrics block (storage-read bytes, docker-exec, gh-spawn per job kind), the gateway metrics, the change-tracking capture benchmark, a React Profiler run and launch-to-ready timing. None was run in this round. Only the old code is available for "before" now by checking out `0bd214ee`.

**Decisions.**

- **How to get "before" numbers for work already done?**
  - **Run each measurement on `0bd214ee` and on the branch that landed the work, in an isolated `dev:test` profile (recommended).**
    - Pros: a real comparison; both commits are known.
    - Cons: two profile runs per measurement.
  - **Measure only from now on.**
    - Pros: half the work.
    - Cons: the first batch is never shown to have helped.

### 2. Storage keyed reads and writes

**Problem.** Some keyed paths still decode or rewrite a whole store for one row.

**Context.** Done: `getEnvironment`, `getNativeAgentSession`, `getPromptQueue`, `getComposeDraft`, `getPaneLayout` and `getSession` read one row (`loadStoreRow`), and `updateStoreRow` carries a cached store forward (`storage-database.ts`). SQLite pragmas (ST-12) were decided 2026-11-01: unchanged, revisited only if fsync cost still shows after this task.

**Investigation.** Still whole-store: the lease-held native session mutations in `storage-native.ts` (more than 20 call sites load the store inside the key's lease), `workerProjection`'s `listNativeAgentSessions()` (`index.ts`), each background job decoding the environment and session stores on its own (BG-5), compose-draft saves taking a global lease and a full load while typing (ST-10, `storage-drafts.ts`), and `updateStoreRow` throwing for keyed array layouts (`storage-database.ts`). Inserts scan their collection for the next position (ST-11). #1423 gave agent mail a revision-keyed read model and dropped the pretty-printed size check, so ST-9's remainder (pending injects as their own collection, a body-free mailbox list) needs re-checking before work.

**Decisions.**

- **How to share decoded stores between background readers (BG-5)?**
  - **One frozen decoded snapshot per store revision, the pattern #1423 used for mail (recommended).**
    - Pros: proven here; callers cannot mutate shared state.
    - Cons: callers that mutate their result must copy first, so each caller has to be checked.
  - **Pass one snapshot per sweep through each job's arguments.**
    - Pros: no cache.
    - Cons: touches every job signature; does not help unrelated jobs in the same second.

### 3. Renderer re-renders and refetches

**Problem.** Several renderer paths serialise or re-render far more than changed.

**Context.** Done: unchanged polls keep the identity object and the projection store's recency condition is gone (WEB-2); per-environment lists hydrate once per id and the status and PR setters skip no-ops (WEB-3, `useHydrateOncePerEnvironment.ts`).

**Investigation.** Not re-checked since the report: pane-layout persistence serialises every layout before its identity check (WEB-4), background polls toggle loading flags (WEB-5), the live-head merge has no identity shortcut (WEB-6), broad store subscriptions in `AppShell` and `usePullRequest` (WEB-7), the agent-info header normalising the whole transcript (WEB-8), the startup bundle (WEB-9), find re-indexing (WEB-10), WebSocket channel rebuilds on visibility change (WEB-11), the smaller WEB-12 to WEB-19, and dialogs polling state the backend pushes (GW-13). WEB-2's third fix, subscribing `AgentNativeTab.controller` to the fields it reads, is not done.

**Decisions.**

- **Order of work?**
  - **WEB-4, WEB-5, WEB-8, WEB-15 and GW-13 first, each a local change; then WEB-7 and WEB-9 (recommended).**
    - Pros: the report's Phase 1 items first; each is testable on its own.
    - Cons: WEB-9's bundle gain waits.
  - **WEB-9 first.**
    - Pros: every launch benefits.
    - Cons: needs a build-size check per step and touches many imports.

### 4. Live agent view requests

**Problem.** Each visible agent tab sends three POSTs every 500 ms while running, and bearer-token web clients open one event stream per terminal.

**Context.** Decided 2026-11-01: take discovery out of the 500 ms round, then add a combined read; choose push or long-poll only if measurements still justify it, and keep a recovery poll either way. Quiet backoff already covers all six providers (0052 task 2).

**Investigation.** The three reads are in `useNativeAgentSession.ts`; only `/invoke` exists (`gateway-auth.ts`). Bridge state reads have no conditional path and hash a state that includes the model catalogue (TX-5); transcript windows are always sent whole (TX-6). GW-3 is in `web-gateway.ts`.

**Decisions.**

- **Where does the combined read live?**
  - **One new progressive-update command that answers transcript and state with their `knownToken`s (recommended).**
    - Pros: one request; reuses the existing token contract; older backends are detected by the missing command.
    - Cons: a new protocol command that needs a version-compatibility entry.
  - **A generic bounded `/invoke-batch`.**
    - Pros: helps every caller.
    - Cons: new gateway surface with its own bounds, auth and error semantics.

### 5. Transcript pipeline

**Problem.** Lagging or second viewers get full snapshots, prompt sends read up to 16 MiB, and several fingerprints re-serialise whole structures.

**Context.** The report's TX items in `native-agent-transcript-projection.ts`, `native-agent-service.ts` and `http-bridge-provider.ts`. #1506 (history paging) changed the projection after the report.

**Investigation.** Confirmed 2026-11-01: the transcript view cache holds one entry per key, so a delta is built only from the newest view (TX-1). The projection-sync path already keeps bounded revisions (`state.revisions`), which is the model for the fix. Not re-checked since #1506: TX-2's unlimited `legacy()` reads, TX-3, TX-7, TX-8, TX-9 and TX-11 to TX-18.

**Decisions.**

- **TX-1: how many bases to keep?**
  - **A ring of 4 to 8 views per key, bounded by count and bytes like `state.revisions` (recommended).**
    - Pros: views share row objects, so the ring costs arrays; one pattern in the file.
    - Cons: more memory per hot session; needs explicit bounds (invariant 11).
  - **Keep one base and send a snapshot to anyone behind.**
    - Pros: no change.
    - Cons: the problem stays.

### 6. Bridge hot paths

**Problem.** Bridges re-measure and re-serialise whole transcripts and tool cards per update, and Codex reads every session record per config read.

**Context.** Done: ACP streaming output persists at most once a second (`scheduleStreamingPersist` in `acp-persist-writer.ts`) and measures the transcript every 1 MB (BR-1, BR-3), as decided on 2026-11-01. Neither has a new test; the existing bridge suite passes. One ACP test (`latches a fatal error when active children exceed the bounded registry`) fails on `0bd214ee` too when the file is run directly.

**Investigation.** Not re-checked since the report: BR-2 (`sessions/persistence.ts`), BR-4 to BR-6 (`transcript-budget.ts` and the Pi, Cursor and ACP transcript helpers), BR-7, BR-8 (`session-manager-messages.ts`, read 2026-11-01: still spreads a fresh `{...tool, createdAt}`), BR-9 to BR-14, BR-15's duplicated helpers and BR-16's likely dead Cursor replay in the Grok-only ACP bridge.

**Decisions.**

- **Fix each bridge or move the helpers first (BR-15)?**
  - **Move the Codex and Cursor versions into `packages/protocol/src/node` first, then fix BR-4 to BR-6 there once (recommended).**
    - Pros: each fix lands once; the good versions already exist.
    - Cons: a protocol change, so `mise run test` across all bridges.
  - **Fix each bridge in place.**
    - Pros: smaller diffs.
    - Cons: three copies of every fix.

### 7. Change tracking and git scans

**Problem.** Captures read and hash unchanged files, recount unchanged diffs every pass, and local scans spawn many git processes with no minimum gap.

**Context.** The report's ST-1 to ST-6 and ST-13 to ST-21. fsmonitor is no longer enabled (`docs/architecture/git-scan-caches.md`), so ST-17's second option is gone.

**Investigation.** Confirmed 2026-11-01: `capture.ts` still calls `confinedRead` and hashes before consulting the stat cache (ST-1). The rest is not re-checked since the report.

**Decisions.**

- **First step?**
  - **ST-1, ST-2 and ST-4 together, measured with the capture benchmark plus the large-asset and 200-changed-file fixtures the report names (recommended).**
    - Pros: the highest-impact items; one benchmark run proves all three.
    - Cons: the fixtures have to be written first.
  - **ST-16's minimum scan gap first.**
    - Pros: one small change with a clear effect during installs.
    - Cons: leaves the per-capture cost untouched.

### 8. tmux and container polling

**Problem.** Each tmux tab still runs up to four separate execs per tick, and container lifecycle changes do not stop the loops that depend on them.

**Context.** Decided 2026-11-01: do the structural container work now. Done that day: an unbound tab searches for its transcript at 2 s backing off to 10 s, and at once on any hook (BG-1); a quiet tab polls at 1 s after eight quiet ticks (BG-2, `TMUX_IDLE_*` in `tmux-shared.ts`); the `docker events` follower also reports `start`, `die`, `stop` and `destroy` and invalidates the shared `docker ps` snapshot (BG-8, `container-oom-events.ts`).

**Investigation.** Still to do: BG-1's bounded head ownership check and memo of rejected `(path, size)` pairs, and folding discovery into `pollSnapshotScript`; BG-2's `has-session` and `capture-pane` in the same snapshot exec, then one long-lived `docker exec -i` co-process per container or a hook-directory doorbell on the `claude-state-signal` pattern; BG-8's use of lifecycle events to retire the tmux, state, diff and PR loops; BG-7 (Claude state poll only with a Claude or tmux session); BG-14 (tail paging on reopen); BG-15. The discovery throttle has no direct test.

**Decisions.**

- **Co-process or doorbell for BG-2?**
  - **A doorbell on the hook directories, reusing `claude-state-signal` (recommended).**
    - Pros: a pattern already in the image; idle tabs cost nothing until a hook fires.
    - Cons: needs an image change, so older containers keep polling and need a fallback.
  - **One long-lived `docker exec -i` co-process per container.**
    - Pros: no image change.
    - Cons: a new long-lived process to supervise, bound and restart; its death must be detected.

### 9. PR monitor cost

**Problem.** Every open PR costs one `gh` process and one GraphQL query every 20 s for as long as it stays open; ten PRs use about 2,400 queries an hour of the 5,000-point budget.

**Context.** Decided 2026-11-01: batch PRs into one GraphQL query per host first; then back off only PRs with no pending checks and auto-merge off, because a finishing check may not change `updatedAt`. Auto-merge (#1494) shipped after the report and relies on this monitor. BG-13 (`get_environments` triggering a whole-installation sync) belongs here too.

**Investigation.** Not checked: whether batching works when `gh` runs inside a container, where each container has its own credentials and host.

**Decisions.**

- **How to batch across containers?**
  - **Batch per (host, credential) group, and keep containers whose `gh` cannot be shared on today's per-PR path (recommended).**
    - Pros: no credential crosses an environment boundary.
    - Cons: containers gain less.
  - **Run every query from the host's `gh`.**
    - Pros: the biggest saving.
    - Cons: the host credential may not see a container's repository, and it changes whose identity polls.

### 10. Other background jobs

**Problem.** Some 2 s and 5 s jobs still do per-item work that could be skipped.

**Context.** Done: mail presence returns early while messaging is disabled. It still refreshes while paused (see Assumptions and decisions).

**Investigation.** Still to do: BG-3's skip of environments that are not running before any store read, and reuse of the tmux loop's liveness result instead of another `has-session`; BG-9 (`contentRevision` for the human-prompt monitor); BG-11; BG-12.

**Decisions.**

- **BG-3: where does a stopped environment get skipped?**
  - **In `refreshPresenceOnce`, from the environment's status before any per-mailbox read (recommended).**
    - Pros: one place; no reads for stopped environments.
    - Cons: needs the environment list once per pass, which task 2's shared snapshot makes cheap.
  - **Compute presence lazily on `list_mailboxes`.**
    - Pros: no periodic work at all.
    - Cons: delivery decisions in the inject drain also read presence, so it changes their timing.

### 11. Gateway and preview proxy

**Problem.** The preview proxy never reuses upstream connections and strips ETags, and several per-frame costs remain.

**Context.** Done: the shared SSE decoder is linear (GW-4). GW-2 is done in 0052 (D14).

**Investigation.** Not re-checked since the report: GW-5, GW-6 (terminal WebSocket flush ignores `bufferedAmount`), GW-8 (`preview-forward.ts` sets `keepAlive: false`), GW-9 to GW-12, GW-14 to GW-16.

**Decisions.**

- **First step?**
  - **GW-8 and GW-9 together, measured with a Vite fixture page load (recommended).**
    - Pros: the largest wins for preview users; GW-9 also removes most of GW-10's rewrite work.
    - Cons: the pool needs revocation on endpoint generation change and access revocation, which `test:preview:browser` must cover.
  - **GW-6 first.**
    - Pros: fixes a correctness-adjacent desync of quiet channels.
    - Cons: only users of the opt-in terminal WebSocket benefit.

### 12. Local desktop transport

**Problem.** Electron main relays every backend event, terminal output included, to every window, and every local `invoke` is serialised four times.

**Context.** Decided 2026-11-01: local windows use the direct gateway transport with a per-window rollback switch, starting with filtered SSE and not tied to the terminal WebSocket. Local desktop traffic is unaffected by the `on` compression default: `backend-process.ts` calls control-only routes, and the control listener never compresses (inferred from code, not tested).

**Investigation.** `backend-process.ts` opens `/__orkestrator/events` with only a cursor (confirmed 2026-11-01). The browser path filters terminal output (`web-gateway.ts`). `installRemoteGatewayRequestAuth` already exists for remote windows. DK-5 and DK-6 are smaller IPC costs.

**Decisions.**

- **Rollback switch scope?**
  - **A per-window setting read at window creation, defaulting to the new transport after one release behind it (recommended).**
    - Pros: a user with a broken window can fall back without a new build.
    - Cons: two transports to keep working for a release.
  - **A build-time flag.**
    - Pros: one transport at runtime.
    - Cons: no way back without a release.

### 13. Toolchain startup and downloads

**Problem.** Every desktop launch SHA-256s about 1.2 GB of binaries twice before the backend starts, and slow links can never finish a download.

**Context.** `packages/toolchain/src/manager.ts`; the final verification is unconditional (confirmed 2026-11-01). Startup is awaited in `apps/desktop/electron/main.ts`.

**Investigation.** Not measured: launch-to-ready time with a warm and a cold page cache.

**Decisions.**

- **What does a stamp hold?**
  - **`dev, ino, size, mtimeNs, ctimeNs, digest` per file, re-hashing on any mismatch and on a periodic full check (recommended).**
    - Pros: catches replacement and in-place edits; a periodic check covers a forged mtime.
    - Cons: a stamp file to keep consistent with the install.
  - **Skip only the final verification when nothing changed this run.**
    - Pros: smallest change; halves the cost.
    - Cons: still one full hash per launch.

### 14. Docker image size

**Problem.** A bridge release re-pulls about 225 MB of unchanged layers, Bun is installed twice, and npm caches are probably left in the image.

**Context.** `docker/Dockerfile` (confirmed 2026-11-01: bridge `COPY`s still precede starship and mise; no `npm cache clean`). 0022 decided against BuildKit cache mounts. Image changes need `bash docker/tests/final-image-smoke.sh <image>` and `mise run test:agent:docker`.

**Investigation.** Sizes are from the report's reading of `docker history`; not re-measured. DK-10 (two Claude binaries) may be unfixable because the CLI and SDK follow separate release trains.

**Decisions.**

- **One change or several?**
  - **DK-7, DK-8, DK-9 and DK-11 in one image change, with `docker history` and `du` before and after (recommended).**
    - Pros: one rebuild and one smoke run.
    - Cons: a regression is harder to attribute.
  - **One change per finding.**
    - Pros: each saving is measured alone.
    - Cons: four rebuilds and four pulls for users.

### 15. Container data transfer

**Problem.** Each environment clones from the remote again, copies its clone byte for byte inside one volume, and copies agent-home inputs in full on every start.

**Context.** Decided 2026-11-01: do this now, ahead of the measurement gate. Files: `docker/workspace-setup.sh` (DK-12, DK-13), `portable-inputs.ts` and the entrypoints (DK-14), `environment-move.ts` (DK-15). Container storage rules in `docs/architecture/container-lifecycle.md` apply: no removal outside lifecycle operations.

**Investigation.** Not started. Unverified: whether blobless clones pay many lazy round trips for history-heavy diffs, which affects DK-13.

**Decisions.**

- **Order?**
  - **DK-12 and DK-14's stamp first, then DK-13's mirror (recommended).**
    - Pros: the first two are local script changes; the mirror is a new per-project host resource with its own lifecycle.
    - Cons: the clone network cost stays until the mirror lands.
  - **DK-13 first.**
    - Pros: the largest saving for big repositories.
    - Cons: a new mounted resource to create, refresh, bound and clean up before anything else lands.

### 16. CLI and logging

**Problem.** `session transcript --follow` re-downloads its page every 2 s for up to 24 h, the CLI transport buffers responses three times, and the log sink runs `mkdir` and `appendFile` per line.

**Context.** `packages/cli/src/client/commands/session.ts`, `packages/cli/src/client/transport.ts`, `packages/protocol/src/node/application-logging.ts`. A `knownToken` on the public API is a contract change (`docs/architecture/public-cli.md`).

**Investigation.** Not re-checked since the report. `attention --follow` probably has the same pattern; not checked.

**Decisions.**

- **DK-16: how does the CLI learn nothing changed?**
  - **An optional `knownToken` on the public transcript action that answers `unchanged` (recommended).**
    - Pros: the same contract every other read already uses.
    - Cons: public API surface; older backends ignore it, so the CLI must handle a full page.
  - **Back off the follow interval when pages repeat.**
    - Pros: CLI-only.
    - Cons: still downloads every page; slower to show new output.

## Assumptions and decisions

Made on 2026-11-01 while doing the first batch. Uncommitted at the time of
writing, on the worktree branch `20261101-012617-580e11a7c62c`.

### Task 2: unreadable rows

`getNativeAgentSession` still throws for a row it cannot read, and falls back
to the whole store only when the store is held as a document, so a corrupt
store still refuses rather than reading as "no session". Other getters return
`null` for an unreadable row, as the whole-store versions did.

### Task 2: carrying the cache forward

`updateStoreRow` copies the cached row map (references only) so a rollback
restores the committed one, and drops the cache when another connection moved
the store first. A graph-run benchmark pinned one row fetch per running pass;
it now fetches none, and the pin was updated.

### Task 3: hydrate once per id

A failed restore is forgotten and retried on the next change to the
environment list, and an environment that leaves and returns hydrates again.

### Task 6: ACP persistence interval

A fixed one-second timer that is not reset by later chunks, so it is also the
maximum wait. Every other change still persists through `schedulePersist`, and
any such write carries the output so far.

### Task 8: idle cadence

Eight quiet ticks (2 s) before polling at 1 s; liveness every two idle ticks, so
an ended session is still noticed in about 2 s. A hook can take one idle
interval to be seen, within the 2 s approval budget.

### Task 10: paused messaging

Presence still refreshes while messaging is paused, because pausing only holds
delivery and the mail surfaces stay visible.

## Current state

Done on 2026-11-01 (see each task's Context): ST-7, ST-8, WEB-2 (partly),
WEB-3, BG-3 (partly), BR-1, BR-3, GW-4, and the first halves of BG-1, BG-2 and
BG-8; GW-2 in 0052. Format, lint and typecheck passed. `mise run test` failed
only on the six `tests/unit/playwright-validation.test.ts` cases, which fail
identically on `0bd214ee`, and once on the known flake 1314. The Docker,
browser and real-stack suites were not run.

## Constraints and rationale

- The report's invariants: live events stay incremental over authoritative
  snapshots with missed events detectable; every new cache, ring and buffer has
  byte and count bounds; unmount is not cancel; Codex's stdout loop never
  awaits; transcript deltas carry `revisedMessages`; metrics stay content-free.
- Durability changes (ST-12) need the maintainer's sign-off.

## Needs verification

- Before-and-after numbers for every landed item (task 1).
- A React Profiler run with two visible agent tabs, idle and streaming, for
  WEB-2.
- The compression default under real remote load: tracked in 0052 task 2.

## Related

- [Efficiency report](../../reports/2026-10-27-efficiency.md).
- [0052 remote client bandwidth](../transcripts-and-observation/0052-remote-client-bandwidth.md), D14.
- [0048 recurring work qualification](../transcripts-and-observation/0048-recurring-work-qualification.md).
- [Flake 1314](../../tests/flaky-tests/design-canvas-and-artifacts/1314-design-profile-ledger-cleanup-race.md).
