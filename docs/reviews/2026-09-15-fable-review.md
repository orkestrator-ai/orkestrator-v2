# Whole-codebase review — 2026-09-15

Reviewer: Claude Fable 5.1 (automated, seven area reviewers plus one validation worker).
Head: `c2ca4a1cb719fc99a621e28cc061eb9a63da7ec6` (identical to `origin/main`; working tree clean).

## Review Scope
- Target branch: main
- Base ref: origin/main...HEAD — base `c2ca4a1cb719fc99a621e28cc061eb9a63da7ec6`, head `c2ca4a1cb719fc99a621e28cc061eb9a63da7ec6` (no diff; the request was to review the whole codebase, not a change)
- Commit created: none (automated review)
- Files reviewed:
  - `apps/backend/src`: `main.ts`, `gateway*.ts` (base, auth, handlers, events, event-replay, proxy, support*), `terminal-websocket-server.ts`, `managed-web-client.ts`, `tailscale-serve.ts`; `core/`: `storage-base.ts`, `storage-projects.ts`, `storage-config.ts`, `storage-reviews.ts`, `index.ts`, `pr-monitor.ts`, `commands-pr-monitor.ts`, `diff-stats-service.ts`, `worktree-watcher.ts`, `git-fetch-scheduler.ts`, `local-server-reaper.ts`, `process-tree.ts`, `pty.ts`, `shell.ts`, `commands-containers.ts`, `commands-environment.ts`, `environment-lifecycle-tasks.ts`, `project-git-service.ts`, `docker-ownership.ts`, `commands-container-exec.ts`, `commands-server-health.ts`, `commands-agent-support.ts`, `commands-files.ts` (partial), `commands-servers.ts` (deletion path), `control-mcp-server.ts` (listener/scope gate), `http-bridge-provider.ts` (usage refresh), plus timer/shutdown sections of the native-agent, build-pipeline, agent-mail, looped-review, multi-review and feature-planning services
  - `bridges/claude-bridge/src`: `index.ts`, `services/event-emitter.ts`, `services/logger.ts`, `services/session-manager-interactions.ts`, `services/session-manager-prompt.ts` (canUseTool block), `services/session-manager-lifecycle.ts` (abort/cleanup), `routes/events.ts`, `routes/session.ts`
  - `bridges/pi-bridge/src`: `index.ts`, `server.ts`, `http.ts`, `interactions.ts`, `timeout.ts`, `config.ts`, `state.ts`, `prompt.ts`, `agent-session.ts`, `persistence.ts`, `translate.ts` (head), `mcp.ts` (refresh predicate)
  - `bridges/cursor-bridge/src`: `index.ts`, `server.ts`, `config.ts`, `http.ts`, `prompt.ts`, `agent-session.ts`, `state.ts` (helpers), `translate.ts` (entry/settle)
  - `bridges/codex-bridge/src`: `index.ts` (ring, emit, SSE writers, `/event/subscribe`), `event-ring.ts`, `engine/app-server-engine.ts`, `app-server/jsonl-rpc-client.ts`, `app-server/process-supervisor.ts` (first 1000 lines), `app-server/server-request-router.ts`, `app-server/approvals.ts`, `app-server/event-reducer.ts`, `sessions/*`, `app-server-runtime-base.ts`, `-lifecycle.ts`, `-tail.ts` (sections), `session-titles.ts` (child spawn)
  - `bridges/acp-bridge/src`: `index.ts`, `acp-server.ts`, `acp-context.ts`, `acp-session.ts`, `acp-client-methods.ts`, `acp-http.ts`, `acp-prompt.ts`, `acp-public.ts` (partial)
  - `packages/protocol/src`: `fatal-rejections.ts`, `parent-watchdog.ts`, `terminal-websocket.ts`, `terminal-history.ts`, `transcript-window.ts`, `progressive-transcript.ts`, `resource-events.ts`, `connections.ts`, `gateway-token.ts`, `web-client.ts`, `browser-preview.ts`, `review-evidence-frames.ts`
  - `packages/cli`: `package.json`, `bin/orkestrator.js`, `scripts/build.ts`, `scripts/smoke-packed.ts`
  - `apps/desktop/electron`: `main.ts`, `window.ts`, `ipc.ts`, `preload.ts`, `preload-api.ts`, `backend-process.ts`, `backend-lifecycle.ts`, `connection-manager.ts`, `remote-gateway-request-auth.ts`, `browser-preview-*.ts`, `context-menu.ts`, `single-instance.ts`, `quit-policy.ts`, `desktop-window-lifecycle.ts`, `toolchain-bootstrap-*.ts`, `toolchain-startup.ts`, `web-client-controller.ts`, `application-logging.ts`, `runtime-profile.ts` (partial), `toolchain-manager.ts` (lock/download/extract/probe sections); `apps/desktop/scripts/build.ts`, `scripts/dev/lifecycle.ts`
  - `apps/web/src`: `lib/native/web-gateway.ts`, `lib/native/events.ts`, `lib/native/gateway-auth-transport.ts`, `lib/native/terminal-websocket-client.ts`, `lib/resource-sync.ts`, `lib/store-resource-sync.ts` (pane-layout), `lib/claude-client.ts`, `lib/codex-client.ts`, `lib/gateway-url.ts`, `lib/gateway-token.ts`, `lib/feature-build-activation.ts`, `lib/build-launch-options.ts` (defaults), `hooks/useTerminal.ts`, `hooks/useNativeAgentSession.ts` (partial), `hooks/useEnvironments.ts`, `hooks/useEnvironmentDiffStats.ts`, `hooks/useUnreadEnvironmentSync.ts`, `hooks/useGlobalActivityMonitor.ts`, `hooks/useAgentState.ts`, `hooks/useManualSessionRefresh.ts`, `hooks/usePromptDeadline.ts`, `hooks/useFilesPanel.ts` (polling), `stores/createNativeChatStore.ts` (header), `stores/environmentStore.ts`, `stores/terminalSessionStore.ts`, `stores/nativeAgentProjectionStore.ts`, `stores/agentActivityStore.ts`, `stores/sessionStore.ts` (partial), `components/terminal/TerminalContainer.view.tsx` (reconnect), `components/terminal/PersistentTerminal.tsx` (effects), `components/terminal/InitializationLogs.tsx`, `components/claude/ClaudeTmuxChatTab.tsx` (effects), `components/native-agent/AgentNativeTab.controller.tsx` (effect inventory), `components/build/BuildLaunchDialog.tsx` (card rendering, open/reset effect), `App.tsx` (Docker poll)
  - `apps/web-public/src`: `connection.ts`, `main.tsx`
  - `docker/`: `Dockerfile`, `init-firewall.sh`, `update-firewall.sh`, `entrypoint.sh` (firewall block, tail), `build.sh`
  - `scripts/`: `download-bun.sh`, `download-agent.ts`, `verify-toolchain-artifacts.ts`, `install-packaged-app-linux.ts`, `install-packaged-app-mac.ts`, `verify-packaged-backend.ts`, `run-logged.ts`, `test-admission.ts`, `test-all.ts`, `generate-codex-app-server-protocol.ts` (generate/write/main)
  - `.github/workflows/lint.yml`, `publish-container.yml`, `validate-bun-runtime.yml`; `patches/*`; root `package.json`, `bun.lock` (patchedDependencies entry only), `mise.toml`, `bunfig.toml`, `turbo.json`; `tests/setup.ts`, `tests/setup-node.ts`, `tests/register-dom.ts`, `tests/isolate-git-config.ts`, `tests/bounded-*.ts`; `config/*.json`, `conductor.json`, `orkestrator-ai.json`
  - `AGENTS.md`, `docs/development/testing-guide.md`
- Files skipped:
  - `bridges/codex-bridge/src/app-server/generated/**` — generated protocol lockfile
  - `node_modules/**`, `**/dist/**`, `release/**`, `bun.lock` body — vendored / generated
  - `apps/ios/**` — outside the non-iOS suite and not requested
  - `apps/backend/src/core/tmux-*.ts`, `terminal-history*.ts`, `http-bridge-*.ts` (beyond usage refresh), `agent-provider-runtime*.ts`, `opencode-*.ts`, `commands-local-server-lifecycle.ts`, `storage-shared-core.ts`, `storage-sessions.ts`, `storage-native.ts`, `agent-tools.ts`, `build-pipeline-service-supervisor.ts`, `review-fanout.ts`, `control-mcp-server.ts` tool bodies — too large for this pass; the sub-reviews assigned to them were terminated by a session rate limit
  - `bridges/claude-bridge/src/services/session-manager-{core,persistence,messages,background-tasks,prompt-stream}.ts` and most of `session-manager-prompt.ts` — not read
  - `bridges/codex-bridge/src/{messages,prompts,history}/**`, `app-server-runtime-{prompt,sessions}.ts`, `codex-collaboration.ts`, `notification-recorder.ts`; `bridges/acp-bridge/src/acp-{tools,transcript,persistence}.ts` — not read
  - `packages/protocol/src` domain-model modules (structured review, feature planning, native-agent, agent-mail, coordinator, pane-layout, agent-settings) — not read
  - `apps/web/src/components/markdown/**`, `components/chat/**`, `lib/terminal-links.ts`, Multi Review / handoff / looped-review / PR-monitor stores and hooks, `stores/paneLayoutStore.ts`, `components/layout/**` — the sub-review covering them was terminated; only a grep for `dangerouslySetInnerHTML` (zero non-test hits) was done
  - `docker/entrypoint.sh` credential-copy section (~lines 430-840), `workspace-setup.sh`, `runtime-env.sh`, `git-branch-helpers.sh`, `codesign-app.sh`; `scripts/scrub-codex-recording.ts`, `run-ios-simulator.ts`, `test-ios.ts`, `opencode-live-compatibility-probe.ts`, `scripts/steer-probes/**` — not read
- Files left uncommitted:
  - `docs/reviews/2026-09-15-fable-review.md` — this report, written at the user's request; not committed
- Commands run:
  - `mise run format:check` — FAIL, exit 1 (19 files not formatted; list under Test Results)
  - `mise run lint` — FAIL (mise reported `[lint] ERROR task failed`; exit code not captured by the worker's pipeline)
  - `bunx oxlint . | grep -v no-unused-vars` — second invocation, run only to recover the error line the worker lost: 1 error, `apps/web/src/components/build/BuildLaunchDialog.tsx:788:7 react-hooks(exhaustive-deps)`
  - `mise run typecheck` — FAIL, exit 2 (`@orkestrator/backend#typecheck` 2 errors; `@orkestrator/web#typecheck` aborted by turbo before completing; 7 other packages cache-hit pass)
  - `mise run test` — FAIL, exit 2, 115 s (workspace group FAIL at the `@orkestrator/web#build` tsc step, so backend/web/desktop/web-public tests did not run; root group 4247 pass / 2 skip / 3 fail; bridges PASS; codex protocol lockfile PASS)
  - `mise run test:logged -- --name review-web -- bun test --cwd apps/web src --parallel=4 --only-failures` — PASS, 39.3 s (run because the aggregate skipped it; counts not printed by the wrapper on success)
  - `mise run test:logged -- --name review-backend -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts src tests --parallel=4 --only-failures` — FAIL: 3238 pass / 1 skip / 1 fail across 142 files, 38.7 s
  - `mise run test:logged -- --name review-desktop -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./electron/application-logging.test.ts ./electron/runtime-profile.test.ts ./scripts/dev --parallel=2 --only-failures` — PASS, 0.5 s
  - `mise run test:logged -- --name review-web-public -- bun test --cwd apps/web-public src --parallel=2 --only-failures` — PASS, 0.6 s
  - `bun install --frozen-lockfile --dry-run` — OK (lockfile current)
- Commands not run:
  - `mise run test:all` / `mise run test:ios` — iOS excluded from the default suite; requires Xcode toolchain
  - `mise run test:browser`, `test:agent:browser`, `test:agent:electron`, `test:agent:docker` — Playwright suites need a built renderer/Electron app and browsers; not part of `mise run test`
  - `mise run verify:opencode:live`, `verify:toolchains:live`, `verify:packaged-backend`, `docker:build` — live-network / packaging tasks, not validation of the source
  - `mise run build:all` — the web `tsc` step is already known to fail from the test run; not repeated
- Limitations:
  - A whole-codebase review of ~360k source lines cannot be exhaustive. Coverage was prioritised toward trust boundaries, process lifecycle, persistence, transport invariants, and the container firewall. The "Files skipped" list is the honest boundary of what was read.
  - The session was interrupted once by an API rate limit and once by a process restart; all reviewers were resumed from saved transcripts, but four backend-core sub-reviews and two web sub-reviews (XSS/URL surface; Multi Review, handoff, build-launch and PR-monitor state transitions) were lost and are unreviewed.
  - The GitHub MCP connection failed, so CI run history for recent merges could not be checked; statements about CI gating are from the workflow files only.
  - Every P1 finding below was independently re-verified in source by the primary reviewer. P2 findings rely on the area reviewers' evidence excerpts.

## Risk Profile
- Change type: feature, bugfix, refactor, test, infra, security (whole-codebase snapshot)
- Risk areas: auth, authorization, data-loss, external-io, concurrency, background-jobs, supply-chain, deployment, llm, container-isolation
- Overall risk: high
- Reasoning: `main` currently fails format, lint, typecheck, the web build and five tests, so the release gate is red. Independently, the Docker "restricted" network mode is not a boundary against the agent it contains (root-equivalent sudo plus NET_ADMIN, and a fail-open firewall script), and token rotation on the gateway does not revoke live SSE streams.

## Issues

### 1. [P1][conf:92][security]
#### Agent user inside the container can disable or widen the network firewall
- File: docker/Dockerfile:390
- Symbol: "" (Dockerfile RUN; container create args in apps/backend/src/core/commands-containers.ts:131)
- Description: Containers are created with `--cap-add NET_ADMIN`, and the image grants the unprivileged `node` user (every agent's identity) passwordless `SETENV` sudo to a uid-0 `orkroot` account for any command, plus sudo on both firewall scripts. Anything running as `node` can flush the iptables policy or re-run the firewall with its own `ALLOWED_DOMAINS`, so restricted mode does not constrain the agent it is meant to contain.
- Evidence: `echo "node ALL=(root) NOPASSWD:SETENV: /usr/local/bin/init-firewall.sh, /usr/local/bin/update-firewall.sh"` (Dockerfile:386) and `echo "node ALL=(orkroot) NOPASSWD:SETENV: ALL"` (Dockerfile:391) with `useradd -o -u 0 -g 0 ... orkroot` (Dockerfile:390); `"--cap-add", "NET_ADMIN"` (commands-containers.ts:131-132). Verified in source by the primary reviewer.
- Suggestion: Apply the firewall from the backend via `docker exec -u root` before the agent starts, then drop `NET_ADMIN`; remove the `node -> orkroot ALL` sudoers rule and provide root terminals through `docker exec -u 0` instead; drop `SETENV` and pass the allowlist via a root-owned file.
- Verification: From an agent shell as `node`, `sudo -u orkroot iptables -P OUTPUT ACCEPT` and `sudo -E ALLOWED_DOMAINS=example.org /usr/local/bin/init-firewall.sh` must both fail; `curl https://example.com` from the container must still be blocked afterwards.
- Fixes: Dropping `NET_ADMIN` entirely is the strongest fix but requires the backend to own firewall setup; removing the sudoers grants alone closes the agent-side bypass while keeping the current entrypoint flow.

### 2. [P1][conf:90][error-handling]
#### Firewall script fails open and the entrypoint continues after failure
- File: docker/init-firewall.sh:17
- Symbol: "" (shell; entrypoint call at docker/entrypoint.sh:423)
- Description: `init-firewall.sh` flushes every chain at the top, then fetches `https://api.github.com/meta` and resolves each allowed domain, and only sets `-P INPUT/FORWARD/OUTPUT DROP` at lines 197-199. Any `set -e` exit in between (GitHub meta unreachable or rate-limited, a `jq` field check failing, a bad CIDR) leaves empty chains with ACCEPT policies. The entrypoint masks the failure as a log line and still marks the environment ready; nothing in the backend consumes that warning.
- Evidence: `iptables -F` … `gh_ranges=$(curl -s https://api.github.com/meta)` (line 54, no `-f`, no `--max-time`) … `iptables -P OUTPUT DROP` (line 199); `sudo -E /usr/local/bin/init-firewall.sh || log_progress "Warning: Firewall initialization failed ..."` (entrypoint.sh:423). Verified in source.
- Suggestion: Set DROP policies immediately after the flush (with lo/DNS/established rules added first), add `trap` on ERR that re-asserts DROP, give `curl` `-fsS --max-time 20`, and make the entrypoint exit non-zero (or write a marker the backend surfaces as an error) when `NETWORK_MODE=restricted` and the script fails.
- Verification: Block `api.github.com` from the build host, start a restricted environment, and confirm `curl https://example.com` from inside the container fails and the environment reports a firewall error rather than "ready".

### 3. [P1][conf:90][correctness]
#### `main` does not typecheck: BuildLaunchDialog card union fails to narrow, plus two stale tests
- File: apps/web/src/components/build/BuildLaunchDialog.tsx:1170
- Symbol: BuildLaunchDialog (card render callback)
- Description: The `reviewPreparation` branch is guarded by `card.kind === "reviewPreparation" && reviewPreparation && resolvedReviewPreparation`, so when the extra conditions are false the `reviewPreparation` member is not narrowed out and the fallthrough accesses `card.key`, which does not exist on that member. This breaks `bunx tsc` in the web build, which in turn aborts the workspace test group of `mise run test`. Two test files also fail typecheck: `BuildLaunchDialog.test.tsx` passes reviewer titles not in the `stepKey` union, and `native-agent-display-tails.test.ts` builds a record whose `schema` is `string` rather than the literal union.
- Evidence: `tsc` output: `BuildLaunchDialog.tsx(1170,33): error TS2339: Property 'key' does not exist on type ... | { kind: "reviewPreparation"; ... }` (also 1172, 1176, 1177, 1187); `BuildLaunchDialog.test.tsx(370,19): error TS2345: Argument of type '"Reviewer 1"' is not assignable ...`; `native-agent-display-tails.test.ts(140,61): error TS2345 ... Type 'string' is not assignable to type '"native-agent-display-tail-v2" | "native-agent-display-tail-v1"'` and `(142,17): TS2339 Property 'historyComplete' does not exist`. Introduced by #753 (`git log` on the file).
- Suggestion: Narrow on `card.kind === "reviewPreparation"` alone and handle the missing-state case inside that branch (return null or a placeholder); widen the test helper's title parameter type or use the step-key union; type the display-tail fixture with `as const` on `schema` and assert `historyComplete` through the validated type.
- Verification: `mise run typecheck` exits 0 and `mise run test` reaches the backend/web/desktop/web-public groups.

### 4. [P1][conf:85][testing]
#### `main` fails five tests, formatting, and lint
- File: tests/unit/components/CreateEnvironmentDialog.test.tsx:4270
- Symbol: "CreateEnvironmentDialog feature builds" (two tests), "bounded test diagnostics", "agent provider module boundaries"
- Description: Two feature-build tests expect the `verify` step to have no `reasoningEffort`, but `resolveBuildLaunchDefaults` now falls back to the `fixReviewIssues` action (which carries `reasoningEffort: "medium"`) when `verify` has no usable platform (apps/web/src/lib/build-launch-options.ts:166-171, from #753). Either the tests are stale or the fallback should not inherit reasoning effort; the failure means the intended default is unspecified. `test-diagnostic-bounds` flags four test files that pass DOM query results straight to `toBeNull`, and `agent-provider-boundaries` fails because `opencode-provider.ts` is 1551 lines against a 1500 limit. Nineteen files fail `oxfmt --check`, and `oxlint` reports one error (`react-hooks/exhaustive-deps` at BuildLaunchDialog.tsx:788 — `resetLaunchState` is a plain closure recreated each render and is omitted from the effect deps).
- Evidence: `expect(request.steps).toEqual(...)` diff `"model": "sonnet", + "reasoningEffort": "medium"` at lines 4270 and 4583; `test-diagnostic-bounds.test.ts:64` offenders `tests/unit/components/FilesPanel.test.tsx`, `apps/web/src/components/native-agent/AgentNativeTab.test.tsx`, `apps/web/src/components/files-panel/FilesPanelViews.test.tsx`, `apps/web/src/components/chat/AgentModelPicker.test.tsx`; `agent-provider-boundaries.test.ts`: `Expected: <= 1500, Received: 1551`.
- Suggestion: Decide the intended verify default (either strip `reasoningEffort` when falling back or update both tests to expect it); rewrite the four DOM absence assertions per the repo's bounded-diagnostics rule; split `opencode-provider.ts` or move helpers out to get under the limit; run `mise run format` and wrap the effect in `useCallback`/add the dependency.
- Verification: `mise run check` and `mise run test` exit 0.

### 5. [P1][conf:85][security]
#### Gateway token rotation leaves already-open SSE `/events` streams authenticated with the old token
- File: apps/backend/src/gateway-base.ts:414
- Symbol: GatewayBase.setToken; GatewayHandlers.handleEvents (scheduleCredentialExpiry, gateway-handlers.ts:263)
- Description: `setToken` clears agent-test sessions and calls `terminalWebSocket.revokeConnections()`, but never touches the SSE clients in `this.clients`. For a durable-token credential `scheduleCredentialExpiry` installs no timer (`gatewayCredentialExpiresAt` returns null), so a client holding the previous token keeps receiving every authoritative event after the operator rotates the token, which is exactly the leaked-credential scenario rotation exists for.
- Evidence: gateway-base.ts:414-419 clears bootstraps/sessions and revokes WebSockets only; gateway-handlers.ts:263-269: `if (!this.gatewayCredentialMatches(credential)) { close(); return; } const expiresAt = ...; if (expiresAt === null) return;`. Reachable via `PUT /__orkestrator/gateway-settings`. Verified in source.
- Suggestion: In `setToken`, after revoking WebSockets, iterate `this.clients` (and in-flight `proxyRequests`) and destroy any whose captured credential no longer matches; or register each stream's `close` in a set that `setToken` drains.
- Verification: Extend `tests/unit/electron/gateway-events.test.ts` "closes active sockets on credential rotation" with an SSE client opened under the old token and assert it receives no events after `setToken`.

### 6. [P1][conf:85][correctness]
#### Cursor bridge `GET /session/:id/usage` is unreachable; the request returns the whole-session snapshot
- File: bridges/cursor-bridge/src/http.ts:262
- Symbol: routeSession (SESSION_ROUTE)
- Description: `SESSION_ROUTE` does not list `usage` in its action alternation, so `/session/abc/usage` matches with `action=undefined, subject="usage"` and takes the `!action && GET` branch. The `usage` branch that calls `refreshAgentUsage` and `refreshPlanAccountWindows` never runs, so the backend's explicit usage refresh silently returns the stale `contextUsage`. The same laxness makes `DELETE /session/:id/<anything>` delete the session.
- Evidence: SESSION_ROUTE alternation is `messages|transcript|status|activity|prompt|attach|dispatch|cancel|abort|hard-abort|steer|structured-output|interactions|config|approvals|runtime-health|commands|mcp|rewind-messages` (no `usage`); the handler at http.ts:339 tests `action === "usage"`; caller `apps/backend/src/core/http-bridge-provider.ts:501-513` fetches `/session/${id}/usage` and reads `body.contextUsage`. Verified in source.
- Suggestion: Add `usage` to the alternation and return 404 when `action` is undefined but a `subject` segment is present.
- Verification: Add an HTTP-level test in `bridges/cursor-bridge/src/http.test.ts` that `GET /session/:id/usage` invokes `refreshAgentUsage`, and that `DELETE /session/:id/unknown` returns 404.

### 7. [P1][conf:80][correctness]
#### Pi bridge `/attach` and idempotent `/session/create` can detach the SDK session under a running turn
- File: bridges/pi-bridge/src/http.ts:457
- Symbol: routeSession (attach), routeGlobal (create); reconcileAgentMcp (agent-session.ts:339)
- Description: Both routes call `storeAgentMcp` then `reconcileAgentMcp`, which detaches the live `AgentSession` whenever the tab MCP token changed, without checking `state.status === "running" || state.dispatching`. `detachSession` unsubscribes the transcript listener, closes MCP and disposes the runtime while `followRun` is still awaiting the run, destroying the live turn. The cursor bridge guards the identical path with a 409 (cursor http.ts:394-395).
- Evidence: pi http.ts:456-458: `storeAgentMcp(state, body.agentMcp); await reconcileAgentMcp(state);` with no busy check; agent-session.ts:339-343: `if (!state.session) return; if (!mcpConnectionNeedsRefresh(state)) return; await detachSession(state);`. Verified in source.
- Suggestion: Refuse with 409 (or defer the reconcile until the turn settles) when the session is running/dispatching/compacting and the connection key would change, mirroring the cursor bridge.
- Verification: Add a test in `bridges/pi-bridge/src/http.test.ts` that attaches with a rotated `agentMcp` during an in-flight prompt and asserts the run completes and the transcript is intact.

### 8. [P1][conf:78][correctness]
#### Zero-length JSON store bypasses backup recovery, and atomic writes never fsync
- File: apps/backend/src/core/storage-base.ts:1126
- Symbol: StorageBase.loadJson; StorageBase.writeAtomic (storage-base.ts:663-684)
- Description: `loadJson` returns `fallback()` for an existing but empty/whitespace file without consulting the `.bak.N` ladder, whereas an unparseable file does trigger recovery. `writeAtomic` writes the temp file and renames it with no `fsync`, so a crash after rename can leave a zero-length primary. The next mutation then loads `[]`, saves it, and rotates the empty file into `.bak.1`; older backups survive a few more rotations but the loss is silent and the `loadJsonCached` doc comment ("only a genuinely absent file yields the fallback") documents the opposite intent.
- Evidence: `if (!raw.trim()) return fallback();` (line 1126) is inside the `try` but not the `catch` that calls `recoverJsonFromBackups`; `await fs.writeFile(tempPath, contents, ...)` … `await fs.rename(tempPath, filePath)` with no `handle.sync()` (lines 663-684), unlike `tmux-backend.ts:188`. Verified in source.
- Suggestion: Treat an empty existing file like a corrupt one and attempt backup recovery before falling back; open the temp file with a handle and `sync()` before rename (and optionally fsync the directory).
- Verification: Add a `storage.test.ts` case writing an empty `environments.json` beside a valid `.bak.1` and assert the environments are recovered; assert no rotation of the empty file into backups.

### 9. [P2][conf:85][security]
#### Restricted network mode allows outbound TCP/22 and UDP/53 to any destination
- File: docker/init-firewall.sh:37
- Symbol: "" (shell)
- Description: Before the allowlist is consulted the script accepts outbound UDP 53 and TCP 22 to every IP, so an agent can tunnel over SSH (`ssh -D`/`-R`) or exfiltrate via DNS to any host regardless of `ALLOWED_DOMAINS`.
- Evidence: `iptables -A OUTPUT -p udp --dport 53 -j ACCEPT` (line 37) and `iptables -A OUTPUT -p tcp --dport 22 -j ACCEPT` (line 41).
- Suggestion: Restrict DNS to the resolvers in `/etc/resolv.conf` (Docker's `127.0.0.11`) and SSH to the git-host IP sets already collected (`-m set --match-set allowed-domains dst`).
- Verification: From a restricted container, `ssh -o ConnectTimeout=3 user@203.0.113.1` and `dig @1.1.1.1 example.com` must fail while `git fetch` over SSH to GitHub still succeeds.

### 10. [P2][conf:85][supply-chain]
#### Bundled desktop Bun binary is downloaded without checksum verification
- File: scripts/download-bun.sh:51
- Symbol: "" (shell)
- Description: The Bun runtime shipped inside the packaged desktop app is fetched from GitHub releases and validated only by running `bun --version`, while every other binary in the repo (Node, grok, pi, starship, mise, agents via `download-agent.ts`) is digest-verified. Bun publishes `SHASUMS256.txt` per release.
- Evidence: `curl -fsSL "$BUN_URL" -o "$TEMP_DIR/bun.zip"` … `unzip` … `DOWNLOADED_BUN_VERSION=$("$BINARIES_DIR/bun" --version)`.
- Suggestion: Pin per-platform SHA-256 digests next to `BUN_VERSION` (or fetch and check `SHASUMS256.txt`) before extracting; add the pins to `tests/unit/version-drift.test.ts`; add `set -uo pipefail`.
- Verification: Corrupt the downloaded zip and confirm the script exits non-zero before `unzip`.

### 11. [P2][conf:85][supply-chain]
#### Dockerfile installs git-delta and OpenCode without integrity verification
- File: docker/Dockerfile:86
- Symbol: "" (Dockerfile RUN; OpenCode at line 136)
- Description: git-delta is `wget` + `dpkg -i` with no digest and OpenCode is `curl … | bash` of an unpinned installer (only the CLI version argument is pinned), both as root during image build and both landing in the published `ghcr.io` image, contrary to the Node block's own stated rule of verifying against `SHASUMS256.txt`.
- Evidence: `wget "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && sudo dpkg -i ...`; `RUN curl -fsSL https://opencode.ai/install | bash -s -- --version "$OPENCODE_CLI_VERSION"`.
- Suggestion: Pin per-arch SHA-256 for the delta `.deb` in the same `case` pattern used for grok/pi; download the OpenCode release tarball directly and verify with `sha256sum -c` using the digests already in `apps/desktop/electron/toolchain-manifest.ts`.
- Verification: `mise run docker:build` succeeds with pinned digests and fails when a digest is altered.

### 12. [P2][conf:78][supply-chain]
#### Git host keys are baked into the image by trust-on-first-use `ssh-keyscan` at build time
- File: docker/Dockerfile:398
- Symbol: "" (Dockerfile RUN)
- Description: `known_hosts` for github.com, gitlab.com and bitbucket.org is populated from whatever answers during the image build; a build-time interception would bake attacker keys into every published image and every environment would then trust them silently. All three providers publish fingerprints.
- Evidence: `ssh-keyscan github.com >> /home/node/.ssh/known_hosts && ssh-keyscan gitlab.com >> ... && ssh-keyscan bitbucket.org >> ...`.
- Suggestion: `COPY` a committed `known_hosts` with the published keys, or verify the scan output against pinned fingerprints with `ssh-keygen -lf` and fail the build on mismatch.
- Verification: Build with a deliberately wrong pinned fingerprint and confirm the build fails.

### 13. [P2][conf:85][error-handling]
#### Unauthenticated `/__orkestrator/login` turns malformed JSON or oversized bodies into a 500 and logs the parse error
- File: apps/backend/src/gateway-support-extra.ts:229
- Symbol: readLoginToken; GatewayAuth.handleLogin (gateway-auth.ts:513)
- Description: `readLoginToken` calls `JSON.parse` without try/catch, dereferences `parsed.token` (throws on a `null` body) and lets `RequestBodyTooLargeError` escape; `handleLogin` catches none of these, so the generic handler in `listen()` answers 500 with `error.message` and logs `[RemoteGateway] Request failed:`. This is pre-auth, trivially triggerable, and the JSC parse message can include body text (invariant 12). The same class of bug was explicitly fixed for `/invoke`.
- Evidence: `const parsed = JSON.parse(body.toString("utf8")) as { token?: unknown }; return typeof parsed.token === "string" ? parsed.token : "";` with no guard; route dispatched before `authenticated()` at gateway-auth.ts:289-292.
- Suggestion: Wrap the JSON branch in try/catch returning `""`, guard `parsed && typeof parsed === "object"`, and map `RequestBodyTooLargeError` to 413 and invalid bodies to the 401 login page, mirroring `handleInvoke`.
- Verification: Add cases to `tests/unit/electron/gateway-auth.test.ts` for `{`, `null`, and an oversized JSON login body, asserting 401/413 and no error log line.

### 14. [P2][conf:80][error-handling]
#### Malformed percent-encoding in the auth cookie throws `URIError` and surfaces as a pre-auth 500
- File: apps/backend/src/gateway-support-extra.ts:101
- Symbol: getCookie
- Description: `getCookie` runs `decodeURIComponent` on the raw cookie value; a cookie such as `orkestrator_gateway_auth=%E0%A4%A` throws, and since `authenticated()` runs for every request the result is a 500 plus an error log instead of a 401. The terminal WebSocket `tokenMatches` path destroys the socket without a response for the same input.
- Evidence: `if (rawKey === name) return decodeURIComponent(rawValue.join("="));` called from `GatewayAuth.authenticated` (gateway-auth.ts:46), `handleEvents` (gateway-handlers.ts:253), and the WebSocket callbacks (gateway-base.ts:194-205).
- Suggestion: Wrap the decode in try/catch and return `null` (treat as no credential).
- Verification: Unit test `getCookie` with a malformed value and an auth-route test asserting 401.

### 15. [P2][conf:75][security]
#### Agent-test session cookies can read the durable gateway token via `GET /__orkestrator/gateway-settings`
- File: apps/backend/src/gateway-auth.ts:405
- Symbol: GatewayAuth.handleGatewaySettings
- Description: In agent-test mode a browser is deliberately given a short-lived session so the durable token never reaches it, but `gatewayCredentialMatches` accepts the session for every authenticated route including `GET /gateway-settings`, which returns `token` in plain JSON. A session holder can upgrade itself to the unbounded credential in one request or `PUT` a new token to lock others out. Scope is the dev-only agent-test profile on a loopback listener.
- Evidence: `if (request.method === "GET") { jsonResponse(response, 200, await this.getTokenSettings()); return; }` where `getTokenSettings` returns `{ token: this.token || auth.token, ... }` (gateway-base.ts:388-398); `authenticated()` accepts agent-test sessions at gateway-auth.ts:50-61.
- Suggestion: When the presenting credential is an agent-test session, respond 403 for `/gateway-settings` or omit `token` from the GET body.
- Verification: Test in `gateway-auth.test.ts` that a session cookie gets 403 (or a redacted body) from `/gateway-settings`.

### 16. [P2][conf:78][correctness]
#### Stale mutation-lock reclamation can delete a lock another process just acquired
- File: apps/backend/src/core/storage-base.ts:1063
- Symbol: StorageBase.acquireMutationLock
- Description: Two waiters that both observe a stale lock each run `fs.rm(lockPath)` unconditionally. If A removes the stale file and creates its own lock, B's already-decided `rm` deletes A's fresh lock and B's next `open("wx")` succeeds too, so both processes hold the "exclusive" lock and read-modify-write the same JSON file.
- Evidence: `const stat = await fs.stat(lockPath).catch(() => null); if (stat && Date.now() - stat.mtimeMs > staleMs) { await fs.rm(lockPath, { force: true }); continue; }`.
- Suggestion: Reclaim by renaming the stale lock to a unique name and removing the renamed file; a failed rename means someone else reclaimed it, so just loop. Alternatively re-`stat` and compare inode after `rm`.
- Verification: Extend `storage-project-concurrency.test.ts` with two concurrent reclaimers against a stale lock and assert only one acquires.

### 17. [P2][conf:78][correctness]
#### Environment deletion leaves a stale `git worktree` registration when the directory is already gone
- File: apps/backend/src/core/commands-environment.ts:1486
- Symbol: removeLocalWorktree (caller commands-servers.ts:1457)
- Description: `removeLocalWorktree` runs `git -C <worktreePath> worktree remove --force <worktreePath>`; if the directory was already deleted, `git -C <missing>` fails, the `fs.rm` fallback is a no-op, and the registration under the main repo's `.git/worktrees/` is never pruned. `createLocalWorktree` only checks `pathExists`, so the next environment with the same slug fails with "missing but already registered worktree". The sibling `cleanupFailedLocalWorktree` (lines 1514-1532) already does this correctly from `projectPath`.
- Evidence: `await runCommand("git", ["-C", worktreePath, "worktree", "remove", "--force", worktreePath], ...).catch(async () => { await fs.rm(worktreePath, { recursive: true, force: true }); });`.
- Suggestion: Run `git -C <projectPath> worktree remove --force <worktreePath>` and fall back to `fs.rm` plus `git -C <projectPath> worktree prune`, mirroring `cleanupFailedLocalWorktree`.
- Verification: Test that deleting an environment whose worktree directory was removed manually leaves no entry in `git worktree list`.

### 18. [P2][conf:80][error-handling]
#### PTY exit listeners run inside a `.then` with no rejection handler and skip `terminal.close()` on throw
- File: apps/backend/src/core/pty.ts:160
- Symbol: spawnPty (notifyExit)
- Description: `notifyExit` iterates `exitListeners` without try/catch and then closes the terminal; it is invoked from `void spawned.exited.then(...)`. A throwing listener produces an unhandled rejection (fatal under Bun outside the guard) and `terminal.close()` is never reached, leaking the master descriptor. The registered chain in `spawnTerminalProcess` (commands-environment.ts:165-177) calls `hooks.onExit`, `completeTerminalHistory`, and `cleanupTerminalSession`, none wrapped.
- Evidence: `for (const listener of exitListeners) listener(event); if (!terminal.closed) terminal.close();` and `void spawned.exited.then((exitCode) => notifyExit({ exitCode }), () => notifyExit({ exitCode: 1 }));`.
- Suggestion: Wrap each listener call in try/catch with logging, move `terminal.close()` into `finally`, and add `.catch` on the chain.
- Verification: `pty.test.ts` case registering a throwing exit listener and asserting the terminal is closed and no unhandled rejection is reported.

### 19. [P2][conf:85][error-handling]
#### `JsonlRpcClient.request` can reject a promise nobody holds while its write is still queued
- File: bridges/codex-bridge/src/app-server/jsonl-rpc-client.ts:421
- Symbol: JsonlRpcClient.request
- Description: The pending entry and its timeout timer are registered before `await this.writeLine(...)`, which serialises behind `writeChain`. If the timer fires or `rejectAllPending` runs while the write is still queued, `reject()` is invoked on a promise no caller has yet received, producing an unhandled rejection, and `request()` then throws the write error instead so the timeout is never observed.
- Evidence: `const promise = new Promise<T>((resolve, reject) => { const timer = setTimeout(() => { if (this.pending.delete(id)) { ...reject(new AppServerTimeoutError(...)); } }, timeoutMs); ... });` … `await this.writeLine({...}); return promise;`; `rejectAllPending` (line 359) rejects every entry regardless of write state.
- Suggestion: Attach `promise.catch(() => {})` immediately after construction, or register the pending entry and start the timer only after `writeLine` resolves.
- Verification: Test a request that times out while its write is blocked behind backpressure and assert no unhandled rejection and the timeout error is returned.

### 20. [P2][conf:80][error-handling]
#### app-server child `stdin` has no `error` listener, and the spawn `error` listener is attached after an early throw
- File: bridges/codex-bridge/src/app-server/process-supervisor.ts:468
- Symbol: AppServerSupervisor.start
- Description: Nothing subscribes to `stdin` `error` (the client attaches `once("error")` only transiently during backpressure), so an EPIPE on a dead child's stdin is an unhandled `'error'` event under Node semantics, which the rejection guard does not cover. On spawn failure the code throws at `if (!child.pid)` before `child.once("error", ...)` is registered. The ACP bridge guards exactly this (`acp-context.ts` attaches `error` to all three streams). Under Bun the stdin case is currently latent because dead-stdin writes are dropped silently.
- Evidence: `if (!child.pid) { throw new AppServerProcessExitError("app-server failed to spawn", ...); } this.startingChild = child; ... await this.updateOwnedPidFile(...) ... child.once("exit", handleExit); child.once("error", ...)`.
- Suggestion: Register `child.once("error")` and `child.stdin.on("error", () => client.close(...))` immediately after `spawnFn` returns, before the pid check and any `await`.
- Verification: `process-supervisor.test.ts` case with a fake child whose `pid` is undefined and one emitting `stdin` `error` after ready; assert no crash.

### 21. [P2][conf:85][performance]
#### `writeOnce` leaks one `stdin` listener per back-pressure event
- File: bridges/codex-bridge/src/app-server/jsonl-rpc-client.ts:498
- Symbol: JsonlRpcClient.writeOnce
- Description: On `!flushed` it registers `once("drain")` and `once("error")`; whichever fires removes only itself, so the other stays on `child.stdin` for the generation's lifetime. Repeated backpressure (large prompts, image attachments) accumulates listeners without bound and trips `MaxListenersExceededWarning`.
- Evidence: `stdin.once("drain", () => finish(null)); stdin.once("error", (error) => finish(error as Error));` with `off`/`removeListener` declared on `WritableLike` but never used.
- Suggestion: In `finish`, remove the sibling listener via `stdin.off`/`removeListener`.
- Verification: Assert `stdin.listenerCount("error")` returns to baseline after a drained write in `jsonl-rpc-client.test.ts`.

### 22. [P2][conf:80][correctness]
#### ACP `onPermission` has no generation guard; a superseded child's request is parked against the new child
- File: bridges/acp-bridge/src/acp-session.ts:512
- Symbol: attachChild (onPermission); parkPermission (acp-session.ts:613)
- Description: `onUpdate`, `onVendor` and `onClose` all check `state.child !== child`, but `onPermission` does not, and `parkPermission` reads `state.child` rather than the emitting child. A replaced child can emit for up to 3 s after `close()`; its `session/request_permission` is parked and the eventual `respond` (including the cancelled fallback) is written to the new child's stdin with the old child's JSON-RPC id, which can collide with an id the new child issued.
- Evidence: `child.onPermission = (requestId, params) => { ...; parkPermission(state, requestId, params); };` and `export function parkPermission(state, requestId, params) { const child = state.child; ... child.respond(requestId, {...}) }`.
- Suggestion: Early-return (or respond cancelled on the emitting child) when `state.child !== child || sessions.get(state.id) !== state`; pass the emitting child into `parkPermission`.
- Verification: `acp-session.test.ts` case where a superseded child emits a permission request; assert it is answered on that child and nothing is written to the new one.

### 23. [P2][conf:78][observability]
#### Approval answered between generation death and the next restart is recorded as `user-approved` although nothing was sent
- File: bridges/codex-bridge/src/app-server/server-request-router.ts:610
- Symbol: ServerRequestRouter.settleApproval; AppServerSupervisor.respondToServerRequest (process-supervisor.ts:365)
- Description: `abandonGeneration(previous)` only runs from `onGenerationReady`, i.e. after the next child is up. In the window after `handleUnexpectedExit` sets `current = null`, a user click routes to `settleApproval` → `finish` → `respondToServerRequest`, which silently returns. The record is still marked `user-approved`, the counter increments, the card clears, and the transcript says nothing, contrary to the "withdraw the card and say so" rule for dead generations.
- Evidence: `if (!this.current || this.current.id !== generation) return;` (supervisor) and `await this.finish(parked.key, parked.record, approved ? "user-approved" : "user-declined", ...)` (router).
- Suggestion: Call the router's abandon path from `handleUnexpectedExit`, or make `respondToServerRequest` throw so `finish` records `engine-restarted`.
- Verification: `server-request-router.test.ts` case answering an approval after the owning generation died and before the replacement is ready; assert the outcome is `engine-restarted`.

### 24. [P2][conf:78][privacy]
#### Pi and Cursor bridge `route()` return raw unexpected error text in 500 bodies, bypassing the server's guard
- File: bridges/pi-bridge/src/http.ts:154
- Symbol: route (catch-all); same at bridges/cursor-bridge/src/http.ts:125
- Description: `server.ts` deliberately answers `{ error: "Internal bridge error" }` with a comment that unexpected error text "can carry a prompt, a file path or a credential", but `route()` catches everything first and returns `errorText(error)`, so the guard only fires if `json()` itself throws. SDK and filesystem errors routinely embed absolute paths.
- Evidence: `return json(response, 500, { error: errorText(error) });` after the typed error cases in both files.
- Suggestion: For the untyped fallthrough, log a bounded message locally and answer the generic string, matching `server.ts`.
- Verification: HTTP test that a handler throwing `new Error("/Users/x/secret")` yields a body without that text.

### 25. [P2][conf:80][correctness]
#### Cursor prompt dispatch failure leaves the user message in the transcript for a turn that never ran
- File: bridges/cursor-bridge/src/http.ts:698
- Symbol: handlePrompt
- Description: `appendUserMessage` runs before `dispatchPrompt`; when `agent.send` rejects, the catch (lines 726-745) sets `status = "error"` and rolls back usage/journal fields but never removes the appended message or restores `uncheckedTranscriptBytes`. A retry under a new request id appends a duplicate. The Pi bridge handles the same case with `state.messages.splice(messageStart)`.
- Evidence: `const userMessageId = appendUserMessage(state, prompt, images);` then a catch block with no `messages.splice`; compare pi http.ts:942-944.
- Suggestion: Record `state.messages.length` and `uncheckedTranscriptBytes` before the append and restore both in the catch.
- Verification: `http.test.ts` case where `agent.send` rejects; assert the transcript has no user message afterwards.

### 26. [P2][conf:80][maintainability]
#### Claude interaction cleanup iterates live Maps while deleting from them
- File: bridges/claude-bridge/src/services/session-manager-lifecycle.ts:447
- Symbol: cleanupPendingPlanApprovals; cleanupPendingQuestions (line 469)
- Description: Both loops walk `pendingPlanApprovals` / `pendingQuestions` directly and `.delete()` from the collection being iterated, which AGENTS.md ("Iterating a collection you are about to mutate") requires to go through `Array.from`. Safe today only because each iteration deletes exactly the current key and emit subscribers do not mutate these maps.
- Evidence: `for (const [approvalId, approval] of pendingPlanApprovals) { ... pendingPlanApprovals.delete(approvalId); eventEmitter.emit(...) }`.
- Suggestion: `for (const [id, entry] of Array.from(pendingPlanApprovals))` (and likewise for questions).
- Verification: `mise run lint` stays clean; existing lifecycle tests continue to pass.

### 27. [P2][conf:75][correctness]
#### Claude plan-approval `feedback` is unvalidated and unbounded before being spliced into a re-prompt
- File: bridges/claude-bridge/src/routes/session.ts:1200
- Symbol: session.post("/:id/plan-approvals/:approvalId/respond"); canUseTool ExitPlanMode branch (session-manager-prompt.ts:1318-1327)
- Description: `feedback` is cast `as string | undefined` with no type or size check, unlike the sibling question-answer route which applies `questionAnswerBodyLimit` and `isBoundedClaudeQuestionAnswers`. A non-string becomes `[object Object]` in the rejection feedback and an arbitrarily large string is forwarded verbatim into the next user turn.
- Evidence: `const feedback = body.feedback as string | undefined;` → `respondToPlanApproval(approvalId, approved, feedback)` → `` `I've reviewed the plan and I'd like changes: ${response.feedback}` ``.
- Suggestion: Require `typeof feedback === "string"` (400 otherwise), bound it with `AGENT_INTERACTION_LIMITS.maxFreeTextBytes`, and apply a `bodyLimit` like the question route.
- Verification: `routes/session.test.ts` cases for a non-string and an oversized `feedback` asserting 400/413.

### 28. [P2][conf:85][security]
#### Electron main-process SSE client buffers a remote gateway's event stream with no byte bound
- File: apps/desktop/electron/backend-process.ts:346
- Symbol: BackendHttpClient.consumeEvents
- Description: The reader appends every chunk to `pending` and only trims on a `\n\n` delimiter. A remote backend (a separate trust domain from the local one) that streams bytes without a delimiter grows `pending` without limit in the main process, violating invariant 11. A single malformed `data:` line also throws out of the loop, tears the stream down and reconnects every 500 ms, re-emitting the connected event that triggers authoritative refetches.
- Evidence: `pending += value; const messages = pending.split("\n\n"); pending = messages.pop() ?? "";` with no cap; reachable via `ConnectionManager.setScopeRemote` → `startRemoteListener` → `client.listen(...)` (connection-manager.ts:590-598).
- Suggestion: Cap `pending` (e.g. 1 MiB) and abort/reconnect with a logged reason when exceeded; wrap the per-message `JSON.parse` so one bad frame is dropped rather than restarting the stream.
- Verification: `tests/unit/electron/backend-process.test.ts` cases with a delimiter-less multi-MiB stream and with one malformed frame among valid ones.

### 29. [P2][conf:78][security]
#### Renderer windows explicitly disable the Chromium sandbox although their preloads are self-contained bundles
- File: apps/desktop/electron/window.ts:68
- Symbol: createMainWindow (also toolchain-bootstrap-window.ts:114 and :176)
- Description: `webPreferences` sets `sandbox: false`, overriding Electron's default (sandboxed since Electron 20; the repo pins `electron ^42`). The renderer displays untrusted agent/tool/markdown output, so a renderer-engine bug would yield an unsandboxed process. The preloads are bundled with `external: ["electron"]` and only use `contextBridge`/`ipcRenderer`/`process.platform`, all available in sandboxed preloads; browser previews already run with `sandbox: true` (browser-preview-manager.ts:297). No comment explains the exception. Other posture points (will-navigate, setWindowOpenHandler, openExternal scheme checks, IPC sender-frame gating) were verified as correct.
- Evidence: `webPreferences: { preload: ..., contextIsolation: true, nodeIntegration: false, sandbox: false, ... }`.
- Suggestion: Set `sandbox: true` on the three windows (or document the concrete reason it must stay off) and update `tests/unit/electron/window.test.ts:86`, which currently locks the disabled value in.
- Verification: App launches, IPC round-trips work, and `window.test.ts` asserts `sandbox: true`.

### 30. [P2][conf:80][maintainability]
#### AGENTS.md and the rejection-guard header describe backend-exit semantics the supervisor no longer has
- File: apps/desktop/electron/main.ts:463
- Symbol: BackendProcess.start onUnexpectedExit callback (docs: AGENTS.md "Unhandled Rejections Are Fatal"; packages/protocol/src/fatal-rejections.ts:8-10)
- Description: Both documents say the desktop supervisor "answers a backend exit by telling the user the application will close". The supervisor now keeps the app running, marks Local unavailable and shows a dialog asking the user to restart; there is no restart path. The invariant documentation therefore describes a blast radius that no longer exists.
- Evidence: `onUnexpectedExit: (error) => { connectionManager?.markLocalBackendUnavailable(); ... dialog.showErrorBox(..., "Local work is unavailable. Remote windows remain connected; restart the application to recover Local."); }`.
- Suggestion: Update the two doc sentences to describe the current behaviour (Local goes offline for the session, no automatic restart), or implement the restart the docs imply.
- Verification: Docs match `tests/unit/electron/connection-manager.test.ts:174`, which already covers the actual behaviour.

### 31. [P2][conf:76][error-handling]
#### Non-JSON error responses from a remote gateway surface as `SyntaxError` instead of HTTP failures
- File: apps/desktop/electron/backend-process.ts:268
- Symbol: BackendHttpClient.invoke (same pattern in gatewaySettings at :376 and webClientAccess at :396)
- Description: `await response.json()` runs before `response.ok` is checked, so a reverse-proxy 502 HTML page or an auth-wall redirect rejects with "Unexpected token <" rather than "Backend request failed with HTTP 502". `probe` and `ConnectionManager.checkRemote` already handle this correctly.
- Evidence: `const payload = (await response.json()) as { result?: T; error?: string }; if (!response.ok) throw new Error(payload.error ?? ...)`.
- Suggestion: `const payload = await response.json().catch(() => ({}))` before the `ok` check, as in `probe`.
- Verification: `backend-process.test.ts` case with a non-JSON 502 body asserting the HTTP-status message.

### 32. [P2][conf:78][error-handling]
#### Direct (bearer/remote) renderer event stream leaks the old connection and double-connects when a listener throws
- File: apps/web/src/lib/native/web-gateway.ts:367
- Symbol: dispatchMessage; connectFetchEventStream (web-gateway.ts:536-563)
- Description: On the fetch-based stream used whenever `bearerToken || baseUrl`, listener callbacks run synchronously with no try/catch. A throwing listener unwinds `consumeFetchEventStream`; the `finally` schedules a reconnect but never calls `controller.abort()`, so the original body stays open while a second stream opens 2 s later, compounding on every throw, and the remaining callbacks for that frame are skipped (an authoritative event silently dropped, invariant 6). The same-origin `EventSource` path isolates `onmessage` throws.
- Evidence: `for (const callback of callbacks) callback(parsed.payload);` (line 367); `finally { if (streamAbortController === controller) streamAbortController = null; if (!controller.signal.aborted) scheduleReconnect(); }` (lines 559-562) with no abort/cancel. Verified in source.
- Suggestion: Wrap each callback in try/catch (log and continue) and abort the controller in `finally` before scheduling the reconnect; apply the same to the per-terminal fetch fallback at :780-810.
- Verification: `web-gateway.test.ts` case with a throwing listener asserting one live stream after reconnect and sibling listeners still receiving the frame.

### 33. [P2][conf:80][deployment]
#### No CI workflow runs typecheck or the unit test suite on pull requests
- File: .github/workflows/lint.yml:41
- Symbol: "" (workflow)
- Description: `lint.yml` runs only `format:check` and `lint`; `validate-bun-runtime.yml` runs `mise run build:all` and a single standalone backend test, and is path-filtered to backend/bridges/desktop/docker/protocol changes (web-only changes never trigger it); `publish-container.yml` is tag-only. Nothing runs `mise run typecheck` or `mise run test`. The current state of `main` (issues 3 and 4) shows the gate did not hold even where it should have (lint fails on `main` and `lint.yml` runs on every push and PR).
- Evidence: workflow files as listed; `git log` shows #753 merged with the failing typecheck and tests. CI run history could not be inspected (GitHub MCP unavailable).
- Suggestion: Add a workflow (or extend `lint.yml`) that runs `mise run typecheck` and `mise run test` on every pull request, and require it plus lint as branch-protection checks on `main`.
- Verification: A PR reintroducing the BuildLaunchDialog type error is blocked from merging.

## Test Coverage Gaps
- File: apps/backend/src/gateway-handlers.ts — no test that an open SSE stream is closed (or kept) after `setToken`; only the WebSocket path is tested (issue 5).
- File: apps/backend/src/gateway-support-extra.ts — no tests for malformed/`null`/oversized JSON login bodies or malformed percent-encoded cookies (issues 13, 14).
- File: apps/backend/src/gateway-auth.ts — no test that an agent-test session credential is denied or redacted on `/gateway-settings` (issue 15).
- File: apps/backend/src/gateway-proxy.ts — `serveStatic` with a percent-malformed or `%00` path is untested.
- File: apps/backend/src/core/storage-base.ts — zero-length store recovery, write durability, and two concurrent stale-lock reclaimers are untested (issues 8, 16).
- File: apps/backend/src/core/commands-environment.ts — `removeLocalWorktree` when the directory is missing or `git worktree remove` fails is untested (issue 17).
- File: apps/backend/src/core/pty.ts — exit-listener error isolation and terminal close on the error path are untested (issue 18).
- File: apps/web/src/lib/build-launch-options.ts — the `verify` fallback to `fixReviewIssues` has contradictory expectations between the root `CreateEnvironmentDialog` tests and the implementation; the intended default is not pinned anywhere (issue 4).
- File: bridges/cursor-bridge/src/http.ts — `GET /session/:id/usage` has no HTTP-level test; unknown sub-path aliasing (including `DELETE`) is untested (issue 6).
- File: bridges/pi-bridge/src/http.ts — `/attach` and idempotent `/session/create` with a rotated `agentMcp` during a running turn are untested (issue 7).
- File: bridges/codex-bridge/src/app-server/jsonl-rpc-client.ts — timeout/close during a queued write and listener cleanup after drain are untested (issues 19, 21).
- File: bridges/codex-bridge/src/app-server/process-supervisor.ts — spawn with `pid: undefined` and `stdin` `error` after ready are untested (issue 20).
- File: bridges/codex-bridge/src/app-server/server-request-router.ts — an answer landing between generation death and restart is untested (issue 23).
- File: bridges/acp-bridge/src/acp-session.ts — permission requests from a superseded child, and client-signal abort during `session/load` (which SIGTERMs the child every joined caller is waiting on), are untested (issue 22).
- File: bridges/cursor-bridge/src/agent-session.ts — `resumeSession` is not deduplicated by `agentId` and `recoverActiveRun` has no time bound; neither is tested.
- File: apps/desktop/electron/backend-process.ts — `BackendProcess.launch` failure paths (readiness timeout, exit before ready, `stop()` racing startup) and oversized/malformed event streams are untested (issue 28).
- File: apps/desktop/electron/main.ts — window/connection bookkeeping (`windowContexts`, `useConnection` swapping preview managers, `forgetConnection`) has no direct tests.
- File: apps/web/src/lib/native/web-gateway.ts — listener exceptions during dispatch and cleanup of the previous fetch stream on error are untested (issue 32).
- File: apps/web/src/hooks/useUnreadEnvironmentSync.ts and hooks/useEnvironmentDiffStats.ts — no test files exist for the optimistic-clear reconciliation or the buffered-reconnect loop.
- File: apps/web/src/lib/claude-client.ts, lib/codex-client.ts — `subscribeToEvents` has no non-test callers; its tests cover dead renderer code.
- File: docker/init-firewall.sh — no test exercises policy ordering, fail-open, or the port-22/53 exceptions; `version-drift.test.ts` only string-matches the domain array (issues 2, 9).

## Test Results
- `mise run format:check` — FAIL (exit 1). 19 files unformatted: `apps/backend/src/core/build-pipeline-review-fanout.test.ts`, `apps/backend/src/core/feature-build.test.ts`, `apps/backend/src/core/feature-build.ts`, `apps/backend/src/core/plan-usage.ts`, `apps/web/src/components/build/BuildLaunchDialog.test.tsx`, `apps/web/src/components/build/BuildLaunchDialog.tsx`, `apps/web/src/components/linear/LinearTicketsView.test.tsx`, `apps/web/src/components/settings/agent/AgentDefaultsPane.tsx`, `apps/web/src/components/settings/agent/MultiReviewDefaultsEditor.test.tsx`, `apps/web/src/components/settings/agent/MultiReviewDefaultsEditor.tsx`, `apps/web/src/hooks/useBuildLaunchOptions.test.tsx`, `apps/web/src/hooks/useBuildLaunchOptions.ts`, `apps/web/src/hooks/useBuildPipeline.test.tsx`, `apps/web/src/hooks/useBuildPipeline.ts`, `apps/web/src/lib/build-launch-options.test.ts`, `apps/web/src/lib/build-launch-options.ts`, `bridges/cursor-bridge/src/run-diagnostics.test.ts`, `packages/protocol/src/agent-settings.ts`, `tests/unit/components/KanbanTaskDialog.test.tsx`.
- `mise run lint` — FAIL. 1 error: `apps/web/src/components/build/BuildLaunchDialog.tsx:788:7 react-hooks(exhaustive-deps): React Hook useEffect has a missing dependency: 'resetLaunchState'`. Warnings (all `no-unused-vars`, pre-existing backlog) were not counted.
- `mise run typecheck` — FAIL (exit 2). `@orkestrator/backend#typecheck`: `apps/backend/src/core/native-agent-display-tails.test.ts(140,61) TS2345` and `(142,17) TS2339`. `@orkestrator/web#typecheck` did not complete (turbo aborted); the web `tsc` errors surfaced via the build step below. Seven other packages passed (cache hits).
- `mise run test` — FAIL (exit 2, 115 s, no infrastructure errors, no watchdog):
  - Workspace group — FAIL at `@orkestrator/web#build` (`bunx tsc`): `BuildLaunchDialog.test.tsx` (370,19), (384,19), (385,19), (386,19), (459,24) TS2345 reviewer titles not assignable to the step-key union; `BuildLaunchDialog.tsx` (1170,33), (1172,37), (1176,41), (1177,47), (1187,59) TS2339 `key` missing on the `reviewPreparation` member; (1176,30), (1177,33) TS7053. Consequently `@orkestrator/backend`, `@orkestrator/web`, `@orkestrator/desktop`, `@orkestrator/web-public` test tasks did not run. `@orkestrator/protocol`: 865 pass / 0 fail (48 files). `orkestrator` CLI: 8 pass / 0 fail.
  - Root and agent-support group — FAIL: 4247 pass, 2 skip, 3 fail, 19638 expect() calls, 4252 tests across 201 files.
    - `CreateEnvironmentDialog feature builds > submits the configured panel defaults without opening customization` — `tests/unit/components/CreateEnvironmentDialog.test.tsx:4270` — `expect(received).toEqual(expected)` on `request.steps`; diff `"model": "sonnet", + "reasoningEffort": "medium"`.
    - `CreateEnvironmentDialog feature builds > turning customization off discards reviewer edits and uses configured defaults` — `tests/unit/components/CreateEnvironmentDialog.test.tsx:4583` — same diff.
    - `bounded test diagnostics > never passes a DOM-producing query result directly to toBeNull` — `tests/unit/test-diagnostic-bounds.test.ts:64` — offenders: `tests/unit/components/FilesPanel.test.tsx`, `apps/web/src/components/native-agent/AgentNativeTab.test.tsx`, `apps/web/src/components/files-panel/FilesPanelViews.test.tsx`, `apps/web/src/components/chat/AgentModelPicker.test.tsx`.
  - Bridges group — PASS: codex-bridge 1767 pass / 17 skip; pi-bridge 295 pass; cursor-bridge 404 pass; acp-bridge 361 pass; claude-bridge 883 pass / 1 skip.
  - Codex protocol lockfile — PASS ("Committed artifacts match the pinned binary", codex 0.153.4).
- Supplementary package runs (because the aggregate skipped them):
  - `apps/web` (`bun test src --parallel=4 --only-failures`) — PASS, 39.3 s; per-test counts not printed by the logged wrapper on success. Note this passes because Bun does not typecheck; the same tree fails `tsc`.
  - `apps/backend` (`bun test --preload ../../tests/setup-node.ts src tests --parallel=4`) — FAIL: 3238 pass, 1 skip, 1 fail, 12108 expect() calls, 142 files, 38.7 s. Failure: `agent provider module boundaries > keeps every provider implementation module within 1,500 lines` — `apps/backend/src/core/agent-provider-boundaries.test.ts` — `opencode-provider.ts exceeds the provider module line limit; Expected: <= 1500, Received: 1551`.
  - `apps/desktop` — PASS, 0.5 s. `apps/web-public` — PASS, 0.6 s.
- Skipped/todo: root group 2 skip; codex-bridge 17 skip; claude-bridge 1 skip; backend 1 skip. No todo counts were printed. Skip names are suppressed by `--only-failures`.
- No failing test was rerun in isolation and no flake classification was attempted.

## Verdict
- Ready: no
- Reasoning: `main` is red on every gate (format, lint, typecheck, web build, five tests), and the container isolation model has two P1 defects (agent-side firewall bypass via sudo/NET_ADMIN and a fail-open firewall script) plus a P1 credential-rotation gap on the gateway. Tests that did run pass broadly, but coverage of the specific failure paths above is absent, so this snapshot should not be treated as verified.
