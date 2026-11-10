# OpenCode startup ordering: aggregate confirmation for flake 0723

## Task analysis

Analysed 2026-11-10 against main at `c6de4733c5beb87a578f82a8548725305e1ff254`.
The startup ordering fix is already implemented in `ec35a99b3` (#1532).
This restored task retains the aggregate confirmation required before retirement.

### Tasks

1. **Confirm flake 0723 in an aggregate under load**. Status: open.

### 1. Confirm flake 0723 in an aggregate under load

**Problem.** The case was marked resolved and this to-do deleted on 2026-11-09
without the aggregate confirmation its disposition required.

**Context.** `waitForLocalServerStartup` now classifies an OpenCode startup exit
after `close`, or a one-second bound after `exit`, so late database-lock stderr
can select the retry. The implementation and fake-child tests are done.
The owner is `apps/backend/src/core/opencode-host-start.test.ts`, in the slow
tier; default `mise run test` excludes it.

**Investigation.** The [0723 case](../../tests/flaky-tests/backend-services-and-tooling/0723-opencode-host-shutdown-retry-race.md)
records deterministic late-stderr reproduction (pre-fix 10/10 failed; fixed
10/10 passed) and repeated focused stress passes. Contention alone also passed
60/60 on pre-fix logic, so it cannot replace the required aggregate evidence.
Preparation's default suite does not supply that evidence.

**Decisions.**

- **Retain the aggregate criterion (recommended).** Pros: preserves the agreed
  acceptance gate and tests the failure's original setting. Cons: needs a run
  that explicitly includes this slow-tier owner alongside other tests.
- **Replace the criterion with deterministic reproduction.** Pros: directly
  distinguishes the old and fixed ordering. Cons: waives the recorded aggregate
  requirement and does not exercise its original environment.

## Current state

The startup fix and focused evidence remain documented in the case and
[agent-engines.md](../../architecture/agent-engines.md#opencode). Flake 0723
and this task remain open; no runtime changes are needed for this correction.

## Outstanding work

- Run an aggregate under load that includes the complete slow-tier owner on a
  base containing `ec35a99b3`. Record the exact command, worker configuration,
  owner outcome, counts and evidence path in 0723. If it holds, resolve the case
  and group index together, then retire this to-do and its index entry.

## Constraints and rationale

- A focused run or the default suite alone does not meet the aggregate gate.
- Keep the historical reproduction and stress evidence; do not change tests,
  timeouts or assertions merely to obtain a pass.

## Assumptions and decisions

### Task 1: preserve the acceptance gate

On 2026-11-10, restored this task and the open case status instead of waiving
aggregate confirmation. The review explicitly permits retaining the task, and
no qualifying aggregate result is recorded. This correction makes the tracking
agree with the evidence without claiming the remaining validation happened.

## Needs verification

- The aggregate confirmation above.
- Whether real users hit the original second-tab startup race remains unverified;
  the ordering fix applies regardless.

## Related

- [0030](../cross-cutting/0030-test-suite-and-ci-health.md), flake 0723.

## Replaces

- Restores the task prematurely retired on 2026-11-09; earlier implementation
  decisions remain in git history and the architecture documentation.
