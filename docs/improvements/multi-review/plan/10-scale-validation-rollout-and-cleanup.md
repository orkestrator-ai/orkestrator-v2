# Step 10 — Scale validation, rollout, and cleanup

Status: 🟨 Deterministic scale validation and rollback gates in place; rollout, real-stack QA and cleanup pending

Depends on: Steps 02–09

## Outcome

Prove the complete optimized system under scale, failure, restart, inactive-UI,
and mixed-provider conditions. Roll changes out in reversible stages with
content-free diagnostics, then remove temporary compatibility and comparison
paths once the new behavior is established.

## Release gates

Populate exact values from `baseline.md`. The final gate table must include at
least:

| Dimension | Required comparison |
| --- | --- |
| Review quality | Finding recall/severity/location/provenance not below agreed corpus threshold |
| Dispatch safety | Zero duplicate prompts across all injected crash/ambiguity interleavings |
| Dispatch skew | Meets bounded-wave target at 2/4/8/32 reviewers |
| Evidence I/O | Two phase verifications per generation, independent of reviewer count |
| Transcript I/O | Zero reads while progress-throttled; bounded token snapshots for UI |
| Persistence | At most one observational checkpoint/event per pass |
| Supervision load | Status/request rate meets adaptive-scheduler target |
| Memory | Peak retained state remains within per-workflow/global bounds |
| Consolidation | Input remains under hard budget with complete provenance |
| Recovery | Restart/fence/inactive UI converge without manual repair |

Do not use a faster median to excuse a regression in tail latency, correctness,
memory, or recovery.

## Feature-gate strategy

Use backend-owned gates only where they provide a real rollback boundary. A
recommended sequence is:

1. lazy transcript loading — enable directly after focused proof;
2. observational checkpointing — gate commit mode during soak;
3. phase verification permits — gate with legacy verify-per-use fallback;
4. concurrent fan-out — configurable cap, starting at `1`, then conservative
   bounded default;
5. adaptive scheduler/batching — gate scheduler, keep reconciliation backstop;
6. progressive transcript route — capability/version negotiation with legacy
   command fallback;
7. compact consolidation — gate payload version and retain full-report builder
   only during comparison; and
8. prompt/launcher changes — independently reversible UI/prompt flag if needed.

Every gate has an owner, removal condition, and expiry issue/date. Avoid a
combinatorial test matrix: support only documented old/new pairings needed for a
rolling desktop/backend/bridge upgrade.

## Compatibility matrix

Test at minimum:

- new renderer with old backend and new backend with old renderer where the
  product supports skew;
- new backend with older bridge lacking bounded snapshots/batch observation;
- persisted workflows created before optional protocol fields existed;
- workflows in every non-terminal phase during backend restart/upgrade;
- local worktree and Docker-backed environments;
- homogeneous and mixed-provider panels; and
- standalone Multi Review and Build Pipeline multi-review stages.

Missing new capabilities must select a bounded compatibility path or report a
clear limitation. Do not read a 404/unknown route as evidence that a session or
workflow is missing when older components may simply lack the route.

## Scale and soak scenarios

Run deterministic scenarios at 1, 2, 4, 8, and 32 reviewers with:

- fast and slow setup/status/report providers;
- one retrying provider and one permanently failed reviewer;
- maximum permitted report and transcript sizes;
- large synthetic evidence artifact sets;
- several workflows due simultaneously;
- cancellation at every admission/dispatch/settlement phase;
- controller lease expiry and takeover;
- backend restart before/after every safety commit;
- bridge disconnect, expired cursor, and missed provider events;
- renderer hidden, environment switched, renderer reload, and return after
  completion; and
- consolidation budget overflow and invalid provenance.

Track wall time, CPU, peak RSS, event-loop delay, file operations/bytes, provider
call counts/bytes, save/event/refetch counts, queue depth, and result quality.
Metrics remain content-free. Store raw benchmark artifacts in a private bounded
location; commit only aggregated content-free results.

## Test workflow

During implementation use the smallest owning tests with the logged runner.
Before rollout:

```bash
mise run test:changed
mise run test:logged -- --name check -- mise run check
mise run test
mise run test:logged -- --name browser -- mise run test:browser
mise run test:logged -- --name agent-browser -- mise run test:agent:browser
```

Use `--parallel=1` for focused lifecycle/provider files that own fake processes,
ports, or shared clocks. Inspect logged failure artifacts rather than rerunning
only to recover output. Browser/agent runs use isolated profiles and follow
`docs/development/agent-testing.md` for cleanup.

The real-stack inactive-environment script is mandatory:

1. Start Multi Review and wait until at least one reviewer is running.
2. Switch to another environment and leave the review view unmounted.
3. Allow reviewers to progress/complete; interrupt network/bridge connectivity
   for one variant.
4. Return and verify workflow phase, reviewer state, pending interactions,
   transcript tail, reports, consolidation, and controls rehydrate correctly.
5. Repeat with a backend restart and with a renderer reload.
6. Confirm no duplicate turn and no background work was cancelled by unmount.

## Rollout observation

For each gated stage:

- compare matched old/new benchmark traces;
- monitor bounded rates of retries, parked dispatches, verification failures,
  legacy fallbacks, batch failures, oversize reports, and source-token resets;
- inspect tail latency and peak memory, not only average wall time;
- establish a rollback threshold before enabling the stage;
- record the decision and observation window in `baseline.md`; and
- roll back the narrow stage, not all efficiency changes, if a gate fails.

No telemetry may include generated review content, source files, commands,
artifact contents, credentials, paths, or attachment data.

## Cleanup

After the observation window and compatibility floor:

- [ ] Remove legacy eager transcript and full-history UI paths.
- [ ] Remove verify-per-reviewer fallback once every readable workflow has a
  generation identity or is safely regenerated.
- [ ] Remove old scheduler interval/catch-up code and temporary comparison
  metrics.
- [ ] Remove full-report consolidation builder after compact V1 quality and
  compatibility gates pass.
- [ ] Remove expired feature flags, config, tests that only exercise impossible
  pairings, and stale documentation.
- [ ] Keep permanent regression benchmarks, safety interleaving tests, limits,
  and content-redaction tests.
- [ ] Update `docs/improvements/multi-review/README.md` with measured results and
  mark recommendations implemented, changed, or deferred.
- [ ] Update this index and each step's status only after merge to `main`.

## Final acceptance criteria

- Every release-gate row is populated with measured before/after evidence and
  passes.
- No known duplicate dispatch, stale-controller commit, missed terminal state,
  unbounded payload, or inactive-UI recovery failure.
- The default two-reviewer case improves without a quality regression; higher
  reviewer counts scale within documented caps.
- Both workflow owners pass the shared conformance and failure-injection suite.
- Rollback paths were exercised before old paths were removed.
- Compatibility code and flags have an explicit removal decision; no permanent
  shadow implementation remains.

## Implementation record

Done on the branch:

- Deterministic scale and failure coverage at 1/2/4/8/32 reviewers, including
  a mixed-provider panel and a slow reviewer. The measured before/after
  release-gate table is in [`baseline.md`](baseline.md).
- Rollback gates are backend-owned and each restores the previous behaviour on
  its own. The removal condition for each is the observation window below.

  | Stage | Gate | Old behaviour when off |
  | --- | --- | --- |
  | Lazy transcript loading | none (enabled directly, per this plan) | — |
  | Observational checkpointing | none; coalescing is inside the runner | — |
  | Evidence permits | `evidencePermits: false` | verify inside every reviewer prompt |
  | Concurrent fan-out | `reviewFanoutConcurrency: { admission: 1, observation: 1, provider: 1 }` | serial admission and observation |
  | Adaptive scheduler | `adaptiveScheduling: false` | 1 s fixed scan with catch-up |
  | Progressive transcript | capability-negotiated; old renderers send no token | full bounded snapshot every poll |
  | Compact consolidation | none; the full-report builder was replaced | — |
  | Prompt/launcher | none; prompt order and warnings are low-risk | — |

- Compatibility:
  - new renderer ↔ old backend and old renderer ↔ new backend (optional
    transcript fields);
  - bridges without progressive snapshots (bounded fallback);
  - stored workflows and reports from before the change (budgets apply only
    to new answers; optional fields only);
  - both workflow owners through the shared runner.

Pending — these need a running application, real providers, or elapsed time,
none of which a code change can supply:

- [ ] Real-stack inactive-environment script (start, switch away, finish,
      return; with backend restart, renderer reload and a bridge interruption).
- [ ] `mise run test:browser` and `mise run test:agent:browser` runs for the
      reviewer tab and launcher changes.
- [ ] Real-provider quality evaluation of compact consolidation (step 08) and
      cache-hit measurement of the stable prefix (step 09).
- [ ] Rollout observation per stage, recorded in `baseline.md`.
- [ ] Cleanup after the observation window: remove the `evidencePermits`,
      `adaptiveScheduling` and legacy interval tick paths and the concurrency
      rollback note. Retire the transcript compatibility fallback once every
      bridge serves `/transcript`. Keep the benchmark, safety and redaction
      tests.
