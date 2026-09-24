# 15 — Qualification and rollout

Status: Planned.  
Dependencies: [01–14](00-index.md#numbered-steps-and-dependencies).  
Findings: all; use this matrix throughout implementation.

## Outcome

The completed feature has reproducible evidence for editing correctness,
restart recovery, export protection, background behavior, browser isolation,
accessibility, and measured efficiency. Release/rollback paths account for
private-record migration and mixed client/backend versions.

This step does not substitute a final large test run for owning tests in each
earlier step. Each PR runs its relevant checks; this step verifies the assembled
product and records limitations honestly.

## Test layers and owners

| Layer | Scope |
| --- | --- |
| Protocol/schema | public v1 compatibility, private record, operation/status/delta validation, every byte/count limit |
| Backend/service | CAS, atomic document+receipt persistence, history, quota reservation, deletion fencing, export recovery |
| Renderer | scheduling, real Chromium isolation, generation death, deadline and process cleanup |
| Client/controller | intent ordering, late responses, version/generation transitions, token/draft recovery, bounded caches |
| Browser component | gestures, CSS validation, selection continuity, responsive panels, keyboard, culling |
| Isolated gateway/Electron | tab persistence, native prompts, reconnect/login, file export/download, end-to-end recovery |
| Real agents | Claude/Codex design MCP use, session resume, questions/approvals, handoff |
| Container | atomic/confined export, interrupted container writes, restart and unavailable workspace |

Use deferred barriers and injected faults for deterministic ordering. Test the
actual browser/process boundary where mocks cannot prove resource release or
sandbox enforcement. Do not loosen race assertions to make retries pass.

## Required end-to-end journeys

### A. New user and prerequisite recovery

- [ ] No Chromium: entry opens, readiness is actionable, existing documents can
  be listed/exported, import is clearly unvalidated, capture is unavailable.
- [ ] Retry after fixing the executable transitions to healthy without app
  restart; broken executable versus missing executable has distinct feedback.
- [ ] Create manual canvas; create Claude/Codex design workspace when available;
  signed-out/unavailable agent state uses existing setup controls.
- [ ] Launch failure before versus after initial prompt dispatch leaves the
  correct recoverable resources and does not start duplicate work.

### B. Editing and concurrency

- [ ] Three consecutive style edits keep selection and produce correct history.
- [ ] Move and resize frame B behind a blocked frame-A edit: no intent disappears.
- [ ] Agent reorders/replaces HTML during user resize: no wrong-target mutation.
- [ ] Two clients edit one base revision: one wins, one gets a recoverable conflict.
- [ ] Lost committed response followed by reload/restart: receipt resolves once.
- [ ] Repeated keyboard resize respects accumulated steps; pointercancel before
  submission has no side effect; cancellation after admission is accurately labeled.
- [ ] Undo/redo with unrelated versus same-target external edits preserves the
  defined scope and never reverts unknown newer work.

### C. Background lifecycle

- [ ] Start edit/agent work in environment A; switch to B; let it finish; return
  to the exact committed canvas and settled operation state.
- [ ] Repeat while the agent is awaiting a question or approval; normal native
  transcript and pending controls rehydrate. No design-specific auto-approval.
- [ ] Close/unmount/cull the canvas while backend capture or editing continues.
- [ ] Drop final hint, expire replay range, change generation, and reconnect;
  snapshot/delta state converges without treating events as the only truth.
- [ ] Delete canvas/environment while work is rendering; no late resurrection.

### D. Save/import/history

- [ ] Duplicate default names and sanitizer collisions preserve distinct files.
- [ ] Concurrent saves and external file changes have the documented conditional
  overwrite/recovery behavior; no misleading guarantee beyond filesystem support.
- [ ] Interrupt local/container export at every write boundary and recover by
  exact output identity rather than replaying blindly.
- [ ] Save revision N while N+1 commits; UI and output agree on N's identity.
- [ ] v1 import/export round-trip contains no credentials, receipts, private
  metadata, session links, or backend-specific record paths.
- [ ] Delete/restore/duplicate across restart and capacity limits; history pruning
  never leaves dangling authoritative references.

### E. Large canvases and accessibility

- [ ] Exercise 1/16/64 frames, small/near-limit documents, long hierarchies,
  offscreen edits, low zoom, narrow panes, and repeated mount/cull cycles.
- [ ] Geometry-only edits transfer zero unchanged HTML and perform no HTML DOM
  replacement. Gap/reset scenarios still use a complete correct snapshot.
- [ ] Live iframe, cache, queue, hierarchy, and history resources remain bounded.
- [ ] Complete reopen/select/edit/move/resize/undo/export using keyboard only;
  focus survives acknowledgment, drawer transitions, culling, and errors.
- [ ] Check screen-reader labels/states, reduced motion, high zoom, and narrow
  container layouts. Record manual accessibility observations alongside tests.

## Fault matrix

| Fault | Required outcome |
| --- | --- |
| Disk full / failed sync / failed rename | Previous record intact or coherent new record; no false success |
| Corrupt current record/index/history file | Scoped recovery; healthy canvases still discoverable |
| Process exit before/after atomic commit | Document and terminal receipt agree on restart |
| Lost execute or export response | Read reconciliation; no automatic semantic replay |
| Queue count/byte exhausted | Explicit bounded rejection; no dropped authoritative state |
| Chromium launch/context/evaluate/screenshot/close hangs | End-to-end deadline, owned-process cleanup, subsequent recovery |
| Old-generation disconnect arrives late | Healthy replacement generation stays registered |
| Unauthorized other-environment request | Denied without content/existence leakage |
| Gateway session expires | Existing login flow; retained intent and no hidden replay |
| Legacy backend / unsupported response | Capability fallback, never fabricated empty/deleted state |
| External export writer race | Detected conflict or preserved recoverable overwritten version per contract |

## Performance experiment

Run the step-01 fixture workload before/after on the same host/build mode with
recorded cold/warm state and competing load. Include local backend and a
controlled-latency gateway path; do not manufacture universal production numbers.

Report sample count, p50/p95/max and resource peaks for:

- User gesture-to-preview and release-to-acknowledgment.
- Queue, render, persistence, reconciliation, and export phases separately.
- Transferred bytes/decoded bytes and iframe DOM replacements per operation.
- Library open time, hierarchy page latency, active iframe/mounted-row count.
- Memory, history/cache/temp disk use, browser/worker count after repeated cycles.
- MCP calls/response bytes for create → inspect → refine → capture → save.

Hard gates are correctness and explicit bounds, plus no unchanged HTML for
geometry-only updates. Set latency regression budgets from reproducible baseline
data before enabling optional pooling/caches. A lower average with worse tail
latency, memory pressure, starvation, or lost work is not a successful optimization.

## Operator workflow

The [testing guide](../../../development/testing-guide.md) and
[agent-testing guide](../../../development/agent-testing.md) remain authoritative.
Commands below are examples for the implementing checkout, not commands run as
part of creating this plan. Run each separately and retain its result.

```sh
mise run test:logged -- --name design-backend -- \
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
  ./src/core/design-service.test.ts ./src/core/design-renderer.test.ts \
  ./src/core/commands-registry-design.test.ts ./src/core/design-mcp.test.ts \
  --parallel=1 --only-failures

mise run test:logged -- --name design-web -- \
  bun test --cwd apps/web ./src/components/design --parallel=2 --only-failures

mise run test:logged -- --name design-check -- mise run check
mise run test
mise run test:logged -- --name design-browser -- mise run test:browser
```

Include new owning test files when the implementation splits modules. Use a
unique isolated profile and only its returned fixture repository:

```sh
mise run dev:test --profile design-space-qa --fixture --agent-platforms claude,codex
mise run dev:status --profile design-space-qa --json
mise run dev:login --profile design-space-qa --json
```

Use the discovered URL and profile-selected test configuration, not fixed
ports. Run relevant logged agent-browser/Electron/container tasks as documented;
set `ORKESTRATOR_AGENT_TEST_PROFILE=design-space-qa` where the task requires it.
Use fixture-scoped agent prompts. Never copy tokens or live customer designs
into test logs/screenshots. Stop and reset the owned profile afterward:

```sh
mise run dev:stop --profile design-space-qa
mise run dev:reset --profile design-space-qa
```

If a suite fails, read its retained log and rerun the owning file alone before
calling it flaky. Follow the repository's single flake registry policy. An
unavailable required platform/browser run is an explicit incomplete gate, not
a passing result or a reason to silently omit the scenario.

## Compatibility and migration qualification

- [ ] Maintain fixtures from legacy backend `.orkdes`, migrated private records,
  interrupted migration, future unsupported version, and corrupted new record
  with an older backup. Verify no silent rollback to stale content.
- [ ] Exercise old-client/new-backend and new-client/old-backend paths. Advertise
  capabilities truthfully and retain legacy behavior where promised.
- [ ] Verify version-1 files remain readable by the old importer; new private
  records are never mistaken for portable `.orkdes`.
- [ ] Document filesystem/process/power-loss guarantees accurately by platform.
- [ ] Verify bounded backup retention and an explicit conversion/export path
  before an older backend is used after migration. Do not dual-write two
  competing authoritative stores to make downgrade appear transparent.

## Rollout and rollback

1. Ship step-01 fixes independently and verify their race regressions.
2. Ship private-record readers and capability discovery before enabling writes
   in the new format. Qualify migration against isolated copied fixtures.
3. Enable operation/controller and safe-save paths with explicit compatibility
   behavior. Document unsupported old-backend actions in the UI.
4. Add history/lifecycle/UX steps in reviewed slices; keep existing agent/session
   APIs as the behavioral authority.
5. Enable deltas/culling/caches independently. Each optimization has a fallback
   to authoritative reads/rendering; disabling it must not discard documents.
6. Broaden rollout after evidence review. Stop on unexpected duplicate edits,
   mismatched receipts, export corruption, unsound migration, or resource leaks.

Optimization rollback can restore full snapshots/fresh contexts without changing
stored documents. Storage rollback is a separate explicit conversion process;
never describe reverting a binary as sufficient once migrated records exist.

## Final completion checklist

- [ ] All mandatory step criteria verified; optional optimizations are either
  measured/implemented or explicitly deferred with reasons.
- [ ] Matrix evidence recorded with commit, platform, command, result, fixture,
  and bounded artifact location; no unsupported production claims.
- [ ] All isolated profiles stopped/reset or deliberate retained state documented.
- [ ] Living `docs/architecture/design-canvas.md` updated to shipped behavior;
  `docs/README.md` catalog updated with this plan's implementation status.
- [ ] Migration, troubleshooting, limits, and unsupported features documented.
- [ ] Source assessment retained as historical evidence; this index and step
  statuses updated together.
- [ ] Changes land through PRs; verify feature branch/upstream before any push
  and leave merging to the human maintainer.
