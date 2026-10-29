---
id: 213
title: "Mock runs"
phase: 2
plan: "P2.13"
status: in-progress
depends_on: [204, 206, 207]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-213-mock"
pr: ""
updated: 2026-10-29
---

# 213 · Mock runs

- **Plan:** [P2.13 Mock runs](../composable-graphs.md#p213-mock-runs)
- **Decisions:** none
- **Depends on:** [204](204-agent-node-executor.md), [206](206-gate-merge-loop-failure.md), [207](207-system-nodes.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Users test control flow without spending tokens or touching GitHub.

## Work

- [x] `graph-mock-provider.ts`: answers from the type's `example`, a schema-generated value, or a per-node pinned sequence (for example "Verify: fail, fail, pass").
- [x] Runs in the same runtime, so gates, loops, merges and the run view are exercised.
- [x] Mock runs are labelled everywhere. Side-effecting system nodes record "would have run" and never open a PR or move a ticket.
- [x] Launch path without providers or an environment: `graph_run_mock` (placeholder role bindings, example run inputs, environment-less runs, retention).
- [x] Designer: "Mock run" button (saves the draft first) and a pinned-sequence editor per node.

## Tests

- [x] A mock run of each report §9 example passes with zero provider sessions.
- [x] No PR, push or ticket write happens in a mock run.
- [x] A mock run of each built-in's duplicate passes with zero provider sessions.
- [x] Pinned "fail, fail, pass" drives a loop to converge on iteration 3.

## Done when

- [x] Mock runs are available from the designer.

## Notes

**2026-10-29 · Files.** Protocol (browser-safe, new export `./graphs/mock`): `graphs/mock.ts`
(barrel), `graphs/mock-pins.ts` (pin types, bounds, shape checks, `graphMockPinAt`,
`mergeGraphMockPins`, `graphMockPinIssues` against a template or plan), `graphs/mock-values.ts`
(`graphMockValue`, `graphMockWorkspace`, `graphMockCommit`, `GraphMockWouldRun`),
`graphs/schema-sample.ts` (`graphSchemaSample`); `GraphTemplateV1.mockPins` (guard in
`template.ts`, excluded from `graphTemplateDigest` like `layout`); `GraphRun.mockOptions`
(guard: only when `mock: true`). Backend: `graph-mock-provider.ts` (mock agent and human
executors, `installGraphMockExecutors`), `graph-mock-outputs.ts` (shared: pin of an activation,
inputs, storing outputs, pinned failure, `stepMs`), `graph-mock-system.ts` (mock system executor,
"would have run"), `graph-mock-launch.ts` (`GraphMockRuns`: launch, placeholders, retention),
`commands-registry-graph-mock.ts` (`graph_run_mock`, `graph_run_effects`). Small changes:
`graph-run-service.ts` (a mock launch without environment starts `running`; `mockOptions`),
`graph-run-pass.ts` (`graphRunLockedWorkspace`: mock runs hold no workspace locks; executors of an
environment-less run see `environmentId: ""`), `graph-artifacts.ts` (`putMockReference`;
`verify` accepts a mock run's unwritten files), `storage-graph-effects.ts` (state `simulated`,
`recordSimulatedGraphEffect`), `storage-graph-runs.ts` (`deleteEnvironmentlessGraphRun`),
`index.ts` (wiring, startup orphan sweep). Web: `lib/backend/graph-mock.ts`,
`lib/graph-run-navigation.ts`, `graph-designer-mock.ts`, `GraphMockPinsEditor.tsx`, the
designer header button, rename/delete keep pins in step. Docs: `docs/architecture/graphs.md`
("Mock runs (item 213)"), `storage.md`. E2E: `e2e/agent-testing/graph-designer-mock.spec.ts`
(browser suite).

**2026-10-29 · Pin format** (`GraphMockPins` = node id → sequence, ≤ 20 pins per node, ≤ 64 KiB
per pin, ≤ 256 KiB in all). The *n*-th activation of a node's branch (retries, loop iterations and
restarts counted in record order, `graphMockOrdinal`) takes the *n*-th pin; the last repeats. A
pin is `"example"` (default), `"generated"`, `{outputs: {port: value | null}}` (custom JSON,
unnamed ports take the example, `null` leaves an optional port unproduced), `{fail: cause,
message?}`, and for human nodes `{outlet, outputs?}` (an `edit` form's edited value) or
`"pause"`. Gates and merges take none. Stored on the template (`mockPins`, designer data, not in
the digest) and replaced node by node by the launch's `pins`; the effective pins are frozen on the
run (`mockOptions.pins`). Issue codes (`GRAPH_MOCK_PIN_ISSUE_CODES`): `mock-pin-unknown-node`,
`mock-pin-node-kind`, `mock-pin-form`, `mock-pin-unknown-port`, `mock-pin-required-port`,
`mock-pin-value`, `mock-pin-outlet`.

**2026-10-29 · Generator API.** `graphSchemaSample(schema, {arrayItems?, variant?, maxDepth?})`:
deterministic over the 102 subset (`const`, then `enum[variant]`, first non-null `anyOf` branch,
every property, `arrayItems` elements with successive variants, empty provenance lists,
name-driven strings: 40-hex SHAs for `*Ref`/`sha`/`commit`, URLs, branches, paths, ids, else
`Sample <name>`; `minimum` or 1 clamped to `maximum`; `true`). `graphMockValue(definition,
"example" | "generated", {choices?, criterionIds?, headRef?})` → `{value, source, issues}`: fits
built-ins to the port (decision choice, verdict criteria from the ticket, `headRef`), validates
with `validateGraphArtifactValue`, and falls back to the other source when the preferred one fails
(every built-in passes in both modes; generated check summaries fall back to the example).

**2026-10-29 · Decisions.**
- *Human nodes in mocks:* auto-answer by default (approve; `edit` forwards unedited; `choose`
  takes the first option) so a mock run completes unattended; a pin picks another outlet or
  `pause`s, which hands the activation to the live human executor (208) so it waits for a person.
  A `pause` pin is refused at launch while no live human executor is registered (208 not merged
  here). Mock agents never call `ask_human`.
- *Environment-less by default:* without `environmentId` a mock run never provisions (even when
  the template asks for a new environment) and starts `running`. With one, it is listed and
  deleted with that environment and still touches nothing. Mock runs hold no workspace locks.
- *Trust and acknowledgements are not required* for a mock (no session, no side effect), so an
  untrusted project template can be tried before approval; compile errors and built-ins
  (`engine`, duplicate first) are refused. Only stored templates are mocked (P2.15: a draft never
  runs unsaved); the designer saves first.
- *Placeholders:* unbound roles → `{platform: "claude", model: "mock"}`; panel roles get `panel`
  of them (default 2, ≤ `maxPanel`). Missing run inputs → the type's example.
- *"Would have run"* lives in the effect journal (state `simulated`, key
  `would-run:<activation>`, data `{wouldRun: GraphMockWouldRun}` = action, label, summary,
  params with defaults, details such as branch/commit/target/title/ticket move/recipient, input and
  output artifact ids). `pr-result@1` mock outputs say no pull request was opened;
  `wait-for-checks` returns its pinned or example `check-summary@1` (example state `failed`).
- *Reference outputs* (`review-package@2`) are unwritten mock files (`putMockReference`, mock runs
  only); `verify` accepts them for mock runs.
- *Retention:* environment deletion never reaches environment-less runs, so each environment-less
  launch keeps the newest 20 finished environment-less mock runs of the project (one store scan
  per launch, never per pass), a deleted project's are cancelled or deleted, and orphans are
  swept at startup.
- *Usage:* `usage.tokens` stays 0 and no activation carries a session, policy, baseline or guard
  result (guards are no-ops); `usage.agentSessions` still counts admitted agent activations (the
  run's budget), so 211 should not present it as provider sessions on a mock run.
- *Cancel:* mock agent and system executors report `cancelled` for any reason (205's `surplus` and
  210's `restarted` included); a paused human activation passes the reason to the live executor.

**2026-10-29 · Tests.** `apps/backend/src/core/graph-mock-provider.test.ts` (world in
`graph-mock-test-support.ts`: real gate and merge, the live agent executor with a fake provider and
the live system executor behind recording command/shell/PR-monitor fakes, plus the mock
executors): every report §9 example (§9.3 without the sub-graph, §9.4 with a static panel) and
every built-in's duplicate completes with zero provider construction, zero sessions and no
command, shell or monitor call; side-effecting system nodes left `simulated` records; "fail, fail,
pass" on §9.2's Verify converges on iteration 3 (and `[fail]` runs to the bound); stored vs launch
pins; pinned failure retried; human outlet, edit and pause pins; `stepMs`; mock runs hold no
workspace locks (mutation-checked); retention. `commands-registry-graph-mock.test.ts`,
`packages/protocol/src/graphs/mock.test.ts` (generator rules, every built-in valid in both modes,
fitting, pins shape and every issue code, digest and run guard), web `GraphMockPinsEditor.test.tsx`,
`GraphDesignerMock.test.tsx`.

**2026-10-29 · Real stack.** `e2e/agent-testing/graph-designer-mock.spec.ts` (browser suite) passed
against an isolated `dev:test --fixture --no-agent-credentials --agent-platforms codex` profile
(`graphs-213`, 18.8 s): a saved §9.3 graph (no sub-graph) opened in the designer, the approval
pinned in the inspector's Mock run section, "Mock run" saved the draft and started an
environment-less mock run (pins frozen, `mockPins` stored), and `graph_run_effects` showed the PR
node's `simulated` open-pull-request record while the environment kept no PR. `graph-designer.spec.ts`
passed; `graph-designer-editing.spec.ts` failed once on a keyboard-undo poll when run after it and
passed alone (recorded as flake 1310 in `docs/tests/flaky-tests/web-ui/`). Profile stopped and
reset.

**2026-10-29 · For 211 (run view).** Label a run by `run.mock`; read "would have run" records with
`graph_run_effects {runId}` (`state: "simulated"`, `data.wouldRun`). Register
`onGraphRunViewRequested` (`apps/web/src/lib/graph-run-navigation.ts`) to open the run tab, and call
`takePendingGraphRunView()` on mount for a request made before the listener existed (the designer
emits `{runId, projectId, environmentId, mock: true}`). An environment-less mock run has no
`environmentId` and is not in `graphRuns.list(env)`; open it by id. Mock activations have no
session (no transcript); `mockOptions.stepMs` (designer: 1,000 ms) makes them visibly run.

**2026-10-29 · For 214 (launch).** `GraphMockRuns.launch` / `graph_run_mock` is the mock path;
`GraphRunLaunch.mock` + `mockOptions` for a launch surface's own mock option. `requestGraphRunView`
works for real runs too. The designer's Run button can sit beside "Mock run" in the header.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Mock executors, schema-driven generator and pins in protocol, would-have-run records, environment-less `graph_run_mock`, designer button and pin editor; tests and docs; real-stack designer check passed. · complete; awaiting PR
