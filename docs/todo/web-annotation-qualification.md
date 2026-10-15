# Web annotation qualification

Checked against `main` at `2459b05c` (2026-10-15).

Web-page annotations shipped in #845 (`964d71f4`, 2026-09-25). They have
unit, contract and component tests, plus two real-stack specs on Linux. No
milestone has a sign-off. The missing evidence is the part mocks cannot give:
the native Electron window beside the Notes column, live agents for each
provider, Docker and remote workspaces, and review from web and iOS clients.
This file lists those runs, the small amount of test code they need, the
sign-off record, and the last recorded evidence. Afterwards the feature's
status can move from "gates pending" to qualified, with a capability matrix
that names what was actually tested.

## Current state

- Since #845: #969 moved storage from JSON manifests to SQLite (and edited the
  shared spec helper `e2e/agent-testing/web-annotations-support.ts`); #983
  split the service into collaborators (`web-annotation-service-store.ts`,
  `-threads.ts`, `-requests.ts`, `-results.ts`); #967 moved the protocol
  fixtures to `packages/protocol/src/testing/web-annotations-fixtures.ts`;
  #947 added a Home native-preview test to the Electron spec.
- The rollout switch (`apps/backend/src/core/web-annotation-rollout.ts`)
  defaults to `enabled`. `ORKESTRATOR_WEB_ANNOTATIONS_MODE` overrides it.
  `read-only` blocks every `author` command but keeps reads, resolution, drafts
  and recovery. `disabled` keeps only capabilities, rollout and metrics. In
  every mode the reconciler keeps settling requests already sent. The feature
  is therefore on by default without a gate sign-off. That is deliberate; see
  the default decision under "Constraints and rationale".
- `e2e/agent-testing/web-annotations-electron.spec.ts` (7 tests, run by
  `mise run test:agent:electron`) drives the production preload API with fixed
  bounds. It covers capture without an agent tab across a renderer reload and a
  backend restart, masking, inert adversarial strings, pins, route identity,
  text/region/page modes, and secret-free storage and logs. It never renders
  the Notes column beside the native view, and it has no zoom or DPR
  variation.
- `e2e/agent-testing/web-annotations-gateway.spec.ts` (3 tests, run by
  `mise run test:agent:browser:isolated`). Its two batch tests use
  `holdQueue: true`, so nothing is dispatched or materialized. The live
  implement test is skipped unless `ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATIONS=1`.
  It takes the provider from `ORKESTRATOR_AGENT_TEST_ANNOTATION_AGENT` (default
  `codex`) and the profile from `ORKESTRATOR_AGENT_TEST_PROFILE` (default
  `codex-qa`). It waits for `awaiting-review` and checks the source change with
  `annotation-app/verify-change.ts`.
- There is no Docker annotation spec. `test:agent:docker` greps for
  `'Docker fixture'`, and no annotation test title matches. Container
  materialization is covered only with a fake container call
  (`web-annotation-dispatch.test.ts`, which expects `write_container_file`).
- The fixture app (`test-fixtures/agent-project/annotation-app/`, checked by
  `tests/unit/annotation-fixture-app.test.ts`) has an iframe, an open shadow
  root, a canvas, synthetic secrets and a hot-reload hook. It has no CSS
  animation, no late-loading font and no expired sign-in route.
- The fault-injection matrix is covered at unit level: SSE loss and restart,
  crash before the queue write, claim versus cancel, environment A/B, and an
  untouched compose draft (`web-annotation-dispatch-flow.test.ts`). So are the
  stale-result acceptance race (`web-annotation-service-results.test.ts`) and
  migration crash and retry (`web-annotation-migration*.test.ts`).
- `WebAnnotationMetrics` (`apps/backend/src/core/web-annotation-metrics.ts`),
  read through `web_annotations_metrics`, has `command_ms`,
  `request_enqueue_ms`, `request_dispatch_ms` and `request_duration_ms`
  histograms. Nothing measures capture-to-saved end to end, from desktop spool
  to backend commit.

## Outstanding work

### Code

Test code the runs below depend on.

1. Electron spec additions: open the real Notes column and assert the native
   view's bounds against it. Add a capture-alignment case at preview zoom 0.8,
   1 and 1.5, and at DPR 1 and 2.
2. A Docker annotation case whose title contains `Docker fixture`, so
   `mise run test:agent:docker` selects it. Assert that
   `.orkestrator/annotations/<request>-<digest>.png` is written inside the
   container, that settled-request cleanup removes it, and that result file
   checks report `unavailable` (until the container check in
   [web-annotation-known-limitations.md](web-annotation-known-limitations.md)
   lands).
3. A real-stack assertion that a sent request writes
   `.orkestrator/annotations/<request>-<digest>.png` into the local worktree.
   Today only the skipped live test exercises this, and only implicitly.
4. A live Discuss case and a needs-input or clarification case next to the
   implement case. Discuss should run in plan mode on Claude and be labelled
   advisory elsewhere.
5. Fixture-app routes for a CSS animation, a late-loading web font and an
   expired sign-in redirect. Use them to exercise `stable`/`unstable` from
   `web_annotation_result_capture` and the redirect handling of Show on page.
6. Fix the flakes that touch these suites:
   [0204](../tests/flaky-tests/0204-web-annotation-quota-hook-timeout.md)
   (`web-annotation-quotas.test.ts` hook timeout) and
   [0225](../tests/flaky-tests/0225-design-and-bench-aggregate-timeouts.md)
   (`web-annotation-payloads.bench.test.ts` creation-cost bound under
   aggregate load).

### Qualification

- Re-run `mise run test:agent:electron` and
  `mise run test:agent:browser:isolated` on current main, and record them with
  the sign-off template below. The last evidence predates #969 and #983.
- Run the live implement test once for each provider in `AGENT_PLATFORMS`:
  claude, codex, cursor, grok, opencode and pi. Record skipped providers and
  missing credentials explicitly. A skipped provider is not a passing one.
- Remote backend: connect the desktop to a backend on another host, capture,
  and confirm that `web_annotation_asset_stage` and materialization in the
  remote workspace both work.
- Approval across disruption: start a request whose turn raises an approval.
  Switch environments, reload the renderer, drop SSE and restart the backend,
  then answer from the request card and from chat. No approval may be applied
  twice, and an approval from a dead generation must be withdrawn, never
  applied implicitly.
- Native window, after code item 1 or as a manual cua-driver pass:
  - with the Notes column open, the preview bounds shrink;
  - menus, dialogs and focus rings are never covered;
  - create, send and resolve work by keyboard alone;
  - the narrow (under 720 px) Preview/Notes switch works;
  - screenshot and highlight alignment holds at the zoom and DPR values
    above;
  - pins and Show on page stay on the right target, or become explicit, for
    an offscreen target, a target inside a modal, and a layout shift from a
    late-loading font (code item 5's font route). Only reorder, hot reload and
    duplication have real-stack evidence so far.
- Web and iOS review: on a gateway browser client and in the iOS wrapper
  (`apps/ios`, `WKWebView`), review a capture made on the desktop while no
  desktop is connected. Capture must show as unavailable.
- Comparison cases (after code item 5): matching and mismatched routes and
  viewports, unstable animation or fonts, expired authentication, and
  unavailable functional verification.
- Baselines: record request-to-review latency (`request_duration_ms`) and
  per-command latency (`command_ms`) from `web_annotations_metrics` during
  fixture runs, and the time from selection to saved feedback measured at the
  client. Record the numbers before setting any target.
- Sign-off: one record per milestone (A core loop; B targets and batches; C
  results, modes and clients). Then update the client capability matrix in
  [web-page-annotations.md](../architecture/web-page-annotations.md) with the
  providers and clients actually tested.

Batch the provider, Docker, remote, macOS and iOS runs with other todo files
through
[live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md).

### Sign-off template

```text
Milestone / PR / commit:
Implemented scope and remaining deferrals:
Platforms, providers, and client versions exercised:
Logged commands and results:
Real workflow and inactive-environment evidence:
Fault-injection boundaries exercised:
Capability matrix and known limitations:
Migration and rollback verification:
Reviewer / date:
```

### Runs on 2026-10-15 (macOS)

Partial evidence only; no milestone was signed off. macOS on Apple Silicon,
`main` at `7ccb193e`, one isolated `mise run dev:test --fixture` profile with
the default credential sources.

| Command | Result |
| --- | --- |
| `mise run test:agent:electron`, before the dialog fix | 1 passed, 4 failed, 1 skipped, 6 did not run. All four failures are the GitHub CLI dialog covering the window (below), not annotation behaviour |
| `mise run test:agent:electron`, with `electron-startup-dialogs.ts` | 9 passed (all 7 annotation tests and the terminal resume test), 2 failed, 1 skipped. Both failures are `electron-main` on macOS and reproduce alone: the Window-menu switch never gives the target window native focus, and the remote connection fails in `safeStorage.encryptStringAsync` |
| `mise run test:agent:browser -- e2e/agent-testing/web-annotations-gateway.spec.ts`, live, agent `codex` | 3 passed (46 s) |

Live implement test (`--grep 'live agent'`), one run per provider unless
stated:

| Provider | Result |
| --- | --- |
| codex | Pass: `awaiting-review` in 42 s, `verify-change.ts` 8/8 |
| claude | Pass: `awaiting-review` in 26 s, 8/8 |
| opencode | Pass (32 s) |
| grok | Before the bridge fixes below: fail, twice. The turn ended `completed` after about five minutes and the request moved to `awaiting-review`, but no file changed (only the three unchanged-checks passed). After the first three: the request reached `needs-input` within 30 s, because Grok asked before every edit, command and fetch; with those five approvals answered from `session interactions resolve` it reached `awaiting-review` with `verify-change.ts` 8/8, and left unanswered it moved to `failed` with the expiry reason. After the auto-approve answer (below): pass with no approvals, `awaiting-review` in 437 s, 8/8 |
| cursor | Skipped, no credential: "Cursor is not signed in" (HTTP 401). The request stayed `queued` with that reason |
| pi | Skipped, no credential: "Pi has no authenticated model provider" (HTTP 401). The request stayed `queued` with that reason |

- Since #982 a profile provisions `gh` only for a non-empty platform
  selection, and agent-test host tool checks never fall back to PATH
  (`apps/backend/src/core/host-tools.ts`). The Electron specs launch with an
  empty selection, so "GitHub CLI Not Found" opened over every window. They
  now close it through `e2e/agent-testing/electron-startup-dialogs.ts`, as the
  browser specs already did.
- Grok cause, reproduced with a one-line `check_inbox` prompt: Grok 1.0.52
  calls every MCP tool through `use_tool` (`tool_name:
  "orkestrator__check_inbox"`). The bridge's auto-allow matched only the
  call's own name or `_meta["x.ai/tool"]`, so even a mail tool was held by
  `parkPermission`. While it was held the session read `working`, and the
  approval was a generic "Permissions: file system" with no options, which the
  CLI could not grant. After the 300 s hold the bridge answered `cancelled`;
  Grok reported "User cancelled the execution for tool `use_tool`" and ended
  the turn, which the backend recorded as `completed`. Fixed in three parts,
  each checked live the same day:
  - `orkestratorToolPermissionOption` (`acp-session.ts`) reads the wrapped
    `tool_name`, from the request or the call already recorded, and also
    allows the annotation result tools. The `check_inbox` probe now takes 45 s
    end to end instead of 5 min 20 s.
  - `/activity` answers `waiting` while a request is held, and approvals carry
    ACP's own shape (the tool title and Grok's options), which the backend
    offers as a choice. Deny selects the reject option.
  - The prompt journal records why a turn was cut short (`turnTerminalError`
    in `acp-prompt.ts`: an expired request, a cancel nobody asked for, or
    `refusal`/`max_tokens`/`max_turn_requests`). The backend reads it as the
    turn's failure (`HttpBridgeProvider.turnTerminalError`, Grok only).
- Grok 1.0.52 still asks before every edit, command and fetch over ACP,
  although the bridge launches it with `--always-approve` under the default
  `auto-approve` policy. The bridge now answers those requests itself under
  that policy (`autoApprovedPermissionOption`), except for a kind the policy
  denies, so Grok no longer waits in `needs-input` at each step. Revisiting
  how approvals should work for Grok was left for later (2026-10-15).
- The spec waits up to 14 minutes for a live request but prints nothing while
  it polls, so `test:logged` kills a run after five quiet minutes. Set
  `ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS` above 840000 for slow providers.
- An implement request moves to `awaiting-review` whenever the turn ends
  without a recorded failure, even when nothing changed. A request to a
  signed-out provider waits in `queued` with the sign-in reason rather than
  failing.

### Last evidence (2026-09-25)

Partial evidence only; no milestone was signed off. Linux (Wayland, display
`:0`), the #845 change set before merge, before #969 and #983.

| Command | Result |
| --- | --- |
| `mise run check` | Pass |
| `mise run test` | Pass, all four groups (one earlier run hit flake 0156) |
| `mise run test:agent:electron` | 9 passed (`electron-main` 3, `web-annotations-electron` 6; the Home test came later) |
| `mise run test:agent:browser:isolated` | Pass (58 s). A rerun had 5 passed, 4 skipped (Docker, live agent) and 1 unrelated failure (flake 0162) |
| `web-annotation-payloads.bench.test.ts` | 6 passed. Largest brief 65,122 B; 16 images / 16.7 MB; 40 pages at up to 62.7 KB each |

- Gate A: capture with no agent tab survived a renderer reload and a full
  app and backend restart; password fields were masked in the native
  screenshot; adversarial strings stayed inside the evidence block and forged
  provenance was refused; no synthetic secret appeared in profile storage or
  logs.
- Gate B: after reorder, hot reload and duplication, pins either matched by
  corroborated identity or became `ambiguous`/`stale`, never a different
  target. Hash and query variants kept separate identities and token
  parameters were stripped. Overlapping batches from two clients reserved
  all-or-none and survived reload, and the annotation-count bound held.
- Gate C: text, region and page modes captured end to end; iframe and shadow
  content resolved to the host element.
- Not run: live-agent runs per provider, Docker materialization, remote
  upload, inactive-environment switching with a pending approval, native-window
  zoom checks, iOS review, and the comparison fixtures.

## Constraints and rationale

- Use only the synthetic fixture and synthetic credentials, in isolated
  profiles ([agent-testing.md](../development/agent-testing.md)). Screenshots
  and traces must show the fixture only.
- Record exact command, commit, platform, provider, exit status, counts and
  skips. A skipped platform is not a passing one, and one provider's happy path
  is not evidence for six.
- Keep unverified capabilities disabled where the missing evidence affects
  safety or correctness.
- The default stays `enabled` (decided 2026-10-15). Dispatch publishes into the
  same per-tab prompt queue as chat sends (`web-annotation-dispatch.ts`).
  Annotation-specific failures show on the request card (`unknown`, Answer in
  chat, a sign-in reason, an empty change) rather than losing data. Settings ›
  Web annotations or `ORKESTRATOR_WEB_ANNOTATIONS_MODE` rolls it back. Holding
  dispatch for providers without a live run was rejected: before 2026-10-15
  that meant all six. Revisit if a live run shows duplicate execution, lost
  data or a write outside the workspace.
- Rollback must stop new operations while keeping reads, spool recovery and
  reconciliation of requests already sent. `web-annotation-rollout.ts` already
  behaves this way; any rollout test must keep it.
- Initial-release targets from the plan: no duplicate execution under fault
  injection, deterministic recovery at every acknowledged boundary, and
  visible catch-up on an active client within two reconciliation intervals
  (`WEB_ANNOTATION_LIMITS.reconcileIntervalMs`) once transport and storage
  recover. Latency and memory targets come from measurements, not from an
  assumed SLA.

## Open questions

- Is macOS (the primary development host) required as well as Linux for the
  native-window gate?
- Is the remote-backend run in scope now, or a deferral recorded in the
  matrix?
- Do the unit-level fault and race tests count for gate A, or does gate A need
  real-stack runs of the acceptance race and migration restart too?

## Needs verification

- Whether the 2026-09-25 runs still pass after #969 and #983.
- Whether the gateway spec's synthetic capture still matches what the Electron
  capture path produces.

## Related

- [web-annotation-known-limitations.md](web-annotation-known-limitations.md),
  [web-annotation-extensions.md](web-annotation-extensions.md).
- [service-preview-rollout.md](service-preview-rollout.md): the native-window
  run uses the same Electron harness, and annotations run inside service tabs.
- [container-platform-qualification.md](container-platform-qualification.md)
  for Docker fixtures.
- [web-page-annotations.md](../architecture/web-page-annotations.md),
  including §"Request states" and §"Anchors and pins".
- Living-doc drift to fix: the `docs/README.md` catalogue row points here for
  the real-stack gates; drop that pointer after sign-off.

## Replaces

- `docs/improvements/web-page-annotations.md` ("How to judge whether it
  helped", validation scenarios)
- `docs/improvements/web-page-annotations/plan/00-index.md` (milestones and
  gates)
- `docs/improvements/web-page-annotations/plan/01-domain-model-and-contracts.md`
  (done; state machine and limits moved to `architecture/web-page-annotations.md`)
- `docs/improvements/web-page-annotations/plan/02-storage-assets-and-retention.md`
  (superseded by SQLite; remote upload proof)
- `docs/improvements/web-page-annotations/plan/03-commands-synchronization-and-capabilities.md`
  (done)
- `docs/improvements/web-page-annotations/plan/04-trusted-capture-and-delivery.md`
  (native-window alignment at several zoom levels)
- `docs/improvements/web-page-annotations/plan/05-annotation-panel-and-authoring.md`
  (real Electron panel and native-view check)
- `docs/improvements/web-page-annotations/plan/07-dispatch-queues-and-recovery.md`
  (done; fault matrix now in tests)
- `docs/improvements/web-page-annotations/plan/08-discussion-progress-and-review.md`
  (approvals across switch and restart)
- `docs/improvements/web-page-annotations/plan/09-migration-and-first-release.md`
  (release sign-off)
- `docs/improvements/web-page-annotations/plan/10-anchors-navigation-and-stale-targets.md`
  (real-window pin cases; resolution rules moved to
  `architecture/web-page-annotations.md`)
- `docs/improvements/web-page-annotations/plan/12-results-and-visual-verification.md`
  (comparison fixtures)
- `docs/improvements/web-page-annotations/plan/13-capture-modes-and-client-support.md`
  (web and iOS review proof)
- `docs/improvements/web-page-annotations/plan/14-validation-observability-and-release.md`
  (gates, commands, sign-off template, evidence record)
