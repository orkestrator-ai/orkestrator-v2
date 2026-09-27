# 13 — Performance baselines and targeted optimization

Status: Implemented on branch; awaiting review. Dependencies:
[06](06-migration-and-transactional-replacement.md),
[08](08-portable-inputs-and-credential-lifecycle.md),
[09](09-environment-networks-and-egress-policy.md),
[10](10-resource-budgets-and-usage-telemetry.md),
[11](11-bounded-logs-and-diagnostic-subscriptions.md),
[12](12-image-build-and-release-delivery.md).
Return to [index](00-index.md).

## Goal

Measure the improved architecture and optimize the dominant costs without
weakening persistence, credential isolation or background reliability. Complete
this step with a baseline report and explicit decisions even when no extra
cache or transport redesign is justified.

## Integration points

- [Container exec/status cache](../../../../apps/backend/src/core/commands-container-exec.ts),
  [container creation](../../../../apps/backend/src/core/commands-containers.ts),
  [lifecycle](../../../../apps/backend/src/core/commands-environment.ts).
- [Entrypoint](../../../../docker/entrypoint.sh),
  [workspace setup](../../../../docker/workspace-setup.sh),
  [environment process usage](../../../../apps/backend/src/core/environment-process-usage.ts).
- Step 02 operation phases, step 10 sampler and step 11 diagnostic bounds.
- [Test runner guidance](../../../development/testing-guide.md) and
  [isolated profile workflow](../../../development/agent-testing.md).

## Measurement design

Use fixture repositories with small, medium and deliberately large Git/workspace
state. Record actual bytes/file counts, provider selection, architecture,
Engine/Desktop version, image digest, backend revision, cache condition and
configured resource limits. Keep fixtures synthetic and their contents out of
telemetry. A cold run means the relevant task-owned cache is absent; do not
clear a user's global Docker/cache state to manufacture cold measurements.

| Scenario | Measurements |
| --- | --- |
| Image acquisition/build | Compressed bytes, pull/build duration, cache hits and unpacked size |
| Fresh environment | Create, firewall, staged input, clone, setup and first authenticated bridge readiness |
| Warm stop/start | Boot readiness, refresh bytes, time until existing session is usable |
| Runtime rebuild | Drain, copy bytes/files, verify, setup, commit, retained recovery disk growth |
| Idle environments | Backend CPU/RSS, Docker CLI calls per minute, container PIDs/RSS, log growth |
| Active multi-environment work | UI response, phase p50/p95, memory peaks and sibling slowdown |
| Observer churn | Follower/process count, event bytes, reconnect reconciliation and bounded memory |

Use at least five cold and ten warm repetitions per important scenario where
practical, with concurrency 1 and a bounded multi-environment case such as 3.
These are sampling goals, not permission to exceed host capacity. Report sample
count/range and variance; do not claim a statistically robust p95 from a tiny
sample. Record incomplete runs and resource-queue waits separately.

## Implementation tasks

- [ ] Add monotonic phase timing around durable operation transitions. Count
  actual Docker subprocesses and bounded transfer bytes; avoid measuring only
  the visible renderer wait.
- [ ] Preserve causal IDs using bounded opaque/hash identifiers. Never record
  shell commands, prompts, terminal/file contents or credential fingerprints in
  product telemetry. Redact private endpoints in benchmark artifacts.
- [ ] Produce a before/after report per platform with the conditions above and
  a list of dominating phases. Store small aggregate tables in docs; keep large
  private artifacts under the test runner's bounded retention mechanism.
- [ ] Define acceptable regressions before optimizing: no unbounded memory or
  disk growth, no additional daemon-wide work, no degraded recovery guarantees.
  Set latency targets from measured baselines and product expectations rather
  than inventing a universal startup duration.

## Optimization decisions, in order

### A. Avoid repeated portable-input work

- [ ] If staging dominates warm startup, reuse verified input revisions based
  on safe source identity/change detection. Credential revocation bypasses the
  cache immediately. Time/size alone must not be treated as proof of unchanged
  secret/config contents when correctness needs a stronger check.
- [ ] Keep hashes private and invalidate on policy/provider selection changes.
  Verify atomic publication and bounded aggregate storage after cache reuse.

### B. Reduce Docker polling overhead

- [ ] Measure existing batched `docker ps` and the three-second cache before
  changing transport. Consolidate redundant inspect/port reads by immutable
  runtime identity where that explains the measured cost.
- [ ] If still significant, prototype one filtered backend Docker-events
  watcher with bounded queues and reconnect backoff. Docker events are hints:
  always reconcile through a full owned-resource snapshot after gaps/reconnect.
- [ ] Install subscription before snapshot/replay handling and detect source
  generation changes. Never let a connected frame advance a client beyond
  replay it has not received.
- [ ] Retain periodic bounded reconciliation as a repair path. Do not replace
  a correct cache with a watcher whose missed events can strand environments.

### C. Improve dependency/rebuild storage costs

- [ ] If downloads dominate, evaluate environment-private dependency cache
  volumes before cross-environment sharing. Key by architecture, runtime and
  package-manager compatibility; define eviction and ownership.
- [ ] Do not share mutable `node_modules`, provider databases or credentials
  between untrusted environments. A shared package cache needs a separate
  cache-poisoning/concurrency analysis and is not the default implementation.
- [ ] If verified storage copying dominates rebuilds, evaluate supported
  snapshots/reflinks as an optional fast path. The portable streaming copy
  remains the fallback; never assume an Engine/Desktop storage driver supports
  snapshot semantics just because the host filesystem does.
- [ ] Preserve the step 06 separate-candidate-copy guarantee. Optimizing by
  running setup against the only source volume is an unacceptable shortcut.

## Verification, decisions and exit criteria

For each accepted optimization, repeat the same scenario/limits against the
baseline and stress invalidation, restart, inactive UI and bounded resource
behavior. Record costs saved, new state introduced and failure recovery. Drop
optimizations with negligible benefit or a materially larger correctness burden.

Exit with a committed small benchmark report and a decision table: implemented,
deferred with evidence, or rejected with reason. Do not leave this step open
indefinitely because speculative optimizations are possible. Rollback disables
an optimization while preserving the authoritative storage/lifecycle contract.

## Implementation record

- **Measurement.** Durable operations record monotonic `durationMs` and
  per-phase durations in their outcome (bounded to 16 phases, durations only);
  `runCommand` counts subprocesses by program name for benchmarks. The opt-in
  harness `tests/unit/electron/container-benchmarks.test.ts` covers fresh
  restricted environments (5), warm stop/start (10), preserving rebuilds at
  two sizes (5 and 3), sampler cost (10) and observer churn (200 cycles), and
  records incomplete runs instead of retrying them.
- **Report.** [`../benchmarks.md`](../benchmarks.md): conditions, results,
  dominant costs and the decision table (implemented, deferred with evidence,
  rejected with reason).
- **Implemented optimizations.** (1) A backend-owned hourly seed of GitHub's
  published ranges plus API-free reachability verification: restricted boots
  had been failing closed once GitHub's 60-per-hour unauthenticated budget
  ran out; 17 → 1 API calls per benchmark run and no incomplete boots.
  (2) Batched destination hashing in the copy verifier: the 5,000-file / 102 MB
  rebuild fell from 29.5 s to 18.4 s with every verification check intact.
- **Tests.** Phase timing (`container-lifecycle-service.test.ts`), the seed
  cache (`github-ranges-cache.test.ts`), the firewall's seed → live → cache →
  fail-closed order (`firewall-policy.test.ts`); live replacement and network
  scenarios re-run on the rebuilt image.
