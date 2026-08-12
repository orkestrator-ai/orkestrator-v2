# Codebase Improvement Suggestions

Collected during an investigation on 2026-08-04. Grouped by area; roughly ordered
by impact within each section. This is a living document — items are appended as
they are found.

## Top priorities (if you only do ten things)

1. Add CI (item 1) and a linter (item 2) — almost every category below has a
   class of bug that tooling would have caught.
2. Fix the environment-delete memory leaks in the renderer (item 60) — three
   stores' `clearEnvironment` and `paneLayoutStore.reset` have zero callers.
3. Remove `CODEX_BRIDGE_TOKEN` from `process.env` before spawning children in
   codex-bridge (item 49) — the agent currently inherits the bridge credential.
4. Close the IPv6 and DNS holes in the container firewall (items 28–29) — the
   sandbox's entire purpose is egress containment.
5. Add checksums to the piped-installer Dockerfile steps and toolchain download
   scripts (items 31–32) — these binaries ship inside the app.
6. Fix the `docker logs -f` child-process leak and the hang-forever
   `write_container_file` path (items 12–13).
7. Add a generation component to codex-bridge SSE cursors (item 51) — silent
   event loss after bridge restart violates AGENTS.md invariant 4.
8. Move the prompt-queue drain out of mounted-component state (items 64–65) —
   background environments currently stop draining.
9. Stop piping bridge child stdout/stderr verbatim to the console (item 20) and
   route frontend `console.*` through `debug-log.ts` (item 68) — both leak
   prompt content against invariant 12.
10. Begin the structural splits (`commands.ts`, `storage.ts`,
    `session-manager.ts`, the shared SSE stack — items 9–10, 46–48); everything
    else gets easier afterwards.

## Repo-wide / tooling

1. **No CI configuration in the repository.** There is no `.github/workflows`
   directory (nor any other CI config), so typechecking, tests, and protocol
   drift checks (`codex:protocol:check`) only run when a developer remembers to.
   Suggestion: add a GitHub Actions workflow that runs `bun install --frozen-lockfile`,
   per-workspace `typecheck`, `bun scripts/test-all.ts`, and `codex:protocol:check`
   on every PR.

2. **No linter or formatter anywhere in the repo.** There is no ESLint, Biome,
   Prettier, or `.editorconfig` config in any workspace, so style and common
   bug-class enforcement (unused vars, floating promises, exhaustive deps) relies
   entirely on review. Suggestion: adopt Biome (fast, Bun-friendly, one config
   for lint + format) at the root, with `oxlint`/`eslint` as an alternative;
   wire it into the CI job above.

3. **Two lockfiles are committed: `bun.lock` (text) and `bun.lockb` (binary).**
   `bun.lockb` is stale (last touched 2026-07-14 vs 2026-08-03 for `bun.lock`),
   and there is also a nested `bridges/claude-bridge/bun.lock` committed inside
   the workspace, which should not exist. Suggestion: delete `bun.lockb` and
   the nested lockfile, keep the text `bun.lock`, and add `bun.lockb` to
   `.gitignore`.

4. **No root `typecheck` script despite a `typecheck` task existing in
   `turbo.json`.** Developers must know to run `bun run --cwd apps/web typecheck`
   etc. per workspace. Suggestion: add `"typecheck": "turbo run typecheck"` to the
   root `package.json` and reference it in AGENTS.md/CI.

5. **All runtime dependencies live in the root `devDependencies`**
   (`package.json` — react, xterm, dnd-kit, react-virtuoso are devDeps of the
   root instead of deps of `apps/web`). This hides which workspace actually uses
   what and makes version bumps riskier. Suggestion: move each dependency into
   the workspace that imports it and keep the root for tooling only
   (turbo, typescript, electron-builder).

6. **TypeScript strictness is uneven across workspaces.** `apps/web`,
   `apps/backend`, and `apps/desktop` enable `noUncheckedIndexedAccess` and
   `noUnusedLocals`, but both bridges and `packages/protocol` only have bare
   `strict` — precisely the packages whose invariants (bounded buffers, cursor
   math, indexed ring access) benefit most from checked index access.
   Suggestion: create a shared `tsconfig.base.json` with the strict flag set and
   extend it everywhere, fixing fallout incrementally.

7. **Shared dependency versions drift across workspaces.** `typescript` is
   `~5.8.3` in some packages and `^5.7.0` in others; `@types/node` is `^25.9.3`
   in some and `^22.0.0` in others. Suggestion: align versions (Bun supports
   `overrides`/catalog-style pinning) so typechecking behaves identically in
   every workspace.

8. **Near-duplicate build scripts in root `package.json`.** `build`,
   `build:desktop`, and `build:electron` are identical commands; `dev` variants
   repeat the same turbo incantation with different filters. Suggestion: prune
   aliases to one canonical name each, or generate them from a small script, so
   the script list stays scannable.

## Code organization (oversized modules)

The largest non-generated source files concentrate a lot of the system's risk:

| File | Lines |
| ---- | ----: |
| `apps/backend/src/core/commands.ts` | ~10,500 |
| `bridges/claude-bridge/src/services/session-manager.ts` | ~6,500 |
| `apps/backend/src/core/storage.ts` | ~6,300 |
| `tests/unit/electron/commands.test.ts` | ~16,700 |
| `apps/web/src/components/codex/CodexChatTab.test.tsx` | ~10,200 |

9. **`apps/backend/src/core/commands.ts` (~10.5k lines) is the whole backend in
   one file.** `createCommandRegistry` alone spans lines ~7451–10427 and makes
   **272 `register(...)` calls** covering Docker, git/worktree, PR/GitHub/Linear,
   terminals, review packages, models, extensions, and file I/O in one closure.
   Suggestion: split into per-domain command modules (`commands/docker.ts`,
   `commands/git.ts`, `commands/terminals.ts`, `commands/integrations.ts`, …)
   that each export a `registerX(register, shared)` function, moving the ~5k
   lines of helpers above the registry into the matching modules and keeping
   `createCommandRegistry()` as a thin composition root.

10. **`apps/backend/src/core/storage.ts` (~6.3k lines) is one `StorageService`
    class with ~145 methods** covering environments, config, prompt queues,
    drafts, kanban, build pipelines, native agent sessions, looped review, pane
    layouts, and journals — each with its own `enqueue*Mutation` serializer
    (lines ~1793–1929). Suggestion: keep the atomic-write/lock primitives as a
    `JsonStore` base and extract per-domain repositories (`EnvironmentStore`,
    `PipelineStore`, …); the tests are already split along those seams
    (`storage-drafts.test.ts`, `storage-build-pipelines.test.ts`, …).

10a. **`apps/backend/src/gateway.ts` (~4.6k lines) mixes five concerns** —
    metrics (`GatewayMetricsStore`, line ~719), compression negotiation, HTTP
    proxying, SSE event replay, and the server lifecycle class (line ~2527).
    Suggestion: extract `gateway-metrics.ts` and `gateway-compression.ts` (both
    already have pure exported functions), leaving `gateway.ts` as routing +
    lifecycle.

11. **Monolithic test files mirror the monolithic sources** (a 16.7k-line
    `commands.test.ts`, four chat-tab test files of 7–10k lines each). Beyond
    editor pain, one flaky case forces rerunning a huge file, and `--parallel`
    can't spread a single file across workers. Suggestion: split test files
    along the same domain seams as the source split, which also improves suite
    wall-clock under Bun's per-file parallelism.

## Backend correctness & resource management

12. **`stream_container_logs` leaks a child process on every call**
    (`apps/backend/src/core/commands.ts:8409–8414`). The
    `spawnCommand("docker", ["logs", "-f", id])` child is never stored or
    killed, has no `error`/`exit` listener, and there is no "stop streaming"
    command — repeated calls accumulate `docker logs -f` processes for the
    backend's lifetime, and an `error` event on the child crashes the process
    as an unhandled emitter error. Suggestion: track children in a
    `Map<containerId, ChildProcess>`, add handlers, register a
    `stop_container_logs` command, and kill them all in `shutdown()`.

13. **`write_container_file` can hang forever**
    (`commands.ts:10009–10016`). The `docker exec -i … base64 -d` child is
    awaited on `exit` with no timeout and no `error` handler on `child.stdin`,
    so a stalled daemon or EPIPE leaves the promise pending with the child
    alive. Suggestion: race exit against a timeout that kills the child, and
    attach a `stdin.on("error")` handler.

14. **The Linear API call has no abort signal**
    (`apps/backend/src/core/linear.ts:140`) while `github.ts:305` correctly
    uses `AbortSignal.timeout(...)`. Suggestion: add the same timeout constant
    pattern.

15. **No `unhandledRejection`/`uncaughtException` handlers in either
    entrypoint** (`apps/backend/src/main.ts`, `apps/desktop/electron/main.ts`)
    despite ~58 `void promise` sites — one missed `.catch` silently kills the
    backend. Suggestion: install process-level handlers that log with context
    and drain via the existing `createBackendShutdownHandler`.

16. **`storage.ts` `writeAtomic` never fsyncs** (lines ~1735–1789). Temp file +
    rename without `fsync` of the file or parent directory means power loss can
    still truncate `environments.json`. Suggestion: `await handle.sync()`
    before close and fsync the parent directory after rename (non-Windows).

17. **A single global write queue serializes every storage file write**
    (`storage.ts:1793–1797`), and backup rotation rewrites all 5 backups per
    environment mutation, so hot paths do ~6 whole-file rewrites while blocking
    unrelated writes. Suggestion: key the queue per file path and skip backup
    rotation for high-frequency volatile-field updates (activity timestamps).

18. **`invoke` has no timeout or error normalization**
    (`apps/backend/src/core/index.ts:246–251`): a hung handler pins the caller
    forever, and raw `Error` messages (possibly embedding paths/command output)
    cross to the renderer unshaped. Suggestion: per-command wall-clock timeout
    plus a `{ code, message }` error envelope.

19. **`docker_system_prune` and `get_docker_system_stats` return fabricated
    zeros** (`commands.ts:8419+`): `containersDeleted: 0`, `memoryUsed: 0`,
    etc. are hardcoded while only some fields are parsed, so the UI shows false
    data. Suggestion: parse `docker system prune` / `docker system df` output
    properly, or drop the fields from the contract.

## Secrets & logging (AGENTS.md invariant 12)

20. **Bridge/OpenCode child stdout+stderr are piped verbatim to the console**
    (`commands.ts:5499–5500`), and the Electron supervisor re-emits backend
    stderr unfiltered (`apps/desktop/electron/backend-process.ts:257`). This
    can leak prompts, transcript fragments, and auth material — exactly what
    AGENTS.md invariant 12 forbids. Suggestion: route through a redacting,
    length-capped log helper (reuse `redactCommandValues` from `shell.ts:63`)
    and gate raw stdout behind a debug flag.

21. **Bridge auth tokens are passed through `docker exec` argv**
    (`commands.ts:7066`, `7133`, `7142`, `8703`, `8714`): the token is visible
    in the container's process table for the command's lifetime. Suggestion:
    pipe the token via stdin (the `write_container_file` pattern) or an env var
    on the `docker exec` invocation.

22. **~90 ad-hoc `console.*` calls with inconsistent prefixes**
    (`[ElectronBackend]`, `[backend]`, `[tmux]`, `[pr-monitor]`, …) and no
    structured logging. Suggestion: add a small shared logger
    (`core/log.ts` or `packages/protocol`) with
    `{ level, component, event, fields }` plus a redaction allowlist — this
    also gives item 20 a single choke point.

## Electron security

23. **`sandbox: false` on the main window**
    (`apps/desktop/electron/window.ts:62`). `contextIsolation` and
    `nodeIntegration` are set correctly, but disabling the sandbox removes the
    OS-level defense-in-depth behind any renderer XSS. The 12-line preload only
    uses `contextBridge` + `ipcRenderer`, which are sandbox-safe — try flipping
    to `sandbox: true`.

24. **`orkestrator:invoke` is an unbounded IPC pass-through**
    (`apps/desktop/electron/ipc.ts:156–163`): any command string plus any
    object reaches the entire 272-command backend registry with no allowlist,
    schema validation, or timeout. Suggestion: once commands carry declared
    schemas (see item 26), validate at this boundary and add a timeout.

25. **`browserPreviewUrl` accepts any scheme at the IPC edge**
    (`ipc.ts:97–102`) — only "non-empty string" is checked there; `file:` /
    `javascript:` filtering happens downstream in
    `browser-preview-manager.ts`. Suggestion: parse with `new URL()` and reject
    non-`http(s)` at the boundary so it is self-contained.

## Backend consistency / duplication

26. **Command argument validation is hand-rolled 272 times**
    (`commands.ts:928–1341` defines `asString`/`asRecord`/… and every handler
    re-derives its contract inline; `tmux.ts:158–183` duplicates the same
    helpers with different error text). Suggestion: declare each command's arg
    shape once (zod is already a dependency; `packages/protocol` already hosts
    shared contracts) and have `register` accept a validator so handlers
    receive typed args — this also unlocks IPC-boundary validation (item 24).

27. **Two divergent shell-quoting layers.** `dockerExec`
    (`commands.ts:4757–4765`) always routes through `bash -lc <string>` with
    ~40 call sites hand-building shell text via `quoteShell`, while `tmux.ts`
    maintains separate `shellArg`/`shellDq` helpers. Suggestion: consolidate on
    one quoting module and add a `dockerExecArgv(containerId, argv[])` variant
    for the many call sites that need no shell at all (`mkdir -p`, `cat`, …).

## Docker sandbox & supply-chain security

28. **The container firewall never touches `ip6tables`**
    (`docker/init-firewall.sh` — `iptables -P OUTPUT DROP` at ~:177 and
    A-record-only resolution at ~:146 are IPv4-only). On any IPv6-enabled
    Docker network an agent has completely unfiltered egress. Suggestion: add
    `ip6tables -P OUTPUT DROP` with an equivalent AAAA allowlist, or explicitly
    disable IPv6 in the container.

29. **Outbound UDP/53 is allowed to any resolver**
    (`init-firewall.sh:38`), leaving an open DNS-tunnel exfiltration channel
    out of a sandbox whose purpose is containment. Suggestion: restrict DNS to
    Docker's embedded resolver (127.0.0.11) / configured nameservers only.

30. **The firewall allowlist is a one-shot DNS snapshot at boot**
    (`init-firewall.sh:193–206`). IPs for `api.anthropic.com`,
    `registry.npmjs.org`, etc. rotate, so long-lived containers silently lose
    access (or an allowlisted IP gets reassigned to a third party).
    Suggestion: periodically re-resolve via the existing
    `update-firewall.sh --refresh`.

31. **The Dockerfile pipes remote installers straight into a shell**
    (`docker/Dockerfile:136` `curl … opencode.ai/install | bash`, `:114`
    `wget -O- … zsh-in-docker.sh | sh`) with no checksum — in contrast to the
    Node install at `:63–67`, which correctly verifies SHASUMS256. Suggestion:
    pin these to release artifacts plus `sha256sum -c`, matching the Node
    pattern.

32. **Toolchain download scripts have zero integrity verification**
    (`scripts/download-bun.sh`, `download-claude.sh`, `download-codex.sh`,
    `download-opencode.sh` all `curl | tar` and `chmod +x` binaries that get
    bundled into the shipped Electron app). Suggestion: record expected SHA-256
    per version/arch in `config/` and verify before extraction — the runtime
    `toolchain-manager.ts` already does this for user-installed toolchains, so
    the pattern exists in-repo.

## Test suite health

33. **Two parallel, divergent test trees cover the same modules.** 99 of 142
    files under `tests/unit/` reach into `apps/web/src` via relative paths, and
    7 basenames exist in *both* trees with different content (e.g.
    `tests/unit/lib/utils.test.ts` vs `apps/web/src/lib/utils.test.ts`,
    `NativeMessage.test.tsx` 2980 vs 3591 lines, `kanbanStore.test.ts`,
    `configStore.test.ts`, `github.test.ts`). Suggestion: pick one convention
    (co-located) and migrate, reserving `tests/` for genuinely cross-workspace
    contract tests.

34. **`tests/setup.ts:41` imports `../apps/web/node_modules/sonner`** — a
    hardcoded path into a nested `node_modules` that only exists under a
    particular Bun hoisting outcome; any hoist change breaks the preload for
    all 142 root test files. Suggestion: import `"sonner"` normally and add it
    to root devDependencies (or use `import.meta.resolve`).

35. **~9 tests rely on multi-second real-time sleeps** (e.g.
    `TerminalContainer.test.tsx:4560` sleeps 3500 ms,
    `native-agent-service.test.ts:1782` 2100 ms,
    `backend-process.test.ts:41` 2000 ms) and ~60 more sub-100 ms sleeps are
    used as synchronization, concentrated in
    `bridges/codex-bridge/src/app-server-runtime.test.ts` (25+ occurrences).
    These are timing races that will flake on loaded CI runners. Suggestion:
    inject a fake clock / `setSystemTime`, or share an
    `await until(() => predicate)` polling helper (the pattern already used at
    `looped-review-service.test.ts:1142`).

36. **Six test files call `mock.module(...)` with no restore**, against the
    explicit rule in AGENTS.md (`tests/unit/components/CommentText.test.tsx`,
    `StatusIndicator.test.tsx`, `tests/unit/hooks/usePullRequest.test.ts`,
    `useEnvironments.test.ts`, `tests/unit/lib/terminal-paste.test.ts`).
    Suggestion: apply the snapshot-and-restore pattern from AGENTS.md or
    promote the mock to `tests/setup.ts`.

37. **`tests/setup.ts` globally mocks `@/lib/native/backend` and
    `@/lib/native/events` for every root test**, so no root test can exercise
    the real invoke/listen path, with a hand-maintained comment as the only
    carve-out mechanism. Suggestion: export an opt-in `installNativeMocks()`
    instead of a blanket preload.

38. **Coverage is never measured or gated** — no `--coverage` anywhere in
    `scripts/test-all.ts` or `bunfig.toml`, though `.gitignore` lists
    `coverage/`. Suggestion: run `bun test --coverage` in CI with a ratchet
    threshold in `bunfig.toml`.

39. **`scripts/test-all.ts` never runs typecheck**, so `bun run test` passes
    with type errors present. Suggestion: add a `turbo run typecheck` group to
    `buildConcurrentGroups`.

## E2E coverage

40. **There is no real Electron e2e.** `e2e/playwright.config.ts` boots a
    2-file Vite browser fixture, so all 8 specs are component/CSS-level tests;
    the Electron main process, preload IPC, backend supervisor, and packaging
    path have zero end-to-end coverage. Suggestion: add a Playwright
    `_electron.launch()` project against the built app covering at least
    launch → create environment → send a prompt → see a response.

41. **The e2e suite is mostly CSS assertions** (`GlobalStyles.spec.ts`,
    `PathTruncation.spec.ts` are the bulk) and uses 20 runtime
    `test.skip(project.name !== …)` calls, so each spec runs twice and mostly
    no-ops. Suggestion: rebalance toward user journeys and use per-project
    `testMatch`/grep instead of runtime skips; add
    `retries: process.env.CI ? 2 : 0` and an HTML/blob reporter to the config.

## Scripts & version management

42. **Four ~90%-identical toolchain download scripts**
    (`scripts/download-{claude,codex,opencode,bun}.sh` each repeat the arch
    switch, mktemp+trap, extract, codesign dance, and smoke check).
    Suggestion: collapse into one manifest-driven `scripts/download-toolchain.ts`
    (Bun), which also gives item 32's checksums a single home.

43. **Toolchain version pins are duplicated in 4+ places with only partial
    drift protection.** `CLAUDE_VERSION=2.1.228` appears in
    `download-claude.sh` and `docker/Dockerfile:126`; Codex `0.147.0` in three
    places; OpenCode `1.18.16` in four — and `version-drift.test.ts` only
    guards Codex/OpenCode, not Claude. Suggestion: single-source in
    `config/toolchain-versions.json` and extend the drift test.

44. **Inconsistent shell strictness across scripts.** `docker/entrypoint.sh`
    (24 KB) and `workspace-setup.sh` (27 KB) use bare `set -e` (no
    `-u`/`-o pipefail`); some helpers use no flags at all, while
    `init-firewall.sh` correctly uses `set -euo pipefail`. Suggestion:
    standardize on `set -euo pipefail`.

45. **`packages/protocol` has a dead alias export and a broken turbo cache
    contract.** It exports both `./review-instruction` and `./review-prompt`
    pointing at the same file, and its `build` script is `tsc --noEmit` while
    `turbo.json` declares `outputs: ["dist/**"]` — a cache entry that can never
    produce its declared output. Suggestion: drop the alias and either give
    protocol a real build or reclassify it as `typecheck` only. (Otherwise the
    package is healthy: import census shows it genuinely shared — web 98,
    backend 96, desktop 15, claude-bridge 13, codex-bridge 7.)

## Bridges — structure & duplication

46. **`bridges/claude-bridge/src/services/session-manager.ts` contains a
    ~1,940-line function**: `sendPrompt` spans lines ~4265–6204 inside the
    6,484-line module, which also owns session CRUD, persistence, transcript
    eviction, title generation, approvals, model catalog, and rewind/fork.
    Suggestion: extract the SDK stream consumer (~4980–5400) into a
    `stream-reducer.ts` mirroring codex's `app-server/event-reducer.ts`, and
    the `canUseTool` question/plan handlers into an `approvals.ts` mirroring
    codex's `server-request-router.ts`. The 12
    `eslint-disable @typescript-eslint/no-explicit-any` suppressions in the
    repo are all clustered in this same reducer — typing the SDK message
    variants during the extraction removes them.

47. **`bridges/codex-bridge/src/index.ts` (1,743 lines) is a composition root
    that also contains auth middleware, the SSE ring/retention/writer, the
    fallback model catalog, and persisted-cache IO.** The tell is the
    `__testing` export of ~70 internals plus orphan test files
    (`fallback-models.test.ts`, `sse-replay.test.ts`, …) that have no source
    module of their own. Suggestion: extract `sse/`, `auth.ts`, and
    `fallback-models.ts` as real modules; `__testing` should shrink to the
    composition root only. Similarly, `app-server-runtime.ts` (4,271 lines)
    could peel off approvals/interactions (~609–866) and the ordered-event
    drain (~2102–2246), which already have clean interfaces.

48. **The entire SSE/replay stack is implemented twice with no shared code** —
    replay buffer (`claude-bridge/src/routes/events.ts:87` vs
    `codex-bridge/src/event-ring.ts:62`), bounded SSE writer, replay
    retention, and cursor parsing all exist in both bridges with divergent
    behavior. Suggestion: move the ring, retention gate, bounded writer, and
    cursor codec into `@orkestrator/protocol` so the invariants have one test
    suite instead of two divergent ones. Likewise the **auth middleware is a
    near-verbatim copy** (differing only in env-var/header names) and the
    **SSE event vocabularies disagree on the same concepts**
    (`session.reconcile-required` + `bridge.cursor` vs `replay.required`) —
    both belong in the shared package.

## Bridges — invariant violations & fragility

49. **codex-bridge never removes the bridge token from `process.env`**
    (`codex-bridge/src/index.ts:141–142`). claude-bridge explicitly deletes it
    so no subprocess can inherit the credential, but codex spawns
    `codex app-server` (and title generation) with `env: { ...process.env }`,
    so `CODEX_BRIDGE_TOKEN` reaches the agent and every shell command it runs.
    Suggestion: capture-and-delete exactly as claude-bridge does.

50. **The codex handshake replay buffer is bounded by count only**
    (`MAX_BUFFERED_REPLAY_EVENTS = 10_000`, `index.ts:983`), not bytes — each
    entry holds a full serialized message, violating AGENTS.md invariant 11;
    claude's equivalent bounds both. Relatedly, codex's writer counts backlog
    in UTF-16 code units (`event.data?.length`, `index.ts:1014`) instead of
    `Buffer.byteLength`, under-counting non-ASCII transcripts up to 3× against
    the 16MB cap. Suggestion: track bytes properly on both bounds.

51. **codex-bridge SSE cursors have no generation component**
    (`event-ring.ts:176–213`): after a bridge restart the revision sequence
    restarts at 1, so a client reconnecting with an old cursor silently
    receives revisions from a *different* sequence and reports complete —
    silent event loss, violating invariant 4. claude-bridge already solved
    this with a `generation:revision` cursor. Suggestion: adopt that format
    (trivial once the stack is shared per item 48).

52. **codex SSE writes are not raced against the request signal**
    (`index.ts:1529–1534`): a vanished client pins up to 16MB of backlog and
    keeps its subscription alive until overflow, where claude's writer
    explicitly races writes against abort/close. Also the SSE handshake is
    `try/finally` with no `catch` (a rejected write propagates out of the
    `streamSSE` callback), and the abort listener is registered only *after*
    replay completes, so aborts during replay are noticed only via write
    failure. Suggestion: mirror claude-bridge's writer (`routes/events.ts:337–365, 492–499`).

53. **Invariant 9 ("stdout loop never awaits consumers") is enforced only by
    convention**: `jsonl-rpc-client.ts:80` types `onNotification` as
    returning `void`, which accepts an `async` handler whose rejection becomes
    silently unhandled. Suggestion: lint with
    `@typescript-eslint/no-misused-promises` (ties into repo-wide item 2) or
    assert the handler's return value is `undefined` in dev.

54. **`POST /session/:id/prompt` has no request body limit on either bridge**,
    and codex accepts an unbounded base64 `attachments` array — the only
    `bodyLimit` in either bridge is on one claude question-answer route.
    Suggestion: apply `hono/body-limit` to every mutating route and cap
    attachment count/size (invariant 11 covers "every decoded request").

55. **Production SSE hot path consults mutable test hooks**
    (`sseRouteTestHooks` at `codex-bridge/src/index.ts:147–155`, including one
    that overrides a memory bound). Suggestion: pass these as route options at
    construction once the route becomes a module.

## Bridges — memory & error handling

56. **An attached codex thread's `ThreadContext.messages` is unbounded**
    (`sessions/thread-registry.ts:122`): reclamation only happens on idle
    detach, so a continuously-active multi-hour session retains every rendered
    message. claude-bridge has `evictIdleHydratedTranscripts`; codex has no
    equivalent. Suggestion: add a byte-budgeted head-trim with rollout
    rehydration (the rollout is already authoritative).

57. **codex `emit` serializes the full payload whenever any subscriber exists,
    even if all are session-filtered away** (`index.ts:638–676` + filter at
    1545–1551): N tabs on other sessions pay a multi-MB `JSON.stringify` per
    frame for nothing. Suggestion: decide serialization eagerness from whether
    any subscriber's filter matches.

58. **Aggregated silent catches in the PID-file quarantine/restore dance**
    (`process-supervisor.ts:1195–1290` has 11 bare `catch { return false }`),
    making a partially-failed ownership handoff indistinguishable from a clean
    one. Suggestion: return a discriminated `"ok" | "lost" | "io-error"`
    result so callers can log the difference. Similarly, a persistently
    failing notification recorder logs once per inbound message with no rate
    limit (`jsonl-rpc-client.ts:296–303`) — latch it off after N consecutive
    failures.

## Bridges — test coverage

59. **No test asserts the AGENTS.md invariants themselves.** Nothing fails if
    the replay buffer loses its byte bound, if the `connected` frame stops
    echoing the client's cursor, or if a stdout handler becomes async.
    Suggestion: add an `invariants.test.ts` per bridge so the doc and code
    cannot drift. Also: `claude-bridge/src/services/claude-home.ts` (which
    every persistence path depends on) has no test at all, and
    `session-manager.test.ts` at 10,329 lines should split along the seams of
    item 46.

## Frontend — memory leaks in the environment-delete path

60. **Deleting an environment leaks most of its renderer state.**
    `useEnvironments.ts:763–803` cleans only 4 of ~10 per-environment stores:
    - `clearEnvironment()` in `claudeStore.ts:587`, `codexStore.ts:608`, and
      `openCodeStore.ts:338` has **zero production callers**, so transcripts,
      clients, drafts, queues, and subscriptions for deleted environments live
      forever.
    - `paneLayoutStore.ts:554` `reset()` is likewise never called — it is the
      only path that disposes `xterm.js` Terminal instances (scrollback +
      WebGL renderer) via `cleanupTabResources`.
    - `agentActivityStore.ts:208` `removeContainerState` has no callers.
    Suggestion: introduce a single `disposeEnvironmentClientState(environmentId)`
    registry that every per-environment store registers into, called from
    `deleteEnvironment` — so adding a new store cannot silently regress cleanup.

## Frontend — duplication across the three chat implementations

61. **Three near-identical hand-rolled SSE/event loops with drifted behavior.**
    `OpenCodeChatTab.tsx:1789–2551` is a single ~760-line `useCallback`;
    `ClaudeChatTab.tsx:1740–2294` and `CodexChatTab.tsx:1451–1892` repeat the
    same shape with independently drifted retry/backoff/reconcile logic.
    Suggestion: extract pure `applyXEvent(event, ctx)` reducers into `lib/` (unit
    testable without mounting) and unify on a shared
    `useNativeAgentEventSubscription({ agent, sessionKey, reduce })` hook,
    extending the already-successful `createNativeChatStore` /
    `useNativeMessageQueue` consolidations.

62. **Verbatim triplicated helpers with latent divergence bugs.**
    `promoteNextQueuedPromptToDraft` is byte-identical in three tabs
    (`CodexChatTab.tsx:1105`, `OpenCodeChatTab.tsx:2809`,
    `ClaudeChatTab.tsx:2467`, with a stale dependency only in the OpenCode
    copy); `handleForkFromMessage` is triplicated and OpenCode's copy silently
    lacks Codex's "no message boundary → fresh session" branch; the pending
    prompt/request map-diff helpers exist twice under different names.
    Suggestion: extract `usePromoteQueuedPromptToDraft`,
    `lib/chat/fork-native-session.ts`, and a generic `mapShallowChanged<T>` —
    the fork divergence is a behavioral bug, not just duplication.

63. **Oversized frontend modules.** `ClaudeTmuxChatTab.tsx` (3,771 lines —
    container + queue state machine + model tables + five card components + a
    TUI text parser), `lib/backend.ts` (2,843 lines / 270 exported endpoint
    functions), `FeaturesView.tsx` (2,615, embedding a Codex conversation
    reconciler that most needs direct tests), `ActionBar.tsx` (2,262),
    `GlobalSettings.tsx` (1,774). Suggestion: split each along its obvious
    seams (parser → `lib/claude-tmux/selection-prompt.ts`, backend barrel →
    per-domain modules re-exported for zero churn, reconciler pure functions →
    `lib/feature-conversation-reconcile.ts`).

## Frontend — AGENTS.md background-state violations

64. **The prompt-queue drain is gated on component mount**
    (`useNativeMessageQueue.ts:92,138,280–282` checks `mountedRef`), so
    switching to another environment halts draining of the
    backend-authoritative queue until the user navigates back — contrary to
    AGENTS.md background-reliability rules 2 and 5. Suggestion: move the drain
    loop into a module-level service subscribed to stores (started from
    `store-resource-sync.ts`), keeping the component as a status renderer.

65. **The tmux queue drain state machine lives entirely in component refs**
    (`ClaudeTmuxChatTab.tsx:442–469` — backoff, paused-head, and
    claim-settlement refs are destroyed on unmount, so a paused head never
    resumes after a tab switch). Suggestion: persist claim/backoff state in
    `claudeTmuxStore` or the backend queue record so remount rehydrates.

66. **Hidden tabs stay fully mounted and rendering**
    (`PaneLeafContainer.tsx:236–243`): every inactive chat tab keeps its
    Virtuoso list and selectors re-rendering during streaming. Suggestion:
    keep subscriptions live (correct per AGENTS.md) but pass `isActive` down
    and render a lightweight placeholder when hidden.

## Frontend — type safety & hygiene

67. **`ClaudeEvent` is not a discriminated union**
    (`claude-client.ts:640–661` declares `{ type: <19-member union>; data?: unknown }`
    even though the per-event payload interfaces already exist above it) —
    directly causing five `event.data as any` casts in `ClaudeChatTab.tsx`.
    Suggestion: wire the existing interfaces into a real discriminated union;
    nearly mechanical and the highest-value type fix available. Similarly,
    `opencode-client.ts` holds 6 of the app's 13 non-test `any`s at parsing
    boundaries — replace with `unknown` + guards (the `todo-tool.ts` pattern),
    and type `createNativeChatStore`'s cleanup key lists as
    `readonly (keyof TState & string)[]` so a typo'd map key can't silently
    skip cleanup.

68. **565 raw `console.*` calls in non-test frontend source** (54 in
    `ClaudeChatTab.tsx`, 53 in `TerminalContainer.tsx`, …) run unconditionally
    in production despite `lib/debug-log.ts` already existing with a
    localStorage gate — and several log prompt/session payloads, which
    AGENTS.md invariant 12 forbids. Suggestion: route through `debug-log.ts`
    and lint-ban bare `console.*` outside it (pairs with repo-wide item 2).

69. **~397 exported symbols in `apps/web/src` have no importer outside their
    own module**, and 357 `catch` blocks — many silently discarding errors —
    exist in non-test source. Suggestion: run `knip` to confirm and prune dead
    exports (e.g. `opencode-live-compatibility-probe.ts` belongs under
    `scripts/`); audit uncommented `catch {}` blocks to either log via
    `debug-log` or surface through the existing `errorDialogStore`.

## Frontend — accessibility & resilience

70. **49 of 74 icon-only buttons have neither `aria-label` nor `title`**
    (worst: `GlobalSettings.tsx`, `RepositorySettings.tsx`,
    `HierarchicalSidebar.tsx`, `DockerStatsDialog.tsx`) — they announce as
    unnamed "button" to screen readers. Suggestion: add labels and make the
    `size="icon"` variant of `components/ui/button.tsx` require an
    `aria-label` prop at the type level.

71. **No top-level React error boundary** (`main.tsx:43–58` only registers
    `createRoot` error callbacks that log; a render error in the shared shell
    blanks the window). Suggestion: wrap `<App />` in an error boundary
    reusing `LazyLoadInlineErrorFallback`'s reset pattern so a crash offers
    reload instead of a blank screen.

## Practices worth keeping (context for reviewers)

- `apps/backend/src/core/shell.ts` is the model to standardize on: `execFile`
  (never a shell), 60s default timeout, discriminated `CommandFailedError`,
  secret scrubbing on both paths.
- `toolchain-manager.ts` (HTTPS-only, double SHA-256 pinning, zip-slip and
  signature checks) and `ipc.ts` sender-frame validation are strong; keep those
  patterns when adding new surface.
- `storage.ts` already has cross-process lock files, backup rotation, and
  recovery backups — items 16–17 refine rather than replace this design.
- In the frontend, `createNativeChatStore.ts` and `useNativeMessageQueue.ts`
  are successful prior consolidations of exactly the duplication in items
  61–62 — extend that pattern rather than reinventing it; and
  `VirtualizedMessageList.tsx` handles the Virtuoso hot path correctly.
- In the bridges, bounds, cursors, and deny-by-default are mostly real rather
  than aspirational, and comments explain *why* — the fixes above close gaps
  in an otherwise disciplined design.
- There are essentially no TODO/FIXME/HACK comments anywhere in non-test
  source — debt is structural, not annotated.
