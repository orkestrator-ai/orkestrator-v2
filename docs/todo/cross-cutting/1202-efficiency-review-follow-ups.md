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
2. **Storage keyed reads and writes**: the lease-held native session mutations, one shared decoded snapshot, the agent mail remainder, keyed-array row writes and the position index (TX-4 rest, BG-5, ST-9 rest, ST-10, ST-11). Status: open (ST-7, ST-8, BG-5, ST-11 and ST-10's compose drafts done; TX-4 rest, ST-9 rest and ST-10's environment, session and project writers open).
3. **Renderer re-renders and refetches**: WEB-6, WEB-7, WEB-9 to WEB-14 and WEB-16 to WEB-19, plus WEB-2's narrower subscriptions. Status: open (WEB-2, WEB-3, WEB-4, WEB-5, WEB-8, WEB-15 and GW-13 done).
4. **Live agent view requests**: discovery out of the 500 ms round, a combined read, then bridge state ETags and transcript deltas (WEB-1, GW-1, GW-3, TX-5, TX-6). Status: open.
5. **Transcript pipeline**: delta-base ring, unlimited post-dispatch reads, memoised fingerprints and the smaller items (TX-1 to TX-3, TX-7 to TX-9, TX-11 to TX-18). Status: open.
6. **Bridge hot paths**: Codex config reads, cached transcript measurement, tool-card fast paths, Claude part identity, stream framing and shared helpers (BR-2, BR-4 to BR-16). Status: open (BR-1 and BR-3 done, without new tests; BR-4 to BR-6 and the transcript half of BR-15 done 2026-11-02; BR-2, BR-7 to BR-14, BR-15's SSE replay rings and BR-16 open).
7. **Change tracking and git scans**: stamp short-circuit, count memo, manifest cache, off-loop zlib and the git scan costs (ST-1 to ST-6, ST-13 to ST-21). Status: open (ST-1, ST-2 and ST-4 done on 2026-11-02; ST-2's directory-handle cache deliberately not done; ST-3, ST-5, ST-6 and ST-13 to ST-21 open).
8. **tmux and container polling**: the rest of BG-1, BG-2 and BG-8, plus BG-7, BG-14 and BG-15. Status: open (first halves of BG-1, BG-2 and BG-8 done).
9. **PR monitor cost**: batched queries, then activity backoff (BG-6, BG-13). Status: done (2026-11-03; live before-and-after numbers stay with task 1).
10. **Other background jobs**: the rest of BG-3, plus BG-9, BG-11 and BG-12. Status: done (2026-11-02; live before-and-after numbers stay with task 1).
11. **Gateway and preview proxy**: GW-5, GW-6, GW-8 to GW-12 and GW-14 to GW-16. Status: open (GW-8 and GW-9 done; GW-4 done; GW-2 done in 0052).
12. **Local desktop transport**: local windows on the filtered gateway transport, and the IPC payload costs (DK-1, DK-2, DK-5, DK-6). Status: open.
13. **Toolchain startup and downloads**: stamp-based verification and resumable downloads (DK-3, DK-4). Status: done (2026-11-03; Electron launch-to-ready 10.2–13.8 s before, 1.6–1.9 s after; a cold-cache run still needs live evidence).
14. **Docker image size**: layer order, the second Bun, npm caches, the leftover apt layer and the second Claude binary (DK-7 to DK-11). Status: open (DK-7, DK-8, DK-9 and DK-11 done 2026-11-02; amd64 image smoke and Docker qualification passed; DK-10 left for a maintainer decision).
15. **Container data transfer**: in-volume clone move, a per-project mirror, agent-home input stamps and same-device moves (DK-12 to DK-15). Status: open (DK-12 and DK-15 done; DK-13 and DK-14 open).
16. **CLI and logging**: conditional `--follow` reads, transport buffering and the log sink (DK-16 to DK-18). Status: open (DK-16 and DK-17 done 2026-11-03; DK-18, the log sink, left open).

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

**Context.** Done: `getEnvironment`, `getNativeAgentSession`, `getPromptQueue`, `getComposeDraft`, `getPaneLayout` and `getSession` read one row (`loadStoreRow`), and `updateStoreRow` carries a cached store forward (`storage-database.ts`). SQLite pragmas (ST-12) were decided 2026-11-01: unchanged, revisited only if fsync cost still shows after this task. Done 2026-11-02 (branch `keyed-storage-row-e11a908a8276-r1`, re-checked against `main` at `38d55ee14`):

- BG-5: `FrozenStoreSnapshot` (`storage-frozen-snapshot.ts`) keeps one deeply frozen decoded copy per committed revision, re-decoding only rows whose serialized value changed, one copy per store and none above 64 MiB of serialized rows. `readEnvironmentsSnapshot` and `readNativeAgentSessionsSnapshot` serve it to the activity sweep and its read-only helpers (`runtimeStopRequested`, `hasObservedLiveWork`, `hasActiveCheckoutWork`), the interaction tracker sweep, the tmux reconcile, the human-prompt monitor's `workingSessions`, `workerProjection`, `workerSessionActivity` and the pending-rename reconcile (`commands-registry.ts`, every 2 s while an environment has a rename intent, else 30 s).
- ST-10, compose drafts: a save or single delete reads and writes only its row (`updateSensitiveStoreRow`, which keeps `saveSensitiveJson`'s archive pruning by journaling a keyed `prune-row` cleanup in the row's transaction); owner sweeps are one `updateStore` that writes nothing when the owner has no draft. The store lease stays.
- ST-11: `store_rows_position` on `(store, collection, position)`, created on open.

**Investigation.** Re-checked 2026-11-02. Still whole-store: the lease-held native session mutations in `storage-native.ts` (22 call sites still load the whole store inside the key's lease, TX-4's rest), `updateStoreRow` throwing for keyed array layouts (`storage-database.ts`), and the record-store writers the report names under ST-10 (`storage-projects.ts`, `storage-sessions.ts`). Environments are an array store written whole under the environment lease by many paths, with attributable archive scrubs, so moving one writer to row writes breaks the one-kind-of-writer rule (`storage-writer-guards.test.ts`); every writer of the store has to move together, and array row writes have to exist first. Background callers not moved to the snapshot either mutate what they read or pass it on to code not checked yet: `reconcilePendingLaunches` (launches environments), environment cleanup, the local-server reaper, diff stats, the PR monitor and the coordinator, goal and sign-in services. Mail presence was checked: it already reads one row per mailbox (`mailInjectPresence`). ST-9's remainder (pending injects as their own collection, a body-free mailbox list) was not re-checked.

**Decisions.**

- **How to share decoded stores between background readers (BG-5)?** Done as recommended.
  - **One frozen decoded snapshot per store revision, the pattern #1423 used for mail (recommended).**
    - Pros: proven here; callers cannot mutate shared state.
    - Cons: callers that mutate their result must copy first, so each caller has to be checked.
  - **Pass one snapshot per sweep through each job's arguments.**
    - Pros: no cache.
    - Cons: touches every job signature; does not help unrelated jobs in the same second.
- **BG-5: replace `listNativeAgentSessions` itself, or add snapshot reads beside it?** Decided 2026-11-02: beside it.
  - **New `read*Snapshot` methods, moving callers one at a time once each is checked (recommended).**
    - Pros: a caller is moved only when it is known not to write; the test harnesses of the moved callers return frozen data, so a write fails there.
    - Cons: two read paths per store; unmoved callers still decode the store.
  - **Make `listNativeAgentSessions` (and later `loadEnvironments`) return the frozen copy.**
    - Pros: every caller benefits at once.
    - Cons: 30 callers, several of which pass records to code that may write them; a missed one throws in production.
- **ST-10, compose drafts: drop the store lease?** Decided 2026-11-02: keep it.
  - **Keep the lease; one row read and write inside it (recommended).**
    - Pros: saves stay ordered against the owner checks they await and against the owner deletion sweeps, exactly as before.
    - Cons: still one lease claim and release per save.
  - **A per-key lease, with the owner fences re-checked inside the row transaction.**
    - Pros: drafts of different tabs save concurrently, and a save costs no store-wide lease.
    - Cons: needs synchronous fences for project removal and coordinator conversation close that do not exist today.
- **ST-10, compose drafts: how to keep the retired JSON archive pruning?** Decided 2026-11-02: journaled with the row.
  - **`updateSensitiveStoreRow`: journal a keyed pruning intent (`prune-row`) in the same transaction as the row update, through the existing durable cleanup journal (`commitWithLegacyJsonCleanup`, `storage-stores.ts`), or one whole-value `prune` intent when the store was unreadable; inside `atomically()` the intent joins the scope's cleanups and commits with it (recommended).**
    - Pros: the same pruning a whole-value save did, for one record, with the same recovery guarantee: an interrupted or failed pruning is replayed on reopen or before the next journaled write, before another mutation (a later re-add included) can obscure the removal; nothing is read when no archive is left (it expires 14 days after migration).
    - Cons: one more cleanup variant in the journal, and each journaled save stores a copy of the row's new value in the private cleanup store until the pruning finishes.
  - **Prune after the row commits, with no durable intent.**
    - Pros: smaller; no journal entry per save.
    - Cons: a crash or an archive write failure between the two leaves removed sensitive content in that archived copy until it expires.
  - **Fall back to the whole-store save while an archive exists.**
    - Pros: byte-for-byte the old behaviour.
    - Cons: two kinds of writer for one store, which the writer guard refuses.
- **ST-11: index or a stored next position?** Decided 2026-11-02.
  - **An index on `(store, collection, position)`, created on open (recommended).**
    - Pros: no stored value or schema version changes, so an older build still opens the database; ordered row fetches use it too.
    - Cons: one more index to maintain on inserts and deletes; it is built once on the first open after the upgrade.
  - **A numbered migration, or the next position kept in `stores`.**
    - Pros: a migration follows the documented pattern.
    - Cons: a new version locks every older build out of the database, and a stored counter is new stored data to keep consistent.
- **ST-10's remaining writers: next step?**
  - **Add array-layout `updateStoreRow` with tests, then move every environment writer at once (recommended).**
    - Pros: environments are the largest store written whole for one field.
    - Cons: one large change touching every environment mutation, its archive scrubs and the deletion fences.
  - **Move the record stores (sessions, projects) first.**
    - Pros: `updateStoreRow` already supports them.
    - Cons: smaller stores, so less gained.

### 3. Renderer re-renders and refetches

**Problem.** Several renderer paths serialise or re-render far more than changed.

**Context.** Done 2026-11-01: unchanged polls keep the identity object and the projection store's recency condition is gone (WEB-2); per-environment lists hydrate once per id and the status and PR setters skip no-ops (WEB-3, `useHydrateOncePerEnvironment.ts`). Done 2026-11-02, each re-checked against `main` at `38d55ee1` first (all five were still true; #1585's transcript rework did not touch `AgentInfoButton`), each with a test that fails on the previous code:

- WEB-4: `pane-layout-persistence.ts` skips an environment whose object and hydration are both unchanged before sanitising and serialising it (`pane-layout-persistence.unchanged.test.ts`: a write to one environment serialised the other's layout once per write before).
- WEB-5: a background read over an authoritative session state (`stateAvailability` current and a projection held) no longer raises and clears `isRefreshing` and `sessionStateRefreshing`, and both setters skip writes that would not change the value (`useNativeAgentSession.background-flags.test.tsx`: steady polls went from one hook render per tick to none; manual reads and reads before any authoritative state still raise the flags). The transcript skeleton flag had already been gated on `background`.
- WEB-8: `AgentInfoButton` normalises the transcript only inside the rewind and undo handlers (`AgentInfoButton.transcript-reads.test.tsx`: six projection updates normalised six times before, now none until the click, then once).
- WEB-15: the native tab's tail reads (latest assistant row, latest prompt, auth failure since it) are one memoised pass, `readTranscriptTail` in `components/native-agent/transcript-tail.ts` (`transcript-tail.test.ts` pins equality with the old expressions, goal turns included).
- GW-13: `EnvironmentRebuildSection` follows `container-lifecycle-updated` through `listenAuthoritative` (subscribe, then read; re-read on resync), keeps the higher-revision snapshot when reads and events cross, and polls every 15 s while a rebuild runs instead of every 2 s (2 s again if the subscription fails). The event name and `ContainerLifecycleEvent` payload now live in `@orkestrator/protocol/container-lifecycle` (`EnvironmentRebuildSection.events.test.tsx`).

**Investigation.** GW-13's other two sites were already event-driven when re-checked: `ProjectCopyDialog` listens to `project-copy-changed` over the portal transport and keeps a 3 s backstop only while a copy is tracked, and `useUserCommands` re-reads on `user-command` changes, resyncs and safety checks, with a 3 s backstop only while a command runs (the resource is ephemeral, absent from the revision manifest, so a missed hint is otherwise invisible). Both were left as they are. Two `container-lifecycle` writes in `commands-environment.ts` (retained storage on deletion, setup completion) bump the revision without emitting; neither changes the operation the rebuild section shows, and the next emitted or read snapshot carries the higher revision. Not re-checked since the report: the live-head merge has no identity shortcut (WEB-6), broad store subscriptions in `AppShell` and `usePullRequest` (WEB-7), the startup bundle (WEB-9), find re-indexing (WEB-10), WebSocket channel rebuilds on visibility change (WEB-11), and the smaller WEB-12 to WEB-14 and WEB-16 to WEB-19. WEB-2's third fix, subscribing `AgentNativeTab.controller` to the fields it reads, is not done. No React Profiler run was made for the 2026-11-02 batch; the numbers above are hook render counts and call counts from tests. Browser check of the batch: the 18 component-browser owners that failed in a loaded nine-worker `test:browser` run (53 failures, almost all 30 s timeouts) were rerun with three workers: 278 passed and 5 failed. The five are the four desktop Cursor `CloseRetention` cases, which fail identically on `main` at `38d55ee1` (flake case 0963), and the known mobile `ClaudeInteractions` route-disposal flake (0252), whose owner then passed alone.

**Decisions.**

- **Order of work?** Decided 2026-11-02 (first batch done).
  - **WEB-4, WEB-5, WEB-8, WEB-15 and GW-13 first, each a local change; then WEB-7 and WEB-9 (recommended).**
    - Pros: the report's Phase 1 items first; each is testable on its own.
    - Cons: WEB-9's bundle gain waits.
  - **WEB-9 first.**
    - Pros: every launch benefits.
    - Cons: needs a build-size check per step and touches many imports.
- **What should still poll once the rebuild section follows lifecycle events (GW-13)?**
  - **A 15 s backstop read while a rebuild runs, 2 s when the subscription failed (recommended, done).**
    - Pros: progress arrives as it is written; a lost event costs at most 15 s even on a transport that cannot report a gap.
    - Cons: still one read every 15 s per open dialog during a rebuild.
  - **No polling at all; rely on events and resync.**
    - Pros: no reads while nothing changes.
    - Cons: a dropped event on a transport without a resync signal leaves the dialog stale until it is reopened.
  - **Keep the 2 s poll and add the listener.**
    - Pros: no behaviour risk.
    - Cons: keeps the cost GW-13 is about.
- **Should `ProjectCopyDialog` and `useUserCommands` lose their 3 s backstops too (GW-13)?**
  - **Leave them (recommended, done).**
    - Pros: both already update from events; each backstop runs only while work is in flight and covers a transport (portal) or resource (ephemeral `user-command`) whose missed hints nothing else detects.
    - Cons: a few extra reads per in-flight copy or command.
  - **Lengthen or remove them.**
    - Pros: fewer reads.
    - Cons: needs a gap signal for the portal stream and the ephemeral resource first.

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

**Context.** Done: ACP streaming output persists at most once a second (`scheduleStreamingPersist` in `acp-persist-writer.ts`) and measures the transcript every 1 MB (BR-1, BR-3), as decided on 2026-11-01. Neither has a new test; the existing bridge suite passes. One ACP test (`latches a fatal error when active children exceed the bounded registry`) fails on `0bd214ee` too when the file is run directly; it passed in the 2026-11-02 bridge run.

Done 2026-11-02 (against `main` at `38d55ee1`), in the order decided below: the Pi, Cursor and ACP transcript helpers moved into `packages/protocol/src/node` first (BR-15's transcript half), then BR-4 to BR-6 were fixed there once.

- `bridge-transcript-text.ts`: `sliceUtf8`, `boundUtf8Text` and `BoundedTextAppender`, which replaces Pi's and Cursor's identical `appendBounded`/`boundText`/`sliceToBytes` and ACP's `appendBounded`/`appendSaturating`/`truncateUtf8`/`truncateDisplayText`. The two truncation behaviours are kept as policies (`append-notice` for Pi and Cursor, `reserve-notice` for ACP), so each bridge's text is unchanged. BR-6: the appender remembers each owner's buffer byte length, used only while `current` is the very string it was taken from, so a delta costs its own bytes.
- `bridge-transcript-bounds.ts`: one `createBridgeTranscriptBounds` for the bound wrapper, read bound, streaming check and revised-row bookkeeping Pi and Cursor each carried. The bridges' `transcript.ts` keep their exported names as thin bindings, so no call site changed.
- BR-4, `TranscriptRowSizes` in `transcript-budget.ts`: a dirty bound re-serialises only the newest row and the rows noted since the last pass. The hook is the existing revised-row note (`noteRowRevised` for Pi and Cursor, ACP's `noteRevisedRow`), which every in-place change to an older row must already reach for `revisedMessageIds`. A remembered size is also tied to the row object and to the row after it, so a replaced history or a row that became newest again (Pi's refused-prompt rollback, ACP's withdrawn prompt) is measured again. One entry per retained row, rebuilt on every pass. Under `bun test` (`NODE_ENV=test`) every remembered size is re-checked and a stale one throws `StaleTranscriptSizeError`, so the three bridge suites prove their write paths note what they change. Two paths that change an older row without a reader note now invalidate it directly: Pi's history-replay result fold (`forgetRowSize`) and ACP's nested-part shedding.
- BR-5, `EncodedObjectSizes` in `transcript-budget.ts`: Pi's `chargeToolPart`, Cursor's `chargeToolPart` and ACP's `commitToolPartMutation` measure a card with exactly `JSON.stringify`'s byte count, but re-measure only string fields that changed, and a field that extends its previous value costs one prefix comparison plus its new suffix. Object and array fields are still measured every time, because the bridges mutate some in place. Cursor's shell-delta `continues` fast path is unchanged.
- Tests: `bridge-transcript-text.test.ts` replays random streams (multibyte, split surrogate pairs, notices, caps below the marker) through verbatim copies of the old bridge helpers and requires the same text; `transcript-budget.test.ts` checks the row cache (only the newest and noted rows are measured, follower and identity checks, count bound, verification) and that `boundTranscriptInPlace` with the cache leaves exactly the state it leaves without it, and checks `EncodedObjectSizes` against `encodedJsonBytes` through random edits; `bridge-transcript-bounds.test.ts` covers the shared wrapper. The Pi, Cursor and ACP bridge suites pass unchanged with verification on.

**Investigation.** Not re-checked since the report: BR-2 (`sessions/persistence.ts`), BR-7, BR-8 (`session-manager-messages.ts`, read 2026-11-01: still spreads a fresh `{...tool, createdAt}`), BR-9 to BR-14, BR-15's SSE replay rings (Codex `event-ring.ts`, Claude `routes/events.ts`) and BR-16's likely dead Cursor replay in the Grok-only ACP bridge.

What BR-5 does not remove: Pi resends a running tool's whole accumulated output on every frame, and `renderToolCall` re-bounds it (`boundText`) before the charge, so a Pi frame still costs O(output) — now one prefix comparison instead of a whole-card serialisation. Getting below that needs Pi's tool rendering to take deltas. ACP's text charge (`Buffer.byteLength(text) * 2`) is not JSON-escaped, so it is not a strict upper bound on encoded growth; it only schedules the bound, which is exact, so it was left alone. Cursor's per-sub-agent byte check (`boundNestedParts` with `measureBytes`) still serialises each live row's nested parts on an exact pass. No before-and-after numbers were taken (task 1).

**Decisions.**

- **Fix each bridge or move the helpers first (BR-15)?** Decided 2026-11-01; done 2026-11-02 for the transcript helpers.
  - **Move the Codex and Cursor versions into `packages/protocol/src/node` first, then fix BR-4 to BR-6 there once (recommended).**
    - Pros: each fix lands once; the good versions already exist.
    - Cons: a protocol change, so `mise run test` across all bridges.
  - **Fix each bridge in place.**
    - Pros: smaller diffs.
    - Cons: three copies of every fix.
- **What invalidates a remembered row size (BR-4)?** Done 2026-11-02 with the first option.
  - **The existing revised-row note, plus row identity and follower checks, verified against a fresh measurement under `bun test` (recommended, taken).**
    - Pros: reuses a hook every older-row change must already call; the newest row, where streaming writes without a note, is always measured; a missed note fails the bridge suites instead of shipping.
    - Cons: a new write path that changes an older row without a note and without a test would make the bound measure that row stale (over or under by that change) until the row is noted or evicted.
  - **A per-row version counter bumped by `rowChanged`, as the report suggested.**
    - Pros: explicit.
    - Cons: the same audit, plus a second hook every path must call.
  - **Skip measuring while the last exact size plus the charged growth is under the budget.**
    - Pros: no per-row state.
    - Cons: relies on every charge being a strict upper bound, which ACP's text charge is not; a transcript at the budget still measures everything on every dirty read, which is the case that costs most.
- **How to keep each bridge's truncated text identical (BR-15)?** Done 2026-11-02 with the first option.
  - **One appender with two named policies (recommended, taken).**
    - Pros: one implementation and memo; output unchanged, proven against copies of the old helpers.
    - Cons: two behaviours remain; unifying them would change what users see at the cap.
  - **Converge on one policy.**
    - Pros: simpler.
    - Cons: changes transcript text in one or two bridges, which this task must not do.
- **Should the SSE replay rings move as part of BR-15?** Open.
  - **Separately, after BR-7 (recommended).**
    - Pros: Claude's ring adopting Codex's superseded-frame collapse changes what a reconnecting client is replayed, which needs its own replay tests; the transcript helpers did not depend on it.
    - Cons: BR-15 stays half open.
  - **Move Codex's `event-ring.ts` into protocol now and point Claude at it.**
    - Pros: closes BR-15.
    - Cons: a behaviour change to Claude's SSE replay in a task meant to leave output unchanged.

### 7. Change tracking and git scans

**Problem.** Captures read and hash unchanged files, recount unchanged diffs every pass, and local scans spawn many git processes with no minimum gap.

**Context.** The report's ST-1 to ST-6 and ST-13 to ST-21. fsmonitor is no longer enabled (`docs/architecture/git-scan-caches.md`), so ST-17's second option is gone. Done on 2026-11-02: ST-1 (a host capture reuses a settled stat-cache entry's oid after `fstat`, without reading or hashing), ST-2's first half (libc is `dlopen`ed once per process, and the `readlinkat` probe uses one scratch buffer) and ST-4 (a bounded LRU of line counts by blob pair in `snapshot-diff.ts`). The capture benchmark (`scripts/benchmark-change-tracking.ts`) gained the report's large-asset and 200-changed-file fixtures (`--only=assets,long-turn`). Tests: `capture-stat-reuse.test.ts` and `snapshot-diff-count-cache.test.ts`.

**Investigation.** Re-checked on 2026-11-02 against `main` at `38d55ee1`: ST-1, ST-2 and ST-4 were still as the report describes; the rest of this task was not re-checked. Measured on the shared build host under heavy load (load average 25 to 34), three interleaved runs each of the old and new code, 10 warm runs per workload, p50 range:

| Workload | Before | After |
| --- | --- | --- |
| 1,000 files, one changed: warm capture | 114–261 ms | 47–141 ms |
| 10,000 files, one changed: warm capture | 2,330–2,494 ms | 615–1,201 ms |
| 200 files + 20 × 8 MiB assets: warm capture | 281–505 ms | 13–44 ms |
| Long turn, 200 changed files vs the turn start: compare | 149–435 ms | 6–18 ms |

A micro-benchmark over 10,000 small files two directories deep (5 rounds, median): the old `confinedRead` 621 ms, the new one 275 ms (so `dlopen` cost about 35 µs per file), and the stamp-matched skip 44 ms, which includes the whole ancestor walk. Caching directory handles could therefore save at most about 2 µs per file. What remains of a warm capture over many small files is ST-3: `ObjectStore.reuse` (`utimes` under the store lock) and the closure `has`, about 230 ms each per 10,000 files in one profiling run.

**Decisions.**

- **First step?** Decided 2026-11-01, done 2026-11-02.
  - **ST-1, ST-2 and ST-4 together, measured with the capture benchmark plus the large-asset and 200-changed-file fixtures the report names (recommended).**
    - Pros: the highest-impact items; one benchmark run proves all three.
    - Cons: the fixtures have to be written first.
  - **ST-16's minimum scan gap first.**
    - Pros: one small change with a clear effect during installs.
    - Cons: leaves the per-capture cost untouched.
- **When may a matching stat stamp stand in for the content?** Done as recommended.
  - **Only when the file's mtime and ctime were at least `STAT_SETTLE_WINDOW_MS` (2 s) old when it was read; a path hint drops its entry (recommended).**
    - Pros: closes Git's "racily clean" case, where a same-size rewrite inside one timestamp tick keeps the stamp; a file stops being re-read 2 s after its last write; restore and watcher hints still force a read.
    - Cons: files the agent is actively writing are read on every capture until they age; one more field (`settled`) in the stat cache.
  - **Trust any matching stamp.**
    - Pros: simplest; skips the most reads.
    - Cons: a racy same-size rewrite would publish the old oid, a wrong capture result.
  - **Trust it and also compare mtime with the capture's own start time, like Git's index.**
    - Pros: the same protection as the window.
    - Cons: needs the previous capture's start time carried with the cache, for no measurable gain over the window.
- **ST-2's second half: cache directory handles within a capture?** Not done.
  - **Leave the per-file ancestor walk (recommended).**
    - Pros: the walk, open and `fstat` together cost about 4 µs per file; no open descriptors outlive a read, so there is no descriptor budget or reuse race to manage.
    - Cons: a few redundant `openat` calls per file remain.
  - **A capture-scoped, reference-counted handle cache.**
    - Pros: fewer syscalls per file.
    - Cons: at most about 20 ms per 10,000 files; needs begin/end hooks on the executor interface (host reads are issued one at a time per capture), a descriptor bound, and keeps a moved or replaced directory open for the rest of the pass.
- **Which line counts are cached?** Done as recommended.
  - **Exact counts and deterministic limits, keyed by kind, both oids and the two deterministic budget fields; a hit is used only while the store still holds both blobs (recommended).**
    - Pros: content addressing means entries never go stale; a deleted or expired body still reads as `body-unavailable`, exactly as before; bounded at 8,192 entries and 4 MiB estimated.
    - Cons: a hit still costs two `stat` calls; a corrupted (rather than missing) object is not noticed on a hit until its body is rendered.
  - **Cache everything, including `cpu-budget` limits.**
    - Pros: simplest.
    - Cons: a wall-clock limit under load would stick for the rest of the process.
- **Container captures?** Not done.
  - **Leave the container helper as it is for now (recommended).**
    - Pros: its hashing runs inside the container, off the backend's event loop, and only hashes cross the boundary.
    - Cons: a container capture still reads every candidate file.
  - **Send cached stamps to the helper so it can skip settled files too.**
    - Pros: the same saving inside the container.
    - Cons: a protocol change to the helper and a larger stdin per batch; needs container qualification.
- **Next step for this task?**
  - **ST-3: skip the closure `has` for objects proven present in this pass and the `utimes` inside the grace window (recommended).**
    - Pros: it is now the largest part of a warm capture over many small files.
    - Cons: touches the orphan fence that retention relies on, so the grace-window reasoning needs care.
  - **ST-16's minimum scan gap.**
    - Pros: small and independent.
    - Cons: does not touch capture cost.

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

**Context.** Decided 2026-11-01: batch PRs into one GraphQL query per host first; then back off only PRs with no pending checks and auto-merge off, because a finishing check may not change `updatedAt`. Auto-merge (#1494) shipped after the report and relies on this monitor. BG-13 (`get_environments` triggering a whole-installation sync) belongs here too. Done 2026-11-03:

- BG-6 batching (`commands-pr-monitor-batch.ts`): a local known-PR lookup reads every open PR of its (GitHub host, Settings credential source) group in one aliased `gh api graphql` query, rollup included, at most 25 per query. Other members' background polls in the next 10 s use that reading without a process; concurrent polls share the query in flight. A user refresh, pending mode or agent completion asks fresh. Anything the batch cannot answer (another host, a PR GitHub left out, a renamed repository, a failed or unparseable batch, a rollup over one page) takes today's per-PR `gh pr view`; a failed batch suspends its group for 5 min, and rate limits and timeouts reach the monitor's cooldown instead of a per-PR retry. Credential rotation (`rotateScope("local-gh")`) drops the group's readings. Containers stay on the per-PR path.
- BG-6 backoff (`pr-monitor.ts`, `pr-monitor-policy.ts`): an open PR whose reading (state, mergeability, head, `updatedAt`, rollup counts, GitHub auto-merge) has not moved for 15 min, whose last rollup succeeded with nothing pending, whose mergeability is known and with neither Orkestrator's `autoMerge` nor GitHub's auto-merge on, is polled every 2 min (+ up to 15 s jitter). Any wake, a changed reading, turning auto-merge on, or a change a batch saw for that PR returns it to 20 s at once. The per-PR lookup now also asks for `updatedAt,autoMergeRequest`.
- BG-13 (`pr-monitor-runtime.ts`): a sync queued behind the running one that has not read storage yet answers every later caller, so a burst of `get_environments` costs at most one running and one queued reconciliation. The project-scoped sync was not done.

Tests: `commands-pr-monitor-batch.test.ts` (reader rules, and the `gh` boundary through a fake `gh` on PATH), `tests/pr-monitor-quiet.test.ts`, `pr-monitor-policy.test.ts`, `pr-monitor-runtime.test.ts`.

**Investigation.** Containers: each sources its own runtime credential inside the container, which the backend cannot prove equal to another's, so the recommended option below was taken and containers keep one lookup per PR (they gain only the backoff). Not checked live: GitHub's real response to a batch where one alias is inaccessible (`gh api` is expected to exit non-zero and still print the answered aliases, which the reader parses), and the before-and-after query counts (task 1).

**Decisions.**

- **How to batch across containers?**
  - **Batch per (host, credential) group, and keep containers whose `gh` cannot be shared on today's per-PR path (recommended).**
    - Pros: no credential crosses an environment boundary.
    - Cons: containers gain less.
  - **Run every query from the host's `gh`.**
    - Pros: the biggest saving.
    - Cons: the host credential may not see a container's repository, and it changes whose identity polls.

### 10. Other background jobs

**Problem.** Some 2 s and 5 s jobs still did per-item work that could be skipped.

**Context.** Done on 2026-11-01: mail presence returns early while messaging is disabled; it still refreshes while paused (see Assumptions and decisions). Done on 2026-11-02, re-checked against `main` at `38d55ee14` first (all four were still true there):

- BG-3. `refreshPresenceOnce` (`agent-mail-service.ts`) reads each environment once per pass and records a stopped one's presence without any per-mailbox read: native `environment_stopped` when the environment is missing, being deleted or not running; tmux `environment_unready` when it is not ready for agents. Those are the answers the per-mailbox reads give, so the inject-backoff reset on a change is unchanged. Coordinator runtimes and unreadable rows still take the per-mailbox read. Tmux presence passes `livenessMaxAgeMs: 3000` to `claude_tmux_status`, which takes the session's last `has-session` answer (`TmuxSession.recentLiveness`, recorded by every `tmuxAlive`) when it is that recent and probes otherwise. A dispatch still probes.
- BG-9. `AgentHumanPromptMonitor` reuses a working session's last observation while `NativeAgentService.humanPromptContentRevision` (provider session id plus the activity sweep's `contentRevision`) is unchanged, for at most 30 s (`HUMAN_PROMPT_PROJECTION_REUSE_MS`). Background task files are still read every pass. Providers that report no revision (OpenCode, Cursor, Pi, Grok) are read every pass as before. OpenCode's `humanPromptOutput` normalises only the newest 64 rows (`normalizeOpenCodeTranscriptTail`, `HUMAN_PROMPT_OBSERVATION_ROWS`) instead of the whole retained history.
- BG-11. `BuildPipelineReviewFanout.reviewHost` builds the shared package prompt (review instruction plus project notes) once per pass for the package it describes; a failed build is dropped.
- BG-12. `syncContainerClaudeLoginUnlocked` compares the pushed digest of a matching keeper handover before the marker `docker exec`; the keeper passes its one read of configuration and environments (`ClaudeLoginPassSnapshot`) for the first gate, and delivery still re-reads its fences after host I/O.

**Investigation.** Counted with the new tests run against the old code: a stopped environment's native mailbox did 1 presence read per pass (now 0), a stopped tmux mailbox 1 (now 0); a four-reviewer dispatch pass read the project notes 5 times (now 2, one of which is the pass's own); four human-prompt passes over a session whose revision changed once made 4 bridge reads (now 2); an unchanged Claude login cost one marker `docker exec` per container per keeper pass (now none). These are unit counts, not the live `recurringWork` diagnostics task 1 asks for.

**Decisions.**

- **BG-3: where does a stopped environment get skipped?**
  - **In `refreshPresenceOnce`, from the environment's status before any per-mailbox read (recommended, done).**
    - Pros: one place; no reads for stopped environments.
    - Cons: one environment read per environment per pass; defers the native read's backstop that clears a refused mail dispatch (see Assumptions and decisions).
  - **Compute presence lazily on `list_mailboxes`.**
    - Pros: no periodic work at all.
    - Cons: delivery decisions in the inject drain also read presence, so it changes their timing.
- **BG-9: what may the monitor skip on an unchanged revision?**
  - **The bridge observation only, reusing the last one for at most 30 s; task files are read every pass (recommended, done).**
    - Pros: an unchanged session costs no request; a file that grows outside the revision is still seen.
    - Cons: only Claude and Codex report a revision; the cache holds up to 256 bounded observations.
  - **Skip the whole session, files included.**
    - Pros: no work at all.
    - Cons: misses a background task's sign-in prompt, which only appears in its output file.
- **BG-12: what does the digest check skip?**
  - **The marker read, and only when the keeper's handover is for the pinned account and generation (recommended, done).**
    - Pros: no extra host credential read; every path past it would have written nothing.
    - Cons: the handover's MCP digests are remembered before the marker check.
  - **Read the login afresh to compare even without a matching handover.**
    - Pros: covers every caller.
    - Cons: adds a host credential read (a `security` call on macOS) where the marker would have stopped the sync.

### 11. Gateway and preview proxy

**Problem.** Per-frame and per-request costs remain in the gateway (GW-5, GW-6, GW-10 to GW-12, GW-14 to GW-16). The preview proxy's missing upstream connection reuse (GW-8) and stripped ETags (GW-9) are fixed.

**Context.** Done: the shared SSE decoder is linear (GW-4). GW-2 is done in 0052 (D14). Done on 2026-11-02:

- GW-8: the private-origin proxy keeps idle upstream connections (`apps/backend/src/preview-upstream-pool.ts`). A connection is reused only by the access (attachment), endpoint generation and target it was opened for, after the access and target are re-checked. The pool is registered with the access service, so revocation, expiry and a new endpoint generation close it at once; a registry revocation also drops it. Bounds: 8 idle per access, 64 per backend, 2 s idle. A safe bodyless request whose reused connection was already closed is resent once on a fresh connection (`preview-forward.ts`); nothing else is retried. Counters `upstream.opened`, `upstream.reused`, `upstream.stale_retry` and the gauge `publication.upstream_idle` are in preview diagnostics.
- GW-9: when the gateway proxy compresses a body, or the legacy browser-preview route rewrites one, it sends a weak ETag derived from the upstream tag, `W/"<upstream>|ork:<w|s>:<coding>[:<rewrite key>]"`, instead of none, and turns it back into the upstream's exact tag on `If-None-Match` (`apps/backend/src/gateway-proxy-etag.ts`). The application's 304 is answered with the client's tag. Reloads now revalidate, so GW-10's rewrite runs only on first loads and changed modules.
- Tests: `preview-upstream-pool.test.ts`, the reuse cases in `preview-forward.test.ts` and `preview-publication.test.ts`, `gateway-proxy-etag.test.ts`, and in `test:preview:browser` `e2e/preview/upstream-pool.spec.ts` (reuse, revocation and generation change close idle connections, legacy-route 304) plus the opt-in measurement `e2e/preview/vite-page-load.spec.ts`. The whole `test:preview:browser` suite with the Vite fixture passed twice in Chromium, Firefox and WebKit (58 passed, 2 skipped: the Chromium-only measurement). On beelink WebKit ran only with Ubuntu 24.04's `libicu74`, `libxml2` and `libflite1` libraries added to a private copy of the WebKit bundle (see 2680).

**Investigation.** Re-checked on 2026-11-02 against `main` at `38d55ee14`. GW-8 held for the private origin only: `preview-http-proxy.ts` supplied no `reuse` hook although the forwarder and HTTP client supported one, while Electron's local ingress already pooled its tunnel connections and the legacy route already reused connections through Bun's HTTP client. GW-9 held for the legacy browser-preview route and the compressing loopback proxy; the private origin already passed ETags through, so its reloads already got 304s.

Measured with `vite-page-load.spec.ts` (Chromium, the pinned Vite 7.3.6 fixture in an isolated copy plus a generated 150-module page, `/wide.html`; medians of 5 loads per run, 3 runs each). "Again" is a second load in the same tab, "cold" a load after clearing the HTTP cache.

| Wide page (156 requests) | Before | After |
| --- | --- | --- |
| Private origin, upstream connections: first / again / cold | 155 / 155 / 155 | 7 / 1 / 1 |
| Legacy route, bytes on a repeat load | 121 KB (no revalidation) | 0 (154 of 154 answered 304) |
| Legacy route, 304s at the gateway on a repeat load | 0 | 154 |

The fixture's own page (7 requests): private-origin connections 6 / 6 / 6 before, 3 / 1 / 1 after; legacy repeat-load bytes 43.5 KB before, 0 after. Page-load times were taken on beelink with about ten builds running (load average 30 to 55) and moved more with host load than with the change: wide-page private-origin first load 418 ms median before and 622 ms after, but in different load windows. An interleaved A/B on the same build (four alternating runs with reuse on and off, `ORKESTRATOR_TEST_PREVIEW_POOL_OFF=1`, load average about 50) gave wide-page private-origin medians of 753 ms on / 744 ms off for a first load, 540 / 577 ms for a repeat load and 611 / 645 ms after clearing the cache, with 7 / 1 / 1 against 155 / 155 / 155 upstream connections: within noise. On loopback a TCP connect costs well under a millisecond, so the gain is in connections, sockets and, for TLS and relay targets, handshakes, not visible milliseconds. Raw lines are in `output/efficiency/preview-page-load/` of the build worktree (git-ignored).

Not re-checked: GW-5, GW-6 (terminal WebSocket flush ignores `bufferedAmount`), GW-10 to GW-12, GW-14 to GW-16.

**Decisions.**

- **First step?** Decided 2026-11-01 and done 2026-11-02.
  - **GW-8 and GW-9 together, measured with a Vite fixture page load (recommended).**
    - Pros: the largest wins for preview users; GW-9 also removes most of GW-10's rewrite work.
    - Cons: the pool needs revocation on endpoint generation change and access revocation, which `test:preview:browser` must cover.
  - **GW-6 first.**
    - Pros: fixes a correctness-adjacent desync of quiet channels.
    - Cons: only users of the opt-in terminal WebSocket benefit.
- **What keys the pool?** Done.
  - **Access (attachment), endpoint generation and target (recommended).**
    - Pros: a connection serves only the browser session that opened it; the access service's existing resource tracking closes it on revocation, expiry and generation change with no new revocation path.
    - Cons: two browser sessions of one service do not share connections.
  - **Service and endpoint generation.**
    - Pros: more reuse across sessions.
    - Cons: a revoked session's connection could serve another one, and revocation needs a separate per-service path.
- **Idle bounds?** Done.
  - **8 per access, 64 per backend, 2 s idle (recommended).**
    - Pros: below the 5 s keep-alive timeout of Node's HTTP server (Vite's), so the application rarely closes a connection about to be reused; matches Electron's ingress pool and a browser's six connections per host.
    - Cons: a pause of more than 2 s between navigations pays a new connect.
  - **Longer idle (30 s or more).**
    - Pros: reuse across slower navigation.
    - Cons: more races with application keep-alive timeouts and more sockets held per idle tab.
- **A reused connection the application had closed?** Done.
  - **Resend once on a fresh connection, only for `GET`, `HEAD` and `OPTIONS` without a body, only when nothing was answered (recommended).**
    - Pros: what browsers do (RFC 9112 §9.3.1); hides the keep-alive race from users; nothing to replay.
    - Cons: a safe request reaches the application twice if it closed after reading the request; requests with a body never take an idle connection.
  - **Never retry.**
    - Pros: the forwarder keeps its "never retries" rule.
    - Cons: an occasional 502 on a page load whenever the application's keep-alive timer fires.
- **Derived tag format?** Done.
  - **`W/"<upstream>|ork:<w|s>:<coding>[:<rewrite key>]"`, the key hashing route prefix, port and the rewriter's source (recommended).**
    - Pros: rebuilds the upstream tag exactly, weak prefix included (Vite compares `If-None-Match` as a plain string); a tag never revalidates bytes rewritten for another route or by another build.
    - Cons: an Orkestrator update that changes the rewriter costs one full reload per module.
  - **The report's `W/"<upstream>|<encoding>|rw<prefix-hash>"`.**
    - Pros: shorter.
    - Cons: loses whether the upstream tag was weak, so Vite would never answer 304; a rewriter change would revalidate stale rewrites.
- **Next step?** Open.
  - **GW-6, the terminal WebSocket flush that ignores `bufferedAmount` (recommended).**
    - Pros: correctness-adjacent; small.
    - Cons: only users of the opt-in terminal WebSocket benefit.
  - **GW-10, one combined rewrite regex with a no-match fast path.**
    - Pros: cheaper first loads on the legacy route.
    - Cons: GW-9 already removed the rewrite from repeat loads, and the legacy route is a fallback.
  - **GW-11 and GW-12, per-node federation event names and one cursor frame per skipped range.**
    - Pros: less replay-window pressure for federation users.
    - Cons: federation only; touches replay invariants.

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

**Problem.** Every desktop launch SHA-256'd the whole installed toolchain (about 1.2 GB) twice per `ensurePinnedToolchains` call before the backend started, and slow links could never finish a download.

**Context.** Done 2026-11-03 on branch `desktop-launch-hash-2ed459efe5f8-r1` (based on `main` at `7b48c23f`). Re-checked first: the final verification was still unconditional, and desktop startup (`apps/desktop/electron/toolchain-startup.ts`) calls the manager twice when a support tool such as `gh` is pinned (required agents, then the combined set), so a launch hashed every agent binary four times, not two. Downloads still had the five-minute total deadline and restarted from zero.

- **DK-3 (done).** `packages/toolchain/src/file-stamps.ts` keeps `toolchains/.verified-stamps.json`: per file `dev, ino, size, mtimeNs, ctimeNs, digest` plus when the stamp was taken. A file whose metadata matches is not read; any mismatch re-hashes it. A stamp taken within 2 s of the file's own mtime or ctime is never trusted on metadata alone (git's racy-index rule). A full check ignores every persisted stamp once a week, when the stamp file is missing or unreadable, when the clock is behind the last check, and on the in-app toolchain repair (`fullVerification`). Stamps taken earlier in the same run are reused, so the final verification no longer re-reads untouched files. Re-signed macOS copies (OpenCode, Pi) are kept, without `codesign` or `--version`, while their stamp matches and they were made from the current pinned upstream.
- **DK-4 (done).** `packages/toolchain/src/download.ts`: a 60 s idle timeout replaces the total deadline; bytes go to `toolchains/.downloads/<sha256>.partial`, which survives the staging directory; a retry or the next launch re-hashes the partial and asks for the rest with `Range:` (a `200` restarts, a wrong `Content-Range` or a damaged partial is discarded). Up to five attempts per call while each makes progress.
- `apps/desktop/electron/main.ts` logs `toolchain` `prepare.ready` with `durationMs`, the toolchain's share of launch-to-ready.

**Investigation.** Measured 2026-11-03 on arktech-mini (macOS, Apple silicon, about ten other builds running, warm page cache) with `output/efficiency/toolchain-13/bench.ts` (git-ignored): the two calls desktop startup makes, against an APFS clone of the installed toolchain in a throwaway data directory, with real `codesign` and `--version` probes and `HOME` pointed at a temporary directory. Times are for the whole toolchain step, which startup awaits before anything else.

| Run | Before (`7b48c23f`) | After |
| --- | --- | --- |
| Unchanged toolchain, stamps current | 7.4 to 10.5 s (first window); 19.3 to 20.7 s (later, busier window) | 0.29 to 0.91 s (nine runs across both windows) |
| First launch after a full check (re-signed copies' stamps still racy) | n/a | 1.0 to 1.5 s |
| First launch after the old code re-created the re-signed copies (an upgrade) | n/a | 3.0 to 3.8 s |
| Full check: first launch with no stamp file, weekly, or repair | as above | 7.7 s (first window); 9.6 to 10.2 s (busier window) |

Whole Electron launch to ready, measured the same day on an isolated `dev:test` profile (`tc13-launch`, no fixture, the six seeded toolchains, 1.3 GB; load average 20 to 29) with `output/efficiency/toolchain-13/launch-runs.sh` (git-ignored). The time runs from the launcher's first status write naming an Electron PID to its `ready` write, which follows Electron's readiness line (window created, backend started); polled every 25 ms. "Before" is the same tree with `packages/toolchain/src` and `apps/desktop/electron/main.ts` checked out from `7b48c23f`; the Electron bundle is rebuilt from source on every start. The profile was reset afterwards.

| Launch | Before (`7b48c23f`) | After | After: `prepare.ready` `durationMs` |
| --- | --- | --- | --- |
| Unchanged toolchain (repeat launches) | 10.2, 13.8, 12.6 s | 1.6, 1.9, 1.8, 1.7 s | 449, 390, 492, 214 ms |
| First launch on the new code (no stamp file, so a full check) | n/a | 4.7 s | 3,339 ms |

Not measured: a cold page cache (`purge` needs root).

**Decisions.**

- **What does a stamp hold?** The ticket chose the recommended option; implemented as such.
  - **`dev, ino, size, mtimeNs, ctimeNs, digest` per file, re-hashing on any mismatch and on a periodic full check (recommended, done).**
    - Pros: catches replacement and in-place edits; a periodic check covers a forged mtime.
    - Cons: a stamp file to keep consistent with the install.
  - **Skip only the final verification when nothing changed this run.**
    - Pros: smallest change; halves the cost.
    - Cons: still one full hash per launch.
- **How often is the full check?** See "Task 13: full-check interval" below.

### 14. Docker image size

**Problem.** A bridge release re-pulled every layer from the first bridge `COPY` to the end of the image, Bun was installed twice, npm's download cache stayed in the image, and a leftover `apt-get update` ran after the script `COPY`s.

**Context.** DK-7, DK-8, DK-9 and DK-11 done 2026-11-02 in one image change, together with Node 24.22.2 ([0032](0032-dependency-upgrades.md) task 7), measured on `main` at `38d55ee14` (before) and the same tree with the change (after), linux/amd64, beelink. What changed in `docker/Dockerfile`:

- DK-7: starship and mise now sit above the bridges. The builder copies each bridge's sources just before its own build, least-changed first (pi, cursor, acp, claude, codex, by commits since 2026-08-01). The vendored SDKs (`dist/node_modules` of pi, cursor and claude) move to `/opt/bridge-deps/<bridge>` in the builder and ship in their own layers ahead of the bundles. The shell config `COPY`s moved below the bridges because they are small.
- DK-8: the base image's `/usr/local/bin/bun` is registered in mise's system directory with `MISE_DATA_DIR=/usr/local/share/mise mise link bun@1.4.4 /opt/bun`, where `/opt/bun/bin/{bun,bunx}` are symlinks to it. Nothing is downloaded. A `node` user with a project that pins `bun = "1.4.4"` gets "already installed" offline.
- DK-9: each `npm install -g` (Claude Code, Codex, Playwright) ends with `&& npm cache clean --force` in the same `RUN`.
- DK-11: the late `apt-get update && apt-get install util-linux` is gone. `util-linux` is Essential in the Debian base and already present; it is now listed in the first apt layer, and the `setpriv` checks stay.

Tests changed: `tests/unit/monorepo-scripts.test.ts` (layer order, npm cache), `version-drift.test.ts` (`mise link` instead of `mise install --system`), `runtime-env-wiring.test.ts` (mise above the bridges, below the browser; the old assertion compared against a comment that no longer existed) and `firewall-policy.test.ts` (one apt layer).

**Investigation.** Measured with `docker image inspect`, `docker history` and `du -sxh` inside the image:

| | Before | After |
| --- | --- | --- |
| Image size (uncompressed) | 6,411 MB | 5,452 MB (−959 MB, −15%) |
| `/home/node/.npm` | 356 MB (`_cacache`) | 32 KB (logs only) |
| Second Bun (`/usr/local/share/mise/installs/bun`) | 103 MB, plus 50 MB mise download cache in `/root/.cache/mise` | 16 KB of symlinks; no cache |
| mise layer | 321 MB | 162 MB (the mise binary is 155 MB) |
| Claude Code npm layer | 443 MB | 301 MB |
| Codex npm layer | 647 MB | 456 MB |
| Playwright npm layer | 58.8 MB | 19.1 MB |
| Re-pulled bytes when all five bridges change | 895 MB (40 layers) | 22.8 MB (38 layers: bundles of 2.8 to 8.9 MB each, the rest small scripts) |

The re-pull row comes from a probe: a runtime line appended to all five `bridges/*/src/index.ts`, both Dockerfiles rebuilt on the same builder, and changed layer digests (`RootFS.Layers`) compared against each unprobed image. The vendored SDK layers kept their digests across the rebuild. CI builds with `cache-from`/`cache-to: type=gha,mode=max` (`publish-container.yml`), so they reuse layers the same way. `bash docker/tests/final-image-smoke.sh` passed on the after image.

`mise run test:agent:docker` ran on the after image, in a disposable profile (`--fixture-environments local,container --no-agent-credentials --agent-platforms codex,grok,opencode --headless-electron`). Load average was about 46 because about ten builds were sharing the host. Result: 17 passed, 4 skipped, 3 failed, and the same three failed again when rerun alone. The causes were not all established; these failures remain qualification blockers:

- `web-annotations-gateway.spec.ts:958`: the "Docker containers can't reach Orkestrator" dialog covered the page. The host's ufw drops traffic from Docker networks to the agent tools port.
- `native-draft-attachments.spec.ts:378`: the test's restricted container started from the new image. After that, the page showed "Orkestrator couldn't connect" before the sidebar loaded.
- `container-app-wiring.spec.ts:447`: the profile's coordinator conversation was already assigned to Codex ("Coordinator, Codex"). The test expects "Coordinator, no agent chosen yet".

The passing tests include container boot and restart with imported logins, rebuild, deletion, the root terminal, settings, Files, merge, Build-tab validation output, the Playwright launch for both container users and design export. The four skipped tests are live-provider opt-ins: Grok login renewal, a live agent note, and two live Claude cases.

Rechecked after rebasing onto current `main` at `643ce87c4` on 2026-11-02: all four findings still applied before this change. Fresh linux/amd64 builds measured **6,411,820,583 → 5,452,072,222 bytes** (−959,748,361 bytes, −15%). `docker history --no-trunc` and container `du -sxh` reproduce the cache and mise savings above. Both builds and the final-image smoke passed; four focused unit test files passed. The Node drift check now enforces ≥24.22.1.

The final amd64 qualification rebuilt the reviewed Dockerfile using
`mise run docker:build:dev --profile dk1202-round2`. The resulting image was
5,452,373,507 bytes with Node `v24.22.2`; `bash
docker/tests/final-image-smoke.sh orkestrator-v2:dev-243dd588f5d7` passed,
including health checks for all five bridges and offline Bun registration
as `node` with a project pin of 1.4.4.

Docker's default address pools were exhausted. Qualification used explicit
`/29` subnets from otherwise unrouted `172.16.240.0/22` for the disposable
profile's own networks, retrying only Docker overlap refusals. No foreign
resources, daemon settings or firewall rules were changed. Reproduction needs
available Docker address space or equivalent explicit subnet allocation;
no untracked helper is required as durable evidence.

The profile used `--fixture-environments local,container
--no-agent-credentials --agent-platforms codex,grok,opencode
--headless-electron`. Against that ready profile, the final qualifying command
was `ORKESTRATOR_AGENT_TEST_PROFILE=dk1202-round2 mise run test:logged --
--name round2-agent-docker-fixed -- mise run test:agent:docker`.
**Result: 20 passed, 4 skipped, 0 failed, 0 flaky (510.5 s).** The skips
are existing live-provider opt-ins; no billed turns or credentials were used.
The suite covers inactive environments, hidden documents, reloads and second
windows. The approval and annotation specs reuse `loadAppWithDevRetry` for
the known dev import failure and host-connectivity warning. The coordinator
check preserves the main conversation and compares its displayed agent with
persisted state. Focused E2E types, lint, format and `git diff --check` passed.
The disposable profile was stopped/reset and its image tag removed.

Earlier attempts did not qualify the image: address exhaustion prevented
fixture readiness, and a later UI attempt exposed stale startup and coordinator
assertions. The successful run above supersedes those attempts. Original
preparation artifacts were preserved.

Review preparation must qualify the committed snapshot with `mise run
test:agent:docker:isolated` (through `test:logged`). This one-shot task builds
and smokes the image, provisions its own credential-free local/container
profile, runs the same Docker fixture selection as `test:agent:docker`, then
stops/resets the profile and removes its image tag. The scheduler declares
coverage of `test:agent:docker`. Running that bare task after the earlier
profile was reset produced a failed validation entry despite a separate later
manual pass; that entry does not establish qualification. The one-shot path
keeps setup, smoke, suite and cleanup in the preparation command's own result.
Its tracked PATH shim handles exhausted pools for owned fixture networks only,
checking host routes before explicit /29 allocation and preserving overlap
refusals. No external helper or running profile is needed. Fresh qualification
on 2026-11-02 passed through this one-shot path: image build and final-image
smoke passed, followed by **20 passed, 4 live-provider skips, 0 failed, 0 flaky**
(578.2 s suite; 608.3 s including build, smoke, setup and cleanup). The profile
reported `missing` with no live processes after cleanup, and its image tag was
absent. This focused pass does not replace the next preparation package's run
against the committed snapshot.

Native arm64 qualification remains open: an emulated build failed at the
existing Chromium verifier after 273.2 seconds (GPU launch error 1002,
QEMU target signal 5). No arm64 final image or smoke result exists; a native
runner is needed. The Chromium check was preserved. DK-10 remains outside
this completed subset.

DK-10 is still open. The SDK's `claude-agent-sdk-linux-x64/claude` (0.3.314) and the CLI's `claude-code/bin/claude.exe` (2.1.314) are the same file today: SHA-256 `4487042b…5f84594`, 298 MB each. [`upgrade-agents.md`](../../development/upgrade-agents.md) says the SDK deliberately does not track the CLI, so they can diverge.

Not addressed, for a later pass: the Playwright layer (1.07 GB: Chromium, the headless shell and `--with-deps` apt packages), and the bridge `src/` trees that ship next to `dist` (about 16 MB, unused at runtime).

**Decisions.**

- **One change or several?** Decided and done: one change.
  - **DK-7, DK-8, DK-9 and DK-11 in one image change, with `docker history` and `du` before and after (recommended).**
    - Pros: one rebuild and one smoke run.
    - Cons: a regression is harder to attribute.
  - **One change per finding.**
    - Pros: each saving is measured alone.
    - Cons: four rebuilds and four pulls for users.
- **How far should DK-7 go?** Done: split out the SDKs.
  - **Reorder and split the vendored SDKs into their own layers (recommended).**
    - Pros: a code-only release re-pulls 22.8 MB instead of 895 MB.
    - Cons: three more `COPY` lines; the builder moves `dist/node_modules` out and the final stage merges it back.
  - **Reorder only, as the report proposed.**
    - Pros: smallest diff.
    - Cons: the claude, pi and cursor layers (549 MB) still re-pull on every release that touches bridge code or `packages/protocol`.
- **How to register Bun with mise (DK-8)?** Done: `mise link`.
  - **`mise link` into the system directory, pointing at the base binary (recommended).**
    - Pros: no download or second copy; mise writes its own runtime symlinks (`1`, `1.4`, `latest`), so `mise install` as `node` reports "already installed".
    - Cons: `mise ls` shows `(symlink)`; mise creates `/usr/local/share/mise/shims`, which the build removes because nothing uses it.
  - **Hand-made `installs/bun/1.4.4/bin` symlinks.**
    - Pros: no mise invocation.
    - Cons: tried; without the runtime symlinks, `mise install` as `node` failed trying to rebuild them through sudo.
  - **Move the base binary into the mise directory.**
    - Pros: one real file.
    - Cons: a move in a later layer copies the 107 MB again, so nothing is saved.
- **DK-10: the second Claude binary.** Open; needs the maintainer.
  - **At build time, symlink the SDK binary to the CLI's when the two are byte-identical, otherwise copy it (recommended).** This needs a `RUN --mount=type=bind,from=bridge-build`. That is a bind mount, not the cache mount 0022 rejected.
    - Pros: saves 298 MB while the pins agree, as they do today; no change when they diverge.
    - Cons: the bridge's SDK would run whatever is at the CLI path, so a user's `npm i -g @anthropic-ai/claude-code@<other>` inside a container would change the bridge's engine too; adds BuildKit-only syntax.
  - **Leave both copies.**
    - Pros: the SDK stays self-contained and follows its own release train.
    - Cons: 298 MB of identical bytes in every image.

### 15. Container data transfer

**Problem.** Each environment clones from the remote again (DK-13) and copies agent-home inputs in full on every start (DK-14). Until 2026-11-02 it also copied its clone byte for byte inside one volume (DK-12), and a same-disk move of a worktree with submodules copied the whole worktree (DK-15).

**Context.** Decided 2026-11-01: do this now, ahead of the measurement gate. Files: `docker/workspace-setup.sh` (DK-12, DK-13), `portable-inputs.ts` and the entrypoints (DK-14), `environment-move.ts` (DK-15). Container storage rules in `docs/architecture/container-lifecycle.md` apply: no removal outside lifecycle operations.

Done 2026-11-02 against `main` at `38d55ee1`:

- DK-12: `move_clone_into_workspace` in `docker/workspace-setup.sh` renames each top-level entry of the staged clone (`/workspace/.orkestrator/.clone-in-progress`) into `/workspace` instead of `cp -a -n` then `rm -rf`. Tests: `tests/unit/workspace-setup-preserve.test.ts` ("workspace setup clone move").
- DK-15: when git refuses to move a worktree because it has submodules, `renameWorktree` in `environment-move.ts` renames the folder, runs `git worktree repair` and re-links the submodules. It copies only when the rename answers `EXDEV`. Tests: `environment-move.test.ts` ("same-disk move of a worktree git will not move"). `docs/development/disk-usage.md` describes the new behaviour.
- DK-14 is left open on purpose: another build edits `portable-inputs.ts` at the same time. DK-13 (the mirror) is also still open.

**Investigation.** Re-checked on 2026-11-02: DK-12 and DK-15 were still as the report describes. A same-disk worktree without submodules already moved by rename (`git worktree move`); the copy happened only for worktrees with submodules, which git refuses to move. Still unverified: whether blobless clones pay many lazy round trips for history-heavy diffs, which affects DK-13.

Measurements, beelink (btrfs host, about ten builds running at once, so timings are noisy), three runs each:

| Item | Setup | Before | After |
| --- | --- | --- | --- |
| DK-12 | Clone of this repository (206 MB, 8,478 files), Docker volume on btrfs, move step only | 400–602 ms; extra peak disk 0–31 MB, because `cp` reflinks on btrfs | 9–42 ms; no extra disk |
| DK-12 | Same clone, tmpfs volume (no reflinks, like ext4 or Docker Desktop's VM disk) | 134–153 ms; extra peak disk 206 MB, a second whole clone | 8–21 ms; no extra disk |
| DK-12 | Real helper in a container, then `git status` | n/a | 26 ms; clean status, `.orkestrator` intact |
| DK-15 | Whole `move_environment`, worktree with nested submodules and 200 MB in 2,000 files, tmpfs | 128–141 ms; one `cp`; extra peak disk 196 MB | 87–128 ms; no `cp`; extra peak disk 1–8 MB (sampling noise) |
| DK-15 | Same, on btrfs | 260–1,119 ms; one `cp` (reflinked) | 160–232 ms; no `cp` |
| DK-15 | Same, 20,000 files of 10 KB, btrfs | 1,399–1,947 ms | 120–147 ms |

The DK-12 numbers came from a throwaway script that runs the old and new steps on a scratch volume. The DK-15 numbers came from a temporary benchmark test that was not committed: it timed `moveEnvironmentTask` and sampled `statfs` every 5 ms, once with the old `environment-move.ts` and once with the new one.

**Decisions.**

- **Order?**
  - **DK-12 and DK-14's stamp first, then DK-13's mirror (recommended).**
    - Pros: the first two are local script changes; the mirror is a new per-project host resource with its own lifecycle.
    - Cons: the clone network cost stays until the mirror lands.
  - **DK-13 first.**
    - Pros: the largest saving for big repositories.
    - Cons: a new mounted resource to create, refresh, bound and clean up before anything else lands.
  - Taken 2026-11-02: DK-12 and DK-15 now; DK-14 next, once the other `portable-inputs.ts` build has merged, then DK-13.
- **DK-12: how is the clone moved?** (decided 2026-11-02)
  - **`mv -n` per top-level entry, skipping `.orkestrator` and `lost+found`, then a check that nothing was left behind (taken).**
    - Pros: one rename per entry within the volume. The existing `.clone-copy-in-progress` marker keeps the step resumable. The check catches an entry `mv -n` skipped, which GNU coreutils 9.7 (the image's) does silently with exit status 0. Per-entry `mv` without `-t` also runs on macOS, where the unit test runs.
    - Cons: one `mv` process per top-level entry (dozens, not thousands).
  - **`mv -n -t /workspace` with `find ... {} +`, as the report suggested.**
    - Pros: one process.
    - Cons: GNU-only `-t`; on its own it does not notice a skipped entry.
  - **Clone straight into `/workspace`.**
    - Pros: no move at all.
    - Cons: the clone would sit beside the storage marker with no staging folder, so an interrupted clone could not be told apart from user files.
  - A repository's own `.orkestrator` folder is left in the staging folder and deleted with it. The old merge copied it, but the restore of `.orkestrator` straight afterwards replaced it anyway, so the end state is the same.
- **DK-15: where does the rename go?** (decided 2026-11-02)
  - **Keep `git worktree move` first and rename only when git refuses because of submodules; copy only on `EXDEV` (taken).**
    - Pros: git still checks the ordinary case (locked worktrees, its own records). The submodule case gets the same journal as the copy: the record, with its submodules, is saved before the rename, so restart recovery adopts a destination whose source is gone and re-links it.
    - Cons: two code paths that rename.
  - **Replace `git worktree move` with `rename` plus `git worktree repair` for every move.**
    - Pros: one path.
    - Cons: drops git's own checks and rewrites a path that already works.
  - When git reports a cross-device error the move goes straight to the copy, without trying a rename that would fail. A failed repair or re-link, or a rejected path commit, renames the folder back and repairs the source. `git worktree move` cannot undo the rename, because git refuses submodules in that direction too. If renaming back fails, the record stays and restart recovery adopts the destination.

### 16. CLI and logging

**Problem.** `session transcript --follow` re-downloads its page every 2 s for up to 24 h, the CLI transport buffers responses three times, and the log sink runs `mkdir` and `appendFile` per line.

**Context.** `packages/cli/src/client/commands/session.ts`, `packages/cli/src/client/transport.ts`, `packages/protocol/src/node/application-logging.ts`. A `knownToken` on the public API is a contract change (`docs/architecture/public-cli.md`).

DK-16 and DK-17 done on 2026-11-03. `session.transcript` takes an optional `knownToken` (`apps/backend/src/core/public-api/actions-transcript.ts`): while the live window still has that token it answers `{sessionId, status: "unchanged", token}` with no messages (`PublicTranscriptUnchanged` in `public-api-resources.ts`). It is refused with `before`. The backend advertises it as `features.transcriptKnownToken`; `--follow` reads capabilities once and sends the held token only when the answering backend (the `--node` leaf when routed) advertises it, because an older backend refuses unknown input. Against an older backend it keeps the old full read and token comparison. The CLI transport now reads the bounded body once inside the request deadline and decodes those bytes directly; it no longer wraps them in a second `Response` and reads them again, and a refused answer (redirect, 401, 403) has its body cancelled unread. `readStreamBounded` hands back a single chunk without copying. Tests: `public-api-launch.test.ts` (unchanged, stale token, moved transcript, `before` refusal, the feature flag), `client-waits.test.ts` (tokens sent where advertised, never otherwise), `client-transport.test.ts` (chunked decoding, refused body unread). DK-18 was out of this change's scope and is still open.

**Investigation.** Re-checked 2026-11-03 against `main` at `7b48c23f`. The backend still reads the window fresh (`forceSnapshot: true`) on an unchanged answer; the saving is the page's mapping, serialisation and transfer, not the provider read. `attention --follow` already pages runs and setups by `cursor`, but each poll re-sends every pending question and approval; not changed here.

**Decisions.**

- **DK-16: how does the CLI learn nothing changed?**
  - **An optional `knownToken` on the public transcript action that answers `unchanged` (recommended).**
    - Pros: the same contract every other read already uses.
    - Cons: public API surface; older backends ignore it, so the CLI must handle a full page.
  - **Back off the follow interval when pages repeat.**
    - Pros: CLI-only.
    - Cons: still downloads every page; slower to show new output.
  - Done with the recommended option.
- **DK-17: how does the transport stop buffering three times?**
  - **Return the bounded bytes from the send step and decode them directly (recommended).**
    - Pros: one bounded read inside the deadline, no second `Response`; the error mapping stays in one place.
    - Cons: a small internal response type instead of `Response`.
  - **Stream-parse the JSON as it arrives.**
    - Pros: no whole-body buffer at all.
    - Cons: needs a streaming parser; responses are at most 8 MiB, so the saving is small.
  - Done with the recommended option.

## Assumptions and decisions

Made on 2026-11-01 while doing the first batch. Uncommitted at the time of
writing, on the worktree branch `20261101-012617-580e11a7c62c`.

### Task 14: preserve unrelated task records (review, 2026-11-02)

Compared the complete document diff from the recorded review base
`82598d869d6b79e44d6c6a1b0577cd261ab8b71f` to reviewed commit
`a88ed87f5d7142222747ca00a213a41536ef2557`: only task 14's index line
and section differ. Tasks 2, 3, 6, 7, 10, 11 and 15 already match that
base. Preserve them; restoring older open statuses would undo records
already present in the review base. Round 2 completed amd64 qualification
(20 passed, 4 live-provider skips); retain only DK-10 as the open decision.

### Task 14: qualification on the shared host (round 2, 2026-11-02)

Chose explicit subnets for this disposable profile (recommended): it preserves
foreign networks and daemon/firewall configuration, at the cost of a temporary
test-only PATH wrapper. Removing foreign networks or changing daemon pools
would reclaim default capacity but violates this run's constraints. Reuse the
existing browser startup helper and assert the backend's current coordinator
selection (recommended): this preserves the tested behavior and diagnoses real
startup errors. Skipping those cases or loosening their behavior assertions
would be less work but would leave acceptance coverage incomplete.

### Task 14: review coverage and durable evidence (2026-11-02)

Keep measurements, the final command, setup constraints and outcomes in this
record (recommended): this remains readable after temporary artifacts expire.
Keeping every failed attempt and local log path gives more chronology but no
portable evidence. For subsequent preparation, choose the self-contained Docker
task (recommended): it records actual qualification and cleanup together but
adds a small supervised setup path. Keeping the manual-profile command is
simpler but requires a live profile that cleanup deliberately removes and
cannot reproduce the recorded pass unaided. The coordinator scenario now
explicitly selects Codex and
asserts it persists; deriving the expectation from each snapshot tested display
consistency but could miss an unexpected selection. Final-image smoke now
checks linked Bun and bunx offline as `node`, with both the image home and an
empty mounted home, using default mise discovery instead of a forced data path.

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

### Task 3: failed layout save cadence (WEB-4)

Review correction on 2026-11-02: unchanged hydrated environments skip work even
after a save failure. Retrying on every unrelated store update would introduce
new behavior and repeated requests under persistent failure. The regression
checks no retry after another environment changes, then a retry containing the
unsaved layout when the failed environment itself changes.

### Task 3: quiet background reads (WEB-5)

Made on 2026-11-02, on the branch `renderer-paths-optimization-845c78394eb7-r1`.
A background read stays quiet only while session state is `current` and a
projection is held, because only then does the connection surface ignore the
flags. A read before that, or any manual read, raises them as before. If a
quiet read loses authority (missing state, an unavailable response, or a thrown
read error), `isRefreshing` stays raised until the independent transcript read
also settles. Deferred-transcript tests cover all three paths and recovery
after both error forms. The first poll after
a connecting read can still render once: React sometimes renders before it
discards a same-value state write that follows a real update.

### Task 3: snapshot ordering in the rebuild section (GW-13)

Reads and events apply through one setter that keeps the snapshot with the
higher revision for the same environment, so a read that started before an
event cannot roll progress back. A snapshot for a different environment always
replaces the held one, as the unconditional setter did. The 15 s backstop and
the 2 s fallback are exported as `REBUILD_BACKSTOP_POLL_MS` and
`REBUILD_POLL_MS`. A regression invokes the registered 15 s timer without
emitting an event or resync and verifies both newer progress and completion
are installed from snapshot reads.

### Task 6: ACP persistence interval

A fixed one-second timer that is not reset by later chunks, so it is also the
maximum wait. Every other change still persists through `schedulePersist`, and
any such write carries the output so far.

### Task 7: stat-stamp settle window

A host capture skips reading a file only when its stat-cache entry is
`settled`: mtime and ctime were at least 2 s old when it was last read. Chose
2 s rather than one kernel tick so FAT's two-second timestamps and small clock
steps are covered; the cost is that a file written in the last 2 s is read
again. `WorktreeChangeOwner.invalidate(paths)` now also drops those paths'
entries, which is what the comment in `service.ts` already claimed it did.
The benchmark waits `--settle-ms` (2.5 s) after writing its fixtures so warm
captures measure the settled path.

### Task 7: line-count cache scope

The cache is module-level, shared by every comparison in the process, because
blob ids are content addresses; a hit is accepted only after `store.has` on
both blobs, so a different or pruned store still reports `body-unavailable`.

### Task 8: idle cadence

Eight quiet ticks (2 s) before polling at 1 s; liveness every two idle ticks, so
an ended session is still noticed in about 2 s. A hook can take one idle
interval to be seen, within the 2 s approval budget.

### Task 9: batch freshness and quiet thresholds

Made on 2026-11-03. A background poll accepts a group reading up to 10 s old
(half the 20 s cadence), so a change can be seen up to 10 s later than
before; anything a user or agent waits on asks fresh. Quiet starts after
15 min without a change (the report suggested an hour; 15 min still saves
most polls of PRs that wait hours for review) and polls every 2 min, inside
the report's 2–5 min range, because a GitHub-side merge or close is then
seen within about 2 min. Unknown GitHub auto-merge, unknown mergeability and
a failed rollup all count as "not quiet".

### Task 10: paused messaging

Presence still refreshes while messaging is paused, because pausing only holds
delivery and the mail surfaces stay visible.

### Task 10: refused mail dispatch on a stopped environment

Made on 2026-11-02. The native presence read also clears a session's refused
mail dispatch when the refusal could not clear it itself. Skipping that read
for a stopped environment defers this backstop until the environment runs
again; the drain never dispatches to a stopped environment and calls the same
read before any delivery, so mail is not affected. Chosen because keeping the
session read would leave a per-mailbox read for every stopped environment,
which is what BG-3 removes.

### Task 10: tmux liveness age

Made on 2026-11-02. Presence reuses a `has-session` answer up to 3 s old. The
poll loop checks about every 2 s busy or idle and removes a session it finds
dead, so a dead session reads `working` (status null) within about 2 s either
way. Mail dispatch keeps its own probe, so a stale answer can only delay a
presence change, never send mail to a dead session.

### Task 10: reviewer prompt failures

Made on 2026-11-02. A rejected shared-prompt build is dropped from the pass's
memo, so the next reviewer reads the instruction and notes again, as each did
before.

### Task 10: digest-first MCP digests

Made on 2026-11-02. Building the handoff remembers the active login's MCP
refresh-token digests (`hostMcpRefreshDigests`). It now does so before the
marker check, for a container on another account too. The digests are the
active account's and the call is idempotent for the same login, so a later
handoff carries the same list it would have carried anyway.

### Task 13: full-check interval

Made on 2026-11-03. A full check runs once a week (`FULL_CHECK_INTERVAL_MS`),
when the stamp file is missing or unreadable, when the clock is behind the
last full check, and on the in-app toolchain repair. Daily would cost most
users the old launch time every time they open the app; never would leave a
forged stamp file trusted indefinitely. Anyone who can rewrite the stamp file
can also rewrite the binaries and the app itself, so the check bounds how
long a corrupted cache goes unnoticed rather than defending against that user.

### Task 13: racy stamps

Made on 2026-11-03. A stamp taken within 2 s of the file's own mtime or ctime
is re-verified by hashing (the rule git uses for its index), so a file changed
in the same timestamp tick as its stamp is never trusted on metadata alone. A
freshly installed or re-signed file is therefore hashed once more on the next
launch, and skipped from the one after.

### Task 13: how launch-to-ready was measured

Made on 2026-11-03. Launch-to-ready is timed on a disposable `dev:test`
profile from Electron's spawn to the launcher's `ready` write, rather than
from the launcher's own start, because the launcher's start also includes
compiling the Electron bundle (16 s of the first run after the code change).
The old code was measured by checking out only the two changed areas from
`7b48c23f` into the worktree for those runs and restoring them afterwards, so
the rest of startup was identical in both sets. The real installed toolchain
was only copied (the profile's seeding), never verified or rewritten.

### Task 13: download retries

Made on 2026-11-03. Within one call an interrupted download retries, resuming,
up to five attempts while each attempt adds bytes; an attempt that adds none
fails at once, so a refused or offline host still reaches the existing retry
dialog quickly. The partial stays for that retry and the next launch. Partials
no pinned archive references are removed after a day unused, not at once,
because another build sharing the cache may pin them.

### Task 16: when follow sends `knownToken` (DK-16)

Made on 2026-11-03. An older backend refuses an unknown input field with
`invalid-input`. So `--follow` checks `features.transcriptKnownToken` once
rather than sending the token and retrying without it on refusal. The check
reads capabilities once per follow, through the same routing as the read,
and never depends on matching the server's error prose.

### Task 16: unchanged still reads the window fresh (DK-16)

Made on 2026-11-03. The action keeps `forceSnapshot: true` and compares the
token afterwards. Dropping the forced read would let the backend answer from
its cache or with a delta the public page cannot express. It would also make
`unchanged` depend on cache state rather than on the transcript. The provider
read on each poll stays, and reducing it belongs with task 4.

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
