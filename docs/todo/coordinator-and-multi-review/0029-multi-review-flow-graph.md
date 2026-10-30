# Multi Review flow graph

Checked against `main` at `9906db30` (2026-10-16), plus the follow-ups that
built zoom and pan, failed-node errors, step transcript tails, queue position
and live findings.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

Statuses re-checked 2026-10-30 against `main` at `cd7bbe3e`.

1. **Pi bridge-owned MCP extension in read-only sessions**: prove with a test that the inline `orkestrator-mcp` extension still loads when `noExtensions` is set. Status: done (2026-10-30): "a read-only session keeps the bridge's own extensions and their attempt tools" in `bridges/pi-bridge/src/agent-session.test.ts`.
2. **Read-only Grok and Pi consolidation turns declare their attempt**: newly found gap; a Multi Review consolidation on Grok or Pi is read-only but sends no `workflowResultKey`, so the bridge refused its submit tool. Status: done in code 2026-10-28 by [0724](0724-multi-review-consolidation-grok-pi-result-key.md) (#1375, `6056d472`; on `main` at `multi-review-service.ts:4144` and `build-pipeline-review-fanout.ts:1030`); the live check rides with task 3.
3. **Live: read-only Grok and Pi reviewers submit their report**: qualification run in a packaged review. Status: open (needs billed Grok and Pi turns; steps in Assumptions and decisions).
4. **Live: `report_finding` on every provider**: one reviewer per provider, plus one container run. Status: open (needs billed turns on six providers; steps in Assumptions and decisions). Its 0031 batching row is done (2026-10-30).
5. **Real-device zoom, pan and error tooltip**: trackpad pinch in Electron, phone pinch, Safari gesture events. Status: open (needs a Mac trackpad, Safari and a phone). The Safari `gesture*` handler now has a synthetic guard, and the spec passed its zoom, pan and tooltip cases under Playwright WebKit (2026-10-30); three WebKit failures elsewhere in the spec went to [0860](0860-multi-review-inspector-webkit-divergences.md).

### 1. Pi bridge-owned MCP extension in read-only sessions

**Problem.** Read-only Pi sessions (reviewers, consolidation, coordinators) pass `noExtensions: true` to Pi's resource loader. If that ever also dropped the bridge's own inline extensions, a read-only reviewer would silently lose `submit_review_report` and `report_finding`, and the approval gate with them. No test pins it.

**Context.** `projectResourceDiscoveryOptions` disables project extensions for read-only sessions because a project extension can replace a built-in tool by name. The bridge registers its gate, MCP tools and command-change hook through `extensionFactories`, which Pi treats as a separate source.

**Investigation.** The wiring is unchanged: `createPiSessionServices` (`bridges/pi-bridge/src/agent-session.ts:464`) spreads `loaderPolicy.discovery` and then passes three inline factories (`agent-session.ts:478`: `orkestrator`, `orkestrator-mcp`, `orkestrator-command-changes`); `projectResourceDiscoveryOptions` is at `agent-session.ts:808`. In the pinned SDK (`@earendil-works/pi-coding-agent` 1.4.0), `noExtensions` filters only discovered paths (`dist/core/resource-loader.js:505`), and `loadExtensionFactories` runs unconditionally in both the pre-trust pass (`resource-loader.js:516`) and the final pass (`resource-loader.js:565`). A throwaway probe on 1.4.0 with `noExtensions: true` and one inline factory loaded `<inline:orkestrator-mcp>` with its tool and no errors. So the behaviour is right today. Existing tests stop short: `agent-session.test.ts:648` checks the option values and that a project extension is excluded; `coordinator-skills.test.ts:83` builds read-only services but asserts skills only; `conformance-execution-policy.test.ts:82` checks project extensions only. None asserts the inline extensions survive `noExtensions`.

**Decisions.**

- **Where should the guard test live?**
  - **Extend the existing read-only test in `agent-session.test.ts` (recommended).** After building `createPiSessionServices` with `state.readOnly = true`, assert the three `<inline:…>` extensions load and the project one does not.
    - Pros: sits beside the test that explains why `noExtensions` is set; exercises the real attach construction; catches an SDK bump that changes the inline path.
    - Cons: needs an MCP runtime stub or must tolerate an empty Orkestrator server list.
  - **Add it to `conformance-execution-policy.test.ts`.**
    - Pros: runs for every policy shape the shared suite enumerates.
    - Cons: the shared suite's contract is about project resources, not bridge-owned tools; mixing the two muddies a cross-bridge file.
- **Keep this as a todo item or record it as done?**
  - **Keep it open until the test lands, then delete the item (recommended).**
    - Pros: the file's rule is that an item goes in the change that finishes it; the probe is not durable evidence.
    - Cons: an open item for something already known to work.
  - **Mark it done now on the strength of the probe.**
    - Pros: the item list reflects real behaviour.
    - Cons: nothing would catch a regression on the next Pi bump, which is the item's whole point.

### 2. Read-only Grok and Pi consolidation turns declare their attempt

**Problem.** "Current state" notes that Consolidation and Fix turns on Grok or Pi do not declare their attempt, but it is not listed as outstanding work. For Multi Review consolidation it matters: the turn is read-only, so Grok and Pi refuse its `submit_consolidated_review` call and the step cannot finish through the tool transport. Anyone who picks Grok or Pi as the consolidation agent is affected.

**Context.** Grok and Pi gate tools in the bridge. They let a read-only turn call its own result tools only when the prompt names the attempt (`workflowResultTool` plus `workflowResultKey`) and the call carries that key ("Attempt tools in read-only turns" in `agent-engines.md`).

**Investigation.** Reviewer turns send both fields (`apps/backend/src/core/review-fanout.ts:1226`). The Multi Review step dispatch sends only `workflowResultTool` (`apps/backend/src/core/multi-review-service.ts:3975`, and on attach at `:3949`), while consolidation uses `READ_ONLY_REPORT_TURN` (`multi-review-service.ts:209`, applied at `:3968`). `http-bridge-prompt-body.ts:76` forwards the pair to Grok and Pi only when both are present, so neither arrives. Pi's gate (`bridges/pi-bridge/src/interactions.ts:74`) then blocks every non-read tool outside `isOwnWorkflowResultCall` (`bridges/pi-bridge/src/mcp.ts:172`, which requires `state.workflowResultTurn`). Grok's `workflowResultPermissionOption` returns nothing without a turn (`bridges/acp-bridge/src/acp-session.ts:761`), and `acp-workflow-result-permission.test.ts:171` asserts exactly that: "a read-only turn that declared no attempt is refused the same tools". Fix turns are sent `readOnly: false`, so they are not gated. Build Pipeline consolidation sends `mode: "plan"` with no `readOnly` (`apps/backend/src/core/build-pipeline-review-fanout.ts:824`), which maps to `readOnly: undefined` (`http-bridge-prompt-body.ts:34`), so whether it is blocked there depends on the session's existing read-only flag. Not reproduced live; this is from code reading.

**Decisions.**

- **How should consolidation declare its attempt?**
  - **Send `workflowResultKey: request.requestId` with `workflowResultTool` on step dispatch and attach (recommended).** The same shape reviewers already use.
    - Pros: one-line change per call site; reuses the bridges' existing, tested key check; no bridge change.
    - Cons: needs a test per bridge path proving a consolidation call with that key is let through, and must confirm the step's result key really is `request.requestId`.
  - **Make consolidation turns on Grok and Pi writable.**
    - Pros: no protocol change.
    - Cons: widens a turn that reads untrusted reviewer output to workspace writes; contradicts the read-only report-turn rule.
  - **Refuse Grok and Pi as consolidation agents.**
    - Pros: no silent failure.
    - Cons: a parity loss for no technical reason, since the reviewer path already works.
- **Where should this item be tracked, given the rule against adding todos to an existing file?**
  - **A new numbered todo file linked from this one (recommended).**
    - Pros: follows the README rule; it is a defect with its own fix and tests, separate from the flow-graph work.
    - Cons: one more file for a small change.
  - **Fix it directly without a todo.**
    - Pros: fastest if someone is already in the code.
    - Cons: the gap is only visible here; if the fix slips, nothing tracks it.

### 3. Live: read-only Grok and Pi reviewers submit their report

**Problem.** The attempt-tool allowance for read-only reviewers is unit-tested on both bridges but has never been run against a real Grok or Pi model, so a packaged Multi Review with either reviewer is unproven.

**Context.** Grok's permission request must carry the call's arguments (`rawInput`, or `tool_input` under `use_tool`) for the key check to pass. A key mismatch fails closed, so the failure shows as a reviewer that never submits.

**Investigation.** The Grok path reads `toolCall.rawInput` and falls back to the recorded input (`bridges/acp-bridge/src/acp-session.ts:772`); the `use_tool` unwrap is at `:710`. Coverage is in `acp-workflow-result-permission.test.ts:29` to `:186` and `bridges/pi-bridge/src/interactions-gate.test.ts`. Whether real Grok supplies `rawInput` on the permission request is still unknown. Per the auto-memory note on Grok ACP "Invalid params", earlier Grok builds failed at `session/new`, so check that a session starts at all before judging this item.

**Decisions.**

- **What counts as a pass?**
  - **Each reviewer calls validate then submit with its own key, the workflow consolidates, and the stored report lists that reviewer as a source (recommended).**
    - Pros: proves the whole chain, including the backend accepting the attempt.
    - Cons: none left from task 2, whose code is fixed (0724); the run can now also consolidate on Grok or Pi.
  - **The submit call is allowed by the bridge (seen in the bridge log).**
    - Pros: cheaper and isolates the bridge.
    - Cons: misses a backend-side rejection or a provider that submits with the wrong key.
- **Run it on its own or batched?**
  - **Batch with task 4 and the 0031 live round (recommended).** One packaged review can carry the Grok and Pi reviewers and the `report_finding` checks.
    - Pros: one set of provider sign-ins and spend.
    - Cons: a failure in one provider can obscure another; keep per-reviewer evidence.
  - **Run it separately first.**
    - Pros: a quick, focused answer for the two gated bridges.
    - Cons: a second live run for the same setup.

### 4. Live: `report_finding` on every provider

**Problem.** "Findings so far" depends on each provider calling `report_finding` mid-run. Every bridge's auto-allow path has a unit test; none has been run against a real model, nor through the container route to the attempt server.

**Context.** This is a packaged Multi Review with one reviewer per provider (Claude, Codex, Cursor, Grok, OpenCode, Pi), plus one provider in a container where the attempt server is reached at `host.docker.internal`. The file asks for it to be batched with 0031.

**Investigation.** The renderer merge is `mergeReviewerFindings` (`apps/web/src/components/review/MultiReviewInspector.tsx`). Bridge tests exist, for example `bridges/pi-bridge/src/interactions-gate.test.ts:589` and the ACP permission test above. 0031 has no row naming 0029 (its multi-provider row at `docs/todo/cross-cutting/0031-live-provider-and-platform-qualification.md:214` cites 0027 and 0025 only), so this run is not actually batched yet. The memory note on host UFW blocking container-to-MCP traffic applies to the container leg: check for a UFW block first if the container reviewer cannot reach the attempt server.

**Decisions.**

- **How should the six-provider run be organised?**
  - **One panel with all six reviewers, plus a separate single-reviewer container run (recommended).**
    - Pros: matches the file; one consolidation; mixed-panel behaviour comes for free (0027 and 0025 want it).
    - Cons: large token spend; one slow provider delays the whole check.
  - **Six single-reviewer reviews.**
    - Pros: failures are isolated and easy to attribute.
    - Cons: six times the setup and consolidation turns; no mixed-panel evidence.
- **Should 0031 list this run?**
  - **Yes, add 0029 to the multi-provider row in 0031 (recommended).**
    - Pros: the batching the file asks for actually happens.
    - Cons: an edit to another file, outside this analysis.
  - **Leave it to whoever runs 0031 to find it.**
    - Pros: no cross-file edit.
    - Cons: it is easy to miss, as it is today.
- **Is a stopped reviewer's "unconfirmed" row part of the pass?**
  - **Yes: stop one reviewer mid-run and check its rows show "unconfirmed (reviewer stopped)" (recommended).**
    - Pros: it is the only live check of the stop path.
    - Cons: needs a reviewer that has reported at least one finding before it is stopped.
  - **No, leave it to unit tests.**
    - Pros: a simpler run.
    - Cons: leaves the state the user is most likely to misread unqualified.

### 5. Real-device zoom, pan and error tooltip

**Problem.** Gesture handling is proved only with synthetic events in Chromium. Real trackpad pinch in Electron, a phone's own pinch and Safari's `gesture*` events may behave differently, and users on those devices would get a graph that will not zoom or that scrolls the page instead.

**Context.** `e2e/MultiReviewFlow.spec.ts` covers Ctrl + wheel and a synthetic two-finger touch pinch (`e2e/MultiReviewFlow.spec.ts:323`). The graph and viewport are `MultiReviewFlowGraph.tsx:628` and `MultiReviewFlowViewport.tsx`, with layout and edge maths in `multi-review-flow.ts:473` and `:92`.

**Investigation.** The references are current. No automated suite can drive a real trackpad or iOS Safari, so this stays a manual check. It is a platform run of the kind 0031 batches (macOS, Safari and iOS).

**Decisions.**

- **How should it be run?**
  - **A manual checklist inside the 0031 macOS and iOS session (recommended).** Pinch, pan, Fit, Fullscreen and the failed-node tooltip, in the desktop app, Safari and a phone.
    - Pros: needs the same hardware as other 0031 items; cheap once the session is set up.
    - Cons: manual evidence only, with no regression guard.
  - **Add a WebKit Playwright project with synthetic `gesturestart` events.**
    - Pros: automated and repeatable.
    - Cons: synthetic again, so it would not prove real hardware, which is the item's whole question.
- **Keep or retire the item?**
  - **Keep it at its current low priority (recommended).**
    - Pros: a real gap on a shipped surface, with a known cost.
    - Cons: may sit until someone has the hardware.
  - **Retire it as covered well enough by Chromium tests.**
    - Pros: one less open item.
    - Cons: Safari gesture events are a known divergence; retiring would hide it.

## Assumptions and decisions

Made 2026-10-30 against `main` at `cd7bbe3e`. Every recommended option was
taken; none was contradicted by the current code.

### Task 1: where the guard test lives

Took the recommended option: the test sits in `agent-session.test.ts`, beside
the one that explains why `noExtensions` is set. It builds the real
`createPiSessionServices` for a read-only state and asserts that the loaded
extensions are exactly `<inline:orkestrator>`, `<inline:orkestrator-mcp>` and
`<inline:orkestrator-command-changes>`, with no load errors, and that
`orkestrator-mcp` registered `submit_review_report` and `report_finding`. The
option's con (it needs an MCP runtime stub) is met by the existing
`setPiMcpTransportForTests` seam, so the test proves the tools, not just the
extension names. The state has `projectResources: true`, so `noExtensions`
comes from read-only alone (the case a reviewer in a project-resource
container hits), and the fixture's `.pi/extensions/project-probe.ts` must stay
out. Checked by mutation: dropping the `orkestrator-mcp` factory whenever
`noExtensions` is set fails the test.

### Task 1: keep or record as done

Took the recommended option: the item stayed open until the test landed. It
has now landed, so the status is done and the item is gone from Outstanding
work. The task subsection stays as the record, since the Task analysis keeps
one subsection per task.

### Task 2: nothing to redo

Already merged: 0724 (#1375, `6056d472`) sends `workflowResultKey` with
`workflowResultTool` on every Multi Review step (`multi-review-service.ts:4144`)
and on Build Pipeline consolidation (`build-pipeline-review-fanout.ts:1030`).
Only its status line was updated.

### Task 3: pass criterion and batching

Took both recommended options: a pass is the whole chain (validate, then
submit with the reviewer's own key, the workflow consolidates, the stored
report lists the reviewer as a source), and the run is batched with task 4 in
one session. Not run: it needs billed Grok and Pi turns. Steps:

1. On the macOS host, in a long-lived terminal, start a disposable profile
   with all six providers and a container fixture:
   `mise run dev:test --profile qa-0029 --fixture --fixture-environments local,container`.
   In another terminal, wait for `status: "ready"` in
   `mise run dev:status --profile qa-0029 --json`, and use its `browserUrl`,
   `testProject` and `logDir` only.
2. First check Grok starts a session at all (open one Grok tab in the fixture
   environment and send a one-line prompt). If `session/new` fails with
   "Invalid params", record that and stop the Grok leg.
3. In the fixture environment, right-click **Multi Review**, pick one reviewer
   per provider (Claude, Codex, Cursor, Grok, OpenCode, Pi; cheapest model
   each), set consolidation to **Grok**, and **Start**.
4. For the Grok and Pi reviewers, record from the bridge logs under `logDir`
   that the permission request for `submit_review_report` carried the call's
   arguments (`rawInput`, or `tool_input` under `use_tool`) and was allowed,
   and that `validate_workflow_result` ran before it.
5. When the workflow reaches `ready`, open the consolidated report and check
   both reviewers are listed as sources. Record the workflow id, commit,
   provider pins and the outcome per reviewer.
6. Repeat step 3 with two reviewers and consolidation on **Pi**, so 0724's
   Pi consolidation is seen once too (Grok consolidation is step 3).
7. `mise run dev:stop --profile qa-0029`, then
   `mise run dev:reset --profile qa-0029` unless task 5's Electron check is
   still to come.

### Task 4: run shape, 0031 row and the stop path

Took the recommended options: one six-reviewer panel (step 3 above) plus one
single-reviewer container run; 0029 is now listed in 0031's "Several providers
at once" row; and the stopped-reviewer "unconfirmed" row is part of the pass.
Not run: it needs billed turns on six providers. Fake coverage already exists
and was not extended: each bridge's auto-allow tests, the backend
`agent-tools-report-finding.test.ts`, and the container URL derivation
(`agent-tools.test.ts:1285`, `host.docker.internal`). Steps, in the same
session as task 3:

1. While the step 3 panel runs, keep the Multi Review tab open with the
   Findings badge in view, and record, per reviewer, that a provisional row
   appears before its report is accepted, and that the accepted report then
   replaces it (the row turns confirmed or disappears).
2. Once one reviewer has at least one provisional row, select its node, press
   **Stop** ("Stop this reviewer") and check its rows read "unconfirmed
   (reviewer stopped)".
3. Start a second Multi Review in `fixture-container` with one reviewer on a
   provider signed in inside the container (for example Codex). Check that it
   calls `report_finding` and its rows appear. If it cannot reach the attempt
   server, check the host firewall (UFW on Linux) before calling it a failure.
4. Record each reviewer's evidence separately, so one provider's failure does
   not hide another's.

### Task 5: how it is run, and the automated part

Took the recommended options: a manual checklist inside the 0031 macOS and
iOS session, kept at low priority, and no new WebKit Playwright project. Two
deterministic additions:

- The Safari `gesturestart`/`gesturechange` handler had no test at all. "a
  Safari gesture pinch zooms the graph and is kept from the page" in
  `e2e/MultiReviewFlow.spec.ts` dispatches synthetic gesture events in both
  layouts and checks that each is cancelled and that the zoom goes to 200% and
  back. It pins the handler; it is not real-device evidence. Checked by
  mutation: removing the `gesturechange` listener fails it.
- A one-off run of the whole spec under the existing
  `ORKESTRATOR_E2E_BROWSER=webkit` override (Playwright WebKit on macOS, not
  Safari): 91 passed, 5 skipped, 4 failed. Every zoom, pan, fullscreen and
  error-tooltip case passed, including Ctrl + wheel, the drag pan and the new
  gesture test. The touch pinch failed only because WebKit has no `Touch`
  constructor for a synthetic event. The other three failures were the
  inspector's transcript follow after Report (both layouts) and the sticky
  findings badge on the phone layout; they are outside this item and went to
  [0860](0860-multi-review-inspector-webkit-divergences.md).

Steps for the real-device check (no provider turns needed except for Electron):

1. Serve the browser fixture on the LAN or Tailscale, from `apps/web`:
   `bunx vite ../../e2e/fixture --config vite.config.ts --host 0.0.0.0 --port 14830 --strictPort`
   (not 34121 or 34122). Stop it afterwards.
2. In desktop Safari, open
   `http://<host-ip>:14830/multi-review-flow?phase=reviewing&reviewers=32`:
   pinch on the trackpad zooms around the pointer and the page itself does
   not zoom; two-finger scroll pans; dragging the canvas pans; −, the level
   (reset), + and Fullscreen work, and Escape leaves fullscreen.
3. Open `...?phase=failed&reviewers=4`: hover and keyboard-focus Reviewer 1;
   the tooltip shows the whole error.
4. On an iPhone in Safari, open both URLs (the stacked layout): a two-finger
   pinch zooms the column, one finger scrolls the page past it, and the zoom
   buttons are reachable. Tap Reviewer 1 on the failed URL and check the error
   is readable.
5. In the Electron window of the task 3 profile (`electronTitle` from
   `dev:status`), open a finished Multi Review and repeat step 2's trackpad
   pinch and pan. Then stop and reset the profile.
6. Record device, OS and browser versions and the result of each step.

### New todo 0860

The three WebKit-only inspector failures have nothing to do with zoom, pan or
the tooltip, so they went to a new file rather than this one: [0860](0860-multi-review-inspector-webkit-divergences.md).

## Current state

The Multi Review tab shows the workflow as a left-to-right flow graph: review
package, then the reviewer panel, then consolidation, then Fix. An inspector
sits below the graph. It shows the selected node's status and actions and a
live transcript tail, and beside it the findings reviewers have reported so
far. Every follow-up from the redesign is built. What is left is qualifying
live findings on real providers and a few gaps found on the way.


- **Shared components.** The graph, viewport, stacked layout, view store and
  inspector frame are shared with the build pipeline tab and live in
  `apps/web/src/components/flow-graph/` (`FlowGraph.tsx`, `FlowViewport.tsx`,
  `flow-viewport.ts`, `flow-graph-model.ts`, `FlowInspector.tsx`) and
  `stores/flowGraphViewStore.ts`. Multi Review supplies its nodes, its
  five-column layout and its edges; see
  [build-pipeline-view.md](../../architecture/build-pipeline-view.md).
- **Graph.** `MultiReviewFlowGraph.tsx` draws the nodes, through the shared
  `FlowGraph`, as tabs that control the inspector. `multiReviewFlowLayout`
  (`multi-review-flow.ts`) computes their positions, and edges are hand-drawn
  SVG béziers. Edge state comes from `multiReviewFlowEdges`. A finished source takes its style from its target:
  `active`, `complete`, `ready` (output waiting for the next step), `failed`,
  or `pending` when nothing has flowed. Below 960 px the graph stacks into one
  column with straight connectors.
- **Zoom and pan.** The graph sits in a scrolling viewport up to 720 px tall
  (`FlowViewport.tsx`, maths in `flow-viewport.ts`). −, the zoom level (which
  resets to 100%), + and Fullscreen sit in its bottom-right corner; zoom runs
  from 20% to 200%. There is no Fit control: it was removed in #1199, and the
  browser suite asserts it stays gone. The shared viewport still offers Fit as
  an opt-in (`fitControl`) that the build pipeline graph turns on. Fullscreen portals the graph
  over the whole Multi Review tab (an `@container` ancestor would confine a
  fixed overlay) and the viewport takes the tab's height; the button or an
  Escape no menu or dialog handled leaves it. Dragging the canvas, wheel and
  trackpad scrolling pan it, but a press that React bubbles up from a node's
  portaled context menu never starts a drag, since capturing its pointer would
  swallow the menu item's selection; Ctrl/⌘ + wheel, a trackpad pinch and a two-finger touch
  pinch zoom around the pointer, while a plain wheel is left to scrolling so
  the page still scrolls past the graph. A node reached from the keyboard is
  scrolled into view first. Zoom and pan are kept per workflow in
  `flowGraphViewStore` (renderer only, at most 50 workflows) and reset
  when the panel width changes.
- **Zoom in the stacked layout.** Below 960 px the column has the same
  controls, range and presets, in a sticky row at its top with 44 px touch
  targets. The column scales inside a viewport that scrolls only sideways and
  grows with it, so vertical scrolling stays with the page and the inspector
  below stays reachable. It keeps its own view, under the workflow
  id plus `stacked`, so each layout restores what it was left at.
- **Failed nodes.** A failed reviewer or step shows its error, joined onto
  one line, in place of its model, truncated to the node (the shared
  `FlowGraph`'s `errorFace="joined"`; the build pipeline shows only the first
  line). The whole text is the node's accessible description and its tooltip,
  which also opens on keyboard focus. Steps take the workflow error, or the Fix session's own once the fix
  is interactive.
- **Inspector.** `MultiReviewInspector.tsx`. Every node has a transcript tail.
  Each step is a keyword and its subject; narrative (`say`) lines drop the
  keyword and read in white against the grey steps.
  A reviewer's reads `getMultiReviewReviewerTranscript`; preparation,
  consolidation and Fix read `getMultiReviewStepTranscript`
  (`get_multi_review_step_transcript`, `multi-review-step-transcript.ts`),
  which has the same contract with tighter bounds: at most 100 messages and
  256 KiB, a session-scoped `knownSourceToken`, and `unchanged` answers with no
  messages. Each tail reads once on selection and on each workflow checkpoint,
  and polls through the read coordinator only while its node is live, the
  window visible and the tab active. A session that several steps share (older
  workflows ran all three in the fix session) is read only for the step using
  it now (`multiReviewStepSessionAccess`, which follows the same rule as
  `fixSessionRuntimeStep`); the other steps say which step has it. Step tails
  hide prompts and schema-shaped text exactly as reviewer tails do.
- **Queue position.** A pending reviewer in a review pass shows its place in
  the admission queue ("queued · #3 of 7"), or "starting" while its session
  is set up. `runBoundedTasks` (`review-fanout-scheduler.ts`) reports its
  waiting queue as each task leaves it, and `ReviewFanoutRunner` projects that
  onto the reviewer records (`admissionState`, `queuePosition`;
  `review-fanout-admission.ts`). The fields are observations: they ride on the
  pass's own safety commits and its one observational flush, so a position can
  trail by one admission until the next commit. Stopping a queued reviewer
  moves the ones behind it up; a restarted reviewer rejoins at its panel
  place on the next pass. A backend without the fields shows a bare "queued".
  There is deliberately no expected start time: nothing measures how long a
  provider takes to admit a reviewer.
- **Findings so far.** `mergeReviewerFindings` lists the issues of completed
  reviewers' accepted reports, plus what reviewers reported through the
  `report_finding` MCP tool before a report was accepted
  (`reviewer.provisionalFindings`; see "Provisional findings" in
  [agent-engines.md](../../architecture/agent-engines.md#provisional-findings-report_finding)).
  An issue that several reviewers raised at the same file, line and title is
  listed once, and a row an accepted report confirms is confirmed. Other rows
  are marked "provisional" while their reviewer runs, or "unconfirmed (reviewer
  failed)" / "(reviewer stopped)" once it ended without a report. The reviewer's
  inspector says how many it reported. The accepted report replaces them,
  consolidation never reads them, and they are removed once the workflow is
  `interactive` or `completed`. Partial reports from failed or stopped
  reviewers are still not included, and findings are never read out of a
  transcript.
- **Read-only Grok and Pi reviewers.** Their bridges gate tools themselves,
  and a packaged review's reviewer turns are read-only, so neither let a
  reviewer call its own result tools. The prompt now names the turn's attempt
  (`workflowResultTool`, `workflowResultKey`) and both bridges let that
  attempt's own tools through for calls naming its key: submit, validate,
  status and `report_finding` ("Attempt tools in read-only turns" in
  [agent-engines.md](../../architecture/agent-engines.md#attempt-tools-in-read-only-turns-grok-pi)).
  Since 2026-10-28 every Multi Review step (preparation, consolidation, Fix)
  and Build Pipeline consolidation declare theirs too
  ([0724](0724-multi-review-consolidation-grok-pi-result-key.md)).

## Outstanding work

### Qualification

- **Read-only Grok and Pi reviewers submit their report.** In a packaged review,
  check that a Grok and a Pi reviewer each validate and submit
  `submit_review_report` and the workflow consolidates their report. Grok's
  permission request must carry the call's arguments (`rawInput`, or
  `tool_input` under `use_tool`) for the key check to pass; confirm it does.
- **`report_finding` on every provider.** Run a packaged Multi Review with one
  reviewer per provider (Claude, Codex, Cursor, Grok, OpenCode, Pi) and check
  that each reviewer calls the tool, that "Findings so far" fills in while it
  runs, that the accepted report replaces the provisional rows, and that a
  reviewer stopped mid-run keeps its findings as unconfirmed. Repeat one
  provider in a container environment, where the attempt server is reached at
  `host.docker.internal`. Each bridge's auto-allow path has a unit test; none
  has been run against a real model. Batch with
  [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).
- **Zoom, pan and the error tooltip on real devices.** The browser suite
  covers them in Chromium at desktop and phone sizes (`e2e/MultiReviewFlow.spec.ts`),
  including Ctrl + wheel, a synthetic two-finger touch pinch and synthetic
  Safari gesture events, and its zoom, pan and tooltip cases pass under
  Playwright WebKit, but not a real trackpad pinch in the desktop app, a
  phone's own pinch, or Safari's own gesture events in the web client. Steps
  are in Assumptions and decisions.

### Known limits (by design)

- A finding staged by `report_finding` lives in memory until the next review
  pass records it; one staged when the backend stops is lost. The report still
  carries it.
- A queue position is an observation, so the stored one can trail the
  scheduler by one admission until the next commit.
- No expected start time for queued reviewers: nothing measures how long a
  provider takes to admit one.
- The new reviewer fields (`admissionState`, `queuePosition`,
  `provisionalFindings`) are additive, but the strict workflow validators of an
  older backend or renderer reject a workflow that carries them. They exist
  only while a review is running (admission fields while a reviewer is queued,
  provisional findings until the report lands or the workflow completes), so a
  downgrade or an old gateway tab is affected only for a workflow mid-review.

## Constraints and rationale

- The graph is a projection of the workflow snapshot. Selection, zoom and pan
  are view state and never reach the workflow record. Nothing about a node's
  state may come from the transcript tail.
- Every new read needs explicit byte and count bounds, and must poll only for a
  visible, live node (AGENTS.md transport invariants 3 and 11).
- Provisional findings are progress, never results: the renderer only shows
  them, consolidation never reads them, and the accepted report wins. A tool a
  read-only turn may call must touch nothing in the workspace; `report_finding`
  writes only to its own attempt's record in the backend.

## Related

- [0027-multi-review-scale-and-cost.md](0027-multi-review-scale-and-cost.md): admission,
  reviewer transcripts and the queue fields.
- [0025-multi-review-panel-value.md](0025-multi-review-panel-value.md): consolidation and
  reviewer overlap, which the findings column makes visible.
- [0724-multi-review-consolidation-grok-pi-result-key.md](0724-multi-review-consolidation-grok-pi-result-key.md):
  read-only Grok and Pi consolidation sending no `workflowResultKey` (task 2), split out.
- [0860-multi-review-inspector-webkit-divergences.md](0860-multi-review-inspector-webkit-divergences.md):
  inspector tests that fail under Playwright WebKit, found while qualifying task 5.
