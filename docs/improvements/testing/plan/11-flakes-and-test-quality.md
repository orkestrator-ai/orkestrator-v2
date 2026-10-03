# 11 — Improve flake handling and behavioral coverage

Status: Not started. Depends on: 04, 06; use 08 for the browser baseline.
Source: review follow-ups on flaky tests and behavioral coverage.

[Plan index](00-index.md) · [Previous](10-evidence-retention.md) ·
[Next](12-results-and-rollout.md)

## Outcome

Use captured evidence to reduce recurring false failures and strengthen tests
of high-impact behavior. Maintain the existing flake registry as the single
source of truth. Do not turn this into a mass mock rewrite or a coverage-number
campaign without evidence that it improves defect detection.

## Baseline and registry work

Owners: `docs/tests/flaky-tests/0000-index.md`, its matched case files,
`tests/unit/flaky-tests-index.test.ts`, test runner summaries, and CI evidence.

- [ ] Start from the index's open/environmental rows; open individual case files
      only when they match the failure being investigated.
- [ ] Distinguish current recurrence, historical unresolved observation, worker
      crash, fixture/environment failure, and a confirmed assertion regression.
- [ ] Add/update owning file, exact test name, last observation, runtime version,
      command/worker budget, aggregate result, isolated rerun, artifact reference,
      evidence-backed hypothesis, and next reproduction step.
- [ ] Add a maintainer/area owner only when known. Use “unassigned” rather than
      inventing ownership. Do not count a case row as a failure occurrence.
- [ ] Repair stale file references and vague sweep entries without deleting
      their history. Separate an actionable current case from a historical note.
- [ ] Prioritize recurring normal-budget failures that block handoff/CI before
      stress-only failures from unsupported oversubscription.

## Investigation procedure

1. Read the original retained failure evidence and owning test in full.
2. Reproduce with the same pinned runtime, preloads, and worker configuration.
3. Run the owning file alone. Preserve both results before calling it flaky.
4. Reduce to the smallest interfering group if it passes alone.
5. Inspect mock registration/import timing, mutable globals/environment, timers,
   ports, filesystem ownership, subprocesses, and external service assumptions.
6. Fix the responsible boundary. Use stable mock functions, dependency injection
   where justified, independent files for incompatible module graphs, and exact
   cleanup in `finally`/teardown.
7. Replace arbitrary sleeps with explicit readiness or controllable barriers.
   Use fake time only for time logic; keep real process/IO behavior real where
   that is the purpose of the test.
8. Verify the original failing scenario, isolated owner, and relevant aggregate
   at normal host admission. Stress only when the hypothesis requires it.
9. Record the root cause and verification; mark resolved in both case and index.

Apply the Bun testing skill when modifying these suites. Do not mask a failure
with retries, blanket timeout inflation, skipped assertions, or serial execution
unless serialization expresses a real owned resource requirement.

## Behavioral coverage map

Create a concise mapping in the testing guide or a linked test document. Reuse
existing suites first; add tests only where an important boundary is missing.

| Invariant | Preferred layer | Evidence to retain |
| --- | --- | --- |
| Background work survives unmount | Backend integration plus real browser | Same run/process, restored visible state |
| Missed transport events reconcile | Protocol/bridge integration | Revision gap and authoritative recovery |
| Approval timeout/disconnect denies | Bridge/provider boundary | Exact deny result and withdrawn interaction |
| Cancellation drains owned work | Real-process worker test | Ticket/process cleanup, partial evidence |
| Review packages match evidence | Package/service test | Integrity and source qualification |
| Final completion problems stay visible | Component behavior plus browser path | Visible persisted failure and retry action |
| Server/container ownership is enforced | Environment integration | Foreign resource unchanged |

Source-string tests can remain for true architecture contracts. For
`BuildCompletionStatusWiring.test.ts`, add or identify a behavior test that
renders a persisted completion failure and exercises its retry. An import/JSX
substring alone cannot establish visibility or usability.

Avoid asserting private helper call sequences when user behavior is the target.
Conversely, a pure protocol invariant does not need a slow browser test merely
to raise end-to-end coverage counts.

## Measurement

Use stable suite/group IDs, exit categories, execution/queue duration, output
bytes, and worker budget. These can show long poles and infrastructure failure
clusters without collecting prompts, commands, file contents, or test names
that could contain user data.

Collect a baseline from normal CI/local runs rather than generating heavy
parallel workloads solely for statistics. Report the number and context of
observations with any rate. Compare cold and warm runs, and distinguish queue
wait from execution; neither high CPU utilization nor a cached build is proof
of better test throughput.

## Acceptance and verification

The initial delivery should produce an actionable current registry, fix the
highest-evidence reproducible issue(s), and close at least the behavior gaps
selected from the map. Do not promise every historical case is resolved.
For cases that cannot reproduce, record a concrete next trigger and retain them
as historical/unconfirmed instead of weakening their test.

Each fix gets owning tests and the relevant aggregate verification. The registry
integrity test must continue passing. Record meaningful measurements before any
proposal to increase scheduler concurrency or change watchdog defaults.

## Rollout limits

Do not add another flake database or a product-facing flake dashboard in this
step. Automating extraction from machine-readable reports may follow step 12,
but manual evidence quality and reproducible fixes come first.
