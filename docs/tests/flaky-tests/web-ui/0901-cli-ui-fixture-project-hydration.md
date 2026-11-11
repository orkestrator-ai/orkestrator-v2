# CLI project cascade browser case misses the fixture project

- **ID:** 0901
- **Status:** resolved
- **Date observed:** 2026-10-25
- **File:** `e2e/agent-testing/cli-ui.spec.ts:268`
- **Test:** `a CLI-initialized project and its cascade removal reach an open renderer`.
- **Revision:** `db35fb35f` plus the interaction review fixes, macOS arm64, Bun 1.4.4.
- **Original command:** `mise run test:logged -- --name browser-smoke -- mise run test:agent:browser:isolated --no-agent-credentials --agent-platforms codex`.
- **Failure:** the 120-second test deadline expired waiting for either `Expand project origin` or `Collapse project origin`, before the case initialized its project. The full browser run also had a new container-test setup error (subsequently corrected and qualified) and an unrelated annotation filename assertion that reproduces alone.
- **Owner rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=review-0001-docker-1025 mise run test:logged -- --name browser-cli-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/cli-ui.spec.ts --workers=1` passed both unchanged tests in 22.2 seconds including startup overhead.
- **Rerun fixture:** a fresh credential-free Codex profile with local and full-network container fixtures, rather than the original profile's local-only fixture. The cause is unknown; the richer fixture means this rerun does not establish that load caused the failure.
- **Evidence:** original `output/agent-testing/qa-browser-a6c7ec9c-d18/browser/`; private log `orkestrator-test-run.BHICIj/browser-smoke.log.gz` in the host temporary directory. Both disposable profiles were stopped and reset after testing.
- **Assessment:** intermittent fixture-project hydration in the broader run; no assertion, timeout or skip in the owning CLI browser file changed.
- **Root cause, beelink (Linux), 2026-11-03,** on the branch for to-do [2181](../../../todo/cross-cutting/2181-dev-test-electron-opens-on-the-linux-desktop.md). `login()` returned at `domcontentloaded` and the case navigated again at once, while the login page's module graph was still loading. The gateway then answered the new document's `/@vite/client` and `/src/main.tsx` with 502, and the page stayed blank with no retry, so `Expand project origin` never appeared. Two traces show exactly those two 502s: this case in `mise run test:agent:browser:isolated`, and `CLI changes reach an open renderer and survive a reload` (the same `login()`) in one of three repeats alone.
- **Fix and verification:** `login()` in `e2e/agent-testing/cli-ui.spec.ts` waits for `load`, which module scripts delay, and no assertion changed. With it, both cases passed five of five with `--repeat-each=5 --workers=1` (10 passed, 0 failed, about 39 s). Why the gateway answers 502 in that race was not investigated; a spec that navigates twice this way could still hit it.

## Recurrence during headless qualification, 2026-11-03

At ae9974f79, `mise run test:agent:browser:isolated` reported 48 passed, 94 skipped and 2 failed. `browser-gateway.spec.ts` / `local environment move survives inactive navigation and reload` timed out waiting for the sidebar after reload; the screenshot was blank. Inspection of the saved trace confirms HTTP 502 for `/src/main.tsx`. This matches the CLI symptom, but does not establish why the gateway fails. The gateway cause remains unresolved, so this record is reopened. Original evidence: `.orkestrator/review-artifacts/review-validation-8806664c-f549-43fa-bbcb-bd646c7edbd8/validation-05.stdout.txt`.

The browser-gateway login and both move-case reloads now wait for `load`, matching the CLI mitigation. This is navigation synchronization, not a demonstrated gateway root-cause fix.

### Repair-stage verification, 2026-11-04

`mise run test:logged -- --name address-isolated-browser -- mise run test:agent:browser:isolated` against repair commit `0f586e738` finished in 636.9 seconds: 47 passed, 94 skipped, 3 failed. The local-environment-move case and headless-profile proof passed. However, `browser-gateway.spec.ts` / `persisted diff baselines keep Files, the badge and diff tabs aligned after background changes and reload` timed out waiting for its sidebar at line 2896. Its saved trace confirms HTTP 502 for `/src/main.tsx` and `/@vite/client`. Waiting for load is therefore a mitigation, not a complete fix. No timeout or assertion was loosened, and this case remains open for gateway investigation.

Evidence: `/tmp/orkestrator-test-run.5fe7Kb/address-isolated-browser.log.gz` and `output/agent-testing/qa-browser-08cf3c58-15c/browser/artifacts/browser-gateway-persisted--1322f-ckground-changes-and-reload/trace.zip`. The other failures were the authoritative-local-environment case's terminal-history assertion (line 635) and terminal-input-resume's missing output file (this host has `nvim`, but no `vim` or `vi`). Their causes are not claimed to be gateway failures. The runner stopped and reset profile `qa-browser-08cf3c58-15c`.

## Root cause and fix, 2026-11-04

The 502s came from `cancelProxyForDisconnect` in `apps/backend/src/gateway-proxy.ts`, not from Vite. When a reload drops a client whose upstream response has already ended (the gateway is still compressing the body), the handler called `proxyRequest.socket?.destroy()`. A finished request keeps that reference after its keep-alive socket returns to the pool, so this destroyed a socket another request was then using. That request's `fail()` answered 502 with `{"error":"Proxy client disconnected"}`, which is the 37-byte body in the saved traces. A reload's `/src/main.tsx` and `/@vite/client` are the requests most likely to be on those sockets, hence the blank page.

- **Evidence:** a temporary log in `fail()` on a live `--fixture` profile recorded that message with `settled: false` for `/src/main.tsx` and `/@vite/client`, a few milliseconds after a different module's disconnect. A scratch Bun 1.4.4 script showed `a.req.socket === b.req.socket` once A's exchange ended, and that only `proxyRequest.socket.destroy()` of the four destroy calls fails B; `proxyRequest.destroyed` is already true at that point.
- **Fix:** skip that destroy when `proxyRequest.destroyed` is true. No assertion or timeout changed. The two `page.reload({ waitUntil: "load" })` arguments added earlier are removed: `load` is the default, so they changed nothing. The `load` waits on login stay.
- **Verification:** a login-then-reload loop on one profile before the fix had 3 of 40 rounds with these 502s. After it, 0 of 110 and 0 of 45 rounds had a 5xx (two of the 110 had not rendered at that loop's 800 ms check, with no failed request; the 45-round rerun waited for the render and none took over 500 ms). `local environment move…`, `persisted diff baselines…` and `real browser gateway exercises…` passed 9 of 9 with `--repeat-each=3 --workers=1`. The regression test `a client disconnect after its upstream finished…` in `apps/backend/tests/gateway-proxy.test.ts` fails without the guard (twice, `SECOND_REQUEST_FAILED`) and passes with it.
- **Not established:** flake [0167](0167-dev-renderer-entry-dynamic-import-fetch.md) and the blank page in [2401](../previews-annotations-and-gateway/2401-browser-smoke-terminal-history-marker.md)'s recurrence share this symptom; neither was checked against this cause. The full isolated suite was not rerun at this stage.

## A different cause, 2026-11-06 (fixed)

`a CLI-initialized project and its cascade removal reach an open renderer` failed in
runs 1 and 2 of the to-do 4222 task 3 qualification (isolated suite, credential-free
Codex profile on beelink), with no `net::ERR_NETWORK_CHANGED` and no 502 in either
trace. Both times `openProject` saw the project's Collapse button, so it did not click,
and 5 s later the project was collapsed (`Collapse project …` not found): the fixture
project after the first load in run 1, the CLI-created project in run 2. An empty
project renders expanded until its environments have loaded, then
`collapseEmptyProjects` (`apps/web/src/stores/uiStore.ts`, called from
`useSidebarHydration.ts`) collapses it unless the user has made a choice. The helper
raced that. `ensureProjectExpanded` (`e2e/agent-testing/sidebar-project.ts`) now
toggles until the expanded state is a recorded choice, which the auto-collapse leaves
alone, and `cli-ui.spec.ts`'s `openProject` uses it. The case passed in runs 3 to 7.
The 2026-11-05 failure of `cli-ui.spec.ts:250` recorded in to-do 4222 ("the project row
did not expand") fits the same race.

### Confirmation on macOS for to-do 7431, 2026-11-11

To-do 7431 (retired) recorded this case's two beelink failures of 2026-11-06 at
`c1724ab7`, before the fix above landed (`ff6f1e50a`, #1914). It read them as
"Expand is clicked and Collapse never appears"; the runs below show the helper
never clicked. Profile `qa-7431-cascade` on arktech-mini (macOS arm64), started
with `mise run dev:test --fixture --headless --no-agent-credentials
--agent-platforms codex` under a throwaway `HOME`, `CODEX_HOME` and
`ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, at `498b68766`; the command was
`bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts
cli-ui.spec.ts --grep "cascade removal" --workers=1` through `test:logged`.

- **Current spec:** passed once (29.8 s), then 5 of 5 with `--repeat-each=5`
  (136 s).
- **Old `openProject` restored, uncommitted:** 2 of 5 failed with the to-do's
  exact error, `Collapse project origin` not found from `openProject` after the
  page's first load.
- **Old helper with a state probe, uncommitted:** 3 of 5 failed. In every
  failure the helper first saw `Collapse project origin`, so it did not click;
  for the next 3 s neither button had an accessible name, because the
  "Continue Without Docker" startup dialog was open over the page; once the
  locator handler dismissed it, the empty fixture project had been collapsed by
  `collapseEmptyProjects`. In the passing runs the helper first saw Expand and
  clicked it, which records a choice the auto-collapse leaves alone.

The sidebar behaves as its store documents, so the spec was the stale side and
`ensureProjectExpanded` is the fix; no product change was needed. The profile
was stopped and reset afterwards.
