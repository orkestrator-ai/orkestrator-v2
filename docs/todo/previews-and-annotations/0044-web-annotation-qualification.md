# Web annotation qualification

Checked against `main` at `a5d338c1` (2026-10-18).

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

1. Done 2026-10-17 (see "Runs on 2026-10-17"): Electron spec additions that
   open the real Notes column and assert the native view's bounds against it,
   plus a capture-alignment case at preview zoom 0.8, 1 and 1.5, and at DPR 1
   and 2.
2. A Docker annotation case whose title contains `Docker fixture`, so
   `mise run test:agent:docker` selects it. Assert that
   `.orkestrator/annotations/<request>-<digest>.png` is written inside the
   container, that settled-request cleanup removes it, and that result file
   checks report `unavailable` (until the container check in
   [0043-web-annotation-known-limitations.md](0043-web-annotation-known-limitations.md)
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
6. Done 2026-10-17: both flakes that touched these suites are resolved.
   [0204](../../tests/flaky-tests/0204-web-annotation-quota-hook-timeout.md)
   (`web-annotation-quotas.test.ts` hook timeout) was resolved on `main` by
   #1042: the cause was a per-record fsync loop in the pre-SQLite storage,
   removed by #969.
   [0225](../../tests/flaky-tests/0225-design-and-bench-aggregate-timeouts.md)
   (the `web-annotation-payloads.bench.test.ts` creation-cost bound) was
   resolved on this branch: the case now bounds actual SQLite writes per
   create, and median timings remain diagnostic.

### Qualification

- Done 2026-10-17 on macOS (see "Runs on 2026-10-17"): re-run
  `mise run test:agent:electron` and `mise run test:agent:browser:isolated` on
  current main and record them with the sign-off template below.
- Done 2026-10-18 (see "Runs on 2026-10-18"): the live implement test ran once
  for each provider in `AGENT_PLATFORMS`. Claude, Codex, Cursor and OpenCode
  passed; Grok and Pi were skipped for missing credentials, recorded with
  their reasons.
- Re-run the live implement test for Grok and Pi once the host has a usable
  login for each (Grok: `grok login` on the host; Pi: a provider in
  `~/.pi/agent/auth.json`). A skipped provider is not a passing one. Grok last
  passed on 2026-10-15 (437 s); Pi has never run.
- Remote backend: connect the desktop to a backend on another host, capture,
  and confirm that `web_annotation_asset_stage` and materialization in the
  remote workspace both work.
- Approval across disruption: start a request whose turn raises an approval.
  Switch environments, reload the renderer, drop SSE and restart the backend,
  then answer from the request card and from chat. No approval may be applied
  twice, and an approval from a dead generation must be withdrawn, never
  applied implicitly.
- Native window. Everything but the last bullet is done and permanent in the
  Electron spec (2026-10-17, macOS), with the exceptions listed under "Not
  qualified" there:
  - with the Notes column open, the preview bounds shrink;
  - menus, dialogs and focus rings are never covered;
  - create, send and resolve work by keyboard alone (create and send only;
    resolve needs a request in `awaiting-review`, which needs a live agent);
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
  [web-page-annotations.md](../../architecture/web-page-annotations.md) with the
  providers and clients actually tested.

Batch the provider, Docker, remote, macOS and iOS runs with other todo files
through
[0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

### Found on 2026-10-17

- **Keychain prompt holds startup (medium).** The Electron specs no longer
  touch the host keychain, but two other paths still can. A `dev:test` profile
  whose name another worktree used first (a shared `--profile codex-qa`, for
  example) waits on the same unanswered prompt. And the desktop app itself
  awaits `isAsyncEncryptionAvailable()` before its first window
  (`connection-manager.ts:731`), with no log line while it waits. Options:
  pass `--use-mock-keychain` for `agent-test` launches from
  `apps/desktop/scripts/dev/`; or start the check without awaiting it, create
  the window, and resolve credential storage when a remote connection first
  needs it; or log after a few seconds that a keychain prompt is pending.
- **Native focus and keyboard resolve (medium, qualification).** Qualify the
  preview's OS-level focus during selection, the `electron-main` Window-menu
  focus check, and "Accept and resolve" by keyboard on a host where the app
  can be frontmost and a live agent can bring a request to `awaiting-review`.
- **Create cost grows with the collection (low).** A create costs about
  4 ms at 1,900 notes against 0.3 ms empty, linear in the collection. Find what
  each create reads or writes in proportion to the collection (not located
  yet) before collections near the 2,000-note cap are common, and rename the
  bench case, which claims the cost "stays flat".

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
| `mise run test` | Codex protocol group passed; the other three failed only on load timeouts in files this change does not touch, each passing alone: known flakes 0165, 0178 and 0180 (0180 also failed once in three runs alone, as recorded), reopened 0093, and new flakes [0460](../../tests/flaky-tests/0460-tab-teardown-hanging-delete-elapsed-bound.md) and [0461](../../tests/flaky-tests/0461-coordinator-fetch-remotes-submodule-timeout.md) |

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
[0272](../../tests/flaky-tests/0272-annotation-home-reload-native-view.md) is
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

## Open questions

- Is macOS (the primary development host) required as well as Linux for the
  native-window gate?
- Is the remote-backend run in scope now, or a deferral recorded in the
  matrix?
- Do the unit-level fault and race tests count for gate A, or does gate A need
  real-stack runs of the acceptance race and migration restart too?

## Needs verification

- Whether the 2026-09-25 runs still pass after #969 and #983. The Electron
  and isolated browser suites do (2026-10-17, macOS); the bench and full
  suite were re-run too. Linux was not re-run.
- Whether the gateway spec's synthetic capture still matches what the Electron
  capture path produces.

## Related

- [0043-web-annotation-known-limitations.md](0043-web-annotation-known-limitations.md),
  [0047-web-annotation-extensions.md](0047-web-annotation-extensions.md).
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
