# Milestone 7 — Rollout, cleanup, and stable policy

Status: Not started

Depends on: Milestones 1 through 6

Unblocks: Completion of the combined plan

## Outcome

Roll out the final policy safely, migrate persisted workflows, remove temporary
and provider-specific compatibility paths, update project guidance, and declare
the interaction system stable only after production evidence shows no invisible
waits or recovery regressions.

## Rollout checklist

- [ ] Confirm contract, policy, journal, build-pipeline, and looped-review
      persistence versions are final.
- [ ] Keep provider-neutral monitoring in observe-only mode long enough to
      compare detections with current status/timeout behavior.
- [ ] Enable build enforcement provider by provider for newly started phases.
- [ ] Do not change the policy of a live request or ambiguously accepted turn.
- [ ] Gate the backend looped-review controller by persisted workflow version.
- [ ] Automatically adopt only idle or paused compatible legacy reviews.
- [ ] Require explicit resume/migration for a legacy workflow that was running
      during upgrade.
- [ ] Monitor input-decline latency, authorization failures, reconciliation,
      stale outcomes, and restart recovery without user content.
- [ ] Observe one release with no invisible-wait detections before removing
      fallback paths.

## Migration checklist

- [ ] Existing ordinary native sessions migrate to `interactive`.
- [ ] Existing build sessions receive `unattended` only at the next safe
      reconciliation/phase boundary.
- [ ] Legacy looped reviews retain their controller version until safe adoption.
- [ ] Older renderer clients can ignore new bounded metadata while still seeing
      terminal workflow failure.
- [ ] Provider-owned transcripts are not rewritten.
- [ ] Unknown future interaction kinds remain fail-closed across mixed versions.
- [ ] Terminal resolution-journal records are cleaned after durable adoption.

## Compatibility cleanup checklist

- [ ] Remove the OpenCode build-only `autoAnswerRequests` switch after every
      caller uses the shared policy path.
- [ ] Remove OpenCode-specific blocked/error branches made obsolete by
      successful input rejection and continuation.
- [ ] Remove React-owned looped-review advancement after backend parity and
      recovery evidence passes.
- [ ] Remove duplicate provider-specific presentation state where the common
      contract is authoritative.
- [ ] Retain exact provider response mappers, raw identities, and generation
      safety checks.
- [ ] Remove temporary observe-only flags or assign a documented operational
      owner and permanent purpose.
- [ ] Ensure every remaining compatibility flag has an owner, default, rollback
      behavior, and removal condition.

## Documentation checklist

- [ ] Update `AGENTS.md` with the final unattended input and authorization
      rules.
- [ ] Document provider limitations, authoritative snapshots, deadlines, stale
      response semantics, and exact-once requirements.
- [ ] Document backend looped-review ownership and migration behavior.
- [ ] Document privacy-safe metrics and the operational diagnostic procedure.
- [ ] Mark the feature planner as the deliberate prose-based exception.
- [ ] Update `docs/qa-plan-combined.md` and each milestone status/evidence.

## Rollback checklist

- [ ] Rollback can stop new automated dispatch without cancelling unrelated
      interactive sessions.
- [ ] Rollback leaves authorization denial fail-closed.
- [ ] Rollback never converts a decline/denial into approval.
- [ ] Rollback never blindly redispatches an ambiguous prompt.
- [ ] Rollback preserves persisted journals and workflow snapshots for the
      version that can recover them.
- [ ] Mixed-version renderer/backend/provider behavior is covered by tests.

## Final validation

- [ ] Run the provider adapter, interactive, build-pipeline, looped-review,
      inactive-environment, restart, and privacy matrices from Milestone 6.
- [ ] Run every migration and rollback fixture.
- [ ] Verify no production workflow depends only on “do not ask” prompt text.
- [ ] Verify no automated workflow depends on a mounted chat/review component.
- [ ] Verify all compatibility removals have no remaining caller.
- [ ] Verify release metrics show zero invisible request waits.

## Commands

```bash
bun test packages/protocol --parallel
bun test bridges --parallel
bun test tests --parallel
bun run --cwd apps/backend typecheck
bun run --cwd apps/web typecheck
bun run --cwd apps/desktop typecheck
bun run test
```

## Exit criteria

- [ ] There is one documented provider-neutral policy path for build pipelines
      and looped reviews.
- [ ] All automated sessions have a persisted origin and interaction policy.
- [ ] No input request waits invisibly; every decline is durably visible and
      counted.
- [ ] No unexpected authorization request is approved; it fails the phase.
- [ ] Looped reviews are backend-owned and progress without React.
- [ ] Compatibility paths and flags are removed or permanently documented.
- [ ] Migration, rollback, recovery, full tests, and typechecks pass.
- [ ] One release of privacy-safe evidence shows no invisible waits or recovery
      regression.

## Evidence and decisions

Record:

- rollout dates and provider order;
- migration counts and legacy workflow dispositions;
- compatibility paths removed;
- rollback rehearsal results;
- release metric summary;
- final full-suite and typecheck output;
- links to updated project guidance.

No evidence recorded yet.
