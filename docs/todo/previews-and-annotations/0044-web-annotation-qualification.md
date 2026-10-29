# Web annotation qualification

Checked against `main` at `ba7cc8d4` (2026-10-25).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Human review of sign-offs A to C**: a person reviews the three
   agent-written sign-off records, answers the gate-scope open questions, and
   then the README catalogue pointer is dropped. Status: open.
2. **Remote backend on another host**: desktop on one host captures and stages
   into a backend on another. Status: blocked (on a second machine; batched in
   0031).
3. **iOS wrapper review**: run web review inside the `WKWebView` wrapper on a
   device or simulator. Status: blocked (on a person entering the gateway token
   against an HTTPS tailnet profile).
4. **Native focus and keyboard resolve**: OS-level preview focus, Window-menu
   focus, and Accept and resolve by keyboard. Status: blocked (on a frontmost
   host and a request in `awaiting-review` inside the Electron spec).
5. **Linux re-run after #969 and #983**: the first "Needs verification" item.
   Status: open.
6. **Quiet-host baselines and targets**: repeat the baselines and decide
   whether to set targets. Status: open.
7. **Gateway synthetic-capture parity**: the second "Needs verification" item.
   Status: partly done (real PNG staged since 2026-10-25; target and evidence
   fields still synthetic).

Code items 1 to 6, the keychain item and the create-cost item (moved to
[0124](0124-web-annotation-commit-cost.md)) are done.

### 1. Human review of sign-offs A to C

**Problem.** The feature is on by default, and its only sign-offs were written
by a worker agent. Until a person reviews them, "qualified" is a claim, not a
decision.

**Context.** The "Sign-off records, 2026-10-25" section and the four open
questions (macOS and Linux for the native gate; whether remote is in scope;
whether unit-level fault tests count for gate A; whether WebKit counts for
iOS). "Related" asks to drop the README catalogue pointer after sign-off.

**Investigation.** The rollout default is still `enabled`
(`apps/backend/src/core/web-annotation-rollout.ts:2`, `:122`). The records cite
evidence from #1250 (`4db5bb2a`). Since then, annotation code changed only in
`cdaa1bb1` (0124's copy-on-write commits), `182a4031` (test reliability) and
`1aabf049` (container runtime); none alters the gated flows, but 0124 rewrote
the storage commit path that milestone A depends on. The pointer still exists
at `docs/README.md:57`, and `docs/architecture/web-page-annotations.md:6`,
`:550` and `:601` link here. The capability matrix's "Exercised" table
(`web-page-annotations.md:549-560`) is current. Needs-input and disruption
were run on Claude only.

**Decisions.**

- **What does the reviewer accept as the gate?**
  - **Accept A to C with the open runs recorded as deferrals in the matrix;
    unit-level fault and migration tests count for gate A; WebKit counts as
    the engine-level iOS signal only (recommended).**
    - Pros: matches what the records already say; lets the file shrink to the
      hardware runs; keeps the iOS wrapper honestly open.
    - Cons: real-stack migration and rollback have never run; needs-input on
      five providers is unproved.
  - **Require real-stack migration, rollback and multi-provider needs-input
    before sign-off.**
    - Pros: stronger evidence for an on-by-default feature.
    - Cons: new test code and live runs; delays sign-off with no reported
      defect behind it.
- **Re-run after 0124's storage rewrite before signing?**
  - **Yes, one `mise run test:agent:electron` and
    `mise run test:agent:browser:isolated` on current `main` (recommended).**
    - Pros: 0124 rewrote every annotation commit; cheap, credential-free.
    - Cons: needs an isolated profile and an Electron-capable host.
  - **No; 0124's unit tests ran the full-diff assertion on every commit.**
    - Pros: no extra run.
    - Cons: the real-stack specs have not run on the new commit path.

### 2. Remote backend on another host

**Problem.** A desktop staging captures into a backend on a different host has
never been run. Remote-desktop users are the ones who would see a failure.

**Context.** The gateway cases already stage through the same HTTP invoke
transport; what remains is two hosts. Assumption 11 and open question 2.

**Investigation.** The command is `web_annotation_asset_stage`
(`packages/protocol/src/web-annotations.ts:1153`, `:1628`). No test spans two
hosts.

**Decisions.**

- **Run it, or record it as a deferral?**
  - **Run it in 0031's two-machine session with 0042's tailnet run
    (recommended).**
    - Pros: one setup serves both files; same hardware.
    - Cons: waits on 0031.
  - **Record it as a deferral in the matrix and drop it here.**
    - Pros: the transport is already covered; lets the file close sooner.
    - Cons: a real remote path (latency, upload size over a WAN) stays unseen.

### 3. iOS wrapper review

**Problem.** iOS review is proved only on Playwright WebKit, not in the
wrapper users run.

**Context.** The wrapper accepts only HTTPS plus a typed gateway token, which
agents must never handle (assumption 10).

**Investigation.** HTTPS is enforced in
`apps/ios/OrkestratorMobile/Networking/GatewayConnectionValidator.swift:32-34`.
Capture is hidden off desktop (`canCapture`,
`apps/web/src/components/browser/annotations/AnnotationPanel.tsx:70`).

**Decisions.**

- **Who runs it?**
  - **A person, on a simulator against a tailnet-served `dev:test` profile,
    batched in 0031 (recommended).**
    - Pros: respects the token rule; a simulator is enough for review-only
      flows.
    - Cons: needs a macOS host with Xcode and a person.
  - **Accept the WebKit run and close the item.**
    - Pros: no hardware.
    - Cons: WebKit is not the wrapper (native form, data store, handoff).

### 4. Native focus and keyboard resolve

**Problem.** OS-level focus and resolving by keyboard in the native window are
unproved; keyboard-only users are the ones at risk.

**Context.** "Found on 2026-10-17". The Electron spec deliberately has no live
provider; its Codex is a shell probe that only records launches
(`e2e/agent-testing/web-annotations-electron.spec.ts:132`, `:626`). The
button is "Accept and resolve"
(`apps/web/src/components/browser/annotations/RequestCard.tsx:635`); Window
menu focus is in `apps/desktop/electron/window-menu.ts`.

**Investigation.** `awaiting-review` is reached only through a turn outcome
(`apps/backend/src/core/web-annotation-dispatch.ts`,
`web-annotation-service-results.ts`), so the spec cannot get there without a
provider that completes a turn.

**Decisions.**

- **How to reach `awaiting-review` in the native window?**
  - **Run once by hand on a frontmost macOS host with a live provider
    (recommended).**
    - Pros: no test-only product hooks; also covers OS-level focus, which only
      a key window can show.
    - Cons: one-off evidence; needs a dedicated desktop.
  - **Teach the Codex probe to answer a minimal app-server turn so the spec
    reaches `awaiting-review` with no credentials.**
    - Pros: permanent keyboard-resolve coverage in CI.
    - Cons: a fake app-server protocol to maintain across Codex bumps; still
      does not prove OS focus on a shared desktop.

### 5. Linux re-run after #969 and #983

**Problem.** Linux last ran the native and gateway suites on 2026-09-25,
before the SQLite and service-split changes.

**Context.** Open question 1 (is macOS required as well as Linux). The
capability matrix lists "Linux after #969" as not exercised.

**Investigation.** Nothing Linux-specific has run since; this analysis host is
Linux, so the run needs no extra hardware.

**Decisions.**

- **Run it now, or leave Linux out of the gate?**
  - **Run `mise run test:agent:electron` and
    `mise run test:agent:browser:isolated` on a Linux desktop host
    (recommended).**
    - Pros: available hardware; closes a matrix gap; combines with task 1's
      post-0124 re-run.
    - Cons: Wayland and X11 differ; a shared desktop still cannot prove focus.
  - **Declare macOS the only required native platform.**
    - Pros: less work.
    - Cons: Linux is a supported desktop; leaves the matrix row unproved.

### 6. Quiet-host baselines and targets

**Problem.** The baselines were taken at load ~45, so no target can be set.

**Context.** "Needs verification" item 3 and the 2026-10-25 baselines
paragraph. The plan says targets come from measurements.

**Investigation.** The baselines come from the Electron spec's `baselines`
case and `web_annotations_metrics`; 0124 changed create cost since (about
18-28 ms down to 2.6-3.8 ms at 1,900 notes), so the backend numbers are already
stale.

**Decisions.**

- **Set targets?**
  - **Re-measure on a quiet host with 0124's run, and record baselines only,
    no targets (recommended).**
    - Pros: one quiet session for both files; avoids a target nobody enforces.
    - Cons: no regression threshold for capture latency.
  - **Set targets from the re-measurement and assert them in the spec.**
    - Pros: a real latency guard.
    - Cons: timing assertions are the flake source already recorded in 0225.

### 7. Gateway synthetic-capture parity

**Problem.** The gateway spec's target and evidence fields are synthetic, so it
could drift from what Electron produces.

**Context.** "Needs verification" item 2. A real staged PNG and geometry image
were added on 2026-10-25.

**Investigation.** The shared helper is `e2e/agent-testing/web-annotations-support.ts`;
the protocol validator is the common contract both paths pass through.

**Decisions.**

- **How to keep them aligned?**
  - **Capture one real target and evidence record in the Electron spec and
    reuse it as the gateway spec's fixture (recommended).**
    - Pros: the gateway runs on real Electron output; drift becomes a fixture
      update.
    - Cons: a fixture to refresh when the capture shape changes.
  - **Rely on the shared validator and close the item.**
    - Pros: no work.
    - Cons: validation checks shape, not that values match a real capture.

Web-page annotations shipped in #845 (`964d71f4`, 2026-09-25). They have
unit, contract and component tests, plus real-stack specs. Milestones A–C
have sign-off records written on 2026-10-25 by a worker agent, awaiting human
review; three runs remain open (a remote backend on another host, the iOS
wrapper, native focus and keyboard resolve). The evidence is the part mocks cannot give:
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
- `e2e/agent-testing/web-annotations-electron.spec.ts` (10 tests, run by
  `mise run test:agent:electron`). Seven drive the production preload API with
  fixed bounds. They cover capture without an agent tab across a renderer
  reload and a backend restart, masking, inert adversarial strings, pins, route
  identity, text/region/page modes, and secret-free storage and logs. Since
  2026-10-17, three more cover the native window:
  - The real renderer draws the Notes column beside the native view. The view
    must sit on its host at app zoom 0.8, 1 and 1.25 and never cover the
    column, its resize handle or a focus ring (within the one DIP that integer
    view bounds allow). A menu and a dialog hide the view. At 150% app zoom,
    and in a 900 px window, the narrow Preview/Notes switch takes over.
  - Create and send by keyboard alone.
  - Capture pixels and the selection highlight stay on the target at preview
    zoom 0.8, 1 and 1.5 in both fixed and Notes-offset views, without image
    reduction. Natural DPR plus forced DPR 1 and 2 run on every host with
    `--force-device-scale-factor`.
- `e2e/agent-testing/web-annotations-gateway.spec.ts` (3 tests, run by
  `mise run test:agent:browser:isolated`). Its two batch tests use
  `holdQueue: true`, so nothing is dispatched or materialized. The live
  implement test is skipped unless `ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATIONS=1`.
  It takes the provider from `ORKESTRATOR_AGENT_TEST_ANNOTATION_AGENT` (default
  `codex`) and the profile from `ORKESTRATOR_AGENT_TEST_PROFILE` (default
  `codex-qa`). It waits for `awaiting-review` and checks the source change with
  `annotation-app/verify-change.ts`. Since 2026-10-18 a request parked on a
  rejected dispatch ends the test at once: a sign-in rejection is a skip that
  names the reason (`isSignInError`), any other rejection is a failure. The
  test also prints a progress line each minute while it waits.
- Since 2026-10-25 the gateway spec has two `Docker fixture` annotation cases
  (selected by `test:agent:docker`), a local-worktree evidence case, a web
  review case (runs in WebKit too with `ORKESTRATOR_AGENT_TEST_BROWSER=webkit`),
  live needs-input cases and a closing metrics baseline. The opt-in
  `web-annotations-approval-live.spec.ts` restarts the profile around a
  pending approval.
- The fixture app (`test-fixtures/agent-project/annotation-app/`, checked by
  `tests/unit/annotation-fixture-app.test.ts`) has an iframe, an open shadow
  root, a canvas, synthetic secrets and a hot-reload hook, and since
  2026-10-25 a CSS animation (`/motion`), a late web font (`/fonts`), a modal
  and an offscreen target (`/dialogs`) and an expiring sign-in (`/account`).
- The fault-injection matrix is covered at unit level: SSE loss and restart,
  crash before the queue write, claim versus cancel, environment A/B, and an
  untouched compose draft (`web-annotation-dispatch-flow.test.ts`). So are the
  stale-result acceptance race (`web-annotation-service-results.test.ts`) and
  migration crash and retry (`web-annotation-migration*.test.ts`).
- `WebAnnotationMetrics` (`apps/backend/src/core/web-annotation-metrics.ts`),
  read through `web_annotations_metrics`, has `command_ms`,
  `request_enqueue_ms`, `request_dispatch_ms` and `request_duration_ms`
  histograms. Capture-to-saved is measured at the client by the Electron
  spec's baseline case (selection → spool, spool → backend commit); see
  "Baselines" under "Runs on 2026-10-25".

## Outstanding work

### Code

Test code the runs below depend on.

1. Done 2026-10-17 (see "Runs on 2026-10-17"): Electron spec additions that
   open the real Notes column and assert the native view's bounds against it,
   plus a capture-alignment case at preview zoom 0.8, 1 and 1.5, and at DPR 1
   and 2.
2. Done 2026-10-25 (see "Runs on 2026-10-25"): `Docker fixture writes
   annotation evidence inside the container, checks paths there, and removes
   it after settlement` (credential-free) and `Docker fixture live agent
   implements a note inside the container and its reported files are checked
   there` (live opt-in), both selected by `mise run test:agent:docker`. The
   evidence PNG is written as `node` under `/workspace/.orkestrator/annotations/`
   with the recorded digest; `check_container_workspace_paths` answers
   `exists`, `exists`, `missing` and `outside-workspace` (a symlink to
   `/etc/hostname`) from inside the container; the agent-reported files of a
   live Claude turn read `exists` / `missing`; and settled-evidence cleanup
   removed the file 226 s after settlement. The run found and fixed a cleanup
   bug (below).
3. Done 2026-10-25: `a sent request writes its evidence image into the local
   worktree under .orkestrator/annotations` (gateway spec, credential-free, in
   `test:agent:browser:isolated`). A staged real-Chromium PNG is written to
   `<worktree>/.orkestrator/annotations/<request>-<digest>.png` with the
   staged bytes' SHA-256 while the request is still held in `queued`, and is
   kept (not removed) after the request settles while its note exists.
4. Done (discuss 2026-10-24; needs-input 2026-10-25): `live agent request
   waits in needs-input on an approval, and one answer completes it` and `…
   on a clarifying question, …`. Both answer through
   `resolve_native_agent_interaction` with the request card's own answer,
   expect a second answer to be refused, and then require `awaiting-review`
   and `verify-change.ts`. The question case runs on providers with a
   question tool (Claude, Grok, OpenCode); the approval case skips Codex with
   the reason (its Ask policy does not gate workspace edits).
5. Done 2026-10-25: fixture routes `/motion` (an infinite CSS animation beside
   copy that never moves), `/fonts?delay=<ms>[&lazy=1]` (a web font the server
   answers late, then a 44 px layout shift; `lazy` starts it after the load
   event as a script font loader does), `/dialogs` (a target inside a
   `<dialog>` opened with `showModal()`, and a footer 2,400 px below the fold)
   and `/account` → 302 `/sign-in?next=%2Faccount` once
   `POST /__fixture/state {"sessionExpired": true}`. Covered by
   `tests/unit/annotation-fixture-app.test.ts`; exercised by the two new
   Electron cases below.
6. Done 2026-10-17: both flakes that touched these suites are resolved.
   [0204](../../tests/flaky-tests/previews-annotations-and-gateway/0204-web-annotation-quota-hook-timeout.md)
   (`web-annotation-quotas.test.ts` hook timeout) was resolved on `main` by
   #1042: the cause was a per-record fsync loop in the pre-SQLite storage,
   removed by #969.
   [0225](../../tests/flaky-tests/previews-annotations-and-gateway/0225-design-and-bench-aggregate-timeouts.md)
   (the `web-annotation-payloads.bench.test.ts` creation-cost bound) was
   resolved on this branch: the case now bounds actual SQLite writes per
   create, and median timings remain diagnostic.

### Qualification

- Done 2026-10-17 on macOS (see "Runs on 2026-10-17"): re-run
  `mise run test:agent:electron` and `mise run test:agent:browser:isolated` on
  current main and record them with the sign-off template below. Re-run again
  on 2026-10-25 with the new cases.
- Done 2026-10-18 (see "Runs on 2026-10-18"): the live implement test ran once
  for each provider in `AGENT_PLATFORMS`. Claude, Codex, Cursor and OpenCode
  passed; Grok and Pi were skipped for missing credentials, recorded with
  their reasons.
- Done 2026-10-24 on node mbp3 (see "Runs on 2026-10-24"): the live implement
  test passed for Grok and Pi (and again for the other four).
- **Open — remote backend on another host.** Connect the desktop to a backend
  on another host, capture, and confirm that `web_annotation_asset_stage` and
  materialization in the remote workspace both work. Not run: this worker had
  one machine (arktech-mini) and no second backend host. What the 2026-10-25
  runs do cover: every gateway case stages its PNG with
  `web_annotation_asset_stage` over the gateway's HTTP `/__orkestrator/invoke`,
  the same transport a desktop uses for a remote backend, and the backend then
  materializes it into a local worktree and a Docker workspace. What remains
  is a desktop process on one host capturing and staging into a backend on
  another (batched in 0031).
- Done 2026-10-25 on Claude (see "Runs on 2026-10-25"): approval across
  disruption, `web-annotations-approval-live.spec.ts` (opt-in
  `ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATION_DISRUPTION=1`; it restarts the
  profile, so it runs alone). Other providers are not run.
- Native window. Everything is done and permanent in the Electron spec, with
  the exceptions listed under "Not qualified" (2026-10-17) and below:
  - with the Notes column open, the preview bounds shrink;
  - menus, dialogs and focus rings are never covered;
  - create, send and resolve work by keyboard alone (create and send only;
    resolve needs a request in `awaiting-review`, which needs a live agent in
    the Electron spec — still open, see "Native focus and keyboard resolve");
  - the narrow (under 720 px) Preview/Notes switch works;
  - screenshot and highlight alignment holds at the zoom and DPR values
    above;
  - done 2026-10-25: pins and Show on page stay on the right target, or
    become explicit, for an offscreen target (matched, scrolled into view), a
    target inside a modal (matched while open; `hidden` and no pin once
    closed — fixed, below) and a layout shift from a late-loading font (on the
    shifted target, both while the font holds the load event and when a
    script loads it after load — fixed, below).
- Web and iOS review. Web done 2026-10-25: `a desktop capture is reviewable
  from the web client with capture shown as unavailable` (gateway browser
  client, Chromium and WebKit): the Notes column shows the "needs the
  Orkestrator desktop app" notice, the note and its saved image load from the
  backend, and Show on page is not offered. **Open — the iOS wrapper.** Not
  run: the wrapper accepts only an HTTPS tailnet origin plus the gateway token
  typed into its native form, and an agent must never handle the gateway
  token; plain-HTTP loopback profiles are refused by design. The WebKit run is
  the engine-level substitute; the wrapper run needs a person (or a
  tailnet-served profile and a token entered by hand) on a simulator or
  device.
- Done 2026-10-25: comparison cases. Matching route and viewport (no
  difference), a different route, a different viewport, an animated target
  and a loading font (`unstable`), an expired sign-in (`route` + `target`), and
  unavailable functional verification (a container path check that cannot
  answer is `unavailable`; a path outside the workspace is
  `outside-workspace`; `unavailable` is covered at unit level for a failed or
  malformed container check, `outside-workspace` on the real stack with a
  symlink).
- Done 2026-10-25: baselines recorded (below). No target is set yet.
- Sign-off: records for milestones A, B and C are below ("Sign-off records,
  2026-10-25"), written by a worker agent and awaiting human review; the
  client capability matrix in
  [web-page-annotations.md](../../architecture/web-page-annotations.md) now
  names what was actually tested.

Batch the remaining remote, iOS and native-focus runs with other todo files
through
[0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

### Found on 2026-10-17

- **Keychain prompt holds startup (medium). Done.** Agent-test profiles
  (including a shared `dev:test --profile codex-qa`) already start Electron
  with the mock keychain: `chromiumSwitchesForRuntime` returns
  `use-mock-keychain` for the `agent-test` flavour on macOS and `main.ts`
  applies it before `whenReady` (#1052, covered by
  `main-startup-switches.test.ts`; development and production keep the real
  keychain). Since 2026-10-25 the app also logs once if the safe-storage check
  has not settled after 5 s: "[Connections] Waiting for the macOS keychain
  (safe storage) before opening the first window; answer the keychain prompt
  to continue" (`connection-manager.ts`, three unit tests). It still awaits
  the check, so a late answer keeps persistent storage.
- **Native focus and keyboard resolve (medium, qualification). Open.** Qualify
  the preview's OS-level focus during selection, the `electron-main`
  Window-menu focus check, and "Accept and resolve" by keyboard on a host
  where the app can be frontmost and a live agent can bring a request to
  `awaiting-review`. Not run on 2026-10-25: arktech-mini is a shared desktop
  (as on 2026-10-17) and the Electron spec deliberately has no live provider
  (its Codex probe refuses launches).
- **Create cost grows with the collection (low). Located; moved to
  [0124](0124-web-annotation-commit-cost.md).** Every commit deep-copies the
  manifest (`structuredClone` in `commitManifest`) and re-serializes every
  index row to diff it (`planRows`); each is about half the cost at 1,900
  notes. The fix is a storage redesign, so it is new work in 0124. The bench
  case is renamed `SQLite writes per create stay bounded as the collection
  grows (no whole-history rewrite)`.

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

### Sign-off records, 2026-10-25

Written by a worker agent from the runs recorded in this file; each awaits a
human reviewer. "Implemented scope" is the shipped feature (#845 and later);
the remaining deferrals are the open items above.

```text
Milestone / PR / commit: A, core loop (capture, store, request, dispatch,
  review); main ba7cc8d4, branch todo-0044-annotation-qualification-55474f22f1aa
Implemented scope and remaining deferrals: capture without an agent tab,
  durable spool and recovery, request send and dispatch through the prompt
  queue, evidence materialization and cleanup, needs-input, review. Deferred:
  remote backend on another host; native OS focus and keyboard resolve
Platforms, providers, and client versions exercised: macOS 27.0 (arm64),
  Electron 44.7.0, Docker Desktop 29.9.2, Playwright Chromium and WebKit 27.2;
  live implement on all six providers (2026-10-18/24, Claude and Codex again
  2026-10-25); needs-input and disruption on Claude
Logged commands and results: "Runs on 2026-10-25" and earlier sections
Real workflow and inactive-environment evidence: an approval pending in one
  environment while the client switched to another, reloaded and lost its
  event stream; capture without an agent tab across reload and restart
Fault-injection boundaries exercised: graceful restart and backend SIGKILL
  with an approval pending (withdrawn, never applied); a second answer to an
  applied approval (stale); unit-level matrix unchanged
Capability matrix and known limitations: web-page-annotations.md, "Client
  capability matrix" and "Known limitations"
Migration and rollback verification: unit level only (web-annotation-
  migration*.test.ts, web-annotation-rollout.test.ts); not run on a real stack
Reviewer / date: Claude (worker agent), 2026-10-25; awaiting human review
```

```text
Milestone / PR / commit: B, targets and batches; same commit
Implemented scope and remaining deferrals: anchors, live pins, Show on page,
  hash/query identity, batch reservation. Deferred: shadow/iframe targets
  (0047)
Platforms, providers, and client versions exercised: macOS Electron (pins,
  Show on page); gateway Chromium (batches)
Logged commands and results: pins after reorder, hot reload, duplication,
  offscreen, modal open/closed, blocking and script-loaded late fonts, expired
  sign-in redirect; overlapping batches from two clients
Real workflow and inactive-environment evidence: batches held across reload
Fault-injection boundaries exercised: two clients racing a send (all-or-none)
Capability matrix and known limitations: pins resolve after a loading page's
  load event; hidden targets are reported, not shown
Migration and rollback verification: not applicable
Reviewer / date: Claude (worker agent), 2026-10-25; awaiting human review
```

```text
Milestone / PR / commit: C, results, modes and clients; same commit
Implemented scope and remaining deferrals: result captures and comparison
  labels, Discuss modes, web review, container file checks. Deferred: the
  iOS wrapper run; pixel differences (0047)
Platforms, providers, and client versions exercised: macOS Electron (result
  captures); gateway Chromium and WebKit 27.2 (web review); Docker container
  (file checks, live Claude report)
Logged commands and results: "Runs on 2026-10-25"
Real workflow and inactive-environment evidence: web review of a desktop
  capture with no capture available in that client
Fault-injection boundaries exercised: an unaddressable container path check
  is unavailable (unit); a symlink out of /workspace is outside-workspace
Capability matrix and known limitations: as milestone A
Migration and rollback verification: not run
Reviewer / date: Claude (worker agent), 2026-10-25; awaiting human review
```

### Runs on 2026-10-25 (macOS, arktech-mini)

macOS 27.0 (arm64), Xcode 27.1, Docker Desktop 29.9.2, Electron 44.7.0,
Playwright 1.64.0 (Chromium; WebKit 27.2), host load average about 45 on 18
cores throughout. One disposable profile, `qa-0044`
(`mise run docker:build:dev --profile qa-0044`, then `mise run dev:test
--profile qa-0044 --fixture --fixture-environments local,container`), stopped
and reset afterwards (`dev:reset`: 2 exact-owner containers, 4 volumes and 2
networks removed). The host Grok login had expired, so Grok was not seeded and
no Grok case ran. Every command ran through `mise run test:logged`.

| Command (abbreviated) | Result |
| --- | --- |
| `test:agent:docker -- web-annotations-gateway.spec.ts` | Pass (229 s). Evidence at `/workspace/.orkestrator/annotations/<request>-<digest>.png`, owner `node`, digest matches; container checks `exists,exists,missing,outside-workspace`; removed 226 s after settlement. The live case skipped without the opt-in |
| Same, live, `ORKESTRATOR_AGENT_TEST_ANNOTATION_AGENT=claude` | Pass (37 s): `awaiting-review`, `verify-change.ts` 8/8 inside the container, reported files `content.ts: exists`, `not-created.ts: missing` |
| `test:agent:browser -- … --grep 'evidence image into the local'` | Pass: file at `<worktree>/.orkestrator/annotations/<request>-<digest>.png` with the staged SHA-256 while `queued`; kept after settlement |
| `… --grep 'reviewable from the web'`, Chromium and `ORKESTRATOR_AGENT_TEST_BROWSER=webkit` | Pass both (WebKit 27.2): capture-unavailable notice, note body and saved image; no Show on page |
| `… --grep needs-input`, Claude | Approval: pass (335 s; `file-approval` after 15 s, card answer `applied`, second answer `stale`, `awaiting-review`, 8/8). Question: pass (`AskUserQuestion`, answered with the expected label, 8/8) |
| `… --grep needs-input`, Codex | Approval: the turn settled `awaiting-review` in 29 s without asking (now a skip with that reason). Question: skipped (no question tool in Default mode) |
| `web-annotations-approval-live.spec.ts`, Claude | Pass (118 s); table below |
| `… --grep "fixture's expected source change"`, Claude and Codex | Pass: `awaiting-review` after 25 s and 20 s, 8/8 each |
| `web-annotations-electron.spec.ts --grep 'late-font shift|comparison differences|baselines'` | Pass after the fixes below; the late-font case failed with the redraw fix reverted (negative control) |
| `mise run test:agent:browser:isolated` (final, own disposable profile) | Pass: 32 passed, 61 skipped (opt-in live, Docker and container cases), 0 failed (638 s); the four credential-free annotation gateway cases and the metrics baseline pass, the live and Docker cases skip as designed |
| `mise run test` (final) | Pass, all groups (1,459 s) |
| `mise run format:check`, `mise run lint`, `mise run typecheck` | Pass (lint warnings only, none in touched files) |
| Focused unit runs | `browser-preview-pins-live` + `browser-preview-show-on-page` pass; `web-annotation-quotas` passes, and fails with the cleanup fix reverted (negative control); `connection-manager` 85 passed; fixture app, `AnnotationThread`, `AnnotationPanel.flows` pass |
| `mise run test:agent:electron` (final) | 31 passed, 1 skipped (Linux-only Wayland), 3 failed (554 s). All 13 annotation cases pass. Failures: `remote nicknames …` (known flake 0515; also fails alone with this branch's desktop changes reverted), `windows on different backends …` (known flake 0622; passed alone), `a leaf's workspace opens in the window's central region …` (DOM focus under load; failed once and passed once alone, passed on the base; new flake [0840](../../tests/flaky-tests/electron-and-desktop/0840-workspace-realm-panel-dom-focus.md)) |

Approval across disruption (Claude, one approval each):

| Step | Request | Interaction | Source |
| --- | --- | --- | --- |
| Raised before the edit | `needs-input` | `file-approval` pending | unchanged |
| Client opened A, switched to B, reloaded, lost and regained its event stream | `needs-input` | same id pending | unchanged |
| Graceful restart | `running`, then `failed` (`turnOutcome: failed`) | absent (withdrawn with the bridge generation); answering it: `stale` | unchanged |
| New environment, approval pending, backend `SIGKILL`, restart | `running`, then `failed` | absent; answering it: `stale` | unchanged |

On Claude neither restart kept the approval alive, so the "answered once from
the card, refused from chat" branch ran only without a restart (the
needs-input case above). After a restart cut its turn, the first session
refused the next request ("The claude session failed before this prompt was
sent … Send a message to continue"), which is why the crash step uses a fresh
environment.

Native window (Electron, display scale 1):

| Check | Result |
| --- | --- |
| Offscreen footer | Pin `matched/stable-id` on the target; Show on page `shown`, scrolled into view |
| Target in an open `<dialog>` | `matched-correct` |
| Same dialog closed | Before the fix: `matched` with a 0×0 rect, Show on page `shown`, pin badge drawn at the page corner. After: no badge, Show on page `hidden` |
| Font holding the load event (`/fonts?delay=2500`) | Pins resolve after load, on the target after its 44 px shift |
| Font loaded by script after load (`&lazy=1`) | Pin drawn before the shift; before the fix it stayed at the old position, after it follows the 44 px shift |
| Expired sign-in (`/account` → `/sign-in`) | Show on page `navigation-required`, `navigated: true` |

Result-capture comparisons (one held implement request per note):

| After-capture | Stability | Differences | Target |
| --- | --- | --- | --- |
| Same route, static copy beside the animation | stable | none | same-target |
| The animated banner | unstable | target, unstable | different-target |
| Another route (`/settings`) | stable | route, target | different-target |
| Same target, preview 1000×700 | stable | viewport | same-target |
| Same target while the font loads | unstable | unstable | same-target |
| Same target once it settled | stable | none | same-target |
| Expired sign-in page | stable | route, target | different-target |

Baselines (no targets set; loaded host). Client, from the full Electron run's
`baselines` case (one local backend): selection → spooled capture median
146 ms, p90 219 ms, max 247 ms (17 captures); spool → backend commit (asset
stage + create) median 46 ms, p90 67 ms, max 98 ms (16). Backend
`command_ms` in that run (mean / max): create 2 / 3 ms, asset stage 5 / 22 ms,
result capture 3 / 4 ms, prepare 2 / 4 ms, send 47 / 55 ms. Backend
`web_annotations_metrics` after the Claude and Codex live implements:
`request_duration_ms` to `awaiting-review` mean 19.9 s, max 21.9 s (2);
`request_dispatch_ms` 4.7 s / 6.2 s; `request_enqueue_ms` 12 / 20 ms;
`command_ms` send 24 / 41 ms, prepare 12 / 13 ms, create 8 / 13 ms, asset
stage 11 / 17 ms, destinations 21 / 72 ms.

Findings (all fixed on this branch unless stated):

- **Settled evidence was never removed from a workspace (fixed).**
  Materialization writes `<request>-<digest>.png`, but cleanup removed the
  attachment's `relativePath` (`<digest>.png`, the brief's name), found it
  missing, marked the attachment `removedAt`, and left the real file forever;
  a user file at the brief's name with the same bytes would have been deleted
  instead. The unit test wrote its file at `relativePath`, so it never saw
  the difference. Both paths now use `materializedEvidencePath`; the test
  fake writes the real name, and a bystander file at the brief's name must
  survive. The Docker case confirms removal on the real stack.
- **A target in a closed dialog was "shown" (fixed).** Pins matched by
  identity drew a badge at the page corner for an element with no box, and
  Show on page reported `shown`. The pin layer now skips targets whose
  `checkVisibility()` is false, and Show on page returns `hidden`
  (`BrowserPreviewShowOnPageResult`), which the panel words as "on the page
  but hidden … open it, then try again".
- **A web font swap left pins behind (fixed).** The pin layer redrew only on
  scroll, resize and DOM mutations; a font swap reflows without any. It now
  also redraws on `document.fonts` `loadingdone`/`loadingerror` and on a
  `ResizeObserver` of the document, and the snapshot reports the drawn rect.
- **Main's page scripts wait for a loading page's load event** (behaviour,
  documented). `webContents.executeJavaScript` (and the capture world's
  equivalent) defer until load, so pins, captures and probes see the page
  after a load-blocking font has settled. The spec probes loading pages
  through `mainFrame.executeJavaScript`.
- **Codex's Ask policy does not gate workspace edits** (provider behaviour,
  documented as a known limitation).
- **A session cut short by a restart refuses the next request** until the
  user sends a message (documented; the card shows the reason).

### Runs on 2026-10-24 (macOS, node mbp3)

Live implement and discuss per provider, run while closing todo 0043 (retired
on 2026-10-29; see [web-page-annotations.md](../../architecture/web-page-annotations.md#known-limitations)).
It is not a milestone sign-off.

```text
Milestone / PR / commit: live implement and discuss per provider; branch
  todo-0043-annotation-limitations-8d52b6eaf37d on main 8454d18b8
Implemented scope and remaining deferrals: 0043 items 1-9; the spec now
  records each request's settled facts ([annotation-live] outcome)
Platforms, providers, and client versions exercised: macOS 26.6.2 (arm64),
  Docker 29.7.2, browser gateway client; host logins for claude, codex, cursor,
  grok, opencode and pi
Logged commands and results: table below
Real workflow and inactive-environment evidence: none new
Fault-injection boundaries exercised: a session switched from Plan to Build
  between preparation and Send (refused, mode left alone)
Capability matrix and known limitations: all six providers pass implement and
  discuss; Discuss is read-only on Claude and on Codex/Cursor/Grok sessions
  already in Plan
Migration and rollback verification: not run
Reviewer / date: Claude (worker agent), 2026-10-24; awaiting human review
```

One disposable profile, `qa-0043-live` (`mise run dev:test --profile
qa-0043-live --fixture`), stopped and reset afterwards. Each provider ran
`--grep 'live agent'` with `ORKESTRATOR_AGENT_TEST_ANNOTATION_AGENT=<agent>`
through `mise run test:logged`, as on 2026-10-18.

| Provider | Implement | Discuss | Discuss, session already in Plan |
| --- | --- | --- | --- |
| claude | Pass, outcome `completed` | Before the brief change 2 of 5 `completed`, 3 of 5 held on a pending plan approval; after it 5 of 5 `completed` in plan mode | not applicable |
| codex | Pass, `completed` | Pass, advisory | Pass: `plan-mode`, sent in Plan; refused after a switch to Build |
| cursor | Pass, `completed` | Pass, advisory | Pass, as Codex |
| grok | Pass, `completed` (first pass since 2026-10-15) | Pass, advisory | Pass, as Codex |
| opencode | Pass, `completed` | Pass, advisory | no modes |
| pi | Pass, `completed` (first pass ever) | Pass, advisory | no modes |

### Runs on 2026-10-18 (macOS)

Live implement test, once per provider. It is not a milestone sign-off.

```text
Milestone / PR / commit: live implement per provider; main a5d338c1, branch
  qualify-annotation-live-implement-0330a0bacc01 (spec and harness changes below)
Implemented scope and remaining deferrals: spec skips signed-out providers with
  the reason; Grok snapshots carry no refresh token; results.json is redacted
Platforms, providers, and client versions exercised: macOS 27.0 (arm64),
  Playwright 1.64.0, browser gateway client; claude 2.1.296, codex 0.162.1,
  opencode 1.19.0, @cursor/sdk 1.0.37, grok 1.0.52, pi 1.2.0 (all seeded from
  the host install at their pins)
Logged commands and results: tables below
Real workflow and inactive-environment evidence: none new
Fault-injection boundaries exercised: none new
Capability matrix and known limitations: Grok and Pi not qualified at this commit
Migration and rollback verification: not run
Reviewer / date: Claude (worker agent), 2026-10-18; awaiting human review
```

One disposable profile, `qa-annot-live-0330`, started with
`mise run dev:test --profile qa-annot-live-0330 --fixture` (every credential
source and platform, the defaults). Bridges were rebuilt first. Each provider
was run with:

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=qa-annot-live-0330 \
ORKESTRATOR_AGENT_TEST_RUN_ID=annot-live-<agent> \
ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATIONS=1 \
ORKESTRATOR_AGENT_TEST_ANNOTATION_AGENT=<agent> \
mise run test:logged -- --name annot-live-<agent> -- mise run test:agent:browser -- \
  e2e/agent-testing/web-annotations-gateway.spec.ts --grep 'live agent'
```

| Provider | Result |
| --- | --- |
| claude | Pass: `awaiting-review`, test 28 s, `verify-change.ts` 8/8 (unchanged spec at `a5d338c1`) |
| codex | Pass: `awaiting-review`, test 57 s, 8/8 (unchanged spec) |
| opencode | Pass: `awaiting-review`, test 47 s, 8/8 (unchanged spec) |
| cursor | Pass: `awaiting-review` after 100 s, 8/8. On 2026-10-15 Cursor had no credential; the host now has an Orkestrator Cursor key |
| grok | Skipped, no usable credential: "Grok Build isn't signed in. Run grok login in a terminal to keep working." The skip came 6 s into the test. A first attempt was dispatched and still running at 517 s when the profile was stopped from outside (the session that supervised it ended). That attempt spent the host's Grok refresh token (below), so Grok could not be re-run |
| pi | Skipped, no usable credential: "Pi has no signed-in model provider. Sign in with /login in a Pi terminal tab, or set the provider's API key." The host `~/.pi/agent/auth.json` has no providers. The skip came 8 s into the test |

Findings:

- **The profile spent the host's Grok refresh token (fixed in the harness).**
  The host access token had expired on 2026-10-16. Grok's log in the isolated
  home (`data/agent-credentials/home/.grok/logs/unified.jsonl`) shows the first
  profile start refreshing successfully with the copied refresh token
  (00:51Z, `oidc try_refresh_pure succeeded`). After a restart re-copied the
  host file, the refresh failed (01:14Z, `oidc try_refresh_pure terminal
  error`), and Grok `cleared credentials after permanent refresh failure`.
  The host file itself was never written (`~/.grok/auth.json` still dated
  2026-10-16 07:02), but it now holds a spent refresh token, so the host
  needs `grok login`. `seedAgentTestProviderCredentials` now publishes only
  `restrictGrokAuthSnapshot`'s output: refresh tokens blanked, expired or
  unparseable logins dropped. When nothing usable remains, the launcher warns
  ("Grok is signed out in this profile: …") and seeds nothing. Containers
  now get the same access-only copy (2026-10-21; see "Single-use refresh
  tokens" in
  [0018-container-network-and-credential-isolation.md](../containers-and-environments/0018-container-network-and-credential-isolation.md)).
- **`results.json` kept the gateway cookie (fixed).** Playwright's JSON
  reporter writes after global teardown, so the sanitizer never saw
  `results.json`. A request that failed when the backend went away left
  `orkestrator_gateway_auth=<value>` in its call log (the trace and
  `error-context.md` were redacted). A last reporter
  (`e2e/agent-testing/artifact-sanitizing-reporter.ts`) now sanitizes the
  tree in `onExit`, for the browser and coordinator configs. Checked with a
  throwaway failing probe: the header reads `[REDACTED]`. The affected local
  artifact was sanitized; the cookie's backend was already gone.
- **A signed-out provider used to hang the test for 14 minutes.** Its
  request stays `queued` with `blockedReason: "dispatch-rejected"` and the
  sign-in reason, which was not a state the poll waited for. The test now
  skips (sign-in) or fails (anything else) on the first poll that sees it.
  `isSignInError` (`apps/desktop/scripts/dev/coordinator-live.ts`) did not
  recognise "isn't signed in" (Claude and Grok) or "no signed-in model
  provider" (Pi), so the coordinator live suite would have counted those as
  failures too; both are matched now, with the bridges' exact messages under
  test.
- **Signed-out behaviour is safe.** Cursor (2026-10-15), Grok and Pi requests
  to a signed-out provider settle in `queued` with the sign-in reason within
  seconds, on the request card. Nothing ran, nothing was written outside the
  workspace, and nothing was lost.

Default decision: unchanged. Annotations stay enabled by default. The
evidence is four of six providers passing on current `main` and safe,
visible holds for the two without a login. None of the revisit triggers
appeared (duplicate execution, lost data, a write outside the workspace).

Validation of the change (commit `50c26708`):

| Command | Result |
| --- | --- |
| Live implement for claude, codex, opencode and cursor again on the final commit | All four pass: `awaiting-review` after 20, 35, 30 and 120 s, 8/8 each |
| `web-annotations-gateway.spec.ts` without the live opt-in | 2 passed, 1 skipped (the live case, as designed) |
| `profile-io.test.ts` and `lifecycle.test.ts`; `coordinator-live.test.ts` | 46 passed; 46 passed |
| Throwaway failing probe through the browser config | `results.json` call log shows `orkestrator_gateway_auth=[REDACTED]` |
| `mise run check`, e2e and desktop typechecks | Pass |
| `mise run test` | Codex protocol group passed; the other three failed only on load timeouts in files this change does not touch, each passing alone: known flakes 0165, 0178 and 0180 (0180 also failed once in three runs alone, as recorded), reopened 0093, and new flakes [0460](../../tests/flaky-tests/backend-services-and-tooling/0460-tab-teardown-hanging-delete-elapsed-bound.md) and [0461](../../tests/flaky-tests/coordinator-and-multi-review/0461-coordinator-fetch-remotes-submodule-timeout.md) |

The profile was stopped and reset afterwards (`dev:reset`: 0 containers,
disposable state removed). The host `~/.grok/auth.json` was never written.

### Runs on 2026-10-17 (macOS)

Sign-off for the two re-runs and the native-window check. It is not a
milestone sign-off: the live providers, Docker, remote, approval and iOS runs
above are still outstanding.

```text
Milestone / PR / commit: suites re-run and native window; main 31d0fb06, branch
  todo-annotation-suites-signoff-93fef49795eb (spec, harness and bench changes below)
Implemented scope and remaining deferrals: Electron spec gains the real Notes
  column, keyboard create/send, and zoom x DPR capture alignment (code item 1);
  flake 0225 resolved (0204 resolved on main by #1042); see "Not qualified"
Platforms, providers, and client versions exercised: macOS 27.0 (arm64), Electron
  44.7.0, Playwright 1.64.0; display scale factor 1 (DPR 2 forced); no provider
  turns (the send is held by a compose draft)
Logged commands and results: tables below
Real workflow and inactive-environment evidence: capture without an agent tab
  across renderer reload and app plus backend restart (Electron spec)
Fault-injection boundaries exercised: none new (unit level, unchanged)
Capability matrix and known limitations: unchanged; see "Not qualified"
Migration and rollback verification: not run
Reviewer / date: Claude (worker agent), 2026-10-17; awaiting human review
```

The tables below are the first run, before the Multi Review. "Review
follow-up" at the end of this section records what the review changed and its
final results.

| Command | Result |
| --- | --- |
| `mise run test:agent:electron`, unchanged `main` | 2 passed, 3 failed, 1 skipped, 6 did not run (716 s). Every failure is Electron never opening a window (`firstWindow` timed out at 90 s, or the test at 120 s): the keychain hang below |
| `mise run test:agent:electron`, with the fixes | 13 passed, 1 failed, 1 skipped (110 s). All 10 annotation tests pass, including the three new ones. The failure is `electron-main` "shares one backend across independent windows" (below). The skip is the Linux-only Wayland case |
| `electron-main.spec.ts --grep 'independent windows'`, alone, twice | Failed both times at the Window-menu native-focus check (`isFocused()` false after 5 s), the same macOS failure as on 2026-10-15. In the full run it failed earlier, once, on an empty second-window title |
| `mise run test:agent:browser:isolated` | Pass: 26 passed, 14 skipped (opt-in live, Docker and container cases), 0 failed (423 s). Both annotation gateway batch tests passed; the live implement test skipped as designed |
| `web-annotation-payloads.bench.test.ts`, alone | 6 passed (0.8 s) |
| All 22 `web-annotation*.test.ts` files, `--parallel=2`, four times | 265 passed each time |
| `mise run lint`, `mise run typecheck`, `mise run format:check` | Pass (lint warnings only, all in files this change does not touch) |
| `mise run test`, twice | Workspace, bridge and protocol groups passed both times. The root group failed once each time, on causes unrelated to this change: first on `flaky-tests-index.test.ts`, because the 0265 case file on `main` had no ID or Status line (fixed here); then on known flake 0178 (`pi-bridge-vendor.test.ts`, 30 s timeout), whose file passed alone (4 passed, 14 s) |

What the new native-window tests measured (this host, display scale factor 1):

| Check | Result |
| --- | --- |
| Notes closed, app zoom 1 | View 1059 x 798 DIP on a 1058.9 x 798 host |
| Notes open, app zoom 1, 0.8, 1.25 | View on its host each time, no overlap with the column, its resize handle, or the focus ring of Add note (at 0.8 the rounded view edge reaches 0.19 DIP into the handle) |
| App zoom 1.5, 1440-DIP window | Layout turns narrow (960 CSS px); Preview lands on its host |
| Menu ("Connected server") and dialog ("New connection") open | View hidden; it comes back on its host after Escape |
| Narrow switch (900 px window) | Notes hides the view; Preview shows it on its host (619 x 709); the wide layout returns at 1440 px |
| Close annotations | Focus returns to the Notes button; the view regains its full width |
| Keyboard create and send | Add note (Enter), Enter in the page selects the focused Save button, focus returns to the editor textarea, Save note (Enter), Discuss…, Space on the codex session, Discuss with…, Send: the request is `discuss:queued` |
| Capture alignment, preview zoom 0.8 / 1 / 1.5 at DPR 1 | Highlight box equals the target times the image scale (0.8 / 1 / 1.5) to the pixel; the marker sits inside the 2 CSS px highlight border |
| The same at DPR 2 (forced) | Images reduced to the 2,000 px bound (scale 1.25 / 1.5625 / 2.34); highlight within 1 px of the target times the scale |

Findings:

- **Keychain hang (fixed in the harness).** `safeStorage` keeps its key in the
  login keychain item "<app name> Safe Storage", and the app name is the
  profile's `electronTitle`. The Electron specs use fixed profile ids
  (`annotation-smoke`, `electron-smoke`, `electron-resume`), so every worktree
  shares one item per spec, and the item's access list names the Electron
  binary that created it. Electron from any other worktree then waits on an
  access prompt that nobody answers. Main awaits
  `safeStorage.isAsyncEncryptionAvailable()` in `ConnectionManager.initialize`
  (`apps/desktop/electron/connection-manager.ts:731`, called from
  `main.ts:746`) before it creates the first window, so startup hangs with no
  window and no error. A bare Electron probe reproduced it: the call never
  returned (25 s timeout) under the name "Orkestrator AI — DEV
  [annotation-smoke]", while it took 7 ms under "[electron-resume]" and 13 ms
  under a fresh name. With `--use-mock-keychain` it took 4 ms and an
  encrypt/decrypt round trip worked. Every Electron spec now launches with that
  switch on macOS (`e2e/agent-testing/electron-launch-switches.ts`). This also
  clears the 2026-10-15 `safeStorage.encryptStringAsync` failure: the
  remote-nickname test passed.
- **Native OS focus is not observable on a shared desktop.** Even after
  `app.focus({ steal: true })` the window was never key
  (`window-focused false`), because other applications kept the foreground.
  The keyboard test therefore checks focus inside the app (the renderer
  focuses the editor once main hands back), and checks the preview's OS-level
  `isFocused()` only when the window is key. The `electron-main`
  Window-menu failure has the same cause. Both are environment limits, not
  product bugs: a user who clicks the Window menu has already brought the app
  forward.
- **Input events take DIPs.** `webContents.sendInputEvent` coordinates are view
  DIPs, not CSS px, so at preview zoom 0.8 a click at the CSS centre landed on
  another element. The spec now scales click points by the preview zoom. This
  was a test bug only; capture was correct.
- **The capture keeps the selection highlight on purpose** (`prepare()` in
  `browser-preview-annotation-script.ts`). The alignment check uses the
  highlight's border box as the target and expects the marker inside the
  2 CSS px border.
- **Creating a note costs time proportional to the collection** (median 0.34 ms
  empty, 1.34 ms at 500 notes, 2.84 ms at 1,000, 4.11 ms at 1,900). That is
  linear, not quadratic. The bench's 2 s floor hides it, and the case name
  ("creation cost stays flat") overstates it. Recorded as a low follow-up.

Decisions (made without the user, to be validated):

1. Fix the startup hang in the test harness (`--use-mock-keychain`), not in
   the app. A per-run or per-worktree profile id would add a keychain item per
   run or per worktree. Bounding the app's check with a timeout would change
   production behaviour: a user who answers the prompt late would get
   session-only tokens. Follow-up below.
2. Extend `web-annotations-electron.spec.ts` in place, sharing its stack,
   rather than adding a new spec file. That costs one Electron launch (plus
   one for each forced DPR) instead of a second stack, and keeps it inside
   `test:agent:electron`.
3. For DPR, run the display's own scale factor and then forced DPR 1 and
   forced DPR 2 (`--force-device-scale-factor`), relaunching without the
   switch at the end. The first version forced only the missing value; the
   review made both forced runs unconditional, so every host runs the same
   branches, at the cost of one more launch.
4. Check the app zoom at 0.8, 1 and 1.25 for wide bounds, and treat 1.5 as the
   narrow case, because a 1440-DIP window is under 720 CSS px of container
   there. Preview zoom 0.8, 1 and 1.5 are all checked for capture alignment.
5. Tolerate less than one DIP of overlap between the view and its neighbours.
   Main rounds bounds to whole DIPs (`validateBounds`), so a fractional
   neighbour edge cannot be met exactly. Snapping inward (`ceil` the left
   edge, `floor` the right) would guarantee no overlap but leave up to one DIP
   uncovered; it was not worth a production change.
6. "Keyboard alone" means controls are reached with real Tab and Shift+Tab
   presses and activated with Enter or Space, never clicked. The first version
   used Playwright's `focus()` in place of Tab; the review replaced it.
   Resolve is not covered: it needs a request in `awaiting-review`.
7. Flake 0225: bound the SQLite rows and bytes each create writes, rather than
   raise the time bound. The first version compared median create times, but
   its 33 ms floor could hide a whole-history rewrite, so the review replaced
   it. Flake 0204 was resolved on `main` (#1042) while this branch was open.
8. Window menu: when `getFocusedWindow()` returns a window that is not
   natively focused (a DevTools-focused owner on a shared macOS desktop), the
   explicit Window-menu selection wins (`window-menu.ts`, with a unit test).
   The `electron-main` test still requires the selected label, and checks OS
   focus only when the app owns a key window. This was added in the review.

Not qualified on this run:

- OS-level native focus of the preview and of the Window-menu target (the
  window was never key on this shared desktop).
- Resolve by keyboard in the native window (needs a live agent turn).
- A real DPR 2 display (DPR 2 was forced; the display here is scale factor 1).
- Linux, Windows, the live providers, Docker, remote backend, approvals across
  disruption, web and iOS review, and the comparison fixtures (unchanged from
  the list above).

#### Review follow-up (2026-10-17)

The Electron keyboard case now reaches renderer controls with Tab and checks
Shift+Tab backtracking. Native page keys reach the selected element without
assigning DOM focus to it. Its Discuss receipt is cancelled and checked absent
from the prompt queue before the compose-draft hold is removed; a failed or
ambiguous cleanup retains the hold until profile disposal. A profile-local
Codex executable probe refuses and records accidental `app-server`/`exec`
launches through cleanup and subsequent profile relaunches.

Capture qualification now uses an 800-DIP fixed preview and the actual Notes
layout (with nonzero view offsets), checking all three preview zooms in both.
The smaller view keeps DPR 2 images under the reduction bound, so native image
scale is asserted unconditionally. Natural capture plus forced DPR 1 and forced
DPR 2 run on every host, removing the old host-dependent forced-DPR branch.
A physical Retina display still requires separate hardware qualification.

The creation benchmark now gates on SQLite row writes and bytes per create,
including document-envelope updates; the former 33.33 ms timing floor could
hide a rewrite. See the correction in flake 0225.

The Window-menu focus resolver also ignores a `getFocusedWindow()` candidate
whose host is not key: Electron can return a DevTools-focused owner while
another app owns native focus. The recorded explicit menu selection is then
authoritative. A unit regression verifies the selected label in that state;
the Electron test continues to require that label and gates only the OS-focus
predicate on actual native focus availability. Initial Home reload flake
[0272](../../tests/flaky-tests/previews-annotations-and-gateway/0272-annotation-home-reload-native-view.md) is
recorded separately; its owning spec passed unchanged on rerun.

Follow-up validation on `annotation-native-window-signoff`:

- `mise run test:logged -- --name agent-electron-final -- mise run test:agent:electron`
  with `ORKESTRATOR_AGENT_TEST_RUN_ID=review-final`: **14 passed, 1 skipped**
  (the Linux-only Wayland case), 80.4 seconds. All ten annotation cases passed,
  including the selected-element identity after keyboard capture. The Codex
  probe recorded no launch during cleanup, later tests or relaunches.
- All 12 forced-DPR/layout/zoom combinations kept unreduced images; reported
  scales matched DPR × preview zoom (DPR 2: 1.6, 2, 3, within pixel rounding).
- Window-menu unit tests, all six payload benchmarks, format, lint and full
  typecheck passed. The negative rewrite control failed as expected.
- Artifacts: `output/agent-testing/review-final/electron/results.json`; all
  temporary profiles and supervised processes were stopped and removed by
  the suite. Native foreground focus and physical Retina hardware remain
  outside this shared-desktop run. Browser, Docker, CLI and iOS scenario suites
  were omitted because those product paths were unchanged.

- Full non-iOS validation: `mise run test:logged -- --name review-full-suite -- mise run test`
  **passed**, 728.4 seconds including a 234-second workspace capacity wait.
  Workspace, root/agent-support, bridge and protocol groups all passed.

After merging `origin/main` (#1042, #1045) into the branch:

- `mise run test:agent:electron`: 14 passed, 1 skipped (Linux-only Wayland
  case), 0 failed (83 s).
- `window-menu.test.ts` 12 passed; the payload bench and quota files 21 passed;
  `mise run lint`, `mise run typecheck` and `mise run format:check` passed.
- `mise run test`: root, bridge and protocol groups passed. The workspace group
  failed once, on known flake 0187 (`commands-integration.test.ts`, 5 s
  timeout), and that file passed alone (55 passed, 19 s).

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
  (Fixed 2026-10-18: it prints a progress line each minute.)
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
  profiles ([agent-testing.md](../../development/agent-testing.md)). Screenshots
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
  data or a write outside the workspace. Rechecked 2026-10-18 at `a5d338c1`:
  Claude, Codex, Cursor and OpenCode pass; Grok and Pi had no login and held
  safely in `queued` with the reason; no trigger appeared.
- Rollback must stop new operations while keeping reads, spool recovery and
  reconciliation of requests already sent. `web-annotation-rollout.ts` already
  behaves this way; any rollout test must keep it.
- Initial-release targets from the plan: no duplicate execution under fault
  injection, deterministic recovery at every acknowledged boundary, and
  visible catch-up on an active client within two reconciliation intervals
  (`WEB_ANNOTATION_LIMITS.reconcileIntervalMs`) once transport and storage
  recover. Latency and memory targets come from measurements, not from an
  assumed SLA.

## Assumptions and decisions

Made on 2026-10-25 without the user, to be validated.

1. **Fix the evidence-cleanup path in the backend, not only in the test.**
   Options: (a) store the written name in the attachment's `relativePath` at
   materialization; (b) derive the written name in one helper
   (`materializedEvidencePath`) used by the writer and by cleanup; (c) record
   the bug and change only the test. Chose (b): the naming has been
   `<request>-<digest>.png` since #845, so the helper is right for every
   existing record, and the frozen request (whose `relativePath` the brief and
   publication use) stays untouched. Pros: no record migration, one source of
   truth. Cons: cleanup depends on the writer's naming rule staying in that
   helper; files written before this fix are removed only by the next GC pass
   after their notes are deleted or 7 days pass, and attachments already
   marked `removedAt` by the old code are not revisited (their files remain;
   they are inert PNGs in `.orkestrator/annotations/`).
2. **Report a hidden target as a new `hidden` outcome.** Options: keep `shown`;
   map it to `not-found` (whose message says "reselect", wrong here); add
   `hidden` to `BrowserPreviewShowOnPageResult`. Chose `hidden`. Pros: an
   explicit, accurate message; no false claim of success. Cons: a protocol
   union grows (renderer and desktop ship together; a web client never calls
   Show on page). "Hidden" means a matched rect with no width and height,
   so a genuinely zero-size visible element also reads as hidden, which is
   still accurate (nothing to show). The pin layer uses `checkVisibility()`
   where available.
3. **Redraw pins on font loads and document resizes, not on attribute
   mutations.** Options: add `attributes: true` to the MutationObserver; a
   `ResizeObserver` per target; font events plus a `ResizeObserver` on the
   document. Chose the last: it catches a font swap (no DOM change at all)
   and most reflows at one redraw per frame, without re-resolving anchors or
   spending the pass allowance. Cons: a target that moves without changing
   the document's size and without a font load (a sibling's transform, say)
   still waits for the next scroll, resize or mutation.
4. **The late font is simulated.** Options: commit a font binary to the
   fixture; generate one; serve a delayed response (a 404) and apply the
   font's larger metrics when the load settles. Chose the delayed response.
   Pros: no binary in the repository, deterministic shift, and
   `document.fonts.ready` pends exactly as for a real font. Cons: no glyphs
   are swapped; only the layout effect is real. A unique URL per load avoids
   Chromium reusing the failed font.
5. **Docker evidence on the existing fixture container.** Options: create a
   container environment per test; reuse `fixture-container`. Chose reuse, as
   the other Docker fixture cases do, restoring its pane layout afterwards.
   Cleanup is waited for (up to 7 minutes) rather than adding a test-only GC
   switch to the product. Cons: the case takes about 4 minutes.
6. **Result file checks through the real command and a live agent.** The
   credential-free case calls `check_container_workspace_paths` over the
   gateway; the live case asks the agent to report two named paths so
   `report_annotation_result` produces `exists` and `missing`. The note body
   is contrived for that purpose.
7. **Needs-input answered at the API the request card uses.** Options: drive
   the card in a browser; call `resolve_native_agent_interaction` with the
   card's own resolution. Chose the API (the card's code path, see
   `RequestInteractions.tsx`), which is deterministic and lets the test send
   the same answer twice. Cons: the card's rendering is not exercised here
   (component tests cover it).
8. **Codex approval case skips with its reason.** Codex under Ask applied the
   edit without asking. Options: force an approval with Codex's `untrusted`
   approval mode; skip. Chose skip: forcing a mode the user did not choose is
   not what an annotation request does. Recorded as a known limitation.
9. **Disruption on a fresh environment for the crash step.** After a restart
   cut its turn, the first session refuses new requests until the user
   writes in chat; reusing it would test that refusal, not the crash.
10. **iOS: WebKit as the engine-level substitute; the wrapper stays open.** The
    wrapper needs the gateway token typed in, which agents must not handle.
11. **Remote backend stays open.** One machine was available; running a
    second backend on the same host would not test another host.
12. **Create cost moved to new file 0124.** The fix is a storage redesign, so
    per the todo rules it is new work; this file records where the cost is.
13. **Keychain: no launcher change.** The `dev:test` launcher already gets the
    mock keychain from the runtime profile (#1052). Added only the pending-
    keychain log line, keeping the await so a late answer still gets
    persistent storage.
14. **Rating unchanged (Medium).** What remains is a second-host run, the iOS
    wrapper and native focus: qualification of secondary platforms of a
    feature on by default, with its main gates now signed off.

## Open questions

- Is macOS (the primary development host) required as well as Linux for the
  native-window gate?
- Is the remote-backend run in scope now, or a deferral recorded in the
  matrix?
- Do the unit-level fault and race tests count for gate A, or does gate A need
  real-stack runs of the acceptance race and migration restart too?
- Does the WebKit run of the web review case count for the iOS gate, or must
  the `WKWebView` wrapper itself be run by a person with the gateway token?

## Needs verification

- Whether the 2026-09-25 runs still pass after #969 and #983. The Electron
  and isolated browser suites do (2026-10-17 and 2026-10-25, macOS); the bench
  and full suite were re-run too. Linux was not re-run.
- Whether the gateway spec's synthetic capture still matches what the Electron
  capture path produces. Since 2026-10-25 it carries a real staged PNG and
  geometry image; target and evidence fields remain synthetic.
- The baselines were taken on a host at load ~45; repeat them on a quiet host
  before setting targets.

## Related

- [0047-web-annotation-extensions.md](0047-web-annotation-extensions.md),
  [0124-web-annotation-commit-cost.md](0124-web-annotation-commit-cost.md).
- [0042-service-preview-rollout.md](0042-service-preview-rollout.md): the native-window
  run uses the same Electron harness, and annotations run inside service tabs.
- [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md)
  for Docker fixtures.
- [web-page-annotations.md](../../architecture/web-page-annotations.md),
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
