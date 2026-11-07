---
id: 2013
title: "Phase 2 exit: a second node scope works on both host families"
phase: 2
plan: "§12 Phase 2 exit"
status: done
depends_on: [2004, 2005, 2008, 2009, 2010]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 2013 · Phase 2 exit: a second node scope works on both host families

- **Report:** [§12 Phase 2](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** [2004](2004-browser-node-clients-registry.md), [2005](2005-relay-status-and-session.md), [2008](2008-desktop-request-auth.md), [2009](2009-desktop-previews-and-gateway-snapshot.md), [2010](2010-command-scope-wiring.md)
- **Blocks:** [4001](4001-in-tree-workspace-seam.md)
- **Size:** S
- **Track:** S (scopes)

## Goal

Demonstrate, against real backends, that one renderer can hold the command scope and a leaf scope at once.

## Work

- [x] A test-only page or harness, mounted only in `dev:test` profiles, that creates a leaf `NodeScope` next to the command scope. It invokes a read on each, listens to `resource-changed` on each, and opens a terminal on the leaf.
- [x] Run it on desktop (Electron spec) and browser (Playwright) against two `dev:test` profiles, one attached to the other, over direct and relay routes.
- [x] Record evidence in Notes:
  - the commands run;
  - pass counts;
  - observed `nextHopProtocol`;
  - the number of long-lived requests per origin.

## Tests

- [x] The report's Phase 2 test list, each pointing to the item that added it:
  - node-tagged event demux: [2007](2007-desktop-node-ipc-and-events.md);
  - scope lifecycle (lazy open, renew, idle release, window close): [2006](2006-desktop-node-scopes.md) and [2004](2004-browser-node-clients-registry.md);
  - longest-prefix auth: [2008](2008-desktop-request-auth.md);
  - tab-to-node preview routing: [2009](2009-desktop-previews-and-gateway-snapshot.md);
  - admin refusal by `nodeId`: [2007](2007-desktop-node-ipc-and-events.md);
  - grant reopen without reload: [2004](2004-browser-node-clients-registry.md).

## Done when

- [x] Both host families pass the harness live, and the app is otherwise unchanged (harness live: 3/3 plus the two-leaf case; unchanged: the harness is not in a production build and the app never calls it; browser smoke at `6860254e8`: 51 passed, 3 failed for reasons outside this item, see Notes).

## Notes

- **Harness (2026-11-07).** `apps/web/src/lib/node-scope/scope-proof-harness.ts`: `createScopeProofHarness({ host, windowScope?, settleMs? }) → ScopeProofHarness` with `run({ leafNodeId, leafEnvironmentId, timeoutMs?, keepOpen? }) → ScopeProofReport`, `open(leafNodeId)`, `close(leafNodeId)`, `scopes()`; hosts `browserScopeProofHost(registry?)` (the 2004 registry's `openLeafScope(getWindowScope(), nodeId)`: workspace grant from the command node, direct probe, relay fallback) and `desktopScopeProofHost(host)` (`createDesktopNodeClient` over the preload's `node(nodeId)` from 2007/2010, opened as a `leaf` scope of the app's window scope; route from `nodes.gateway(nodeId)`); `desktopHostApi(window)`; `installScopeProofHarness(window)` sets `window.orkestratorScopeProof`. A run opens the leaf scope next to the command scope, then on each scope reads `get_node_status` (the node that answered) and `get_projects`, listens to `resource-changed` with the typed `resourceChangedEvent` (7011), adds and deletes a kanban task on that scope's own first project and waits for the change, and counts any copy the *other* scope's listener received (cross-talk, must be 0); on the leaf it opens a local terminal (`create_local_terminal_session` → `terminal.listenOutput` → `outputReady` → `start_local_terminal_session` → `local_terminal_write` of `echo uf2013-$((40+2))-<nonce>`), waits for `uf2013-42-<nonce>` (the output, not the echo) on the leaf's terminal stream, and closes it. The report holds ids, timings and booleans only. With `keepOpen` the leaf scope and both listeners stay until `close`, so both event streams stay open for the connection count.
- **Mounted only in `dev:test` (decision).** Options: a route/page in the app (visible surface, needs routing changes), a global set by a test init script (would need the harness bundled in production), or a dynamic import behind a build-time flag. Chosen: `renderer-entry.tsx` imports the harness only when `import.meta.env.DEV && import.meta.env.VITE_ORKESTRATOR_PROFILE_FLAVOR === "agent-test"`. The agent-test launcher (`apps/desktop/scripts/dev/lifecycle.ts`) now passes `VITE_ORKESTRATOR_PROFILE_FLAVOR: profile.flavor` to Vite (`development` for `mise run dev`, which therefore never installs it); the Electron spec's own Vite sets it too. A production `vite build` drops the branch and its chunk (checked: no `orkestratorScopeProof` or `scope-proof-harness` string in `dist`). The app never calls the harness, so nothing visible changes.
- **Specs.** `e2e/agent-testing/scope-proof.spec.ts` (browser, two cases: direct, relay) and `scope-proof-electron.spec.ts` (desktop, one case: direct then relay), with `scope-proof-support.ts` and their own config `playwright.scope-proof.config.ts` (projects `browser` and `electron`; added to `tests/unit/playwright-spec-loading.test.ts`). They skip unless `ORKESTRATOR_AGENT_TEST_PROFILE` and `ORKESTRATOR_AGENT_TEST_LEAF_PROFILE` name two running profiles, so they are not part of the smoke suite. Setup (idempotent): `add_node` (or `update_node`) on the command profile with the leaf's origin and token, then a started local environment on the leaf's fixture project, deleted afterwards. Tokens are read from the profiles' auth files into the spec process only (`add_node` needs the leaf's; the Electron window gets the command profile's through `connections.connect`, as a user's would); nothing prints or saves them.
- **Desktop topology (deviation, recorded).** Playwright cannot drive a profile's own Electron, so the Electron spec launches its own (disposable agent-test profile, hidden windows) and connects its window to the command profile's gateway as a *remote* command node (`connections.connect`). That keeps "two `dev:test` profiles, one attached to the other": the window's command node is `uf-2013-cmd`, the leaf is `uf-2013-leaf`. It is also the only way to get a true relay on desktop: with a Local command node, main's fallback is the command node's own loopback route to the leaf (`openNodeWorkspace`'s `loopbackOrigin`), not `/__orkestrator/nodes/<id>`.
- **Forcing the relay.** Browser: CDP `Network.setBlockedURLs` for the leaf's origin (no request interception), so the registry's direct probe fails and it falls back to the relay. Desktop: main's `globalThis.fetch` refuses the leaf's origin (main's only path to it; the command node still reaches the leaf), so main's probe fails and it binds `${commandGateway}/__orkestrator/nodes/<id>`.
- **Effect.** Not used in the harness: it is a test driver of a few sequential awaits over existing Effect-backed lifetimes (the registry's grants, `WindowScope`/`NodeScope`, main's node scopes); a hand-rolled `within`/`waitFor` keeps it dependency-free and readable in `page.evaluate` traces.
- **Phase 2 test list (report §12), where each lives** (all run green here, see Work log):
  - node-tagged event demux: `apps/desktop/tests/node-ipc.test.ts` "an event for node B never reaches a node-A listener, terminal output included", "a renderer invokes and listens on two nodes at once"; `apps/desktop/tests/preload-api.test.ts` (`node(nodeId)` demux) — [2007](2007-desktop-node-ipc-and-events.md);
  - scope lifecycle: `apps/desktop/tests/node-scopes.test.ts` (single-flight lazy open, renew, idle release, window close, command-node change) — [2006](2006-desktop-node-scopes.md); `apps/web/src/lib/node-scope/node-clients.test.ts` (renewal, last release revokes, `pagehide`, leaf scope disposal) — [2004](2004-browser-node-clients-registry.md);
  - longest-prefix auth: `apps/desktop/tests/window-request-authorization.test.ts` — [2008](2008-desktop-request-auth.md);
  - tab-to-node preview routing: `apps/desktop/tests/node-previews.test.ts` — [2009](2009-desktop-previews-and-gateway-snapshot.md);
  - admin refusal by `nodeId`: `node-ipc.test.ts` "machine administration names a node and a leaf is refused" — [2007](2007-desktop-node-ipc-and-events.md);
  - grant reopen without reload: `node-clients.test.ts` "a lapse reopens and swaps the bearer without a reload", "a reopen on another route replaces the transport and keeps the holder's listeners" — [2004](2004-browser-node-clients-registry.md).
- **Live evidence (2026-11-07, commit `6860254e8` code + spec fixes in `0069f0a92`, run from a detached worktree at that code).** Profiles `uf-2013-cmd` and `uf-2013-leaf`: `mise run dev:test --profile <p> --fixture --no-agent-credentials --headless --agent-platforms claude` with `ORKESTRATOR_HOST_REACHABILITY_CHECK=off` and the agent session's `ORKESTRATOR_*`/`CLAUDE*` variables removed. Command: `ORKESTRATOR_AGENT_TEST_PROFILE=uf-2013-cmd ORKESTRATOR_AGENT_TEST_LEAF_PROFILE=uf-2013-leaf ORKESTRATOR_AGENT_TEST_RUN_ID=uf-2013 mise run test:logged -- --name uf-2013-proof-all -- bunx playwright test --config e2e/agent-testing/playwright.scope-proof.config.ts`. Result: **3 passed, 0 failed** (`results.json`) (browser direct 26.5 s, browser relay 25.8 s, Electron direct+relay 51.3 s; each holds both scopes through a 20 s quiet window). Evidence JSON (no secrets): `output/agent-testing/uf-2013/evidence/{browser,desktop}-{direct,relay}.json`, `results.json`.
  - Every run: both scopes open at once (`openScopes`: command + leaf), `get_node_status` answered by the right node on each, `resource-changed` received on each (4–84 ms after the mutation), 0 cross-scope deliveries, the leaf terminal's output seen (55–56 ms after the write), both connections `live` while held. Leaf open: browser 10 ms direct / 7 ms relay; desktop 34 ms direct / 125 ms relay (includes the refused direct probe).
  - Route: browser direct `path: direct` on the leaf's origin, relay `path: relay` on the command origin's `/__orkestrator/nodes/<leaf>`; desktop the same, relay `via` the command node.
  - `nextHopProtocol`: browser, command origin `http/1.1`; leaf origin `""` in resource timing (cross-origin without `Timing-Allow-Origin` hides it), CDP's response protocol `http/1.1`; under the relay no response came from the leaf's origin at all. Desktop: the renderer has no resource entry for any node origin (only the Vite dev server, `http/1.1`), because every node call goes over IPC; main reaches nodes with Node's `fetch` (HTTP/1.1).
  - Long-lived requests per origin, held after the quiet window. Browser direct: command origin 4 (`/events` ×2, `/session`, `/client-metrics`), leaf origin 1 (`/events`), plus the Vite HMR socket. Browser relay: command origin 5 (the same 4 plus `/nodes/<leaf>/__orkestrator/events`), leaf origin 0. So a relayed leaf adds one long-lived request to the command origin's six-connection HTTP/1.1 budget, leaving one slot. Desktop (main, event streams opened after instrumentation; the command connection's own stream predates it): direct leaf 1 (`/events`), command 0 extra; relay command 1 (`/nodes/<leaf>/__orkestrator/events`), leaf 0, and the direct phase's leaf stream had closed on release. Main's established TCP sockets (idle keep-alive included): 18 to the command origin, 2–3 to the leaf.
- **Two leaves at once (browser, 2026-11-07, `6d985b088`).** With a third profile (`uf-2013-smoke`) attached as a second leaf, `ORKESTRATOR_AGENT_TEST_SECOND_LEAF_PROFILE=uf-2013-smoke ... --project browser -g "two leaf"`: **1 passed**. The page held three scopes at once (command + two leaves, all `live`, three distinct node ids), each leaf answered by itself over its own direct route, `resource-changed` and the terminal proven on each, no cross-talk. Evidence `output/agent-testing/uf-2013/evidence/browser-two-leaves.json`. This is also 2004's live Done-when.
- **Browser smoke at the same code (2026-11-07).** `mise run test:agent:browser` against a running profile `uf-2013-smoke` started as the isolated runner starts its own (`--fixture --no-agent-credentials --agent-platforms codex`, its env), at `6860254e8` (includes `57ed02976`/`632c0e0ba`; the worktree also carried `0069f0a92`'s test-harness-only changes while it ran): **51 passed, 3 failed, 124 skipped** (`output/agent-testing/uf-2013/smoke-run1-results.json`). All three failures are `terminal-input-resume.spec.ts`, reproduced alone (`smoke-rerun-terminal-input-resume-results.json`). "a lost terminal write stays fenced …" also fails at base `148e9ad0a` on this host (vim ruler pattern; `base-148e9ad0a-terminal-input-resume-results.json`). The two "a stopped shell is automatically replaced after terminal-only {http-sse,websocket} recovery" cases pass at base and fail here because the spec reads `useTerminalPortalStore.getState().getTerminal(environmentId, "tab-shell")`, and plan item 3008 (`8603b56f9`) made it `getTerminal(nodeId, environmentId, tabId)`: the spec gets `undefined` and an empty buffer. Spec drift for 3008 to fix, not a 2013 change. (A first smoke attempt on `uf-2013-cmd`, started with `--agent-platforms claude`, was invalid: codex-dependent cases failed for want of Codex; stopped, its failure list kept in `invalid-smoke-claude-only/`.)
- **Findings for the report/orchestrator.** (1) Browser relay puts five long-lived requests on one HTTP/1.1 origin with a single leaf (§6.2 "Connection budget" should count `/session` and `/client-metrics` too). (2) A local environment created over the API has no `worktreePath` until `start_environment`. (3) The desktop renderer's `nodes.gateway` snapshot names `via` with the command node's display name (`arktech-mini` here, its host name).
- Aggregate suite (`mise run test`) left to review preparation.

## Work log

- 2026-11-07 (claude-worker): added the dev:test-only scope-proof harness (`apps/web/src/lib/node-scope/scope-proof-harness.ts`, installed from `renderer-entry.tsx` behind `import.meta.env.DEV && VITE_ORKESTRATOR_PROFILE_FLAVOR === "agent-test"`; the agent-test launcher passes the flavor to Vite), its unit test (6 pass), and the live specs `e2e/agent-testing/scope-proof.spec.ts` / `scope-proof-electron.spec.ts` with `scope-proof-support.ts` and `playwright.scope-proof.config.ts` (registered in `tests/unit/playwright-spec-loading.test.ts`). Commits `57ed02976` (with an empty `vite-env.d.ts` by mistake, restored in `632c0e0ba`), `0069f0a92`, `6d985b088`. Live at `6860254e8` against `uf-2013-cmd` + `uf-2013-leaf`: browser direct, browser relay, Electron direct then relay, 3 passed; two leaves at once, 1 passed. Phase 2 test list at the same code: desktop `node-ipc`, `node-scopes`, `window-request-authorization`, `node-previews`, `preload-api` 81 pass; web `node-clients` + `scope-proof-harness` 25 pass. Web and desktop typecheck clean at `6860254e8`; fmt and oxlint clean; production `vite build` contains no harness. Browser smoke on `uf-2013-smoke` at `6860254e8`: 51 passed, 3 failed (`terminal-input-resume.spec.ts`, see Notes). Profiles stopped and reset; the live worktree removed.
