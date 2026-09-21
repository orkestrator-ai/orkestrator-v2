# Test streamlining implementation plan

Status: Implemented and validated locally; pending review and integration.

Prepared: 2026-09-21.
Source review: [Streamlining the test suite](../../streamlining-tests.md).
Source snapshot: `88c2f9ccfaa68045573b658dd4f172bc5ff7c51b`.

This directory intentionally uses the requested spelling, `streamlning-tests`.
The plan now records the implementation completed on 2026-09-21. No production
application code was changed; the changes are confined to tests, test helpers,
package scripts, Turbo configuration and test documentation.

## Outcome

Reduce developer feedback time and the cost of authoritative validation while
preserving the important behavioral contracts. Achieve this through controlled
time, smaller fixtures, clearer test ownership, cheaper runtime setup and a
better dependency/scheduling graph. Test-count reduction is a consequence of
removing demonstrated overlap, not a quota.

The review's single contended run took 401.9 seconds and failed one gateway
test, which passed alone. It is useful evidence of where time goes, not a clean
baseline or a promised amount of recoverable time. In that run:

| Cost | Observation | First relevant step |
| --- | --- | --- |
| Renderer build followed by renderer tests | 160.6 s + 240.7 s | 09 |
| Two settings component files | 42.4 s combined file time | 03 |
| PersistentTerminal | 22.1 s file time | 04 |
| ACP package | 105.6 s execution | 07 |
| Validation-worker tests | 30.4 s file time | 08 |
| Late start of ACP within bridge group | About 21 s behind initial tasks | 10 |
| Protocol unit package | 886 cases in 1.04 s | Preserve cheap coverage |

Do not add these numbers to estimate total savings. Tasks overlap, timing
profiles include different kinds of work, and queue contention is external to
the test body.

## Steps and dependencies

**Implemented** means the change and its focused validation are present in this
working tree. **Complete** remains reserved for reviewed changes integrated
through the repository's required PR process. **Retained** means the existing
implementation was deliberately kept after evaluating the candidate and
documenting why changing it was not worthwhile or equivalent.

| Step | Plan | Resolution | Intended change boundary |
| --- | --- | --- | --- |
| 01 | [Baseline and coverage inventory](01-baseline-and-coverage-inventory.md) | Implemented | Measurement, explicit suite ownership and discovery guard |
| 02 | [Stabilize the gateway expiry fixture](02-gateway-expiry-fixture.md) | Implemented | Focused test/harness correction for the observed flake |
| 03 | [Control settings autosave time](03-settings-autosave-time.md) | Implemented | Two settings suites and a small test helper |
| 04 | [Control terminal and native-session time](04-terminal-and-native-session-time.md) | Partially implemented; unsafe conversions retained | Timer-heavy UI suites, one behavior family at a time |
| 05 | [Consolidate duplicate and shallow tests](05-test-ownership-and-duplicates.md) | Implemented; compiler/barrel contracts retained | Case mapping, merge duplication, smoke/type contracts |
| 06 | [Use the right runtime preloads](06-runtime-preloads.md) | Bridge migration implemented; root partition retained | Bridge migration first; root partition only if justified |
| 07 | [Reduce ACP subprocess matrices](07-acp-test-layers.md) | Retained after boundary audit | Direct update tests plus retained transport/lifecycle cases |
| 08 | [Narrow backend and command fixtures](08-backend-and-command-fixtures.md) | Worker observation implemented; Git fixtures retained | Validation-worker polling and unnecessary Git setup |
| 09 | [Separate source tests and artifact builds](09-build-and-test-task-graph.md) | Implemented | Turbo graph, package scripts, aggregate/CI wiring |
| 10 | [Schedule bridge packages by cost](10-bridge-package-scheduling.md) | Retained after remeasurement | Bounded scheduling using post-optimization measurements |
| 11 | [Final assurance and performance validation](11-validation-and-rollout.md) | Implemented and validated locally | Comparison, contention checks, documentation and handoff |

The final authoritative `mise run test` completed successfully in 283.3
seconds: workspace 283.3 seconds, root 104.4 seconds, bridges 95.9 seconds and
the protocol lockfile check 0.5 seconds. This is substantially below the
401.9-second contended review observation, while a previous warm aggregate at
the same source snapshot completed in about 272.8 seconds. Host load and build
cache state therefore still matter; the focused settings and bridge results are
the clearest attributable improvements.

Implement in numeric order by default. Step 02 need not delay the local
settings work, but resolve or explicitly account for the flake before using
aggregate pass rates as performance evidence. Changes that both edit runner
selection or preloads should be integrated sequentially and rebase onto the
latest inventory. Each step may become several small PRs; avoid one large
change that simultaneously alters assertions, fixture lifetime and scheduling.

## Scope and decision rules

Start with test/harness/configuration changes. A small production seam is an
exception requiring a demonstrated need and review of its runtime behavior.
Do not change production debounce durations, retry policy, approval decisions,
transport state ownership or lifecycle semantics to make tests cheaper.

The implementation may decline a candidate after measurement. Examples:

- Keep a bridge test process-backed if direct invocation would bypass the
  behavior its assertion actually protects.
- Keep root preloads unchanged if a safe partition has negligible benefit.
- Keep the existing package scheduler if ACP ceases to dominate after step 07.
- Retain a smoke test if its import-time failure cannot be covered by a useful
  behavioral consumer or a compiler contract.

Record such decisions in the relevant step with the measurement and coverage
reason. The final report must distinguish delivered, retained and deferred work.

## Corrections and refinements from source inspection

The implementation plan uses production behavior as the authority when a broad
recommendation in the review is imprecise:

1. **Settings flush pending valid edits on unmount.**
   `GlobalSettings.tsx` clears the debounce timer but separately persists a
   pending valid edit in unmount cleanup. Step 03 must preserve that flush and
   prevent duplicate writes. Do not reinterpret it as cancellation of the save.
2. **Gateway expiry is scheduled from the accepted credential deadline.**
   Merely changing a session's expiry after connection does not necessarily
   re-arm an already scheduled timer. Step 02 must drive the real scheduled
   callback as well as the credential clock.
3. **ACP already has direct tool tests and a unit environment bootstrap.**
   Extend these where appropriate; do not create a second simulation of the
   normalization logic or assume every transcript case needs a new harness.
4. **The review found 898 tracked test/spec files but 869 collected files.**
   Most exclusions are intentional. Two test files need explicit ownership;
   a faster run caused by leaving them uncollected is not an optimization.

## Shared assurance requirements

Every step follows [AGENTS.md](../../../../AGENTS.md), the
[testing guide](../../../development/testing-guide.md) and the existing
`bun-testing` skill when editing Bun suites. In particular:

- Preserve per-file isolation, stable module mocks and exact restoration of
  globals, environment, clocks and process resources.
- Keep durable backend state and inactive-environment rehydration coverage.
  Unmounting a renderer does not cancel backend work.
- Retain at-most-once dispatch, replay subscription order, cursor recovery,
  fail-closed approvals, bounded resources and dead-generation cases.
- Keep real SDK regressions, parser compatibility and packaged-artifact tests
  wherever a mock cannot reproduce the failure.
- Keep test-result caching disabled. Keep existing build-cache sharing across
  worktrees and private, per-worktree timing profiles.
- Do not expand the eight-slot aggregate ceiling or bypass memory admission.
  Preserve bounded logs, watchdogs, process-tree cleanup, all-group reporting,
  queue fairness, validation heartbeat and `covers` behavior.
- Do not change a test to skipped, add automatic retries or weaken an assertion
  to improve a timing result. Use the existing flake registry for flake history.

## Common implementation record

Each implementation PR should supply the following record. Keep raw output in
the existing private artifacts; commit only bounded, non-sensitive summaries.

| Field | Required content |
| --- | --- |
| Identity | Base/candidate commits, runtime version, platform and worker plan |
| Coverage | Old case/file → retained owner mapping; intentional count changes |
| Commands | Exact focused, static and aggregate validation commands |
| Performance | Cache state, queue/execution time, file/package duration and relevant fixture counts |
| Reliability | Failed/skipped/incomplete outcomes, cleanup observations and flake links |
| Decision | Measured benefit, tradeoff, rollback boundary and remaining work |

Examples in step documents are run from the repository root. Use the pinned
runtime through `mise` and logged focused commands. They are future validation
instructions, not claims that these commands were run while writing this plan.
Confirm pinned runner/library APIs before implementing configuration or timer
helpers; use Context7 for library-specific documentation as required by the
repository. Do not copy an assumed flag or a newer timer API into the code.

For each implementation handoff, run appropriate owning tests, changed-code
selection, static checks and the default suite as required by the testing guide.
The final step adds cross-cutting acceptance; it does not postpone all full-suite
verification until the end. All changes to `main` go through PR review, with
the final merge left to a human maintainer.
