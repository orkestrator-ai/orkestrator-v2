# Full and isolated suites fail on `main` in the DOM-assertion scanner, two backend tests, two graph journeys and the container Files panel

## Task analysis

Analysed 2026-11-03 against main at `b0dcf1660`.

### Tasks

1. **The DOM-assertion scanner finds six offending test files**: open.
2. **`build pipeline commands` expects `restartStep` without its selection argument**: open.
3. **The workflow baseline cannot capture a ticket delivery policy**: open.
4. **Two graph journeys cannot find their environment in the sidebar**: done (spec drift, not a regression).
5. **The container Files panel shows a change while the document is hidden**: open.

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

On 2026-11-03, against `main` at `7b48c23fb` on a disposable codex profile (`dev:test --fixture --no-agent-credentials --agent-platforms codex --headless-electron`), a probe created a stopped local environment after the page had loaded: the sidebar listed it live, with the accessible name `probe-stopped-2922, on beelink, Idle`. Since `980719e6c` (#1553) a client that can show several machines labels every row of its own machine `<name>, on <machine>, <activity>` (`environment-row-model.ts`), so the exact name `graphs-designer-other` and the pattern `/^graph-human-run(\s|$)/` no longer match. The product did not regress; the specs drifted. With the row matcher fixed, the human-approval case then failed on its unread bell: the run reached its first human wait before the switch away had landed (wait opened 26.16 s, switch started 27.46 s), so the renderer cleared the unread badge of the environment still on screen (`useUnreadEnvironmentSync`), and `get_environment` reported `hasUnreadWork: false` with the wait's attention key recorded. On this host both specs also met the modal "Docker containers can't reach Orkestrator" dialog, which hides the whole page from Playwright until closed.

With the fix at `04a57aefa`, on a fresh disposable codex profile (`dev:test --fixture --no-agent-credentials --agent-platforms codex --headless-electron`, load average ~47 on 16 cores), `bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/graph-designer.spec.ts e2e/agent-testing/graph-run-view.spec.ts --workers=1 --retries=0` through `test:logged` passed twice in a row: 5 passed, 1 skipped (the opt-in profile-restart case at `graph-run-view.spec.ts:659`), 0 failed, including `graph-designer.spec.ts:33` and `graph-run-view.spec.ts:433`.

Re-run on the branch head `7d99f7acc` (the last code change, which only adds the Docker dialog handler to `graph-designer-mock.spec.ts`) on 2026-11-03, on a fresh disposable codex profile started the same way (load average ~4.5): the same command passed twice in a row (49–51 s each, `test:logged` exit 0). The JSON reporter recorded 5 expected, 1 skipped, 0 unexpected, 0 flaky: `graph-designer.spec.ts:33` and `:239`, `graph-run-view.spec.ts:48`, `:188` and `:433` passed; `graph-run-view.spec.ts:659` (opt-in profile restart) skipped. `graph-designer-mock.spec.ts` passed on the same profile (1 passed). The profile was stopped and reset afterwards.

**Decisions.**

- **Where to start?**
  - **Check whether the sidebar still lists a stopped local environment created after the page loaded, and what its accessible name is now (recommended; taken, see Assumptions and decisions).**
    - Pros: one question covers both cases.
    - Cons: needs a live profile.
  - **Reload the page after `create_environment` in both specs.**
    - Pros: quick.
    - Cons: would hide a sidebar that no longer picks up new environments live.

### 5. The container Files panel shows a change while the document is hidden

**Problem.** In the isolated Docker suite, `e2e/agent-testing/container-files-wiring.spec.ts:64` (`Docker fixture container Files panel follows changes across switch, hidden document, reload and two windows`) fails at line 114: after the test hides the document and writes `qa-wiring-hidden-<run>.txt` in the container, the Files panel already lists the file, where the test expects the poll to pause until the document is visible again.

**Context.** The test came in with `3cd8f0add` (#1541). The terminology branch does not touch the Files panel, its polling or the container fixture.

**Investigation.** `mise run test:agent:docker:isolated` on a detached `origin/main` at `b0dcf1660` failed the same case at the same line (`toHaveCount(0)` received 1, 14 resolutions) with the same counts as the branch's preparation run: 1 failed, 19 passed, 4 skipped. The companion case `local Files panel shows a file whose announcement arrived while hidden` passed on both.

**Decisions.**

- **How to proceed?**
  - **Find which path delivered the change while hidden (the paused poll, a pushed file-change event, or a refresh on another trigger) before changing the test (recommended).**
    - Pros: tells a real pause regression apart from a test that assumes too much.
    - Cons: needs the Docker fixture.
  - **Drop the hidden-document step.**
    - Pros: quick.
    - Cons: loses the only check that hidden windows stop polling containers.

## Assumptions and decisions

### Task 4: fix the specs, not the sidebar

The live check showed the row is listed and only its accessible name changed, so the product stays as it is. `sidebarEnvironmentRow` in `e2e/agent-testing/sidebar-project.ts` matches a row button whose name starts with the environment name followed by a comma, whitespace or nothing, which covers the machine-aware label and the content-derived name of a single-machine client without matching a longer name. Both graph specs use it; `graph-run-view.spec.ts` drops its local `sidebarRow`. Matching the full label (`, on beelink, Idle`) was rejected because the machine name and activity text vary by host and state.

### Task 4: assert the unread bell on the wait that opens while away

The first human wait opens before the test can switch away, so its badge is cleared as seen; that is the intended behaviour of `useUnreadEnvironmentSync`, not a bug. The case still checks the `waiting` marker after the first wait, and now checks the bell after answering it, when the second wait opens with the environment genuinely away. Slowing the template with an extra node or launching through the command path instead of the Run graph dialog were rejected: the first changes what the journey qualifies, the second skips the dialog the case covers.

### Task 4: close the host Docker reachability dialog

`graph-designer.spec.ts`, `graph-run-view.spec.ts` and `graph-designer-editing.spec.ts` install the existing `acknowledgeDockerReachabilityWarning` helper from `e2e/docker-reachability-warning.ts` in `beforeEach`. The initial implementation overlooked that shared helper and added a duplicate; review caught this and the duplicate was removed. The shared helper now accepts an optional `TestInfo`: overlay callers retain their annotations, while local graph journeys dismiss the notice without an inaccurate docker-exec annotation. Reusing the helper avoids selector drift; retaining a separate copy would isolate callers but duplicate maintenance (reuse is recommended). Existing inline copies elsewhere were left alone to keep the change scoped.

### Task 4: a blank page after reload under load is recorded, not fixed

One run failed `graph-run-view.spec.ts:48` with a blank page after `page.reload()` at load average ~56; it passed in the run before and alone afterwards. Recorded as flake [3610](../../tests/flaky-tests/web-ui/3610-graph-run-view-blank-page-after-reload.md).

## Related

- [2921-component-browser-failures-on-main.md](2921-component-browser-failures-on-main.md), the component browser failures on `main` found in the same branch's validation.
- [2920-upstream-pool-idle-test-accept-race.md](../previews-and-annotations/2920-upstream-pool-idle-test-accept-race.md), the default-suite failure on `main`.
- [0030-test-suite-and-ci-health.md](0030-test-suite-and-ci-health.md).
