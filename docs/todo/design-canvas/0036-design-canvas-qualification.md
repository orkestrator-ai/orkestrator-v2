# Design canvas qualification

Checked against `main` at `2459b05c` (2026-10-15); the flake review against
`9906db30` (2026-10-16); the live agent cycle against `a5d338c1`
(2026-10-18) and its Claude rerun against `9b3f53a2` (2026-10-21); container
export, Electron, accessibility and client performance against `b83ae534`
(2026-10-22, see [Qualification evidence](#qualification-evidence-2026-10-22));
the opening prompt, export into an Orkestrator container, mixed versions and
the 0174 reproduction against `20f6de91` (2026-10-25, see
[Qualification evidence (2026-10-25)](#qualification-evidence-2026-10-25));
container export on Linux Docker Engine, the Linux client performance run and
flakes 0208 and 0174 against `93b99bfb` (2026-11-01, see
[Qualification evidence (2026-11-01)](#qualification-evidence-2026-11-01)).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Opening prompt without the tab mounted**: the backend sends the brief for a new design tab. Status: done (#1262). One accepted residual window and a stale test name remain.
2. **Container export on Linux Docker Engine**: the export protocol against a real Linux Engine. Status: done (2026-11-01): passed on Docker Engine 29.9.2 (Linux x64), both the backend file and the Docker fixture spec, and the backend file now runs in the Linux Engine CI workflow on amd64 and arm64.
3. **Electron gaps**: native menu key equivalents, the OS Save dialog, the packaged `file://` renderer, and the unexplained Ctrl/⌘+0 failure. Status: open.
4. **Human screen-reader pass**: VoiceOver and NVDA over the layer tree, frame list, inspector and status regions. Status: open.
5. **Client performance on other hosts and Electron**: rerun the perf harness on Linux and a slower machine, and decide about Electron. Status: Linux done (2026-11-01, on a busy shared host, so host evidence only); its leak check found listener and frame growth at 64 frames, now to-do [2140](2140-design-frame-bridge-growth-under-culling.md). A slower machine and the Electron decision stay open: the 2026-11-01 host is not a slow laptop.
6. **Old renderer with new backend, and the reverse**: the renderer half of mixed versions. Status: open (published desktop builds exist).
7. **Interrupted migration on a real binary**: the record-written, legacy-not-moved window. Status: deferred (unreachable from outside the process; unit-covered).
8. **Design browser flakes 0208 and 0174**: the import picker late in the suite, and the parallel canvas timeout. Status: done (2026-11-01): 0208 was a picker race, fixed in the product; 0174 was the journey's page loads spending its budget under parallel load, fixed in the test. Both are resolved in the registry, and a host cause that hits any browser suite on a Linux host with Docker churn is recorded as [2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md).
9. **Deferred optimisations**: thumbnails, capture cache, second render worker, warm context pool, storage redesign, plus the open question on whether thumbnails are wanted. Status: deferred.
10. **Shared live-provider harness (open question)**: whether design joins a shared live harness. Status: done in practice (own specs with a shared support module).
11. **Cross-environment transfer UI (open question)**: whether to build one. Status: open (question only).

### 1. Opening prompt without the tab mounted

**Problem.** A **New design workspace** brief used to depend on the new tab being mounted. A user who switched environment at once could lose the brief, or have it sent twice.

**Context.** Fixed on 2026-10-25 by handing the brief to the backend's durable prompt queue under `initial-prompt:<environment>:<tab>` (decisions 1–4).

**Investigation.** Done at HEAD:
- `handTabInitialPromptToBackend` is at `apps/web/src/lib/tab-initial-prompt.ts:163`. It is called from `apps/web/src/components/design/DesignWorkspaceDialog.tsx:415` and `apps/web/src/components/layout/useActionBarController.ts:856`.
- The `noQueue` guard is at `apps/web/src/components/native-agent/AgentNativeTab.controller.tsx:1650-1656` and `:2477`, and its test is at `AgentNativeTab.test.tsx:6542`.
- The inactive real-stack case at `e2e/agent-testing/design-canvas.spec.ts:480` is now named "an image brief drains after enqueue acknowledgement and fallback failure while inactive", not "a new design tab's brief is sent while its environment is inactive" as "Current state" says. It was renamed within #1262.
- The residual window from decision 1 still exists: a renderer that dies between creating the tab and the queue write loses the brief.

**Decisions.**

- **Close the renderer-death window?**
  - **Accept it and record it in `design-canvas.md` (recommended).**
    - Pros: the window is a few milliseconds of renderer work; no new backend surface; the same exposure exists for every renderer-created tab.
    - Cons: a crash at exactly that moment still loses a brief silently.
  - **Have the backend create the tab and queue the prompt in one command (decision 1 option a).**
    - Pros: atomic; nothing depends on the renderer surviving.
    - Cons: a new backend command and layout write path for a rare crash; the pane layout deliberately never stores prompts.

### 2. Container export on Linux Docker Engine

**Problem.** The export protocol, including reconciliation by digest after a killed client, is proved only on Docker Desktop for macOS. Linux Engine users run the same helpers on a different daemon, filesystem and stdin-close behaviour. The "killed after every byte" case depends on the daemon closing the helper's stdin.

**Context.** Batched with 0019. The file says "this machine is macOS with Docker Desktop only". That was true of the earlier host; it is not true of every host this work runs on.

**Investigation.**
- `apps/backend/src/core/design/export-container.test.ts` is unchanged in shape: 11 cases, gated on `ORKESTRATOR_TEST_DOCKER_DESIGN_IMAGE` (`:40`, `:114`).
- This host runs Docker Engine 29.9.1 on Linux x64 (rootful, seccomp builtin), with `orkestrator-v2:latest` (two weeks old) and a current dev image available.
- `.github/workflows/container-live-qualification.yml` already runs real Linux Engines on `ubuntu-24.04` and `ubuntu-24.04-arm`, with `ORKESTRATOR_QUALIFICATION_IMAGE` built per job (`:59-61`). It does not run `export-container.test.ts`, and `tests/unit/ci-workflows.test.ts` only checks the suites it lists.
- The Orkestrator-created path (`e2e/agent-testing/design-container-export.spec.ts:55`, run by `mise run test:agent:docker`) needs a `dev:test --fixture-environments local,container` profile, so it cannot run in that workflow.

**Decisions.**

- **Where to qualify Linux Engine?**
  - **Add `export-container.test.ts` to `container-live-qualification.yml`, with `ORKESTRATOR_TEST_DOCKER_DESIGN_IMAGE` set to the job's qualification image, and list it in `ci-workflows.test.ts` (recommended).**
    - Pros: amd64 and arm64 Linux Engine every week and on PRs touching it; no shared-host risk; no change to the test.
    - Cons: adds about 10–30 s per architecture to that workflow; CI runners are not a user's host (no rootless, no SELinux).
  - **One manual run on this Linux host: the backend file plus `mise run test:agent:docker` on a `--fixture-environments local,container` profile.**
    - Pros: covers the Orkestrator-created container on Linux too; quick.
    - Cons: one-off evidence; the host also runs a production instance, so the run needs care (exact-owner labels already handle cleanup).
  - **Leave it batched in 0019 until a Linux pass happens there.**
    - Pros: no new work now.
    - Cons: keeps the "Docker Desktop for macOS only" qualification although a Linux Engine is already at hand.
- **What counts as a pass?** All 11 backend cases pass on both CI architectures. A pass on this host also needs `design-container-export.spec.ts` to pass once. A skip (no image variable) is not a pass.

**Outcome (2026-11-01).** Both options were taken. On beelink (Docker Engine 29.9.2, Linux x64, rootful) the backend file passed 4 of 4 runs (11 cases each) and `design-container-export.spec.ts` passed 3 of 3 against a headless `dev:test` profile; nothing needed fixing. The backend file is now a step of `container-live-qualification.yml`, with the job's own image, and `ci-workflows.test.ts` pins it. The arm64 half is that workflow's first run, which had not happened when this was written. See [Container export on Linux](#container-export-on-linux).

### 3. Electron gaps

**Problem.** Four Electron behaviours are unproven:
- OS-delivered key equivalents through the native menu.
- The OS Save dialog of a download.
- The packaged `file://` renderer.
- A one-in-twelve failure where Ctrl/⌘+0 left the canvas at 71%.

The menu gap has a concrete risk. The application menu binds the same keys the canvas claims.

**Context.** Playwright sends keys through Chromium, not the OS. The production main loads the renderer from `process.resourcesPath/web` (`apps/desktop/electron/main.ts:768`, `:1141`, `:1234`), so a dev-served spec never sees it. 0031 batches Electron runs.

**Investigation.**
- `apps/desktop/electron/application-menu.ts:119-122` gives View → **Actual Size** `CmdOrCtrl+0` (and Zoom In/Out `CmdOrCtrl+=`/`-`). These emit `menu-zoom` (`main.ts:718`). App.tsx's `menu-zoom` listener (`apps/web/src/App.tsx:907`) resets app zoom with no check for the canvas. Only the keydown handler checks `defaultPrevented` (`:930`).
- If the OS key equivalent reaches the menu even though the canvas claimed the key, Ctrl/⌘+0 on a focused canvas would reset both canvas zoom and app zoom. Chromium normally gives the page first refusal on key equivalents, so this is expected to be fine, but nothing has checked it.
- Edit → `undo`/`redo` roles (`application-menu.ts:107-108`) have the same question for ⌘Z on the canvas.
- The spec header (`e2e/agent-testing/design-canvas-electron.spec.ts:25-37`) still lists the packaged renderer as not covered.
- `mise run package:linux` builds and installs an unpacked Linux app, and release assets include an AppImage, a pacman package and a dmg (checked for v2.22.3). So a packaged renderer can be run without a release.

**Decisions.**

- **How to cover the packaged renderer?**
  - **A Playwright `_electron.launch({ executablePath })` variant of the design Electron spec against a `mise run package:linux` build, run with the release smoke (recommended).**
    - Pros: exercises `file://` loading, the CSP and asset paths with the existing assertions; repeatable on Linux without signing.
    - Cons: needs a packaged build (minutes); the macOS bundle still needs its own run.
  - **A manual checklist on the release build.**
    - Pros: no harness work.
    - Cons: not repeatable; easy to skip.
- **How to settle native menu key equivalents?**
  - **A manual pass in a real macOS desktop session: ⌘0, ⌘=, ⌘- and ⌘Z with the canvas focused, checking that app zoom does not change (recommended).**
    - Pros: answers the exact question in minutes; no code change unless it fails.
    - Cons: needs an unshared desktop session; Linux and Windows menu accelerators remain unchecked.
  - **Defensively ignore `menu-zoom` while the canvas owns shortcuts.**
    - Pros: removes the double-reset whatever the OS does.
    - Cons: a mouse click on View → Actual Size while the canvas is focused would stop resetting app zoom, which is wrong; a fix for an unproven bug.
- **Keep the OS Save dialog check?**
  - **Retire it (recommended).** The product installs no `will-download` handler, so the dialog is Electron's own default, and the spec already proves the download manager path.
    - Pros: drops a check that tests Electron, not Orkestrator.
    - Cons: a future `will-download` handler would need its own test (worth noting in `design-canvas.md`).
  - **Keep it in the macOS manual pass.**
    - Pros: costs seconds alongside the menu check.
    - Cons: keeps an item open for no product code.
- **The unexplained Ctrl/⌘+0 failure?**
  - **Keep the key-event dump and close the item unless it recurs in the batched Electron runs (recommended).**
    - Pros: no recurrence in eight runs; the diagnostics are in place.
    - Cons: the re-measure wait in the spec could hide a real timing issue.
  - **Investigate now by stressing the step (`--repeat-each`) under CPU throttle.**
    - Pros: may find a product race.
    - Cons: time on a one-in-twelve failure with no user report.

### 4. Human screen-reader pass

**Problem.** No screen reader has been used on the canvas. Verbosity, live-region timing during nudge bursts, the `aria-description` on frames, Preview-mode frames and browse-mode navigation are unknown to screen-reader users.

**Context.** The automated pass and 0054 fixed every defect the tree and focus checks could find. 0054 deliberately chose label-only inspector names and left verbosity to this pass.

**Investigation.** The surfaces exist as described:
- the frame `aria-description` at `apps/web/src/components/design/DesignFrameView.tsx:343`;
- the layer tree's polite region at `DesignLayerTree.tsx:824`;
- the save state and status at `DesignStatus.tsx:200` and `:294`;
- the canvas announcer at `DesignCanvasTab.tsx:1150`.

No screen-reader automation (for example Guidepup) is a dependency, and Orca is not installed on this Linux host. The pass still needs a person.

**Decisions.**

- **Which readers, and who?**
  - **VoiceOver on macOS first, then NVDA on Windows, by someone who uses a screen reader daily, following a checklist built from the five areas above (recommended).**
    - Pros: the two most-used desktop readers; a daily user catches verbosity problems a sighted tester accepts.
    - Cons: needs access to such a person and a Windows machine.
  - **VoiceOver only, by the team.**
    - Pros: available now on the dev Macs.
    - Cons: NVDA's browse mode and virtual cursor differ the most from VoiceOver, and that is where the canvas and iframes are riskiest.
  - **Automate with Guidepup in CI.**
    - Pros: repeatable.
    - Cons: a new dependency and macOS/Windows runners with screen readers; it checks speech strings, not whether the experience is usable.
- **What counts as a pass?** Every journey step of `DesignCanvasAccessibility.spec.ts` completed by speech alone, with findings filed as a new numbered todo (not added here), and the label-only naming either confirmed or reversed.

### 5. Client performance on other hosts and Electron

**Problem.** The client numbers come from one Apple M5 Max running headless Chrome. A slower laptop or Linux GPU stack could drop pan frames or slow acknowledgments, and nobody would know.

**Context.** The numbers are host evidence, not thresholds. The deferred backend optimisations (task 9) do not depend on them.

**Investigation.**
- `e2e/perf/design-canvas-perf.ts:1449-1450` launches `channel: "chrome"`. This host is a Linux x64 laptop with an AMD Ryzen 5 PRO 5650U (12 threads) and Google Chrome at `/opt/google/chrome/chrome`, so it is both "Linux" and "a slower laptop", and the harness can run here unchanged.
- The harness has no Electron mode. Electron 44.7.0 ships Chromium 152, against Chrome 155 in the measured run.

**Decisions.**

- **Where to run next?**
  - **Run the same command on this Linux laptop on a quiet host, keeping the JSON report alongside the M5 Max one (recommended).**
    - Pros: covers both missing host classes in one run; no harness change.
    - Cons: the host is shared with production work, so load must be recorded and runs repeated.
  - **Wait for a dedicated perf machine.**
    - Pros: cleaner numbers.
    - Cons: no such machine is planned; the gap stays open.
- **Measure the Electron renderer?**
  - **No: treat Chrome as a proxy and retire the Electron part unless an Electron-only regression is reported (recommended).**
    - Pros: same Blink and V8 lineage, three Chromium versions apart; avoids building an Electron mode for a measurement nobody is waiting on.
    - Cons: Electron's IPC transport and compositor flags are not measured, and acknowledgment there includes a different hop.
  - **Add an `--electron` mode using `_electron.launch`.**
    - Pros: measures the shipped desktop path, including the transport.
    - Cons: a sizeable harness change; Electron cannot run headless, so it needs a display.

**Outcome (2026-11-01).** The run happened on beelink, not on the Ryzen laptop above: an Intel Core Ultra 9 285H with no Google Chrome, so the harness gained `--browser chromium` (Playwright's Chromium 156) and its `--rev` build was repaired. The host was shared with other builds throughout, so the figures are a busy host's, not reference numbers. See [Client performance on Linux](#client-performance-on-linux). The structural results matched the M5 Max; the 100-cycle leak check did not converge at 64 frames (window listeners and frames grew one for one), which is new to-do [2140](2140-design-frame-bridge-growth-under-culling.md). Still open: a slower machine, and the Electron question above (not decided here). On Linux, `_electron.launch` can now run without a display: Electron 45 starts on `--ozone-platform=headless --disable-gpu` (see decision 11).

### 6. Old renderer with new backend, and the reverse

**Problem.** No run has paired an old renderer with the new backend, or the reverse. The desktop app can connect to a remote backend with either side newer (`docs/architecture/version-compatibility.md:45`, through `apps/desktop/electron/connection-manager.ts`), so users can hit both.

**Context.** The npm package has no renderer. The file says this needs "an old desktop app build", and that is available: GitHub releases v2.21.0, v2.21.1, v2.22.3 and v2.23.0 are published, and v2.22.3 carries an AppImage, a pacman package, a dmg and a zip.

**Investigation.**
- New finding: the renderer's v1 fallback (`getCapabilities` returns `null` on `unsupported`, `apps/web/src/lib/design-client.ts:107-118`, which drives `legacySync` at `apps/web/src/components/design/design-controller.ts:321-334` and `:391`) serves backends without `design_capabilities`. That command shipped in #844 (2026-09-25) and is in every release from v2.21.0, the floor. So the fallback cannot be reached inside the support window.
- `version-compatibility.md:91` says "The renderer has none left", which this path contradicts.
- Newer commands an old renderer lacks are handled on the renderer side, for example the `design_session_link_states` "unsupported" fallback (0038 decision 10; added 2026-10-24, so v2.21–v2.23 backends lack it). That fallback is still needed.

**Decisions.**

- **How to run the renderer half?**
  - **Run the v2.22.3 desktop build (AppImage on this Linux host, or the dmg on macOS) connected to a `dev:test` backend from this checkout. Then run the current renderer from a `dev:test` profile against `orkestrator@2.22.3` installed by `scripts/qualify-design-mixed-versions.ts`. Exercise open, edit, export, Ask agent and Resume (recommended).**
    - Pros: real published binaries on both sides; reuses the existing install step; covers the user path through the connection manager.
    - Cons: manual; an old desktop app on a shared host must use its own data directory and port.
  - **Build old renderers from tags in worktrees (like `qualify-backend-upgrade-rollback.ts`).**
    - Pros: scriptable and repeatable.
    - Cons: not the binary users run; slower.
- **What to do with the renderer's v1 design fallback?**
  - **Retire it: delete the `null`-capabilities path and its `design_action` snapshot use in the controller, and keep `design_action` on the backend for MCP and the old adapters (recommended).**
    - Pros: removes an unreachable branch and its test; makes `version-compatibility.md:91` true.
    - Cons: a source build from before #844, outside the window, would show an error instead of a v1 canvas.
  - **Register it in `version-compatibility.md` as a renderer path with removal condition "met".**
    - Pros: documents it truthfully without code churn.
    - Cons: keeps dead code that the register itself says should go.

### 7. Interrupted migration on a real binary

**Problem.** The window between writing a migrated `.orkrec` and moving the legacy `.orkdes` into `legacy-backups` has not been exercised on a real binary.

**Context.** The window cannot be reached from outside the process. It is covered by "an interrupted migration (record written, legacy not retired) reads the record" (`apps/backend/src/core/design/records.test.ts:323`).

**Investigation.** No fault hook exists in the shipped backend that would let a real binary stop at that point. `records.ts` takes `this.faults` only in tests (`writeAtomically(..., this.faults)`, `apps/backend/src/core/design/records.ts:534`).

**Decisions.**

- **Keep or retire?**
  - **Retire it as covered by the unit test (recommended).**
    - Pros: the unit test uses the real record code and filesystem; a real-binary run adds only process-kill timing.
    - Cons: no proof that a SIGKILL in that window behaves the same as a thrown fault.
  - **Add an env-gated fault hook to the backend and SIGKILL it at the window in the mixed-version script.**
    - Pros: end-to-end proof.
    - Cons: ships a test-only kill point in production code for a window the unit test already covers.

### 8. Design browser flakes 0208 and 0174

**Problem.** Two design browser flakes keep the real-stack and component suites from being reliably green. This file's statements about both are out of date.

**Context.** Flakes are tracked only in `docs/tests/flaky-tests/` (AGENTS.md). This file holds the qualification next steps.

**Investigation.**
- **0174** is `open` again in `docs/tests/flaky-tests/design-canvas-and-artifacts/0000-index.md:16`. It reached its deadlines in the nine-worker suite on `74841142b` on 2026-10-26, waiting for a replacement iframe's `display: inline-block` on mobile, and the cause is not established. So this file's "0174 is resolved; one quiet nine-worker run would confirm" no longer holds.
- **0208** recurred on 2026-10-24 in a full `mise run test:agent:browser:isolated` run (case 56 of 83). Its case now starts at `e2e/agent-testing/design-canvas.spec.ts:305`, with the **Select file** assertion at `:420`; the index still says `:230`.
- **0246**, listed under Related as an open design flake, is `resolved` in the index (`:23`).
- The CPU throttle (`ORKESTRATOR_E2E_DESIGN_CPU_THROTTLE`, `e2e/DesignCanvas.spec.ts:14`) exists only in the component spec, not the real-stack one.

**Decisions.**

- **Who owns the flake work?**
  - **The flake registry owns it. This file keeps only "suites green" as a qualification gate that links 0174 and 0208 (recommended).**
    - Pros: follows AGENTS.md; avoids two diverging records, which already happened with 0174 and 0246.
    - Cons: the design-specific next steps move into the case files.
  - **Keep the next steps here.**
    - Pros: one place for design qualification.
    - Cons: duplicates the registry and drifts, as this file already has.
- **Next step for 0208?**
  - **Port the CDP CPU throttle to `design-canvas.spec.ts` and run the private-canvas case under it (recommended).**
    - Pros: the same approach found 0174's first race in hours; it does not need an idle host, which this shared host never is.
    - Cons: a harness change in the real-stack spec; may reproduce only budget exhaustion, not the real ordering.
  - **A full shared-profile `mise run test:agent:browser` run on an idle host, as the file says.**
    - Pros: reproduces the real setting.
    - Cons: needs an idle host, which has not been available on any recorded date.
- **Next step for 0174?**
  - **Reproduce the mobile replacement-iframe stall under the existing throttle before changing anything (recommended).**
    - Pros: same method that found the first cause.
    - Cons: may be another budget-only failure.
  - **Raise the per-test deadline for the mobile project.**
    - Pros: quick.
    - Cons: decision 7 rejected this, because it hides real stalls.

**Outcome (2026-11-01).** The registry owns the detail; see [Design flakes (2026-11-01)](#design-flakes-2026-11-01).
- **0208** is a product race: the host path picker's first listing replaced a path typed before it landed, so Enter browsed the home folder and **Select file** stayed disabled. Fixed in `HostPathPickerDialog.tsx`, with a unit reproduction and a real-stack A/B (decision 12).
- **0174** reproduced 16 of 16 with eight workers on a loaded host, without throttling: the two dev-server page loads took 14–16 s of the 30 s budget and no step stalled. The test now adds page-load time back to its deadline (decision 13). The CPU throttle found nothing new: 4x passed 10 of 10, 8x 9 of 10, and the failure was the host cause below.
- **2340** (environmental): on Linux, Chromium aborts in-flight loopback requests with `net::ERR_NETWORK_CHANGED` whenever Docker adds or removes a bridge or veth, so pages from a Vite server render blank while other work starts containers. It spoiled several runs here and is the likely cause of 0826's blank fixture pages.

### 9. Deferred optimisations

**Problem.** Five optimisations are deliberately unbuilt: thumbnails, a capture/inspection cache, a second render worker, a warm context pool, and a storage redesign. The open question asks whether thumbnails are wanted at all.

**Context.** Each waits on a measurement. The client numbers (2026-10-22) made no case for them.

**Investigation.** The baseline facts still hold:
- `DESIGN_LIMITS.renderWorkers: 1` is at `packages/protocol/src/design-operations.ts:27`, and the `workers` option is at `apps/backend/src/core/design/renderer.ts:99` and `:200`.
- Whole-record atomic writes go through `writeAtomically` (`apps/backend/src/core/design/records.ts:170`, `:534`).
- Leases use the database (`apps/backend/src/core/design/coordination.ts`).
- Nothing in `apps/web/src/components/design/DesignLibrary.tsx` or the backend design code mentions thumbnails.

No measurement since 2026-09-24 has touched repeated captures, worker contention or rewrite cost.

**Decisions.**

- **Keep them here or split them out?**
  - **Move the five into a new Low todo file ("design canvas deferred optimisations") so this file holds only qualification (recommended).**
    - Pros: this file can finish when qualification does; the deferred list keeps its measurement gates.
    - Cons: one more file; the decision table and baseline have to move with it.
  - **Keep them here.**
    - Pros: no churn.
    - Cons: this Medium file can never be marked Finished while it holds items that may never be built.
- **Are thumbnails wanted on their own merits?**
  - **No, not until users ask: the library lists facts, and the first page renders in about 35 ms at 256 canvases (recommended).**
    - Pros: avoids a render-queue workload that would then justify the cache.
    - Cons: a visual library is harder to scan once there are many canvases.
  - **Yes: build library thumbnails as a product feature.**
    - Pros: a better saved-designs experience.
    - Cons: brings in items 1 and 2 (bounded capture jobs, invalidation, cache) at once.

### 10. Shared live-provider harness

**Problem.** The open question asks whether design should use a shared live harness rather than its own spec.

**Context.** It was asked before the design live specs existed.

**Investigation.** Design now has `e2e/agent-testing/design-live.spec.ts` and `design-resume-clients-live.spec.ts`, which share `e2e/agent-testing/design-live-support.ts`. Both are opt-in and excluded from the default browser run (`e2e/agent-testing/playwright.browser.config.ts:16-17`). They passed for Claude and Codex (2026-10-21, 2026-10-25, 2026-10-26). `opencode-live.spec.ts` is also its own spec. No cross-provider live harness exists to join.

**Decisions.**

- **Answer the question?**
  - **Close it: design keeps its own opt-in specs with a shared support module (recommended).**
    - Pros: matches what shipped and passed; the specs encode design-only steps (stale selection, handoff).
    - Cons: a future shared harness would need to absorb them.
  - **Build a shared live harness and move design onto it.**
    - Pros: one place for provider setup, rate-limit handling and usage logging.
    - Cons: a cross-cutting project with no owner; nothing is blocked on it.

### 11. Cross-environment transfer UI

**Problem.** There is no UI to move or copy a canvas between environments.

**Context.** Recovery copies, download and import cover copying today. If a transfer UI is built, the file requires a defined lock order for two-canvas operations first.

**Investigation.** No two-canvas operation exists. Duplicate stays within one environment. Nothing in the code is waiting on this.

**Decisions.**

- **Build it?**
  - **No: close the question and record "download then import" as the supported path in `design-canvas.md` (recommended).**
    - Pros: no cross-environment lock order to design; the current path works.
    - Cons: two steps for the user and a file on disk in between.
  - **Yes: add "Copy to environment…" with a two-canvas lock order.**
    - Pros: one step.
    - Cons: a new class of concurrent operation across two canvases' lanes, which this file warns needs design first.

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
  has three tests: "real gateway saves a design and rehydrates another client's
  edits", "private canvases survive reload and can be retired to recover
  quota" and "a new design tab's brief is sent while its environment is
  inactive". It drives the backend through the `design_action` gateway command
  and the UI, never through an agent.
- Opening prompt: since 2026-10-25 the backend owns it. The **New design
  workspace** brief goes onto the new tab's durable prompt queue
  (`handTabInitialPromptToBackend`, `apps/web/src/lib/tab-initial-prompt.ts`)
  under `initial-prompt:<environment>:<tab>`, and the backend queue dispatcher
  sends it whether or not the tab is mounted. See
  [`design-canvas.md`](../../architecture/design-canvas.md).
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
  (macOS arm64) and on 2026-11-01 on Docker Engine 29.9.2 (Linux x64); the
  Linux Engine CI workflow now runs it on amd64 and arm64. The container is
  started directly, not by Orkestrator's
  container lifecycle. The Docker fixture case
  `e2e/agent-testing/design-container-export.spec.ts` (part of
  `mise run test:agent:docker`) covers a container Orkestrator created; it
  passed three times on 2026-10-25 (macOS) and three times on 2026-11-01
  (Linux Engine).
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
  measures the backend side. It ran on an Apple M5 Max (2026-10-22) and on a
  busy Linux x64 host with Chromium (2026-11-01).
- Mixed-version fallback and migration are unit-tested
  (`design-controller.test.ts`, `records.test.ts`). On 2026-10-25
  `scripts/qualify-design-mixed-versions.ts` ran the published backend
  `orkestrator@2.22.3` and this checkout's backend over one data directory
  (see [Mixed versions](#mixed-versions)). No run used an old renderer.

## Outstanding work

### Qualification

Live-agent and platform runs share prerequisites and batching with other todo
files; see [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

- **Opening prompt of a new design tab without the tab mounted.** Done on
  2026-10-25 (see [Opening prompt](#opening-prompt)). The brief is handed to
  the backend's durable prompt queue the moment the tab exists, under the
  same request id `initial-prompt:<environment>:<tab>` the mounted tab would
  use, so it is sent at most once with the tab and its environment off
  screen. The review action already did this; both now share
  `handTabInitialPromptToBackend`. The renderer fallback no longer joins a
  running turn's id-less queue. The owning tests are the new inactive case in
  `design-canvas.spec.ts` (fails with the hand-off disabled), "never queues an
  opening prompt behind a running turn" in `AgentNativeTab.test.tsx` (fails
  without the guard), `tab-initial-prompt.test.ts`, and the queue assertions
  in `DesignWorkspaceDialog.test.tsx`.
  - The line 220/221 failure did not reproduce on `20f6de91`: four runs of
    `mise run test:agent:design:isolated` passed before any change, and the
    file with the new case passed twice after it. Something merged between `b83ae534` and `20f6de91`
    fixed the mounted path; the backend hand-off makes it no longer matter.
  - Every other native tab created with an opening prompt already had a
    backend-owned dispatch: the environment's `startup-agent` tab (the launch
    reconciler), review tabs (now through the shared helper) and
    `launch_native_agent_job` tabs. Coordinator conversations bind their
    platform and first prompt through backend authority (`onAssignPlatform`).
    No other caller passes `initialPrompt` to a native tab today; the
    mounted-tab path stays as the fallback, and it alone handles a tab
    resumed to a requested session, because that prompt must be withheld if
    the session was substituted (see
    [Assumptions and decisions](#assumptions-and-decisions)).
- **Real-container export.** Done on 2026-10-22 for the export protocol
  against a running container of the environment image on Docker Desktop
  (macOS arm64): every interruption the item named reconciled by exact
  digest, and reconciliation never started a second writer (see
  [Container export](#container-export)). Local export was already covered by
  `exports.test.ts` and `export-writer.test.ts`. On 2026-10-25 the same
  protocol passed against a container Orkestrator created, through its
  network-policy entrypoint, cloned workspace and `ContainerService`
  lifecycle (`design-container-export.spec.ts`, see
  [Orkestrator container export](#orkestrator-container-export)). On
  2026-11-01 both passed on Docker Engine 29.9.2 on Linux x64 (see
  [Container export on Linux](#container-export-on-linux)), and the backend
  file joined the Linux Engine CI workflow for amd64 and arm64. Describe
  container export as qualified on Docker Desktop for macOS and Docker Engine
  on Linux x64; arm64 Linux follows from that workflow's next run. Not
  covered: rootless Engine and SELinux hosts.
- **Electron window.** Done on 2026-10-22 through
  `e2e/agent-testing/design-canvas-electron.spec.ts` (see
  [Electron](#electron)). Not covered: native menu key equivalents (Playwright
  delivers keys through Chromium, not the OS), the native Save dialog of a
  download (the spec sets the save path in `will-download`), and the packaged
  `file://` renderer. Not attempted on 2026-10-25: the packaged renderer needs
  a packaged app, because the production main loads it from
  `process.resourcesPath/web` (`apps/desktop/electron/main.ts`), so it belongs
  with the release smoke of a built app; the other two need OS-level input
  and dialogs in a real desktop session, which a shared host running other
  worktrees and a production instance is not.
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
  400% zoom layout defect and the other findings were fixed on 2026-10-25 in
  todo 0054 (retired on 2026-10-29; see
  [design-canvas.md](../../architecture/design-canvas.md#client)).
  Still not done on 2026-10-25: it needs a person listening to VoiceOver
  (macOS) and NVDA (Windows); no automated run stands in for it.
- **Large-canvas client performance.** Done on 2026-10-22 on one host and
  build, including a 100-cycle leak check on the committed fixes that
  converged at every size (see [Client performance](#client-performance)).
  Other hosts (Linux, a slower laptop) and the Electron renderer are not
  measured; the numbers are host evidence, not thresholds. Still not done on
  2026-10-25: only this Apple M5 Max host was available, and the harness
  (`e2e/perf/design-canvas-perf.ts`) drives headless Chrome, not an Electron
  window. On 2026-11-01 it ran on a busy Linux x64 host with Playwright's
  Chromium (see [Client performance on Linux](#client-performance-on-linux)).
  Still open: a slower machine and the Electron renderer.
- **Mixed versions and migration on real binaries.** The backend half is
  done on 2026-10-25 with the published `orkestrator@2.22.3` (the oldest
  Stable release on npm, inside the support window) and this checkout's
  backend over one data directory (`scripts/qualify-design-mixed-versions.ts`,
  see [Mixed versions](#mixed-versions)). The upgrade read, edited and
  re-exported the old canvas; a copied legacy `.orkdes` migrated on its first
  write with a backup; a future record version and a corrupt record with an
  older backup were each fenced and left in place. The downgrade is refused
  by the backend database's schema fence before any design record is read,
  and the explicit downgrade path (export, then import into the older
  release) worked. Still open:
  - an old renderer against the new backend, and the reverse. The npm package
    ships no renderer, so this needs an old desktop app build; the hosted web
    client always follows `main`.
  - an interrupted migration on a real binary. The window (record written,
    legacy file not yet moved) is not reachable from outside the process; it
    stays covered by "an interrupted migration (record written, legacy not
    retired) reads the record" in `records.test.ts`.
- **Browser design flakes under controlled parallel load.** Both resolved
  on 2026-11-01 (see [Design flakes (2026-11-01)](#design-flakes-2026-11-01)):
  0208 was a host path picker race, fixed in the product, and 0174's
  recurrences after 2026-10-25 were the journey's page loads spending its
  budget under parallel load, fixed in the test. On Linux hosts, browser
  runs beside Docker churn also lose page loads to
  [2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md).
  The history below is kept as it was.
  [0174](../../tests/flaky-tests/design-canvas-and-artifacts/0174-design-canvas-parallel-browser-timeout.md)
  (`e2e/DesignCanvas.spec.ts` timeouts with six workers) is fixed on
  2026-10-25: a 4x CDP CPU throttle reproduced it as a race in the test's
  conflicting edit, now made deterministic (see
  [Design flakes](#design-flakes)). Still open on 2026-10-25:
  - [0208](../../tests/flaky-tests/design-canvas-and-artifacts/0208-design-canvas-private-import-picker-disabled-in-suite.md)
    (import picker stays disabled late in `test:agent:browser`). Its case
    passed all seven standalone `test:agent:design:isolated` runs on
    2026-10-25 and all three on 2026-10-22. It has only failed late in a full
    `test:agent:browser` run on a shared profile, which was not attempted:
    the host was shared with other worktrees throughout. Next step: that run,
    then the same CPU throttle on the private-canvas case if it does not
    reproduce.
  - 0174 is resolved; one quiet nine-worker `mise run test:browser` would
    confirm it does not recur in the aggregate suite. Every 2026-10-25 run
    was on a host shared with other worktrees.

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
     [0273](../../tests/flaky-tests/native-agents-and-transcripts/0273-claude-live-slash-provider-result.md).
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
[0450](../../tests/flaky-tests/design-canvas-and-artifacts/0450-claude-live-design-account-rate-limit.md))
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
- **Fixed later.** The 400% zoom layout, label-in-name on inspector fields,
  and a silent first Enter on a row whose frame has not rendered were fixed
  and asserted on 2026-10-25 in todo 0054.

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

## Qualification evidence (2026-10-25)

Branch `todo-0036-design-canvas-qualification-e17e8f7e743c` from `20f6de91`.
Host: Apple M5 Max (18 cores), macOS (Darwin 27.0.0), Bun 1.4.4 (mise),
Docker Desktop 29.9.2 (arm64). The host was shared with other worktrees
(load averages 18–54 during the runs).

### Opening prompt

- **Before the change.** `mise run test:agent:design:isolated` passed four
  times in a row on `20f6de91` (39.0, 31.9, 33.2 and 32.9 s), so the 2026-10-22
  failure at the opening brief no longer reproduces.
- **New case.** "a new design tab's brief is sent while its environment is
  inactive" creates a Codex design workspace, switches to another environment
  at once, and refuses every `dispatch_native_agent_intent` the page sends
  under an `initial-prompt:` id, so only the backend can send the brief. It
  polls `get_native_agent_projection` for the new tab's session until the
  brief is in it, then returns and checks the brief shows once and the canvas
  guidance never shows. With the change the whole file passed twice (3 passed;
  1.0 min, then 70.0 s through `test:logged`). With the hand-off disabled the new case failed (the projection
  never held the brief) and the other two passed.
- **Unit tests.** "never queues an opening prompt behind a running turn"
  fails without the `noQueue` guard: the mounted tab put the prompt on the
  id-less queue while a turn ran. The review action's existing queue
  assertions in `ActionBar.test.tsx` pass unchanged through the shared
  helper.

### Orkestrator container export

Profile `qa-design-ctr-0036`: `mise run dev:test --profile qa-design-ctr-0036
--fixture --fixture-environments local,container`, which built and ran
`orkestrator-v2:dev-62ff71e7ec52` from this checkout. Command:
`ORKESTRATOR_AGENT_TEST_PROFILE=qa-design-ctr-0036 ORKESTRATOR_AGENT_TEST_DOCKER=1
bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts
e2e/agent-testing/design-container-export.spec.ts`. Passed three times (6.5,
25.7 and 7.9 s). The profile was stopped and reset afterwards (one container,
two volumes and one network removed by exact owner).

- **Round trip** into the fixture environment's cloned `/workspace`: the
  file reads back through `read_container_file` with the canvas id and
  revision, is owned by `node` with mode 644, shows in `git status` as an
  untracked repository file, and leaves no temporary file. A preview without
  a path suggests the same file and reports the same canvas with the
  receipt's digest.
- **Stopped outside Orkestrator** (`docker stop`): the export fails with
  `storage` before writing and reconcile reports `none`.
- **Restarted through Orkestrator** (`start_environment`, so the
  network-policy entrypoint runs again): nothing was published while
  stopped, the export association survived, a fingerprinted replace landed
  revision 3, and an unconfirmed overwrite of the changed file was refused.
- The client-kill interruptions are not repeated here: they need the spawn
  seam that only `export-container.test.ts` has.

### Mixed versions

`bun scripts/qualify-design-mixed-versions.ts --report
output/agent-testing/design-mixed-versions/2026-10-25.json` exited 0 with no
failed check. Old: the published `orkestrator@2.22.3` (it reported 2.22.3).
New: this checkout's `apps/backend/src/main.ts`. One temporary data directory
and HOME, loopback only.

| Step | Result |
| --- | --- |
| 2.22.3 creates a local environment and a canvas, exports `designs/old.orkdes` | ok |
| New reads and edits the old canvas | `snapshot`; edit committed |
| New previews the old export | same path, same canvas, fingerprint equals 2.22.3's digest |
| New opens `designs/old.orkdes` | reuses the old canvas |
| A legacy portable `.orkdes` in the private store | read in place; first write wrote `.orkrec` and moved the legacy file to `legacy-backups` |
| 2.22.3 on the upgraded directory | refuses to start: "Storage database schema version 4 is newer than this build supports (3)" |
| Downgrade path: new exports, 2.22.3 imports into a fresh directory | imported with the new backend's edit |
| New after the round trip | old canvas intact; `recordVersion: 99` gives `record-problem/unsupported-version` and the file stays; a corrupt record gives `record-problem/corrupt` with `backupAvailable` |

The downgrade fence sits in the backend database, so 2.22.3 never reads a
design record written by the new backend; the design-level fence for a future
record version was exercised on the new backend instead.

### Design flakes

- **0174** (`e2e/DesignCanvas.spec.ts` timeouts). `DesignCanvas.spec.ts` now
  takes `ORKESTRATOR_E2E_DESIGN_CPU_THROTTLE` (CDP
  `Emulation.setCPUThrottlingRate` on the page). With
  `--workers=1 --repeat-each=5` over both projects:
  - rate 4: 2 of 10 failed, both at the 30 s test deadline on the last
    steps (clicking **Done** in the export dialog, line 278); the page
    snapshot shows Done enabled and focused, so nothing was stuck.
  - rate 8: 10 of 10 failed at the deadline, each at a different step (lines
    147–202: options, comboboxes, the colour field, `page.reload`).
  - unthrottled, the journey took 9.5–22.2 s per run on this loaded host
    (`--repeat-each=3`, 6 passed).
  - rate 4 with a 120 s deadline (`--repeat-each=3`): four runs took
    29.6–38.8 s, and two stalled until the deadline at line 209, clicking
    **Apply styles** with "element is not enabled" for 80 s. The test
    landed another client's edit just before that click; when its live hint
    reached the page first, the inspector rightly disabled Apply styles for
    the stale selection, and the click could never happen. This is the race
    behind 0174: the variety of failing steps under load came from the same
    budget being spent waiting here or simply running slow.
  - **Fixed in the test** (no product change): the other client's edit now
    lands when the page's `design_prepare` for Apply styles reaches the
    service, so the server always moves on while the edit is in flight.
    After the fix, rate 4 passed 10 of 10 (24.3–38.3 s, 120 s deadline) and
    the unthrottled file passed 6 of 6 at the default 30 s (7.2–11.7 s).
- **0208** (import picker disabled late in `test:agent:browser`). The
  private-canvas case passed all seven `test:agent:design:isolated` runs
  above. A full shared-profile `test:agent:browser` run was still not
  attempted; see [Assumptions and decisions](#assumptions-and-decisions).

### Repository validation

`mise run format:check`, `mise run lint` (no new findings) and
`mise run typecheck` passed. The web package's native-agent, design and
action-bar tests passed (1,030). `mise run test` passed every group except
root/support, which failed two cases of
`scripts/opencode-live-compatibility-probe.test.ts` on the shared temporary
directory; the file passed alone three times, recorded as a recurrence of
flake [0242](../../tests/flaky-tests/agent-bridges/0242-opencode-probe-shared-temp-root.md).
The flake-index, doc and mise-task unit tests passed. Electron, iOS and the
full `test:agent:browser` suite were not run: the change is renderer
dispatch, the design specs and a script, covered by the isolated design
suite and the Docker fixture case above.

## Qualification evidence (2026-11-01)

Branch `linux-canvas-export-c8f02f652ad2-r1` from `93b99bfb`. Host: beelink,
Linux 7.1.8 (Arch-based), Intel Core Ultra 9 285H (16 logical CPUs), 62 GiB,
Bun 1.4.4, Docker Engine 29.9.2 (linux/amd64, rootful, overlayfs, seccomp
builtin, cgroupns), Playwright 1.64.0 with Chromium 156. Other builds ran on
this host throughout, starting and removing containers; load averages are
given per run and ranged from 3 to 77. No timing here is a reference figure.

### Container export on Linux

- **Backend file.** `ORKESTRATOR_TEST_DOCKER_DESIGN_IMAGE=orkestrator-v2:latest`
  (image `ba91a0125f81`, the published `2.34.4-beta` build of 2026-10-29),
  `bun test --cwd apps/backend ./src/core/design/export-container.test.ts`:
  11 pass, 0 fail, 86 expectations, three runs in a row (11.2, 10.8 and
  10.8 s; load 4.7–5.3). The workflow's form (`--preload
  ../../tests/setup-node.ts --parallel=1`) passed once more (10.6 s; load
  8.5). No Docker call took over 10 s, unlike `docker stop` on Docker
  Desktop. Nothing with the test's owner label was left behind.
- **Every case held as on Docker Desktop**, including the one that depends
  on this daemon: with the Docker client killed after sending every byte, the
  Engine closed the helper's stdin, the helper published the complete file,
  and reconcile proved `exported` by digest without a second writer.
- **Docker fixture spec.** A disposable profile,
  `ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1 mise run dev:test --profile
  qa-0036-linux --fixture --fixture-environments local,container
  --no-agent-credentials --agent-platforms codex`, which built
  `orkestrator-v2:dev-a2140e5dc5e5` from this checkout and ran its backend on
  port 34803. `ORKESTRATOR_AGENT_TEST_DOCKER=1 bunx playwright test --config
  e2e/agent-testing/playwright.browser.config.ts
  e2e/agent-testing/design-container-export.spec.ts` passed three times
  (5.3, 6.5 and 7.7 s; load 9–17). `dev:reset` then removed two containers,
  two volumes and one network by exact owner, and the dev image was removed
  by tag.
- **CI.** `container-live-qualification.yml` gained a "Live design export"
  step with `ORKESTRATOR_TEST_DOCKER_DESIGN_IMAGE` set to the job's
  qualification image, and runs on pull requests that change the test,
  `export-writer.ts` or `exports.ts`. It has not run yet.
- **Headless profile.** This host's `DISPLAY` and `WAYLAND_DISPLAY` belong to
  the signed-in user, so the profile's Electron ran on
  `--ozone-platform=headless --disable-gpu` with both removed (decision 11).
  Electron 45.0.0 (Chromium 156) started, loaded its window and announced
  readiness in that mode.
- **Host firewall.** The container-fixture profile showed **Docker containers
  can't reach Orkestrator** (this host's ufw drops container traffic to the
  agent tools port). It does not affect export, which goes over
  `docker exec`, but it covers the app and fails UI specs on that profile.

### Client performance on Linux

`mise exec -- bun e2e/perf/design-canvas-perf.ts --runs 3 --samples 20
--moves 3 --html-samples 5 --cycles 12 --skip-library --rev HEAD --browser
chromium`, then the same with `--skip-canvas --library-samples 5`: the
2026-10-22 parameters, in two invocations so one late failure cannot lose
both halves (an earlier single invocation failed in its library phase,
waiting 30 s for **New design workspace**, and wrote no report; the library
phase alone then passed).

- **Setup.** Playwright's Chromium 156.0.8078.4, headless (no Google Chrome
  on this host), a production React build of `95093c16`, served by
  `vite preview` at 1440×900; otherwise as on 2026-10-22. Reports:
  `output/benchmarks/design-canvas/2026-11-01T03-57-50-519Z.json` (canvas)
  and `2026-11-01T04-13-42-394Z.json` (library), numbers only.
- **Host load, measured by the harness at each phase.** Canvas runs 1 and 2
  (03:58–04:08 UTC): load1 0.8–12, other processes 1–12 cores busy. Run 3
  (04:08–04:13): other builds started again and load1 climbed from 0.8 to
  79 (up to 21 cores busy). Library (04:13–04:17): load1 58–77. These are a
  busy shared host's figures, not reference figures, and they do not rank
  this host against the M5 Max.

| Metric | 1 frame | 16 frames | 64 frames |
| --- | --- | --- | --- |
| Pointer move → preview painted, p50/p95 ms (360 samples) | 11.8/30.35 | 13.75/31.86 | 16.6/33.54 |
| Pointer up → acknowledgment painted, p50/p95 ms (120 samples) | 25.1/69.18 | 35/129.11 | 51.75/258.58 |
| Longest acknowledgment ms (runs 1/2/3) | 48/36/91 | 90/41/160 | 115/65/395 |
| Pan frame interval p50/p95 ms; dropped frames (pooled) | 16.7/16.7; 0% | 16.7/16.7; 0.6% | 16.7/16.8; 5.2% |
| Live iframes at fit all / 100% / panned away / max while panning | 1/1/0/1 | 8/8/2/8 | 8/8/6/8 |
| Mounted layer rows at fit all / 100% / panned | 7/7/7 | 16/16/22 | 37/37/37 |
| Iframe replacements per geometry edit (120 edits) | 0 | 0 | 0 |
| Iframe replacements / in-frame re-renders per HTML edit | 0/1 | 0/1 | 0/1 |
| Post-GC JS heap MiB at 100% / after 12 leak cycles | 10.36/12.16 | 11.59/13.29 | 12.72/14.27 |
| DOM nodes at 100% | 415 | 655 | 892 |

| Library | 1 canvas | 50 canvases | 256 canvases |
| --- | --- | --- | --- |
| **Saved designs** press → first page painted, p50/p95 ms (15 samples) | 93.6/208.56 | 124.7/286.83 | 87.7/183.58 |
| `design_library` call p50/p95 ms | 4.54/14.62 | 3.2/6.66 | 1.37/9.78 |

- **What the numbers mean.**
  - The structural results match the M5 Max exactly: geometry edits never
    replaced or re-rendered an iframe, an HTML edit re-rendered its frame
    once in place, culling held live iframes at 8, and layer rows stayed
    bounded. DOM nodes are about 98 higher at every size than on
    `b83ae534`, from UI added since; heap is about 1.5 MiB higher.
  - Load showed directly in run 3. With load1 at 33–79 the 64-frame pan
    dropped 13.5% of frames (pan p95 33.4 ms) and acknowledgment p95 reached
    293 ms, against 0% and 56–84 ms in runs 1 and 2 at load1 0.8–12. In
    runs 1 and 2 alone, preview p95 was 29–31 ms, acknowledgment p95
    33–84 ms and no pan frame dropped, close to the M5 Max's figures.
  - The library open times (88–125 ms p50) were taken at load1 58–77; the
    one quiet probe of the same step, at load1 14, took 45 ms. The first
    page is still 50 rows, so 256 canvases cost the same as 50; all pages
    took 879 ms p50.
- **Leak check** (12 cycles × 3 runs). Converged at 16 frames in all three
  runs. At 1 frame, `jsEventListeners` grew once from 260 to 285 in runs 1
  and 2: the same +25 warm-up the M5 Max showed at 12 cycles, which settled
  at 100 cycles there. At 64 frames, run 2 grew window listeners 33 → 35
  and CDP frames 9 → 11, and run 3 (load1 67–79) grew listeners 441 → 450,
  window listeners 39 → 44 and CDP frames 15 → 20.
- **Recheck at 100 cycles** (`--runs 1 --frames 1,64 --cycles 100
  --skip-library`, load1 falling from 42 to 3; report
  `2026-11-01T04-18-05-573Z.json`). At 1 frame it converged: listeners
  settled at 260 after the first cycle. At 64 frames it did not: window
  listeners grew 34 → 61 and CDP frames 10 → 37, one for one, unevenly,
  while the DOM held 8 iframes and the post-GC heap rose 13.8 → 14.6 MiB.
  The M5 Max converged at 64 frames on `60a75b73`. A frame bridge that is
  created but never committed would explain it; that is unverified and is
  new to-do
  [2140](2140-design-frame-bridge-growth-under-culling.md).
- **Decision.** Unchanged apart from 2140: nothing here argues for a client optimisation,
  and the backend items under [Deferred until measured](#deferred-until-measured)
  stay deferred. Not covered: a slower machine, and the Electron renderer.

### Design flakes (2026-11-01)

- **0208.** A race in `HostPathPickerDialog`: the picker's first listing (the
  home folder) wrote its folder into the address field when it landed, so a
  path typed before then was replaced, Enter browsed the home folder, and
  **Select file** stayed disabled. The new unit test holds that listing,
  types a path and releases it; it failed before the fix (`/home/me` in the
  field) and passes after it. On the real stack, a diagnostic edit of the
  case (not committed) held the first `list_host_directory` until the path
  was typed: without the fix **Select file** stayed disabled in 2 of 2 runs,
  with it the case passed 2 of 2 (1.2 min, 56.4 s; load 35–45). The
  unchanged `ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1 mise run
  test:agent:design:isolated` failed all three cases before any picker,
  each on a page that never rendered (2340; load 43–57).
- **0174.** One worker with the CPU throttle and a 120 s deadline: 4x passed
  10 of 10, 8x passed 9 of 10 (21.9–25.1 s), and the failure was 2340. No
  stall at **Apply styles** or the replacement element. Eight workers
  (`--workers=8 --repeat-each=8`, default 30 s, load 48–77) failed 16 of 16
  at the deadline at lines 210, 220 and 224; in the traces `page.goto` took
  8.6–10.0 s and `page.reload()` 5.2–5.8 s, and no other step more than
  1.4 s. After `pageLoad()` gave that time back: mobile passed 8 of 8
  (36.2–40.3 s wall time; load 58–73); desktop lost 15 of 16 runs across two
  attempts to 2340 (4–340 aborted module requests each) and passed the one
  without aborts; one worker passed 6 of 6 (16.2–22.5 s; load 44–62).
- **2340** (environmental). With a page of 60 slow loopback scripts loaded
  15 times, 0 of 915 requests failed without Docker churn of mine and 797 of
  915 failed with `net::ERR_NETWORK_CHANGED` while a labelled network was
  created and removed every 0.5 s. `ip monitor` showed other builds'
  bridges and veths appearing every few seconds. Chromium on Linux treats
  each as a network change and aborts in-flight requests, loopback included.

### Repository checks (2026-11-01)

Focused only, as this stage requires: `HostPathPickerDialog.test.tsx`
(23 pass), `apps/desktop/scripts/dev/lifecycle.test.ts` (17 pass),
`tests/unit/ci-workflows.test.ts` (7 pass), `tests/unit/flaky-tests-index.test.ts`
(18 pass), `tests/unit/docs` and `tests/unit/todo-index.test.ts` (33 pass),
`tests/unit/mise-tasks.test.ts` (15 pass) and `bun fmt --check` on the changed files. The full suites, typecheck and
lint are left to the next stage's validation.

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

## Assumptions and decisions

Made on 2026-10-25 while working this file.

1. **Where the opening prompt's backend dispatch comes from.**
   - Options: (a) a new backend command that ensures the session and
     dispatches for a renderer-chosen tab id; (b) the backend reads opening
     prompts out of the saved pane layout and dispatches them; (c) the
     durable prompt queue the review action already used, behind one shared
     helper.
   - Chosen: (c), `handTabInitialPromptToBackend`.
   - Why: the queue dispatcher already creates the session, waits until the
     environment is ready for agents, retries with backoff, settles
     ambiguous dispatches and dedupes by request id; the review action had
     proved it.
   - Pros: no new backend surface, one path for every renderer-created tab,
     survives switching environment and never mounting the tab. Cons: the
     queue write is still issued by the creating renderer, so a renderer
     that dies between creating the tab and the write loses the prompt, as
     before; (b) would close that but needs prompts in the pane layout,
     which deliberately never stores them.
2. **Keeping the mounted-tab fallback.**
   - Options: drop it once the queue has the prompt; keep it until the queue
     write lands, under the same request id.
   - Chosen: keep it, cleared on a successful write.
   - Why: a failed queue write must not strand the brief; the shared request
     id makes the race at most once.
   - Pros: no lost prompt on a transient failure. Cons: two paths to reason
     about, and one more guard (next decision).
3. **The fallback and a running turn.**
   - Options: let it queue as before; skip the opening prompt while a turn
     runs (`noQueue`), retrying when idle.
   - Chosen: `noQueue`.
   - Why: the queue carries no request id, so if the backend had already sent
     the prompt and its turn was running, the fallback would send it again.
     The new unit test proves it did.
   - Pros: at most once holds on every path. Cons: an opening prompt for a
     tab opened onto a busy session now waits for idle instead of sitting in
     the queue; the effect is the same order of turns.
4. **Resumed tabs keep the mounted path.** The controller withholds a resumed
   tab's opening prompt when the provider substituted the session; only the
   mounted tab can see that, so such tabs are not handed to the queue. No
   caller creates one today.
5. **Orkestrator-container export as a Docker fixture spec**, not a variant of
   `export-container.test.ts`.
   - Why: only the real stack runs the network-policy entrypoint, the cloned
     workspace and `ContainerService`. Pros: runs with `test:agent:docker`.
     Cons: the client-kill interruptions stay in the backend test, which has
     the spawn seam they need.
6. **Mixed versions with the published npm backend.**
   - Options: old releases built from tags in worktrees (as
     `qualify-backend-upgrade-rollback.ts` does); the published
     `orkestrator` package.
   - Chosen: the published package, `2.22.3` by default.
   - Why: it is the binary users run, it installs in seconds, and 2.22.3 is
     the oldest Stable release on npm inside the support window (v2.21.0 was
     never published to npm).
   - Pros: real binary, quick, repeatable. Cons: no renderer in the package,
     so the old-client half stays open; the floor release itself is not
     covered.
7. **Flake 0174: fix the order, not the deadline.**
   - Options: raise the journey's 30 s budget; split the journey; make the
     conflicting edit deterministic.
   - Chosen: the third. The other client's edit now lands when the page's
     **Apply styles** operation reaches the service, instead of before the
     click.
   - Why: a 4x CPU throttle reproduced a real stall: when the edit's live hint
     reached the page before the click, the inspector correctly disabled
     Apply styles for the stale selection and the click waited until the
     deadline. Raising the deadline would only have waited longer.
   - Pros: removes the race and keeps every assertion. Cons: the 8x and some
     4x failures were the 30 s budget running out under emulated slowdown
     well beyond the suite's; those are not addressed and are not product
     defects.
8. **0208 was not chased further.** Its case passed all seven isolated runs
   here, and the remaining reproduction needs a full shared-profile
   `test:agent:browser` run on an otherwise idle host.
9. **Criticality stays Medium.** The most serious remaining work is
   qualification on other platforms (Linux Docker Engine, other hosts,
   screen readers) and an old renderer, all Medium by the rating rules; the
   opening prompt, which users hit, is done.

Made on 2026-11-01 while working tasks 2, 5 and 8.

10. **Linux Engine: both a run here and the CI workflow.**
    - Options: the CI workflow only (task 2's recommendation); a manual run
      on this host only; both.
    - Chosen: both. The local run gives the evidence now, including the
      Orkestrator-created container, which CI cannot run; the workflow gives
      arm64 and keeps it from regressing.
    - Pros: amd64 proved today, arm64 and recurrence covered by CI. Cons:
      about 11 s more per architecture in that workflow; CI runners are
      still not rootless or SELinux hosts.
11. **Headless Electron for agent-test profiles on Linux.**
    - Options: run `dev:test` as is (its Electron window would open on the
      signed-in user's desktop, which this host's rules forbid); a virtual
      X server (`xvfb-run`; not installed, and nothing may be installed
      system-wide); an opt-in that starts Electron on Chromium's headless
      Ozone platform without `DISPLAY` or `WAYLAND_DISPLAY`.
    - Chosen: the opt-in, `ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1`
      (`electronLaunchForRuntime` in `apps/desktop/scripts/dev/lifecycle.ts`),
      honoured only by agent-test profiles on Linux.
    - Pros: no display or install needed; nothing changes unless it is set.
      Cons: Electron window specs and screenshots of that window do not work
      in this mode (`capturePage` hung in a probe); it is one more
      environment variable to know about.
12. **0208: fix the picker, not the test.**
    - Options: have the test wait for the first listing before typing; keep
      a typed path when a listing lands.
    - Chosen: the product fix.
    - Why: a person typing a path while the picker loads (a remote backend,
      a large home folder) loses it the same way; the test only showed it.
    - Pros: fixes users' input as well as the flake; a unit test pins it.
      Cons: a path typed and then abandoned stays in the field until the
      next navigation, rather than being replaced by the listed folder.
13. **0174: give page-load time back to the deadline.**
    - Options: raise the 30 s deadline (decision 7 rejected it); split the
      journey into several tests; build the fixture for production in the
      component suite; add the time spent in `page.goto` and `page.reload()`
      back to the deadline.
    - Chosen: the last, `pageLoad()` in `e2e/DesignCanvas.spec.ts`.
    - Why: under eight workers the two page loads took 14–16 s of the 30 s
      and no step stalled; the steps alone fit.
    - Pros: the steps keep exactly the budget decision 7 defended, so a
      stalled step still fails at 30 s; one small helper. Cons: a slow page
      load is no longer caught by this test (it still fails if a load hangs
      past the deadline); the wall time of a passing run can exceed 30 s;
      only mobile was confirmed under parallel load, because 2340 spoiled
      the desktop runs.
14. **Perf on this host with Playwright's Chromium.**
    - Options: install Google Chrome (not allowed system-wide); wait for a
      host with Chrome; add `--browser chromium` and run here.
    - Chosen: `--browser chromium`.
    - Pros: Linux numbers now. Cons: Chromium 156 rather than Chrome; the
      host was shared with other builds throughout, so the numbers are not
      comparable with the M5 Max ones as a ranking.
15. **2340 is recorded, not mitigated.**
    - Options: route every Vite module request through Playwright in the
      browser suites; keep Docker work and browser suites apart on Linux
      hosts; record it and leave the suites unchanged.
    - Chosen: record it.
    - Why: the condition is the host's, not the product's, and routing
      every module request through Playwright would change what the suites
      measure.
    - Pros: no test transport change. Cons: browser runs on a shared Linux
      host stay exposed while other builds start containers.

## Open questions

- Should design join a shared live-provider harness (like
  `e2e/agent-testing/opencode-live.spec.ts`) rather than get its own spec?
- Are thumbnails wanted as a product feature on their own merits? The library
  shipped without them.
- Is a cross-environment design transfer UI wanted? Recovery copies, download
  and import cover copying today. If it is built, define and test the lock
  order for two-canvas operations before adding them.

## Related

- [0038-design-agent-conversation-links.md](0038-design-agent-conversation-links.md).
- [2140-design-frame-bridge-growth-under-culling.md](2140-design-frame-bridge-growth-under-culling.md):
  the window listener and frame growth the 2026-11-01 Linux leak check found
  at 64 frames.
- [`design-canvas.md`](../../architecture/design-canvas.md) ("Operations" and
  "Client"): the operation recovery edges and accessibility fixes, moved there
  when todos 0037 and 0054 were retired on 2026-10-29.
- [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md)
  for container runs, [`version-compatibility.md`](../../architecture/version-compatibility.md#the-support-window)
  for the support window (old-binary runs for design are recorded here), and
  [0030-test-suite-and-ci-health.md](../cross-cutting/0030-test-suite-and-ci-health.md) for flake triage.
- [`agent-testing.md`](../../development/agent-testing.md) and
  [`testing-guide.md`](../../development/testing-guide.md).
- Design flakes resolved on 2026-11-01:
  [0208](../../tests/flaky-tests/design-canvas-and-artifacts/0208-design-canvas-private-import-picker-disabled-in-suite.md)
  (host path picker race) and
  [0174](../../tests/flaky-tests/design-canvas-and-artifacts/0174-design-canvas-parallel-browser-timeout.md)
  (page loads under parallel load; also a test race on 2026-10-25). The Linux
  host condition behind blank pages beside Docker churn:
  [2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md).
  Resolved earlier:
  [0246](../../tests/flaky-tests/design-canvas-and-artifacts/0246-design-renderer-real-chromium-launch-deadline.md)
  (real-Chromium launch on CI).
  Resolved on 2026-10-16 as test artefacts:
  [0193](../../tests/flaky-tests/design-canvas-and-artifacts/0193-design-sync-gap-aggregate-timeout.md),
  [0215](../../tests/flaky-tests/design-canvas-and-artifacts/0215-design-operation-replay-event-count.md),
  [0218](../../tests/flaky-tests/design-canvas-and-artifacts/0218-design-service-replay-aggregate-timeout.md)
  and the design half of
  [0225](../../tests/flaky-tests/previews-annotations-and-gateway/0225-design-and-bench-aggregate-timeouts.md).

## Replaces

- `docs/improvements/design-space.md` (assessment; all twelve findings are
  implemented, the U4 remainder is in
  [0038-design-agent-conversation-links.md](0038-design-agent-conversation-links.md))
- `docs/improvements/design-space/plan/00-index.md` (qualification gaps,
  deferred items, non-goals, capability decision, measurements and
  deviations; the residual edges went to todo 0037, retired on 2026-10-29)
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
