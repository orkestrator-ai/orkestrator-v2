# Design canvas qualification

Checked against `main` at `2459b05c` (2026-10-15); the flake review against
`9906db30` (2026-10-16); the live agent cycle against `a5d338c1`
(2026-10-18) and its Claude rerun against `9b3f53a2` (2026-10-21); container
export, Electron, accessibility and client performance against `b83ae534`
(2026-10-22, see [Qualification evidence](#qualification-evidence-2026-10-22)).

The design canvas ([`design-canvas.md`](../../architecture/design-canvas.md)) is
complete in code: recoverable operations, safe export, history, incremental
sync, visible-frame culling, the saved-designs library and agent context all
shipped with owning tests (#844, then #926, #928, #969 and #988). What it lacks
is evidence from real agents, real containers, an Electron window, assistive
technology and the client side under load. This file tracks that evidence and
the optimisations that were deliberately deferred until it exists, so that
nobody builds them speculatively.

## Current state

- Real-stack suite: `mise run test:agent:design:isolated` runs
  `apps/desktop/scripts/test-agent-browser-isolated.ts --design` against
  `e2e/agent-testing/design-canvas.spec.ts` on a disposable profile. The spec
  has two tests: "real gateway saves a design and rehydrates another client's
  edits" and "private canvases survive reload and can be retired to recover
  quota". It drives the backend through the `design_action` gateway command and
  the UI, never through an agent.
- The task passed on `7081ae8c` (2026-09-24). The Electron dev-startup failure
  that had blocked it was fixed by #840. On 2026-10-15, after the `AppShell`
  breakpoint fix that resolved flake 0209, both tests passed on a fresh profile
  and again inside a full `mise run test:agent:browser:isolated` run.
- Live agents: `e2e/agent-testing/design-live.spec.ts` (opt-in,
  `ORKESTRATOR_AGENT_TEST_LIVE_DESIGN=1`; see
  [`agent-testing.md`](../../development/agent-testing.md#live-design-tool-cycle))
  runs one fixture-scoped cycle per provider through the real app: launch with
  create, inspect, refine, capture and `save_canvas`; **Ask agent** against a
  stale selection; an approval pending across an environment switch; and an
  unsent implementation handoff. Codex passed it on 2026-10-18 (see
  [Live cycle evidence](#live-cycle-evidence-2026-10-18)); Claude passed the
  launch cycle then and the whole cycle on 2026-10-21, twice (see
  [Claude rerun](#live-cycle-evidence-claude-rerun-2026-10-21)).
- Component browser spec `e2e/DesignCanvas.spec.ts` runs the real runtime at
  desktop and phone widths. Because `DesignService` loads `bun:sqlite` since
  #969, the spec drives it in a Bun child process (`e2e/design-service-host.ts`,
  #988).
- Container export: besides the helper-level tests in
  `apps/backend/src/core/design/export-writer.test.ts`, the opt-in
  `apps/backend/src/core/design/export-container.test.ts`
  (`ORKESTRATOR_TEST_DOCKER_DESIGN_IMAGE`; see
  [`testing-guide.md`](../../development/testing-guide.md#opt-in-design-checks))
  exports from a running container of the environment image through real
  `docker exec` and interrupts it. It passed on 2026-10-22 on Docker Desktop
  (macOS arm64). The container is started directly, not by Orkestrator's
  container lifecycle.
- Electron: `e2e/agent-testing/design-canvas-electron.spec.ts`, part of
  `mise run test:agent:electron`, opens, edits, exports, downloads, imports a
  host file and drives the keyboard shortcuts in the real window.
- Accessibility: `e2e/DesignCanvasAccessibility.spec.ts` (component browser
  suite) runs a keyboard-only journey, checks focus survival, accessibility
  tree structure, reduced motion, 200% zoom and narrow panes. Its header
  records the observations. It is not a screen-reader pass.
- Client performance: `e2e/perf/design-canvas-perf.ts` (real Chrome, not part
  of any suite) measures gestures, panning, culling, iframe churn, memory,
  leak cycles and library open time. Culling is also unit-tested
  (`planLiveFrames` in `apps/web/src/components/design/design-visibility.ts`,
  tested in `design-viewport.test.ts`); `scripts/benchmark-design.ts`
  measures the backend side.
- Mixed-version fallback and migration are unit-tested
  (`design-controller.test.ts`, `records.test.ts`); no run used real old and
  new binaries.

## Outstanding work

### Qualification

Live-agent and platform runs share prerequisites and batching with other todo
files; see [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

- **Opening prompt of a new design tab needs the tab mounted.** The agent tab
  of **New design workspace** sends its brief from the mounted tab
  (`AgentNativeTab.controller.tsx`, `initialPrompt`) once its projection loads.
  Switching environment before that defers the first turn until the user
  returns; nothing is lost, but the agent sits idle. Only the environment's
  `startup-agent` tab has a backend-owned startup prompt. Give tabs created
  with an initial prompt a backend-owned dispatch (the same request id
  `initial-prompt:<environment>:<tab>` keeps it at most once), with an
  inactive-environment test. This applies to every tab created with an
  initial prompt, not only design.
  - Evidence (2026-10-22): `mise run test:agent:design:isolated` failed the
    same way three times at line 220 of `design-canvas.spec.ts` ("Mock up the
    sidebar" never visible), once with this branch's product files reverted to
    `b83ae534`. The new Codex tab showed "Ready to build!" with a disabled
    composer and **Resume Session**, and no brief. The private-canvas case
    passed every time. The owning file fails alone, so this is a failing
    case, not a flake.
- **Real-container export.** Done on 2026-10-22 for the export protocol
  against a running container of the environment image on Docker Desktop
  (macOS arm64): every interruption the item named reconciled by exact
  digest, and reconciliation never started a second writer (see
  [Container export](#container-export)). Local export was already covered by
  `exports.test.ts` and `export-writer.test.ts`. Still open:
  - the same run against a container Orkestrator created (its
    network-policy entrypoint, workspace setup and the `ContainerService`
    lifecycle), for example as a case in the Docker agent fixture
    (`mise run test:agent:docker`);
  - Docker Engine on Linux, batched with
    [0019](../containers-and-environments/0019-container-platform-qualification.md).
  Describe container export as qualified on Docker Desktop for macOS only.
- **Electron window.** Done on 2026-10-22 through
  `e2e/agent-testing/design-canvas-electron.spec.ts` (see
  [Electron](#electron)). Not covered: native menu key equivalents (Playwright
  delivers keys through Chromium, not the OS), the native Save dialog of a
  download (the spec sets the save path in `will-download`), and the packaged
  `file://` renderer.
- **Manual accessibility.** The automated part is done (see
  [Accessibility](#accessibility)): the keyboard-only journey, focus survival
  across acknowledgment, drawers, culling and errors, reduced motion, 200%
  zoom and narrow panes, with observations in the header of
  `e2e/DesignCanvasAccessibility.spec.ts`. The nine focus, announcement and
  layer-loading defects it found were fixed. Still open: a human pass with
  VoiceOver and NVDA over the layer tree, frame list, inspector and both
  status regions
  (verbosity, live-region timing during nudge bursts, `aria-description` on
  frame titles, Preview-mode frames, rotor and browse-mode navigation). The
  400% zoom layout defect and the other findings are in
  [0054-design-canvas-accessibility-findings.md](0054-design-canvas-accessibility-findings.md).
- **Large-canvas client performance.** Done on 2026-10-22 on one host and
  build, including a 100-cycle leak check on the committed fixes that
  converged at every size (see [Client performance](#client-performance)).
  Other hosts (Linux, a slower laptop) and the Electron renderer are not
  measured; the numbers are host evidence, not thresholds.
- **Mixed versions and migration on real binaries.** Old client with new
  backend and the reverse. Migrate a copied legacy `.orkdes` fixture, and check
  the explicit downgrade path (export before running an older backend). Cover
  a migrated record, an interrupted migration, a future record version and a
  corrupted record with an older backup. Not attempted on 2026-10-22: it
  needs real old desktop and backend binaries, which are batched with
  [0034](../cross-cutting/0034-mixed-version-compatibility.md).
- **Browser design flakes under controlled parallel load.**
  [0174](../../tests/flaky-tests/0174-design-canvas-parallel-browser-timeout.md)
  (`e2e/DesignCanvas.spec.ts` timeouts with six workers) and
  [0208](../../tests/flaky-tests/0208-design-canvas-private-import-picker-disabled-in-suite.md)
  (import picker stays disabled late in `test:agent:browser`). Neither
  reproduced on 2026-10-22, so there is nothing yet to decide between a client
  wait on an observable state (the controller's 3 s cursor check is a real
  timer) and a product fix.
  - 0174 passed all 24 runs with six workers and `--repeat-each=3`: three
    runs at host load 41–64, and one with 18 synthetic `yes` processes on 18
    cores. It also passed both nine-worker `mise run test:browser` runs.
  - 0208's case passed all three standalone `test:agent:design:isolated` runs.
    It has only failed late in a full `test:agent:browser` run on a shared
    profile, which was not attempted.
  - Next step: rerun with more repeats, or with the CPU throttled (CDP
    `Emulation.setCPUThrottlingRate`), instead of adding host load.

### Deferred until measured

Each option must be removable on its own without reverting a safety fix, and
none may log design content. Today there is one render worker
(`DESIGN_LIMITS.renderWorkers` in `packages/protocol/src/design-operations.ts`;
`DesignRenderer` accepts a `workers` option), a fresh isolated browser context
per job, no capture or inspection cache, no thumbnails (`DesignLibrary.tsx`
lists facts only; culled frames show placeholders), and a whole-record atomic
rewrite per commit (`write` and `writeAtomically` in `core/design/records.ts`).

Decision basis: the 2026-09-24 baseline from `bun scripts/benchmark-design.ts`
(one Linux x64 host, Bun 1.4.0, synthetic content, 20 samples; "before" is
`2aec227b`, before #844):

| Fixture | Catch-up bytes before → after | Edit p50/p95 ms before → after | Commit bytes before → after | Agent response full → compact | Style edit cold/warm ms | Library list ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1 frame, small | 2478 → 1034 | 0.41/0.77 → 2.41/5.2 | 2487 → 17074 | 2282 → 403 | 131.2/122.3 | 0.33 |
| 16 frames, small | 36065 → 1034 | 0.71/4.48 → 2.42/3.96 | 37184 → 74606 | 2282 → 405 | 106.4/119.6 | 0.07 |
| 64 frames, small | 143777 → 1034 | 1.29/2.28 → 4.46/5.7 | 148448 → 249551 | 2282 → 405 | 105.7/114.8 | 0.03 |
| 16 frames, near-limit HTML | 3295765 → 1036 | 13.41/23.69 → 25.51/33.09 | 3296884 → 3334394 | 206191 → 405 | 183.1/190.2 | 0.1 |
| 64 frames, near-limit document | 3969491 → 1035 | 18.51/26.45 → 34.09/39.85 | 3974162 → 4075391 | 62232 → 405 | 130.1/153.9 | 0.11 |

Durable receipts cost 2–15 ms per edit, dominated by the record fsync; that
did not justify a storage redesign. In order:

1. **Library and offscreen thumbnails.** Low-priority, bounded capture jobs
   behind interactive work in the render queue, invalidated by content,
   viewport and runtime identity. A stale thumbnail is labelled, a missing
   renderer gives a placeholder, and a thumbnail is never a hit-test target.
   This is the feature that would create the repeated-capture workload item 2
   needs.
2. **Capture and inspection cache.** Only after thumbnails or measurements
   show repeated identical captures. Key on canvas and frame incarnation,
   content identity, viewport, runtime and sanitiser version, scale, colour
   scheme and parameters. 64 entries and 64 MiB with LRU eviction, counting
   PNG and base64 copies. Single-flight identical requests without coupling
   their cancellation; authorise the environment on every read; never cache
   animated content as a permanent result.
3. **Second render worker.** Measure memory and p95 latency with several
   environments rendering before raising `renderWorkers`.
4. **Warm browser-context pool.** Only if context setup dominates once the
   rest is done. It must prove a full reset of DOM, origin storage, listeners,
   routes, permissions and request state between jobs, pass adversarial tests,
   and be compared with fresh contexts including memory.
5. **Storage redesign.** Only if full-record rewrites dominate at high edit
   frequency on near-limit documents. Write a separate storage decision first
   (manifest indirection versus a journal or database) that keeps document
   and receipt atomicity, crash recovery, history and v1 export. Since #969
   cross-process leases already use the backend database
   (`core/design/coordination.ts`); records stay files.

## Live cycle evidence (2026-10-18)

Profile `qa-design-live-c2`: `mise run dev:test --profile qa-design-live-c2
--fixture --credential-source claude --credential-source codex
--agent-platforms claude,codex`, bridges rebuilt first, on branch
`qualify-design-live-cycle-fd9df34bd9d5` from `a5d338c1`. Pins: Claude Code
2.1.296 (Agent SDK 0.3.296), Codex 0.162.1 (model GPT-6.1-Sol, High). Command
per provider:

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=qa-design-live-c2 ORKESTRATOR_AGENT_TEST_LIVE_DESIGN=1 \
  ORKESTRATOR_AGENT_TEST_DESIGN_PROVIDERS=codex ORKESTRATOR_AGENT_TEST_DESIGN_TURN_TIMEOUT_MS=360000 \
  bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
  e2e/agent-testing/design-live.spec.ts --workers=1
```

- **Codex: passed twice** (2.1 min each). Launch: 7 design calls
  (`get_canvas_summary`, `create_frame`, `get_frame`, `inspect_element`,
  `replace_element_html`, `capture_frame`, `save_canvas`), the export landed at
  the nonce path, and the turn finished while the canvas was inactive. Ask
  agent: the dialog showed the stale-revision notice, Codex re-read
  (`get_canvas_summary`, `get_frame`), and both its edit and the other
  client's survived. Approval (Untrusted): the shell command and then the
  `set_element_styles` call each parked (`command-approval`, then `mcp-form`);
  the turn was `blocked`, survived a 15 s environment switch with the canvas
  unchanged, and completed after approval. Handoff: the new conversation held
  the unsent draft across a switch, nothing was sent, and the canvas linked
  both conversations. Whole cycle: 11 design MCP calls, 0 failed, 28,411
  response bytes (tool outputs fetched through `get_native_agent_tool_details`).
- **Claude: launch cycle passed, rest not run.** Before the fixes below, one
  run completed the launch cycle (create, inspect, replace, capture,
  `save_canvas`, recovering by itself from a revision conflict on its first
  `create_frame`) and then failed at Ask agent on the missing link. Four
  launch-only probes passed the same brief with an environment switch, a
  reload and the link poll. Every later run hit `429 rate_limit`.
- **Defects found and fixed** (each with a test):
  1. A design launched before the dialog's readiness probe finished (the probe
     waits on the renderer) was never linked to its agent conversation, so
     Ask agent could not target it. `DesignWorkspaceDialog.tsx` now reads the
     session capability directly when readiness is still loading.
  2. A user stop (Stop or Escape) that reached Claude before any text streamed
     ended the turn as an error showing
     `[ede_diagnostic] result_type=user …`. The Claude bridge now records the
     generation a stop was requested for and settles that turn's aborted
     result (`terminal_reason` `aborted_streaming` or `aborted_tools`) as a
     stop. An aborted result nobody asked for is still an error. This is
     also the root cause of flake
     [0273](../../tests/flaky-tests/0273-claude-live-slash-provider-result.md).
- **Test findings.** Pressing Escape to clear a sidebar tooltip stops the
  active tab's running turn; `design-live.spec.ts` and
  `slash-command-inactive.spec.ts` no longer do. A turn waiting on an approval
  is `blocked` and its composer shows no Stop button (the card is the
  control). Codex asks an `mcp-form` before each MCP tool call outside
  auto-approve. A conversation nothing was sent to shows the unassigned
  composer (`unassigned-native-compose-bar`).
- **Not covered here:** a pending *question* across a switch (the approval
  case stands in for it), containers (local environments only), and the
  Electron window (browser client only).

### Review follow-up: heartbeat and renderer reloads

Profile `qa-review-design-live-fd9df34`, using the same pinned providers and
`mise run test:logged -- --name review-design-live-rerun -- mise run
test:agent:browser -- e2e/agent-testing/design-live.spec.ts`, with
`ORKESTRATOR_AGENT_TEST_LIVE_DESIGN=1` and
`ORKESTRATOR_AGENT_TEST_DESIGN_MODELS=claude=claude-haiku-4-5`:

- **Codex passed the complete cycle.** The launch transcript explicitly
  completed `inspect_element` and `capture_frame`. Renderer reloads restored
  the canvas and design-session link after launch, the still-pending approval
  before its command ran, and the unsent implementation draft and both links
  after handoff. Whole cycle: 13 design MCP calls, 0 failed, 30,279 response
  bytes. The minute heartbeat appeared during the case.
- **Claude remained unqualified for the remainder.** Both the default-model
  attempt and the Haiku retry ended at launch with the provider API error;
  no assertion was weakened or skipped. The combined retry reported one pass
  (Codex) and one failure (Claude), in 170.3 seconds. Evidence:
  `output/agent-testing/qa-review-design-live-fd9df34/browser/` and the logged
  failure artifact `orkestrator-test-run.DvvwEf/review-design-live-rerun.log.gz`.
- **Deterministic regression checks passed.** An eight-minute virtual wait
  keeps emitting without projection changes, on success and timeout; a scaled
  real `run-logged.ts` subprocess survives beyond its silence deadline.
  Dialog tests cover delayed/rejected capabilities, disabled session support,
  and environment/backend changes during the read. Claude tests cover both
  abort reasons, streamed output, generation isolation, structured-output
  exclusion, and marker cleanup after normal completion or transport loss.
  The design-launch browser file passed both viewport projects.
- **Isolated design validation did not pass.** Two fresh profiles each passed
  the private-canvas case but failed the other unchanged test: first on the
  persisted hidden-file tab (the assertion tracked by case 0380), then on
  the initial brief's visibility. The second run also exceeded the trace
  sanitization bound. No new flake classification is claimed. Evidence is
  under `output/agent-testing/qa-browser-175d0fde-8ef/` and
  `output/agent-testing/qa-browser-6f765d62-da0/`. All profiles were stopped
  and reset.

- **Repository validation:** format, lint and typecheck passed. The full
  non-iOS suite exited 1 after 692.0 seconds: the root diagnostics rule caught
  two newly added DOM absence assertions (corrected, then the complete root
  and live-support rerun passed in 187.8 seconds), plus the existing Pi staging
  timeout (0178) and backend activity-batch failure (0247). Both unchanged
  flaky owning files passed alone, in 20.7 and 0.5 seconds respectively; their
  records were updated. Every other workspace package, bridges, and protocol
  verification passed. Electron, Docker and iOS suites were omitted because
  the change concerns local browser qualification and internal interrupt cleanup.

## Live cycle evidence: Claude rerun (2026-10-21)

The Claude steps that the account rate limit blocked on 2026-10-18 (flake
[0450](../../tests/flaky-tests/0450-claude-live-design-account-rate-limit.md))
now pass.

- **Setup.** Branch `qualify-claude-design-cycle-rerun-dab5ea290ebf` at
  `9b3f53a2`, all five bridges rebuilt. Profile `qa-design-live-c06`:
  `mise run dev:test --profile qa-design-live-c06 --fixture --credential-source
  claude --agent-platforms claude`, started with `CLAUDE_CONFIG_DIR` set to an
  empty, owner-only scratch directory. Pins: Claude Code 2.1.296 (Agent SDK
  0.3.296), default model (the transcript reports `claude-opus-5-5`, High).
  The profile authenticates with the host's default login (its plain
  Keychain entry, access token only), which the app's last usage read
  (23:59Z on 2026-10-20) showed at 0% of its five-hour and weekly windows.
  Command:

  ```bash
  ORKESTRATOR_AGENT_TEST_PROFILE=qa-design-live-c06 ORKESTRATOR_AGENT_TEST_LIVE_DESIGN=1 \
    ORKESTRATOR_AGENT_TEST_DESIGN_PROVIDERS=claude ORKESTRATOR_AGENT_TEST_DESIGN_TURN_TIMEOUT_MS=360000 \
    mise run test:logged -- --name design-live-claude-c06-r1 -- bunx playwright test \
    --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/design-live.spec.ts --workers=1
  ```

- **Run 1 passed** (started 00:09:57Z, 80.7 s, no retry). Step times: launch
  16.0 s, reload 1.6 s, Ask agent 14.0 s, approval 30.0 s, handoff 8.0 s.
  Launch: `get_canvas_summary`, `create_frame`, `inspect_element`,
  `replace_element_html`, `capture_frame`, `save_canvas`, and the export landed
  at the nonce path. Ask agent: the stale-revision notice showed; Claude
  re-read (`get_canvas_summary`, two `inspect_element`), said the frame had
  moved on, and replaced only `#title`, so both its edit and the other
  client's survived. Approval (Ask): the `touch` command parked as **Approve
  command**; the turn stayed `blocked` with no Stop button through a 15 s
  environment switch and a renderer reload, with the marker file absent and the
  canvas revision unchanged. After approval the command ran and
  `set_element_styles` landed the colour. Handoff: **Implement** opened a
  second conversation holding the unsent draft across a switch and a reload,
  nothing was sent, and the canvas linked both conversations. Whole cycle: 11
  design MCP calls, 0 failed, 19,483 response bytes.
- **Run 2 passed** (started 00:22:16Z, 80.5 s): the same steps in 17.0, 1.6,
  13.0, 29.2 and 7.9 s; 10 design MCP calls (one `inspect_element` fewer on
  Ask), 0 failed, 16,762 response bytes.
- **Rate limit.** No 429 in either run. An attempt at 00:09Z was stopped by
  hand after a few seconds, because the shell running it had too short a
  timeout, and is not counted.
- **Not recorded.** The spec approves every pending tool request of the
  approval turn and logs only design calls, so whether Claude also asked
  before `set_element_styles` (Codex asks an `mcp-form`) is not in the
  evidence. Nothing in the Claude bridge pre-allows `orkestrator-design`
  tools in Ask mode.
- **Observation, not a defect.** The approval screenshot, taken right after
  the reload, catches the compose dock's 300 ms slide from centred to docked
  (`NativeComposeDock`), so the "Ready to build!" heading shows faded over the
  transcript. It is the intended transition after the transcript loads.
- **Isolation.** Claude's session records went to the scratch config directory
  (four fixture and worktree project folders), not to any host provider home;
  no credential file was written there. The profile was stopped and reset,
  and the scratch directory deleted. Artifacts (results JSON and four
  screenshots per run) are under `output/agent-testing/qa-design-live-c06/`:
  run 2 in `browser/`, run 1 in `run-1/`.
- **Follow-up found while setting up.** At `9b3f53a2`, an agent-test profile
  took the default host login's token but used the launching shell's
  `CLAUDE_CONFIG_DIR` as the bridge's configuration directory. Started from a
  shell on an added account, it ran on one account and wrote into the
  other's directory, with no way to pick the account with headroom. The
  merged host-home isolation change now keeps writes in the profile; selecting
  the matching credential entry remains logged in
  [0003-agent-accounts-and-sign-in.md](../agent-engines/0003-agent-accounts-and-sign-in.md).
- **Repository validation.** No product or test code changed. `mise run
  check` passed, and so did the flake-index and doc-link unit tests. A full
  `mise run test` passed all four groups in 647.6 s with no profile live.

## Qualification evidence (2026-10-22)

Branch `todo-0036-design-canvas-qualification-1477f37ca3cf` from `b83ae534`.
Host: Apple M5 Max (18 cores), macOS 26.6.2, Bun 1.4.3, Docker Desktop
29.7.2. The host was shared with other worktrees and a production Orkestrator
instance (load averages 11–44 during the runs). It also slept while
unattended, from 03:48 to 04:09 local time, including a 927 s "Dark Wake
Thermal Emergency" sleep. Two container runs and one Electron run that hung
in that window are discarded, not counted as failures. Every later run had
`caffeinate -i -s` holding the host awake.

### Container export

`ORKESTRATOR_TEST_DOCKER_DESIGN_IMAGE=orkestrator-v2:latest` (image
`262fff6c6d0c`, built 2026-10-19), `bun test --cwd apps/backend
./src/core/design/export-container.test.ts`. The file has 11 cases and passed
6 consecutive direct runs (9–11 s each) and once through `test:logged` (9.9 s).
Without the variable all its cases skip.

- **Setup.** A container of the environment image, started with `sleep` as its
  entrypoint and `--network none`. `/workspace` is a named volume mounted
  `volume-nocopy` as `storageMountArguments` does, and owned by `node`.
  Exports run the shipped helpers through the default `docker exec -i`
  transport. The spawn seam only counts helper runs and forwards or holds the
  payload. Container and volume carry a throwaway owner label and are
  removed by id.
- **Round trip.** An export to the default path lands with the exact portable
  digest, mode 644 and owner `node`. Preview then reports the same canvas
  with no confirmation, and a fingerprinted replace keeps one private backup
  with the old digest. No temporary file is left behind.
- **Container stopped before the export.** A `storage` failure, no pending
  export, and reconcile reports `none`. Once the container runs again the
  export succeeds.
- **Docker client killed before or during the write** (no bytes, or half the
  payload, read by the helper). The export is `unknown-outcome` and its intent
  is `unknown`. The orphaned helper sees end of input, refuses the short
  payload (`incomplete-input`) and exits; nothing is published. Reconcile
  reports `not-exported` without starting a writer, and a fresh export then
  succeeds.
- **Docker client killed after sending every byte.** The daemon closes the
  helper's stdin, so the helper publishes the complete payload although
  Orkestrator never hears the result. The export is still `unknown-outcome`;
  reconcile proves `exported` by digest, with the file's inode and mtime
  unchanged and no second writer. This is the case digest reconciliation
  exists for, observed on a real transport.
- **Crash after the rename, before the association commit** (the settlement's
  record write fails, then the service restarts). The intent surfaces as
  `unknown`. Reconcile settles it as `exported` from the digest, the file's
  identity is unchanged, and no writer ran.
- **Container stopped or restarted while the helper waits for its payload.**
  The export is `unknown-outcome`. While the container is stopped, reconcile
  reports `unavailable` and keeps the intent. Once it runs, reconcile
  reports `not-exported`, nothing was published, and the next export
  succeeds. The variant stopped after publishing reconciles to `exported`
  once the container runs again, without rewriting.
- **Workspace emptied.** Under a held export, the writer recreates the
  folder and publishes only its own bytes. Emptied after the rename but
  before the association commit, reconcile reports `not-exported` without
  writing.
- **Canvas or environment deleted during the export.** A deleted canvas
  settles the export without being restored. A deleted environment fences
  the settlement (`not-found`), and the canvas stays missing.
- **Observations.** `docker stop -t 1` sometimes took 22 s on Docker Desktop.
  The harness bounds every Docker call (60 s, SIGKILL) without blocking the
  event loop.
  - Not reachable deterministically without an in-helper seam: a helper
    killed between its temporary-file write and the `link()`. It would leave
    a hidden `.<name>.orkdes.<uuid>.tmp` in the workspace, which nothing
    sweeps. The local helper tests cover the same window
    ("an interruption before publish leaves the old complete file and no
    temp").

### Electron

`ORKESTRATOR_AGENT_TEST_RUN_ID=design-electron mise run test:logged -- --name
design-electron -- bunx playwright test --config
e2e/agent-testing/playwright.electron.config.ts design-canvas-electron.spec.ts`
on Electron 44.7.0 (Chromium 152.0.7977.130). The production main bundle
and preload ran on a disposable profile with a fixture repository; the
renderer was served by Vite, as in the other Electron specs. The last three
runs after the final edits passed (31.4, 30.8 and 26.9 s).

- **Covered in the window.**
  - Open: **New design workspace** → blank canvas.
  - Edit: a pointer drag read back from the backend.
  - Export: the file on disk matches the portable bytes and the recorded
    digest.
  - Download: through Electron's download manager. Only the OS Save dialog is
    replaced, by a `will-download` save path.
  - Keyboard: nudges, resize, undo and redo (each burst one undo entry),
    Delete and its undo, zoom keys, fit all, preview mode, shortcut help and
    Escape.
  - **Open design** (`design_import_host_file`): Orkestrator's own host path
    picker, so nothing is stubbed. The spec asserts that no
    `dialog.showOpenDialog*` ran.
- **Defect found and fixed.** Ctrl/⌘+0 never reset the canvas to 100%, in
  Electron or the browser. App.tsx's app-wide zoom listener ran first and
  prevented the key.
  - The canvas now claims Ctrl/⌘+0 in the capture phase while it owns
    shortcuts, outside text fields. The app's handler skips a key that was
    already handled.
  - Owning tests are in `DesignCanvasTab.test.tsx` (fails without the fix) and
    `App.test.tsx`.
- **Unexplained.** After the fix, one run in about twelve failed at the
  Ctrl/⌘+0 step (the canvas stayed at 71%). It did not recur in eight later
  runs. The spec now waits for the canvas to re-measure after the window zoom
  changes, and dumps key events if the step fails again. That wait could hide
  a narrow product timing issue; no code path that drops the key was found.

### Accessibility

`mise run test:logged -- --name design-a11y -- bunx playwright test --config
e2e/playwright.config.ts DesignCanvasAccessibility.spec.ts` passed three runs
in a row (22.0, 26.1 and 25.2 s): 7 passed, plus 4 desktop-only cases skipped
in the phone project.

- **Under load.** The first nine-worker `mise run test:browser` failed two of
  its cases, and a six-worker `--repeat-each=3` run failed the journey 4 times
  out of 6 (host load 41–54). That exposed two more defects, fixed below
  (8 and 9), and a too-tight watcher.
  - The watcher counted Radix's zero-delay focus-restore timer, which runs
    late on a loaded host. It now needs two frames and 100 ms on `<body>`.
  - After the fixes, three runs passed every time: a six-worker
    `--repeat-each=3` run (30 passed, load 52–58), the same with 18 synthetic
    `yes` processes on 18 cores (30 passed, load about 60), and
    `mise run test:browser` (276.6 s).

- **Journey.** Keyboard only, after load: reload and reopen, select a frame and
  an element from the tree, edit `color`, move (arrows), resize (Alt+arrows
  and the resize handle), undo, and export (file contents checked, focus back
  on the Export button). A frame watcher fails the case if focus rests on
  `<body>` for two or more frames.
- **Defects found and fixed** (each reproduced first; with the four product
  files reverted, all 8 runnable cases fail):
  - Focus fell to `<body>` when:
    1. the inspector was closed;
    2. the phone-width inspector drawer replaced Layers;
    3. a second client's conflict disabled the inspector fields (focus now
       goes to **Reselect**);
    4. a focused frame title was culled;
    5. the export dialog closed (it now returns focus to its opener).
  - Other fixes:
    6. An acknowledgement pulled focus from the edited field to the first
       field.
    7. A successful edit was never announced. The footer save state is now a
       polite `status`.
    8. Pressing **Export revision N** disabled the focused button for the
       write (and the re-run preview kept it disabled), so focus sat on
       `<body>` inside the dialog. Focus now moves first to Cancel, which
       becomes Done.
    9. A frame culled or re-rendered while its layers loaded left the row
       "Could not load layers: Frame closed", and retried only after the next
       render. `DesignLayerTree.tsx` now forgets the branch when its bridge
       closed, so it loads again from the backend or the new bridge.
  - Changes are in `DesignCanvasTab.tsx`, `DesignInspector.tsx`,
    `DesignExportDialog.tsx`, `DesignStatus.tsx` and `DesignLayerTree.tsx`.
    Each has unit tests in its test file; the tests for 8 and 9 fail without
    their fix.
- **Checked.**
  - Tree structure: level, expanded, selected, setsize and a single roving
    tab stop.
  - Every inspector control is named and both status regions are polite.
  - Reduced motion: workspace transitions drop to 0.01 ms.
  - At 200% zoom and in a 320 px pane, nothing overflows and every control
    outside the canvas is reachable and unclipped.
  - The spec attaches `ariaSnapshot` captures of the four regions to each run.
- **Not fixed.** These are in
  [0054](0054-design-canvas-accessibility-findings.md): the 400% zoom layout,
  label-in-name on inspector fields, and a silent first Enter on a row whose
  frame has not rendered.

### Client performance

`mise exec -- bun e2e/perf/design-canvas-perf.ts --runs 3 --samples 20
--moves 3 --html-samples 5 --cycles 12 --library-samples 5 --rev HEAD`.

- **Setup.** Chrome 155.0.8059.85 headless, a production React build of
  `b83ae534` (`--rev` builds a `git archive`, so uncommitted edits in the
  checkout are left out), served by `vite preview` at 1440×900. The real
  `DesignService` is hosted in Bun, and frames carry about 8.3 KB of synthetic
  HTML each.
- **Conditions.** The run took place from 04:42 to 05:00 local time with no
  sleep or DarkWake in that window. Load1 was 11.5–37.6, rising in run 3,
  where most acknowledgment outliers fall. The JSON report is
  `output/benchmarks/design-canvas/2026-10-22T03-42-27-643Z.json` (numbers
  only).
- **Not included.** The measured build predates the focus and layer fixes
  above; see the recheck after the leak check.

| Metric | 1 frame | 16 frames | 64 frames |
| --- | --- | --- | --- |
| Pointer move → preview painted, p50/p95 ms (360 samples) | 12.5/31.4 | 12.05/29.6 | 11.45/29.5 |
| Pointer up → acknowledgment painted, p50/p95 ms (120 samples) | 23.75/61.5 | 30.55/101.6 | 29.45/129.9 |
| Longest acknowledgment ms | 1061 | 1070 | 1118 |
| Pan frame interval p50/p95 ms; dropped frames | 16.7/16.7; 0 | 16.7/16.7; 0 | 16.7/16.8; 0 |
| Live iframes at fit all / 100% / panned away / max while panning | 1/1/0/1 | 8/8/2/8 | 8/8/6/8 |
| Mounted layer rows at fit all / 100% / panned | 7/7/7 | 16/16/22 | 37/37/37 |
| Iframe replacements per geometry edit (120 edits) | 0 | 0 | 0 |
| Iframe replacements / in-frame re-renders per HTML edit | 0/1 | 0/1 | 0/1 |
| Post-GC JS heap MiB at 100% / after 12 leak cycles | 8.86/10.6 | 10.01/11.74 | 11.24/12.7 |
| DOM nodes at 100% | 317 | 557 | 794 |

| Library | 1 canvas | 50 canvases | 256 canvases |
| --- | --- | --- | --- |
| **Saved designs** press → first page painted, p50/p95 ms (15 samples) | 32.0/33.6 | 34.8/36.7 | 35.2/36.7 |
| `design_library` call p50/p95 ms | 0.76/1.24 | 0.74/1.74 | 0.67/1.76 |

- **What the numbers mean.**
  - Geometry-only edits never replaced or re-rendered an iframe, and culling
    held live iframes at 8.
  - Headless frame timing is not a display's: about half of next frames come
    before 16.7 ms, so preview p50 is about 12 ms. Synthetic CDP input
    excludes OS input latency.
  - Acknowledgment includes the hosted service's fsyncs and the Playwright → Bun
    IPC hop, not the gateway or Electron transport.
  - The library renders a first page of 50 rows, so 256 canvases cost the same
    as 50 until **Load more** (all pages: 476 ms p50).
- **Leak check** (12 cycles × 3 runs). Window and document listeners, DOM
  nodes, iframes, timeouts (1), intervals (0), pending animation frames (0)
  and blob URLs (0) stayed constant.
  - The renderer-wide listener count jumped once and then stayed flat: +25 at
    1 frame in 2 of 3 runs, and +55 at 16 frames in 1 run. That alone marks
    those sizes as not converged.
  - The post-GC heap grew about 0.45–0.75 MiB over 12 cycles at every size.
  - At 1 frame only, Chrome's renderer process count rose from 5 to 9 and then
    plateaued; this looks like sandbox-process handling.
- **Recheck with the fixes and 100 cycles.** `--runs 1 --samples 20 --moves 3
  --html-samples 5 --cycles 100 --skip-library --rev HEAD` on `60a75b73` (load1
  4–19). Report: `output/benchmarks/design-canvas/2026-10-22T04-53-02-132Z.json`.
  - Gestures held. Preview p50/p95 ms: 12.1/29.75, 11.7/30.4 and 10.7/28.42.
    Acknowledgment p50/p95 ms: 21.35/220.31, 21.95/29.74 and 26.05/50.65.
    Pan p95 was 16.7–16.8 ms with no dropped frames, and live iframes stayed
    at 1/8/8.
  - The leak check converged at 1, 16 and 64 frames.
    - After the first (warm-up) cycle, listeners, DOM nodes, iframes, timers,
      animation frames and blob URLs were flat for the remaining 99 cycles.
      At 1 frame the warm-up added 34 listeners and 177 nodes once.
    - Post-GC heap growth slowed each quarter: 10.35 → 10.76 → 10.90 → 11.00
      → 11.04 MiB at 1 frame, and +1.03–1.07 MiB in total at 16 and 64.
      That looks like warm-up, not a leak.
- **Decision.** Nothing here makes a case for a client optimisation:
  geometry edits never touch iframes, culling holds at 8 live iframes, and
  panning stays at 60 fps. The backend items under
  [Deferred until measured](#deferred-until-measured) stay deferred; these
  client numbers do not measure repeated captures, render-worker contention
  or full-record rewrites.

## Constraints and rationale

- Runs use a unique isolated profile and only its fixture repository, with
  fixture-scoped prompts. Never put tokens or real designs in logs or
  screenshots. An unavailable platform is an explicit incomplete gate, not a
  pass.
- Single-machine timings are host evidence, not thresholds. The hard gates are
  correctness and explicit bounds, plus no unchanged HTML for geometry-only
  edits (met: about 1 KiB per catch-up at any size). A lower average with
  worse tail latency, memory pressure or starvation is not a win.
- Capability fallback: the client asks `design_capabilities`; when an old
  backend reports the command unsupported, `getCapabilities`
  (`apps/web/src/lib/design-client.ts`) returns `null` and the client uses the
  v1 legacy snapshot and action path. Missing support never shows a canvas as
  empty or deleted, and old clients never receive an incompatible export
  shape. Pinned by "a v1 backend falls back to legacy snapshots, never an
  empty document" in `design-controller.test.ts`.
- Optimisation rollback restores full snapshots or fresh contexts without
  touching stored documents. Storage rollback is a separate explicit
  conversion; reverting a binary is not enough once records are migrated.
- Non-goals unless evidence changes: multiplayer cursors and comments,
  authored JavaScript, external asset fetching, a resident design agent,
  design launch for providers beyond Claude and Codex (`DESIGN_AGENTS`), CRDT
  or automatic conflict merging, a new database, asset package or write-ahead
  log solely for speed, and automatic implementation dispatch, approval,
  publishing or deployment.
- Design flake review (2026-10-16): none of the backend design flakes was an
  ordering bug, and no product code changed.
  1. **Hint contract.** Hints stay at most once, best effort, and in commit
     order per canvas within one backend, because they are published inside
     the lane after their commit. The cursor and `design_sync` are
     authoritative, and there is no per-hint sequence number and no dedupe.
     The ordering is pinned by "live hints follow per-canvas commit order and
     stale validation publishes nothing" in `core/design/sync.test.ts` and
     stated under Synchronization in `design-canvas.md`. A sequence number
     would add nothing: revision plus status version already orders hints,
     and clients repair gaps by cursor.
  2. **0215 was fixed in the test.** The 4th event was the first commit's
     background-validation `status` hint, which is correct behaviour. The case
     now holds that job with `renderer.block` before counting, then asserts
     that the hint is the only later one. Awaiting validation inside
     `execute` was rejected: it would put a render on every HTML edit's
     acknowledgment path.
  3. **0193, 0218 and the 0225 design cases bound the work, not the
     deadline.** 258, 260 and 55 sequential fsynced commits took 0.4–0.9 s
     alone and over 5 s under load. The tests lower the bound with
     `withDesignLimit` (`core/design/test-support.ts`; `DESIGN_LIMITS` is read
     at call time), and in-memory cases check the shipped 256-change and
     50-entry bounds. Raising the per-test deadline was rejected because it
     keeps the load sensitivity. A `DesignServiceOptions` limit seam was
     rejected because it would touch `records.ts`, `apply.ts` and `service.ts`
     only for tests.
- Electron (decided 2026-10-22): the design spec stays in
  `e2e/agent-testing/playwright.electron.config.ts` rather than a one-off
  manual pass. It is credential-free and found the Ctrl/⌘+0 defect.
- Deliberate deviations, not bugs: drafts persist per client in
  `localStorage` (`design-drafts.ts`) rather than the backend compose-draft
  store; the layer tree uses its own fixed-row windowing instead of
  `react-virtuoso` so focused and selected rows stay mounted; "agent
  available" means enabled in settings.

## Open questions

- Should design join a shared live-provider harness (like
  `e2e/agent-testing/opencode-live.spec.ts`) rather than get its own spec?
- Are thumbnails wanted as a product feature on their own merits? The library
  shipped without them.
- Is a cross-environment design transfer UI wanted? Recovery copies, download
  and import cover copying today. If it is built, define and test the lock
  order for two-canvas operations before adding them.

## Related

- [0037-design-operation-recovery-edges.md](0037-design-operation-recovery-edges.md),
  [0038-design-agent-conversation-links.md](0038-design-agent-conversation-links.md) and
  [0054-design-canvas-accessibility-findings.md](0054-design-canvas-accessibility-findings.md).
- [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md)
  for container runs, [0034-mixed-version-compatibility.md](../cross-cutting/0034-mixed-version-compatibility.md)
  for old-client and old-backend runs, and
  [0030-test-suite-and-ci-health.md](../cross-cutting/0030-test-suite-and-ci-health.md) for flake triage.
- [`agent-testing.md`](../../development/agent-testing.md) and
  [`testing-guide.md`](../../development/testing-guide.md).
- Open design flakes:
  [0174](../../tests/flaky-tests/0174-design-canvas-parallel-browser-timeout.md),
  [0208](../../tests/flaky-tests/0208-design-canvas-private-import-picker-disabled-in-suite.md)
  and [0246](../../tests/flaky-tests/0246-design-renderer-real-chromium-launch-deadline.md)
  (real-Chromium launch on CI). Resolved on 2026-10-16 as test artefacts:
  [0193](../../tests/flaky-tests/0193-design-sync-gap-aggregate-timeout.md),
  [0215](../../tests/flaky-tests/0215-design-operation-replay-event-count.md),
  [0218](../../tests/flaky-tests/0218-design-service-replay-aggregate-timeout.md)
  and the design half of
  [0225](../../tests/flaky-tests/0225-design-and-bench-aggregate-timeouts.md).

## Replaces

- `docs/improvements/design-space.md` (assessment; all twelve findings are
  implemented, the U4 remainder is in
  [0038-design-agent-conversation-links.md](0038-design-agent-conversation-links.md))
- `docs/improvements/design-space/plan/00-index.md` (qualification gaps,
  deferred items, non-goals, capability decision, measurements and
  deviations; the residual edges went to
  [0037-design-operation-recovery-edges.md](0037-design-operation-recovery-edges.md))
- `docs/improvements/design-space/plan/01-preserve-editing-intent.md` (done)
- `docs/improvements/design-space/plan/04-renderer-scheduling-and-recovery.md`
  (second-worker evaluation)
- `docs/improvements/design-space/plan/05-safe-saving-and-export.md`
  (real-container interruption runs; the rest is done)
- `docs/improvements/design-space/plan/06-validation-deletion-and-recovery.md` (done)
- `docs/improvements/design-space/plan/07-history-and-document-lifecycle.md`
  (cross-environment transfer question; the rest is done)
- `docs/improvements/design-space/plan/08-entry-readiness-and-library.md`
  (thumbnails; the readiness panel was removed in #926 and the library
  restored in #928)
- `docs/improvements/design-space/plan/09-selection-and-inspector.md` (done)
- `docs/improvements/design-space/plan/10-navigation-and-accessibility.md`
  (manual accessibility and Electron passes)
- `docs/improvements/design-space/plan/12-incremental-synchronization.md` (done)
- `docs/improvements/design-space/plan/13-visible-frame-and-layer-rendering.md`
  (client performance and leak evidence)
- `docs/improvements/design-space/plan/14-storage-rendering-and-mcp-efficiency.md`
  (conditional cache, context pool and storage redesign; A–D are done)
- `docs/improvements/design-space/plan/15-qualification-and-rollout.md`
