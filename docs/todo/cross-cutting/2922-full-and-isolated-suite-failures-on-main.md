# Full and isolated suites fail on `main` in the DOM-assertion scanner, two backend tests, two graph journeys and the container Files panel

## Task analysis

Analysed 2026-11-03 against main at `b0dcf1660`.

### Tasks

1. **The DOM-assertion scanner finds six offending test files**: open.
2. **`build pipeline commands` expects `restartStep` without its selection argument**: open.
3. **The workflow baseline cannot capture a ticket delivery policy**: open.
4. **Two graph journeys cannot find their environment in the sidebar**: open.
5. **The container Files panel shows a change while the document is hidden**: done (2026-11-03: the backend's change projection delivers it; the spec was wrong and now checks the page poll on the All files tab).

### 1. The DOM-assertion scanner finds six offending test files

**Problem.** `tests/unit/test-diagnostic-bounds.test.ts` (`bounded test diagnostics > never passes a DOM-producing query result directly to toBeNull`) fails. It lists `tests/unit/components/KanbanTaskDialog.test.tsx`, `tests/unit/components/KanbanCard.test.tsx`, `apps/web/src/components/environments/FeatureBuildFields.test.tsx`, `apps/web/src/components/build-pipeline/PipelineKeyInformationTab.test.tsx`, `apps/web/src/components/kanban/ProjectNotesView.test.tsx` and `apps/web/src/components/federation/sidebar-parity.test.tsx`, each with at least one `expect(screen.queryBy…(…)).toBeNull()`.

**Context.** The scanner exists so a failing absence assertion cannot print a whole DOM subtree. The offending lines came in with `508995a94` (#1584, ticket delivery policy: the first three files), `04096f24f` (#1610) and `643ce87c4` (#1613); `sidebar-parity.test.tsx` has four. In the aggregate run it reported 10.2 s because the scan shares the host; alone it fails in about 2 s.

**Investigation.** `bun test tests/unit/test-diagnostic-bounds.test.ts` fails with the same six files on a detached `origin/main` at `fd679c0e2`, at `b0dcf1660`, and on the terminology branch (`rename-environment-kinds-fbee095fc40a-r1`), which adds no `toBeNull` assertion.

**Decisions.**

- **How to fix the offenders?**
  - **Rewrite each with `rewriteUnsafeDomAbsenceAssertions` from `tests/dom-assertion-safety.ts`, giving `expect(… === null).toBe(true)` (recommended).**
    - Pros: the scanner's own rewrite, so the result is exactly what it accepts; no behaviour change.
    - Cons: touches six files owned by different areas.
  - **Exempt the files.**
    - Pros: none beyond speed.
    - Cons: brings back unbounded failure output, the thing the scanner prevents.

### 2. `build pipeline commands` expects `restartStep` without its selection argument

**Problem.** `apps/backend/src/core/commands-state-sync.test.ts:5320` (`build pipeline commands > delegates lifecycle operations to the backend supervisor`) expects `restartStep("pipeline-1", "review-session")` but the command calls it with a third argument, `undefined`.

**Context.** `a73bc1cdc` (#1611, restart speed) made `restart_build_pipeline_step` (`commands-registry-build.ts`) pass an optional `selection` through to `buildPipelines.restartStep`. The test's call-shape assertion was not updated.

**Investigation.** The owning file fails the same single case (175 pass, 2 fail with task 3's file) on detached `origin/main` at `fd679c0e2` and `b0dcf1660` and on the terminology branch.

**Decisions.**

- **How to fix?**
  - **Assert `toHaveBeenCalledWith("pipeline-1", "review-session", undefined)` and add one case that passes a selection (recommended).**
    - Pros: pins the new argument instead of only tolerating it.
    - Cons: none of note.
  - **Drop the arity check.**
    - Pros: shortest.
    - Cons: would no longer catch a dropped selection.

### 3. The workflow baseline cannot capture a ticket delivery policy

**Problem.** `apps/backend/tests/recurring-baseline.test.ts:232` (`driven workflow supervision baseline (step 08) > is deterministic, content-free, and keyed selection no longer scales with history`) throws `Could not capture the ticket delivery policy` from `launchDeliveryPolicy` in `build-pipeline-service-lifecycle.ts`.

**Context.** `508995a94` (#1584) made `start()` read the Kanban ticket's delivery policy through `ctx.invoke("get_kanban_tasks")` whenever the input names a `taskId`, and throw unless an array comes back. `seedBuildPipelines` in `apps/backend/scripts/recurring-baseline-workflows.ts` starts pipelines with `taskId: "task-N"` through `reviewInvoke`, which does not answer `get_kanban_tasks`.

**Investigation.** Fails identically on detached `origin/main` at `fd679c0e2` and `b0dcf1660` and on the terminology branch.

**Decisions.**

- **Where to fix?**
  - **Make the baseline's invoke answer `get_kanban_tasks` with `[]` (recommended).**
    - Pros: matches a real project with no such ticket; the service keeps refusing an unreadable answer.
    - Cons: none of note.
  - **Fall back to `input.deliveryPolicy` when the read is not an array.**
    - Pros: no script change.
    - Cons: weakens a deliberate refusal in production code to suit a script.

### 4. Two graph journeys cannot find their environment in the sidebar

**Problem.** In the isolated browser agent suite, `e2e/agent-testing/graph-designer.spec.ts:31` (`Graphs designer shows built-ins, imports JSON and pins diagnostics`) times out clicking the sidebar button named exactly `graphs-designer-other`, and `e2e/agent-testing/graph-run-view.spec.ts:436` (`a human approval waits while its environment is away and is answered later`) never finds the `environment-status-marker` of the row named `/^graph-human-run(\s|$)/`. Both environments are created through `create_environment` earlier in the same test.

**Context.** The page snapshot shows the fixture project with no environment rows when the click times out. The federated sidebar was reworked recently (`0412ae2c4`), which is also behind the drag failures in [2921](2921-component-browser-failures-on-main.md); whether the same change hides these rows was not established.

**Investigation.** Started a disposable `dev:test --fixture --no-agent-credentials --agent-platforms codex` profile on a detached `origin/main` at `b0dcf1660` and ran `bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts` on `graph-designer.spec.ts`, `graph-run-view.spec.ts` and `graph-designer-editing.spec.ts` with `--workers=1 --retries=0`: the same two cases failed with the same errors (2 failed, 4 passed, 1 skipped). The third failure in the branch's run, `graph-designer-editing.spec.ts` (edge count 2, expected 1), passed on `main` and is open flake [1311](../../tests/flaky-tests/web-ui/1311-graph-designer-keyboard-undo-edge.md).

**Decisions.**

- **Where to start?**
  - **Check whether the sidebar still lists a stopped local environment created after the page loaded, and what its accessible name is now (recommended).**
    - Pros: one question covers both cases.
    - Cons: needs a live profile.
  - **Reload the page after `create_environment` in both specs.**
    - Pros: quick.
    - Cons: would hide a sidebar that no longer picks up new environments live.

### 5. The container Files panel shows a change while the document is hidden

**Problem.** In the isolated Docker suite, `e2e/agent-testing/container-files-wiring.spec.ts:64` (`Docker fixture container Files panel follows changes across switch, hidden document, reload and two windows`) fails at line 114: after the test hides the document and writes `qa-wiring-hidden-<run>.txt` in the container, the Files panel already lists the file, where the test expects the poll to pause until the document is visible again.

**Context.** The test came in with `3cd8f0add` (#1541). The terminology branch does not touch the Files panel, its polling or the container fixture.

**Investigation.** `mise run test:agent:docker:isolated` on a detached `origin/main` at `b0dcf1660` failed the same case at the same line (`toHaveCount(0)` received 1, 14 resolutions) with the same counts as the branch's preparation run: 1 failed, 19 passed, 4 skipped. The companion case `local Files panel shows a file whose announcement arrived while hidden` passed on both.

Delivery path (2026-11-03, main at `7b48c23fb`, beelink, disposable `dev:test` profile with `--fixture-environments local,container --fixture-network full`, headless Chromium). The change reaches the Changes tab through the backend's change projection, not through any page poll:

- Since `d9bc8b840` (agent change tracking, 2026-10-20) the Changes tab is `ChangesView` over `useEnvironmentChangeRows`. `useFilesPanel.ts` turns the 5 s coordinated poll off while the projection owns that tab (`projectionOwnsChanges`), so the "paused poll" the spec waited out does not run on the Changes tab at all, visible or hidden.
- The backend scans every running container on its own clock (`diff-stats-service.ts`: every 15 s when the container's worktree signal is not armed, within about 2 s of a signal ring when it is), and `environment-projector.ts` publishes `CHANGE_PROJECTION_CHANGED_EVENT`. `lib/changes/subscriptions.ts` applies it and `useEnvironmentChangeRows` reads the first page (`changes_get_view`) with no visibility check.
- A diagnostic spec sampled once a second while hidden. On the Changes tab: the backend `diff-scan` count advanced on its 15 s clock, the renderer's projection revision went up, the row appeared 4 s and, in a second run, about 13 s after the write, and the only command the page sent was `changes_get_view`. On the All files tab: visible, the page sent `get_file_tree` + `get_git_status` every 5 s; hidden for 32 s, it sent neither and the new tree entry did not appear; it appeared 0.3 to 1.3 s after return.
- Why the result varied: on this host the container's worktree signal fails to arm (`[diff-stats] signal.demoted demotion=arm-failed`, the host's ufw blocks container-to-host), so delivery waits for the 15 s tick, which lands inside the spec's 12 s hidden window about four times in five; an unmodified rerun here passed. Where the signal arms, delivery takes about 2 s and the old assertion fails every time. The 2026-11-01 pass recorded in 0048 is the 15 s case landing late.

So the product is right: a backend-owned projection keeps a hidden page current from pushed events and a backend cache read, which is what the background-work invariants ask for, and the container is not polled from the page while hidden. The spec assumed the Changes tab was still polled.

**Fix.** `e2e/agent-testing/container-files-wiring.spec.ts` now records this page's own Files panel read commands (`get_git_status`, `get_file_tree`, `get_file_subtree` and their local forms) from its `/__orkestrator/invoke` requests, so another client of the profile cannot add or hide one, and splits the hidden step in two:

- **Changes tab:** with the document hidden, a file written in the container shows while still hidden, within 40 s (one 15 s backend interval, a tick skipped after a recent scan, and the scan), and the page sends no Files panel read meanwhile.
- **All files tab:** the visible tab is seen polling; once hidden, the page sends no Files panel read for 18 s (three poll intervals, past the container tree's 10 s cache) and a file written then is absent from the tree; it shows after return, and then on the Changes tab and after the reload.

A run with the document left visible fails the new no-read assertion (10 reads recorded), so the check still catches a page that keeps polling a container while hidden. `docs/development/agent-testing.md` describes the split.

**Decisions.**

- **How to proceed?**
  - **Find which path delivered the change while hidden (the paused poll, a pushed file-change event, or a refresh on another trigger) before changing the test (recommended).**
    - Pros: tells a real pause regression apart from a test that assumes too much.
    - Cons: needs the Docker fixture.
  - **Drop the hidden-document step.**
    - Pros: quick.
    - Cons: loses the only check that hidden windows stop polling containers.

## Assumptions and decisions

### Task 5: fix the spec, not the product

The ticket asked to fix whichever of product or spec was wrong. Options: pause the change projection while the document is hidden (keeps the old spec, but drops pushed state the backend already computed, needs a catch-up read on return, and saves only a backend cache read per revision, since the container scan runs whatever the page does); or make the spec check what the hidden pause covers (recommended). I took the second: the hidden pause exists to stop the page polling containers, and the projection's live-while-hidden behaviour is already relied on by the local case in the same spec.

### Task 5: assert on this page's requests rather than the backend's counters

`get_recurring_work_diagnostics` counts reads from every client of the profile, and its `file-tree-read` count also rises on backend-side re-walks; one rose while the page was hidden. Recording the page's own `/__orkestrator/invoke` commands is exact for the page under test. The tree-entry absence check is kept as the user-visible half.

### Task 5: run with a full-network fixture container

On beelink, 29 leaked `reach-probe-net` networks from other owners fill Docker's default address pools (follow-up [3320](../containers-and-environments/3320-leaked-probe-networks-block-docker-fixtures-on-beelink.md)), so the fixture could not create its environment network. For the live runs a PATH shim outside the repository gave this profile's networks explicit `10.229.x.0/24` subnets. With that subnet the restricted container's egress gateway failed to apply its policy, so the fixture used `--fixture-network full`. The Files panel path does not depend on the network policy. Not run: the restricted-mode fixture and `mise run test:agent:docker:isolated` end to end.

## Related

- [2921-component-browser-failures-on-main.md](2921-component-browser-failures-on-main.md), the component browser failures on `main` found in the same branch's validation.
- [2920-upstream-pool-idle-test-accept-race.md](../previews-and-annotations/2920-upstream-pool-idle-test-accept-race.md), the default-suite failure on `main`.
- [0030-test-suite-and-ci-health.md](0030-test-suite-and-ci-health.md).
