# Improvements Execution Plan

This plan sequences the 72 findings in [`docs/improvements.md`](improvements.md)
into seven phases of small, independently shippable PRs. Item numbers in
parentheses (e.g. *(#49)*) refer to that document. A traceability table at the
end maps every finding to a work item so nothing is silently dropped.

## Guiding principles

- **Tooling first.** CI and a linter (Phase 0) are prerequisites — several later
  phases rely on lint rules (`no-misused-promises`, `no-console`) or CI gates
  (coverage ratchet, protocol drift) to *stay* fixed.
- **Security and leak fixes before refactors.** Phases 1–2 are small, surgical
  diffs that can land on the current file layout. Doing them before the big
  structural splits (Phase 4) keeps them easy to review and avoids rebasing
  hell.
- **Every fix ships with a test that would have caught it.** Especially the
  AGENTS.md invariant violations — Phase 2 ends with `invariants.test.ts` files
  so the doc and the code cannot drift again.
- **One concern per PR.** Target diffs a reviewer can hold in their head
  (< ~500 lines changed outside of mechanical moves). Mechanical file moves go
  in their own commits with no logic changes, so `git diff --follow` stays
  readable.
- **Never regress the strong parts.** `shell.ts`, `toolchain-manager.ts`,
  bridge deny-by-default approvals, and the existing store consolidations are
  the patterns to extend, not replace (see "Practices worth keeping" in the
  findings doc).

## Phase map and dependencies

```
Phase 0  Tooling foundation ──────────────┐
Phase 1  Security & correctness hotfixes  │  (independent of 0, land in parallel)
Phase 2  Leaks, lifecycle & invariants    │  (depends on 0 for lint enforcement)
Phase 3  Shared SSE stack in protocol ────┤  (depends on 2: fixes land first,
Phase 4  Structural splits                │   then are unified)
Phase 5  Test-suite health ───────────────┤  (4 and 5 interleave: test splits
Phase 6  Polish: a11y, logging, dead code ┘   follow source splits)
```

Phases 0 and 1 can start immediately and in parallel. Phase 3 must follow the
Phase 2 bridge fixes (fix in place → extract the now-correct implementation).
Phase 4's test-file splits are shared work with Phase 5.

---

## Phase 0 — Tooling foundation

Goal: every later fix is protected by an automated gate.

### 0.1 Single lockfile *(#3)* — trivial

- Delete `bun.lockb` and `bridges/claude-bridge/bun.lock`; add `bun.lockb` to
  `.gitignore`.
- Verify: `bun install --frozen-lockfile` passes; `git status` clean.

### 0.2 Root scripts + turbo alignment *(#4, #8, #45-turbo)* — small

- Add `"typecheck": "turbo run typecheck"` and `"lint": "turbo run lint"` to the
  root `package.json`.
- Prune duplicate aliases: keep `build`, `build:backend`, `build:renderer`,
  `build:web-public`, bridge builds; delete `build:desktop`/`build:electron`
  (aliases of `build`).
- Fix `packages/protocol`: its `build` is `tsc --noEmit` while `turbo.json`
  declares `outputs: ["dist/**"]`. Rename the script to `typecheck` (it already
  has one — delete the fake `build`) and drop protocol from the `build` graph,
  or give it a real `dist/` build. Prefer the former: consumers import its
  TS sources directly today.
- Remove the dead `./review-instruction` alias export *(#45)*.
- Verify: `bun run typecheck` from root checks all seven workspaces;
  `turbo run build --dry` no longer lists protocol with phantom outputs.

### 0.3 CI workflow *(#1, #39-part)* — small

Create `.github/workflows/ci.yml`:

```yaml
jobs:
  ci:
    runs-on: macos-latest   # or ubuntu-latest if no mac-only tests in scope
    steps:
      - checkout
      - oven-sh/setup-bun with bun-version from package.json packageManager
      - bun install --frozen-lockfile
      - bun run typecheck          # new root script from 0.2
      - bun run codex:protocol:check
      - bun scripts/test-all.ts    # already parallel + buffered per group
      - bun run lint               # added in 0.4; add the step now, allow-failure until 0.4 lands
```

- Skip iOS in CI initially (simulator); keep it in the local `test-all.ts` path.
- Verify: open a PR with a deliberate type error → CI fails.

### 0.4 Linter *(#2)* — medium

- Adopt **Biome** at the repo root (one config for lint + format, fast on Bun).
  If `react-hooks/exhaustive-deps` coverage is a hard requirement, run Biome
  for everything plus a scoped ESLint with only `react-hooks` and
  `@typescript-eslint/no-misused-promises`, `no-floating-promises` on
  `apps/web` and `bridges/**`.
- Initial rule set (errors): unused imports/vars, `no-explicit-any` (warn to
  start), `no-misused-promises` *(#53)*, `no-floating-promises`,
  `no-console` **scoped**: allowed only in `debug-log.ts`, the backend logger
  (Phase 6.2), and scripts *(#68 enforcement)*.
- Land as: (a) config + `bun run lint` wiring, (b) one mechanical autofix
  commit, (c) flip CI step to required.
- Verify: `bun run lint` clean; CI red on a new `console.log` in `apps/web/src`.

### 0.5 Dependency & tsconfig alignment *(#5, #6, #7)* — medium

- Move runtime deps (`react`, `react-dom`, `@xterm/*`, `@dnd-kit/*`,
  `react-virtuoso`) from root `devDependencies` into `apps/web`'s
  `dependencies`; keep root for tooling only *(#5)*.
- Align `typescript` to `~5.8.3` and `@types/node` to one major everywhere via
  a root `overrides` block *(#7)*.
- Create `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`,
  `noUnusedLocals`; extend it from every workspace. Bridges and protocol will
  surface new errors — fix them in the same PR if < ~30, otherwise set the two
  flags per-package with a tracked TODO list *(#6)*.
- Verify: `bun run typecheck` green; `bun why typescript` shows one version.

---

## Phase 1 — Security & correctness hotfixes

All independent, small diffs. Each ships with a regression test.

### 1.1 Bridge token hygiene *(#49, #21)* — small

- `bridges/codex-bridge/src/index.ts:141`: capture `CODEX_BRIDGE_TOKEN` into a
  local and `delete process.env.CODEX_BRIDGE_TOKEN` before anything can spawn,
  mirroring `claude-bridge/src/index.ts:29–32`. Audit
  `process-supervisor.ts:517` and `session-titles.ts:269` spawn envs to
  confirm nothing re-injects it.
- `apps/backend/src/core/commands.ts` (5 sites): stop interpolating
  `authToken` into `docker exec bash -lc` argv; pass it via `docker exec -e
  BRIDGE_TOKEN` (env applies to the exec'd process only) or stdin.
- Tests: codex-bridge boot test asserting the child env lacks the token; a
  backend test asserting the constructed `docker exec` argv contains no token.

### 1.2 Container firewall: IPv6 + DNS *(#28, #29, #30)* — medium

- `docker/init-firewall.sh`:
  - Mirror the IPv4 policy in `ip6tables` (`-P OUTPUT DROP`, established/
    related, loopback). Simplest safe v6 story: drop all v6 egress and rely on
    v4 for the allowlist; only build an AAAA ipset if something breaks.
  - Restrict UDP/TCP 53 to the container's configured resolvers (parse
    `/etc/resolv.conf`, which in Docker is 127.0.0.11) instead of any host.
  - Add a `--refresh` loop: re-resolve the domain allowlist every 5 minutes via
    the existing `update-firewall.sh`, run from the entrypoint under a
    background supervisor.
- Verification (manual once, then scripted into the image test): inside a
  container, `curl -6 https://example.com` fails, `dig @8.8.8.8` fails,
  `dig @127.0.0.11 api.anthropic.com` works; after forcing an ipset flush the
  refresh loop restores connectivity within one interval.

### 1.3 Supply-chain: checksums everywhere *(#31, #32, #43, #42-prep)* — medium

- Create `config/toolchain-versions.json` as the single source of truth:
  `{ tool: { version, sha256: { "darwin-arm64": …, "linux-x64": … } } }` *(#43)*.
- `docker/Dockerfile`: replace `curl … | bash` (opencode) and `wget … | sh`
  (zsh-in-docker) with pinned release artifacts + `sha256sum -c`, matching the
  existing Node.js pattern at lines 63–67 *(#31)*.
- `scripts/download-*.sh`: verify the recorded SHA-256 before extraction
  *(#32)*. (Full consolidation into one script is Phase 5.4; here we only add
  verification to the existing four.)
- Extend `tests/unit/version-drift.test.ts` to cover Claude and to read the new
  JSON, so a bump touches exactly one file.
- Verify: corrupt a downloaded archive in a test → script exits non-zero.

### 1.4 Backend process robustness *(#12, #13, #14, #15)* — medium

- `stream_container_logs` *(#12)*: track children in a
  `Map<containerId, ChildProcess>`, attach `error`/`exit` handlers, add a
  `stop_container_logs` command, kill all in `shutdown()`.
- `write_container_file` *(#13)*: race child exit against a timeout that
  `kill()`s; add `child.stdin.on("error")`.
- `linear.ts:140` *(#14)*: `signal: AbortSignal.timeout(LINEAR_REQUEST_TIMEOUT_MS)`
  in the `github.ts` style.
- Both entrypoints *(#15)*: install `unhandledRejection`/`uncaughtException`
  handlers that log (redacted) and drain via `createBackendShutdownHandler`.
- Tests: leak test spawning `stream_container_logs` twice and asserting child
  count; timeout test with a stubbed never-exiting child.

### 1.5 Storage durability *(#16, #17)* — medium

- `writeAtomic`: `await handle.sync()` on the temp file before close; fsync the
  parent directory after rename on POSIX *(#16)*.
- Key the write queue per file path so unrelated files don't serialize behind
  each other; skip backup rotation for volatile-field-only mutations (activity
  timestamps) *(#17)*.
- Tests: per-path queue independence (slow write to file A does not delay file
  B); backup count unchanged after an activity-timestamp update.

### 1.6 Electron boundary *(#23, #25, #24-part)* — small

- Flip `sandbox: true` in `window.ts:62`; the 12-line preload is sandbox-safe.
  Smoke-test terminal, chat, previews, and file dialogs in `bun run dev` and a
  packaged build before merging *(#23)*.
- Validate `browserPreviewUrl` with `new URL()` and an `http(s)` allowlist at
  the IPC edge *(#25)*.
- Add a wall-clock timeout to `orkestrator:invoke` at the IPC layer now
  (cheap); full schema validation waits for Phase 4.1's zod contracts *(#24,
  #18)*.

### 1.7 Bridge request bounds *(#54)* — small

- Apply `hono/body-limit` to every mutating route on both bridges; cap
  `attachments.length` and per-attachment decoded size on codex's prompt
  route.
- Tests: oversized body → 413; attachment over cap → 400 with a clear message.

### 1.8 Honest Docker stats *(#19)* — small

- Parse `docker system prune` / `docker system df` output properly, or remove
  the fabricated zero fields from the contract and the UI display. Prefer
  parsing — the UI already renders the fields.

---

## Phase 2 — Leaks, lifecycle & invariant enforcement

### 2.1 Renderer environment-dispose registry *(#60)* — medium

- New `apps/web/src/lib/environment-dispose.ts`:
  `registerEnvironmentDisposer(name, fn)` + `disposeEnvironmentClientState(id)`.
- Each per-environment store registers its own cleanup at module init:
  `claudeStore`/`codexStore`/`openCodeStore` `clearEnvironment`,
  `paneLayoutStore.reset` (disposes xterm instances),
  `agentActivityStore.removeContainerState`, `promptDraftStore`,
  `sessionStore`, terminal portal.
- Call `disposeEnvironmentClientState(id)` from `useEnvironments.deleteEnvironment`
  after the backend delete succeeds, replacing the current 4 ad-hoc calls.
- Test: create → populate → delete an environment in a store-level test; assert
  every registered store's maps no longer contain the id. Add a lint-adjacent
  guard: the registry exposes `registeredNames()` and a test asserts every
  store file matching `stores/*Store.ts` with per-environment maps is
  registered (keeps future stores honest).

### 2.2 codex-bridge SSE correctness *(#50, #51, #52, #57, #19-writer)* — large

Fix in place (extraction to protocol happens in Phase 3):

- Byte-bound the handshake replay buffer (`pendingLiveBytes` alongside the
  10k count) and count backlog with `Buffer.byteLength` *(#50)*.
- Add `generation:revision` cursors to `event-ring.ts`, mirroring
  claude-bridge's `event-emitter.ts`; a cursor from another generation triggers
  `session.reconcile-required` instead of silently serving the wrong range
  *(#51)*.
- Race SSE writes against the request signal; wrap the handshake in
  `try/catch`; register the abort listener *before* replay, remove it in
  `finally` *(#52)*.
- Make `emit`'s serialization decision consult subscriber session filters, not
  just subscriber count *(#57)*.
- Tests for each, plus: restart-simulation test proving an old-generation
  cursor cannot report `complete: true`.

### 2.3 codex-bridge memory bound for attached threads *(#56)* — medium

- Byte-budgeted head-trim on `ThreadContext.messages` with a
  `needsRehydrate` flag; the rollout is authoritative, so a trimmed head
  rehydrates on demand — same philosophy as claude-bridge's
  `evictIdleHydratedTranscripts`.
- Test: pump messages past the budget; assert retained bytes stay bounded and
  a subsequent full read rehydrates from the rollout fixture.

### 2.4 Frontend background-state fixes *(#64, #65, #66)* — medium/large

- Move the prompt-queue drain from `useNativeMessageQueue`'s mount-gated loop
  into a module-level service started from `store-resource-sync.ts`; the hook
  becomes a status renderer *(#64)*. Test per AGENTS.md: start a queue, switch
  environment, assert the queue keeps draining.
- Persist the tmux drain/backoff/claim state in `claudeTmuxStore` so remount
  rehydrates instead of restarting *(#65)*.
- Pass `isActive` into `VirtualizedMessageList` and render a placeholder when
  hidden — subscriptions stay live, rendering stops *(#66)*.

### 2.5 Invariant guard tests *(#59, #53, #55, #58)* — medium

- `bridges/*/src/invariants.test.ts`: executable checks for the AGENTS.md
  invariants — replay-buffer byte bound, `connected` frame echoing the client
  cursor, stdout handler returning `undefined` (dev assertion added in
  `jsonl-rpc-client.ts` *(#53)*, belt to Phase 0.4's lint braces).
- Convert `sseRouteTestHooks` from a mutable module global into route-options
  injection *(#55)* (small now; also unblocks the Phase 3 extraction).
- PID-quarantine catches return `"ok" | "lost" | "io-error"`; recorder latches
  off after N consecutive failures *(#58)*.

---

## Phase 3 — Shared SSE/replay stack in `@orkestrator/protocol` *(#48, #47-part)*

Do this only after 2.2, so the extracted implementation is the corrected one.

### 3.1 Extract primitives — large

- Move into `packages/protocol/src/sse/`: the event ring (byte+count bounded),
  replay retention gate, bounded/serialized SSE writer (signal-racing), and
  the `generation:revision` cursor codec. Port the *union* of both bridges'
  tests with them.
- Unify the SSE event vocabulary: one shared union covering
  `session.updated`/`session.idle`/`message.updated`/`message.patched`/
  reconcile signal; keep per-bridge extensions as intersection types. Pick one
  reconcile event name and alias the other during a deprecation window so the
  web client drops one of its two unions.

### 3.2 Adopt in both bridges — medium each

- codex-bridge first (it just got the fixes; adoption is mostly deletion),
  then claude-bridge. Shared auth middleware
  (`createBridgeAuthMiddleware({ tokenEnv, originsEnv, headerName })`) moves in
  the claude PR *(#48-auth)*.
- Acceptance: both bridges' SSE suites pass against the shared module;
  `__testing` on codex no longer exports ring/writer internals.

---

## Phase 4 — Structural splits

Mechanical-move commits separated from logic commits. Test splits mirror each
source split (shared with Phase 5).

### 4.1 Backend command registry *(#9, #26, #27, #24, #18)* — the big one; 4–6 PRs

1. **Extract shared helpers first**: one shell-quoting module +
   `dockerExecArgv(containerId, argv[])`; migrate no-shell call sites
   (`mkdir -p`, `cat`, …) *(#27)*. One arg-validation module — zod schemas in
   `packages/protocol` per command, `register(name, schema, handler)` so
   handlers receive typed args *(#26)*.
2. **Split by domain**, one PR each: `commands/docker.ts`, `commands/git.ts`
   (worktrees), `commands/terminals.ts`, `commands/integrations.ts`
   (GitHub/Linear/PR), `commands/review.ts`, `commands/files.ts`. Each exports
   `registerX(register, shared)`; `createCommandRegistry()` becomes a
   composition root. Move the matching slice of the 16.7k-line
   `commands.test.ts` in the same PR *(#11)*.
3. **Boundary hardening**: with schemas in place, validate at
   `orkestrator:invoke` *(#24)* and wrap `invoke` with per-command timeout +
   `{ code, message }` error envelope *(#18)*.
- Guard: a test asserting the registered command-name set is unchanged after
  each split PR (snapshot of the 272 names).

### 4.2 Storage repositories *(#10)* — 2–3 PRs

- Extract `JsonStore` (atomic write w/ fsync, per-path queue, locking, backup
  rotation — the Phase 1.5 fixes come along) as the base; peel domains into
  `EnvironmentStore`, `PipelineStore`, `DraftStore`, … matching the existing
  test-file seams. `StorageService` becomes a façade delegating to
  repositories until callers migrate.

### 4.3 Gateway extraction *(#10a)* — 1 PR

- `gateway-metrics.ts` and `gateway-compression.ts` out of `gateway.ts`; both
  are already pure-function clusters.

### 4.4 claude-bridge session-manager *(#46, #59-part)* — 2–3 PRs

- Extract the SDK stream reducer (~4980–5400) into `stream-reducer.ts`
  mirroring codex's `event-reducer.ts`; type the SDK message variants and
  delete the 12 `no-explicit-any` suppressions.
- Extract `canUseTool` question/plan handling into `approvals.ts` mirroring
  codex's `server-request-router.ts`.
- Split the 10,329-line test file along the same seams.

### 4.5 codex-bridge composition root *(#47, #55-done)* — 1–2 PRs

- After Phase 3 removed the SSE stack: extract `auth.ts` (now shared),
  `fallback-models.ts`, persisted-cache IO. Orphan test files
  (`fallback-models.test.ts`, …) move next to their new modules. `__testing`
  shrinks to composition-root concerns. Same treatment for
  `app-server-runtime.ts`: peel approvals/interactions and the ordered-event
  drain.

### 4.6 Frontend chat unification *(#61, #62, #67)* — 3–4 PRs

1. `ClaudeEvent` → real discriminated union; delete the five `as any` casts
   *(#67)*. Do this first — it makes the reducer extraction typed.
2. Extract pure `applyXEvent(event, ctx)` reducers per agent into `lib/`, unit
   tested without mounting *(#61-part)*.
3. Shared `useNativeAgentEventSubscription({ agent, sessionKey, reduce })`
   hook replacing the three hand-rolled loops *(#61)*.
4. Deduplicate `usePromoteQueuedPromptToDraft`,
   `lib/chat/fork-native-session.ts` (fixing OpenCode's missing
   fresh-session branch — behavioral fix, gets its own test), and generic
   `mapShallowChanged<T>` *(#62)*.

### 4.7 Frontend module splits *(#63)* — mechanical, 3–4 PRs

- `ClaudeTmuxChatTab.tsx`: parser → `lib/claude-tmux/selection-prompt.ts`
  (+ unit tests), cards → `components/claude/tmux/`, model tables →
  `lib/claude-tmux/models.ts`.
- `lib/backend.ts` → per-domain modules re-exported from `backend.ts` (zero
  churn for callers).
- `FeaturesView.tsx`: conversation-reconcile pure functions →
  `lib/feature-conversation-reconcile.ts` + tests.
- `GlobalSettings.tsx` → one file per section, mirroring `RepositorySettings`.

---

## Phase 5 — Test-suite health

### 5.1 One test-tree convention *(#33, #34, #37)* — 2–3 PRs

- Resolve the 7 duplicated basenames first: diff each pair, merge unique cases
  into the co-located file, delete the `tests/unit` twin.
- Migrate co-located-in-spirit tests from `tests/unit/` into `apps/web/src`;
  keep `tests/` for cross-workspace contract tests. Update
  `scripts/test-all.ts` groups accordingly.
- Fix `tests/setup.ts`: import `"sonner"` normally (add to devDeps) *(#34)*;
  convert the blanket native mocks into an explicit `installNativeMocks()`
  used by the files that need it *(#37)* — do this during the migration, when
  every file is being touched anyway.

### 5.2 Deflake: kill the sleeps *(#35)* — medium

- Add `tests/helpers/until.ts` (`await until(() => predicate, {timeout})`).
- Replace the ~9 multi-second sleeps and the ~60 sub-100 ms syncs (worst:
  `app-server-runtime.test.ts`, 25+) with `until` or `setSystemTime`.
- Lint guard: ban `setTimeout` with a literal ≥ 1000 inside test files
  (Biome `noRestrictedSyntax`-equivalent or a small custom check in CI).

### 5.3 Mock hygiene + coverage *(#36, #38, #39)* — small

- Apply snapshot-and-restore to the six offending `mock.module` files or
  promote to `tests/setup.ts` per the AGENTS.md decision rule *(#36)*.
- Turn on `bun test --coverage` in CI with an initial ratchet at current
  coverage −1pt; raise quarterly *(#38)*. Typecheck already gates via 0.3
  *(#39)*.

### 5.4 Consolidate download scripts *(#42, #44)* — medium

- One `scripts/download-toolchain.ts` (Bun) driven by
  `config/toolchain-versions.json` from 1.3: arch table, mktemp+trap
  equivalent, extract, checksum verify, codesign dance, `--version` smoke
  check. Delete the four shell scripts.
- Standardize remaining shell (`entrypoint.sh`, `workspace-setup.sh`,
  helpers) on `set -euo pipefail`; fix the unset-var fallout it exposes
  *(#44)*.

### 5.5 Real Electron e2e *(#40, #41)* — large, can run parallel to everything

- New Playwright project using `_electron.launch()` against the packaged app:
  smoke journey = launch → create local-worktree environment → send a prompt
  (stub agent binary from the e2e fixture) → assert response renders → restart
  app → assert session rehydrates (the AGENTS.md background-reliability path).
- Config: `retries: process.env.CI ? 2 : 0`, HTML+blob reporters, per-project
  `testMatch` replacing the 20 runtime `test.skip` calls *(#41)*.
- Keep the CSS/browser specs; they just stop being the whole suite.

---

## Phase 6 — Polish: logging, a11y, dead code

### 6.1 Structured backend/bridge logging *(#22, #20)* — medium

- `core/log.ts` (or protocol): `{ level, component, event, fields }` with a
  redaction allowlist; migrate the ~90 backend `console.*` call sites.
- Route bridge/OpenCode child stdout/stderr through a redacting, length-capped
  helper (reuse `redactCommandValues`); raw passthrough only behind a debug
  flag. Same at the Electron supervisor boundary *(#20)*.
- The one silent `closeSync` catch logs at debug with the path *(#9-adjacent)*.

### 6.2 Frontend console discipline *(#68)* — mostly mechanical

- Migrate the 565 `console.*` calls to `debug-log.ts` (worst five files first);
  the Phase 0.4 lint rule then holds the line. Audit for prompt/session
  payloads while migrating (invariant 12).

### 6.3 Dead code & silent catches *(#69)* — medium

- Run `knip`; unexport or delete the ~397 orphan exports; move
  `opencode-live-compatibility-probe.ts` under `scripts/`.
- Sweep uncommented `catch {}` blocks: each either logs via `debug-log`,
  surfaces via `errorDialogStore`, or gains a one-line justification comment.

### 6.4 Accessibility & resilience *(#70, #71)* — small/medium

- Make `size="icon"` require `aria-label` at the type level in
  `components/ui/button.tsx`; fix the 49 unlabeled sites the compiler then
  flags.
- Wrap `<App />` in a top-level error boundary reusing
  `LazyLoadInlineErrorFallback`'s reset pattern.

---

## Suggested landing order (first ten PRs)

| # | PR | Phase | Size |
|---|----|-------|------|
| 1 | Delete stale lockfiles; root typecheck/lint scripts; protocol turbo fix | 0.1–0.2 | XS |
| 2 | CI workflow | 0.3 | S |
| 3 | codex-bridge: strip bridge token from env (+ backend argv fix) | 1.1 | S |
| 4 | Firewall: ip6tables drop + DNS restriction + refresh loop | 1.2 | M |
| 5 | `config/toolchain-versions.json` + checksums in Dockerfile & scripts | 1.3 | M |
| 6 | Backend: log-stream leak, write_container_file timeout, Linear abort, crash handlers | 1.4 | M |
| 7 | Biome + first autofix + scoped ESLint rules | 0.4 | M |
| 8 | Renderer environment-dispose registry | 2.1 | M |
| 9 | codex-bridge SSE: byte bounds, generation cursors, signal-raced writes | 2.2 | L |
| 10 | Electron: sandbox=true, URL validation, invoke timeout | 1.6 | S |

## Verification gates per phase

- **Phase 0**: CI red/green demonstrably tied to typecheck, lint, tests,
  protocol drift.
- **Phase 1**: each fix has a regression test; manual container firewall
  checklist run once and scripted.
- **Phase 2**: `invariants.test.ts` in both bridges; AGENTS.md
  inactive-environment manual test (start work → switch env → return) passes
  for queue drain.
- **Phase 3–4**: command-name snapshot unchanged; both bridges green on the
  shared SSE suite; `bun run test` wall-clock should *drop* as monolithic test
  files split across workers.
- **Phase 5**: zero literal sleeps ≥ 1s in tests; coverage ratchet active;
  Electron smoke e2e in CI.
- **Phase 6**: lint bans bare `console.*`; knip clean or allowlisted.

## Traceability: finding → plan item

| Findings | Plan |
|---|---|
| 1, 2 | 0.3, 0.4 |
| 3, 4, 5, 6, 7, 8 | 0.1, 0.2, 0.5 |
| 9, 26, 27 | 4.1 |
| 10 | 4.2 · 10a | 4.3 · 11 | 4.1/4.4/5.1 |
| 12, 13, 14, 15 | 1.4 |
| 16, 17 | 1.5 (carried into 4.2) |
| 18, 24 | 1.6 + 4.1 · 19 | 1.8 |
| 20, 22 | 6.1 · 21 | 1.1 |
| 23, 25 | 1.6 |
| 28, 29, 30 | 1.2 |
| 31, 32, 43 | 1.3 · 42, 44 | 5.4 |
| 33, 34, 37 | 5.1 · 35 | 5.2 · 36, 38, 39 | 5.3 |
| 40, 41 | 5.5 |
| 45 | 0.2 |
| 46 | 4.4 · 47 | 4.5 · 48 | 3.1–3.2 |
| 49 | 1.1 |
| 50, 51, 52, 57 | 2.2 · 53, 55, 58, 59 | 2.5 |
| 54 | 1.7 · 56 | 2.3 |
| 60 | 2.1 |
| 61, 62, 67 | 4.6 · 63 | 4.7 |
| 64, 65, 66 | 2.4 |
| 68 | 0.4 + 6.2 · 69 | 6.3 · 70, 71 | 6.4 |

Every finding maps to exactly one primary plan item; none are deferred without
a phase.
