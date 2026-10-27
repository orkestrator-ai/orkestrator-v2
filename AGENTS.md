# Agent Instructions
.
This file provides specific guidance for AI agents working on this codebase.
The living documentation catalog is [`docs/README.md`](docs/README.md).

Orkestrator AI is an Electron desktop application for managing isolated Docker-based and local-worktree development environments for Claude Code, Codex, OpenCode, Cursor Agent, Grok Build, and Pi.

## Read before changing these areas

This file holds only the rules that apply everywhere. Area-specific rules live
next to the code. Read the matching file before editing in that area; Claude
Code loads them automatically when it reads a file there, other agents may not.

| Area | Read first |
| --- | --- |
| Any bridge, or backend code that calls bridge routes (`http-bridge-provider*`, `bridge-session-close.ts`, the activity sweep) | [`bridges/AGENTS.md`](bridges/AGENTS.md) |
| `bridges/claude-bridge/`, the coordinator shell allowlist | [`bridges/claude-bridge/AGENTS.md`](bridges/claude-bridge/AGENTS.md) |
| `bridges/codex-bridge/` | [`bridges/codex-bridge/AGENTS.md`](bridges/codex-bridge/AGENTS.md) |
| `bridges/pi-bridge/` | [`bridges/pi-bridge/AGENTS.md`](bridges/pi-bridge/AGENTS.md) |
| `bridges/cursor-bridge/` | [`bridges/cursor-bridge/AGENTS.md`](bridges/cursor-bridge/AGENTS.md) |
| `bridges/acp-bridge/` | [`bridges/acp-bridge/AGENTS.md`](bridges/acp-bridge/AGENTS.md) |
| `docker/`, container lifecycle, firewall, Playwright in containers | [`docker/AGENTS.md`](docker/AGENTS.md) |
| OpenCode provider, SDK pin or `patches/` | [`docs/architecture/agent-engines.md`](docs/architecture/agent-engines.md#maintaining-the-opencode-integration) |
| Coordinator qualification (`coordinator-providers.ts`) | [`docs/architecture/coordinator.md`](docs/architecture/coordinator.md#changing-qualification) |
| Scheduled jobs (`scheduled-jobs/`, `schedule.*` actions, schedule tools) | [`docs/architecture/scheduled-jobs.md`](docs/architecture/scheduled-jobs.md) |
| Slash-command discovery or dispatch | [`docs/architecture/native-agent-commands.md`](docs/architecture/native-agent-commands.md) |
| Agent SDK/CLI version bumps | [`docs/development/upgrade-agents.md`](docs/development/upgrade-agents.md) |
| Rendered UI or browser-visible behavior | [`docs/development/agent-testing.md`](docs/development/agent-testing.md) |
| Writing or debugging tests, `mock.module()` | [`docs/development/testing-guide.md`](docs/development/testing-guide.md) |
| Lint findings and disable directives | [`docs/development/linting.md`](docs/development/linting.md) |

## Main Branch and Pull Request Policy

All changes to `main` must be integrated through a pull request. Agents must
never commit or push directly to `main`, and must not merge, squash, or rebase a
pull request into `main` themselves. Agents may prepare a feature branch, push
that branch explicitly, and open a pull request for review; the final merge into
`main` must be left to a human maintainer.

Before pushing, verify both the current branch and its configured upstream. If
either operation would update `main` directly, stop and correct the branch or
upstream configuration instead of pushing.

## Background Work and Transport Invariants

Environments keep doing work while another environment is active in the UI. Do
not assume the active React tree is mounted, subscribed to events, or able to
receive every Electron IPC/SSE/tmux update. When changing background behavior
(agent sessions, tmux, terminals, local servers, Docker, file watchers, PR
monitoring, build pipelines) or gateway, bridge, terminal, streaming, replay,
compression, or synchronization code, preserve these invariants:

1. Long-running state lives in the backend, bridge, persistent store, or
   external process, not only in mounted React state. Foreground components
   rehydrate from an authoritative snapshot when they mount or become active.
2. A component unmount or inactive environment does not stop background work.
   Unmount means "not visible", not "cancel"; tie cleanup to an explicit stop.
3. Live events are incremental updates over authoritative snapshots, never the
   only source of truth.
4. Every missed event is detectable through a revision gap, generation change,
   expired cursor, or explicit reconciliation frame.
5. Terminal output may be dropped only under bounded backpressure, with an
   explicit desync signal and exact snapshot recovery.
6. Authoritative state events must not be silently dropped.
7. Replay subscribes before it calculates and flushes the replay range.
8. A connected SSE frame echoes the client's cursor; it must not jump the
   client to the latest server revision before replay completes.
9. Codex app-server's stdout loop never awaits rendering, SSE writes, browser
   work, or other consumers.
10. Approval timeout, disconnect, malformed answers, and generation death deny
    rather than approve.
11. Every queue, replay ring, decoded request, rewritten response, and
    compression buffer has explicit byte and count bounds.
12. Metrics and logs never contain prompts, terminal contents, file contents,
    credentials, tokens, or attachment data.
13. Closing a tab never deletes the conversation. Never call Claude's
    `DELETE /session/:id` or SDK `deleteSession`, Codex `thread/delete`, or
    OpenCode `client.session.delete` from a close path.
14. A transcript row is one model response (one step of the agent loop),
    never a whole turn. A turn kept alive by background work runs for hours,
    and a multi-megabyte row fits no transcript window: readers get only a
    trimmed copy and lose its start once newer rows push it out of the live
    tail. Late updates find the row holding their call, a changed row outside
    the live tail still reaches readers (`revisedMessages`), and everything
    that leaves the live tail stays reachable through history paging. See
    `bridges/AGENTS.md` ("Transcript rows"); each bridge's `AGENTS.md` names
    its row boundary.

Test the inactive-environment path: start work, switch away, let it progress or
finish, return, and verify status, messages, pending prompts and controls.

## Unhandled Rejections Are Fatal

Under Bun an unhandled promise rejection terminates the process once the entry
module has finished evaluating. The backend and all five bridges install
`installFatalRejectionGuard` (`packages/protocol/src/fatal-rejections.ts`) at
startup; install it in any new long-lived entrypoint. It is inert under
`bun test` (`NODE_ENV=test`) so tests still fail on unhandled rejections.

The guard is a floor, not a licence: a backend exit takes Local offline for the
session. When aborting an `AbortController` whose signal is shared with
in-flight work, check that every consumer of that signal has a rejection
handler. A guard log line every turn is still a bug.

## Stack and Layout

React 19, TypeScript, Tailwind CSS v4, shadcn/ui and Zustand in `apps/web`;
Electron in `apps/desktop`; the standalone Bun backend in `apps/backend`
(`src/core/`); shared contracts in `packages/protocol`; the pinned agent toolchain
(manifest, installer) in `packages/toolchain`; the published
`orkestrator` CLI in `packages/cli`; native-mode bridge servers in `bridges/`;
the container image in `docker/`.

- UI uses **shadcn/ui** (`apps/web/src/components/ui/`) and Tailwind CSS v4.
  Check for an existing component first.
- **Zustand** for global state (`apps/web/src/stores/`), React Context for
  component-tree state (`apps/web/src/contexts/`). Stores use the
  `Map<string, T>` pattern for per-environment/per-session state.
- Register backend commands in `apps/backend/src/core/commands.ts` through
  `createCommandRegistry()`, using the existing `CommandContext` and
  `StorageService` patterns rather than renderer-only state.
- Desktop `BrowserWindow` preloads are bundled as ESM, so the main window and
  toolchain bootstrap windows keep `sandbox: false`. Browser preview views stay
  sandboxed.
- Application data lives in `~/Library/Application Support/orkestrator-v2/`
  (macOS) or `${XDG_CONFIG_HOME:-~/.config}/orkestrator-v2/` (Linux).

## Splitting large classes

Split a large class by responsibility into collaborators (modules or small
classes that take a shared context object), not into `extends` layers. A class
cut into `-base` / `-core` / `-extra` files chained by `extends` and held
together by `abstract` forward declarations is still one class, just harder to
read. `tests/unit/inheritance-chains.test.ts` fails on any new project-class
inheritance; a deliberate one-level subclass (an error refinement, a hook
override) goes in its `INTENTIONAL_SUBCLASSES` list with a reason.

## OpenCode SDK v2 - CRITICAL

**Always use v2 of the `@opencode-ai/sdk` package.**

```typescript
// CORRECT - v2 API
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";

// WRONG - v1 API (different parameter structure, missing features)
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
```

The SDK is patched (`patches/`). Read the OpenCode maintenance notes in
`docs/architecture/agent-engines.md` before bumping it.

## Task Runner - mise; Package Manager - Bun

Use mise for repository-level tasks and Bun for package management and focused
commands. Never use npm or yarn.

```bash
bun install              # NOT npm install
mise run <task>          # Repository-level task; NOT npm run
mise run test            # Default suite; NOT bare root-level `bun test`
bun test <explicit-path> # Focused Bun test-runner invocation only
bunx <package>           # NOT npx
bun <file>               # NOT node <file>
mise run dev             # Run the Electron application
mise run build           # Build for production
```

Bun automatically loads `.env` files. At the repository root, bare `bun test`
performs direct discovery and can collect Playwright/E2E specifications and
unrelated fixtures, so it is never a substitute for `mise run test`.

Before selecting or diagnosing a test workflow, read
[`docs/development/testing-guide.md`](docs/development/testing-guide.md). It is
the source of truth for suite scope, changed-only testing, concurrency, caching,
watchdogs, leases, failure artifacts, and escalation to browser, agent, Docker,
or iOS validation.

### Choosing validation for a change

Review preparation (the Build pipeline's package preparation and Multi Review)
reads this file to decide which checks a change needs. Scale the plan to what
the changed paths can affect instead of always running every suite:

- Documentation-only changes (prose in files such as `*.md`, `docs/**`, or
  `plans/**`, not content consumed by tests, builds, or tooling) need no test
  suite: `mise run format:check` is enough. This includes merge-conflict
  resolutions confined to such files (see below). File role takes precedence
  over location or extension; source under `docs/` still counts as code.
- Every change to code or configuration runs `mise run format:check`,
  `mise run lint`, and `mise run typecheck`.
- Code changes under `apps/`, `bridges/`, `packages/`, `scripts/`, or `tests/`
  run `mise run test` (the non-iOS suite). It selects the slow area suites
  itself from the change's import graph; do not add `mise run test:full` to
  force them.
- Treat dependency, lockfile, `mise.toml`, Turbo, test-runner, or
  `packages/protocol` changes as wide-reaching even when the diff is small;
  they always need `mise run test`.
- Add a scenario suite from the testing guide's **Verification by change type**
  table only when the change touches that area: browser-visible renderer flows
  (`mise run test:browser`, or `mise run test:agent:browser:isolated` for
  real-stack flows), the design canvas (`mise run test:agent:design:isolated`),
  Electron main/preload/IPC (`mise run test:agent:electron`), Docker lifecycle
  (`mise run test:agent:docker`), service preview origins, forwarding and
  fixtures (`mise run test:preview:browser`), the published CLI
  (`mise run test:cli:scenarios`), and iOS (`mise run test:all`, macOS only).
  Omit them otherwise and say so in one limitation.

#### Documentation-only merge-conflict resolution

Resolving merge conflicts that are only in documentation needs no tests. When
the complete original conflicted-path list shows that every conflict was in
prose documentation or other non-code text not consumed by tests, builds, or
tooling, and the manual resolution changes only those files, confirm no
conflict markers remain and run `mise run format:check`. That is the whole
validation for the step: do not run tests, lint, typechecking, builds, or
scenario suites for it, even when code, configuration, or tests from the target
branch merged cleanly alongside it. This rule takes precedence over the normal
changed-path requirements above and over generic merge-validation guidance.

Capture the complete original unmerged path list before staging any resolution
and retain it with the merge's parent commit IDs in local Git metadata for
resume. A conflict remains in scope even when resolved exactly to one parent's
version. If the original list is unavailable or incomplete, do not infer a
documentation-only scope from remaining unmerged paths, staged diffs, or a merge
commit's combined diff; run relevant validation on the merged result, including
the full suite when impact cannot be scoped.

The exception does not waive outstanding validation required for the feature
work or apply to new code/configuration changes, non-documentation conflict
resolutions, or documentation consumed by tests, builds, or tooling. Those
changes follow the normal validation requirements.

### Running tests

Run every test, typecheck, build verification, or smoke suite through
`test:logged`, one command per suite so each exit status maps to one check. It
streams output to a private bounded file, preserves the exit status, deletes
passing output, and compresses failing evidence. Do not add a second `tee`.

```bash
mise run test:changed # Fast affected-only feedback; not final handoff proof.
mise run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures
mise run test:logged -- --name web-typecheck -- bun run --cwd apps/web typecheck
```

The exit status is authoritative; if a tool buffer maxes out, read the
compressed artifact the runner prints with bounded reads (`gzip -cd ... | tail`)
rather than inferring the result. Always pass `--parallel` to a direct suite.
`--parallel` implies `--isolate`, so a test that fails only in parallel usually
depended on a global set by a sibling file; run it alone before calling it a race.

Bun's `mock.module()` is global at the module-cache level and `mock.restore()`
does not undo it. Register mocks every suite needs once in `tests/setup.ts`, put
reusable mock functions in `tests/mocks/*`, mock narrow dependencies rather than
shared app modules, and never add a competing global mock for a module another
suite imports for real.

Flakes are tracked only in the group folders of
[`docs/tests/flaky-tests/`](docs/tests/flaky-tests/0000-index.md); the top-level
index only lists the groups. Search the group indexes by test name or owning
file; do not read every case file. A
failure is a flake only if the owning file passes when rerun alone; record it in
the same change, and never hide one by skipping or loosening the test.

For real-stack UI QA use isolated `dev:test` profiles with `--fixture`, never a
production instance or this checkout as the project. Never print, paste, or save
the gateway token — sign in with `mise run dev:login`. Never use broad cleanup
(`docker prune`, killing by name or port); stop and reset the profile with
`dev:stop`/`dev:reset` when done. The
[`orkestrator` CLI](docs/development/cli-testing.md) can drive the same profiles
without the UI.

### Production Orkestrator shares this host

Orkestrator is built with Orkestrator, so assume the production app is running
on the same machine, and that your shell, tests, and fixtures are descendants
of its backend. Its backend, bridges, agent CLIs, and `opencode serve`
processes look like the ones tests start. Killing one ends every agent session
on the host, including yours. The production backend has been SIGKILLed during
agent-run `mise run test` suites.

- Signal only processes you spawned, through the handle or PID you recorded at
  spawn time. Signal a process group only if you created it detached.
- Never kill by name, pattern, or port (`pkill`, `killall`, `fuser -k`,
  `kill $(lsof ...)`), and never signal `process.ppid`, an ancestor, PID `0`,
  or a group you did not create.
- Before signalling a PID read from a file, registry, or `ps` scan, confirm
  its identity (start time and exact command line), because PIDs are reused.
- Never point a test or fixture at `~/.config/orkestrator-v2`, its toolchains,
  or its fixed ports; use a temporary data directory or an isolated `dev:test`
  profile.

[`testing-guide.md`](docs/development/testing-guide.md#production-orkestrator-shares-this-host)
has the details.

### Updating Bun and lockfiles

When bumping the Bun runtime, changing a dependency, or changing package
metadata that Bun records (including a workspace package's `version`),
regenerate lockfiles with the Bun version pinned by `mise.toml`. Do not hand-edit
`bun.lock`, and do not omit a lockfile change just because no dependency version
changed.

Regenerate every tracked lockfile from the directory that owns it. The root
install does not replace the standalone Claude bridge lockfile:

```bash
mise exec -- bun install
mise exec -- bun install --cwd bridges/claude-bridge
```

Review the lockfile diff, then prove both files are current by repeating the
installs in frozen mode and running the drift test:

```bash
git diff -- bun.lock bridges/claude-bridge/bun.lock
mise exec -- bun install --frozen-lockfile
mise exec -- bun install --cwd bridges/claude-bridge --frozen-lockfile
mise exec -- bun test tests/unit/version-drift.test.ts
```

If another standalone `bun.lock` is added later, add its owning directory to
both command lists and to the lockfile coverage in
`tests/unit/version-drift.test.ts`.

`docker/artifact-preview-worker/package-lock.json` is the one npm lockfile: the
worker image runs Node and installs with `npm ci`. When the backend's
`playwright-core` pin changes, update that directory's `package.json` and
regenerate the lockfile with the base image's own npm (`npm install
--package-lock-only --ignore-scripts` in a container of the worker image); the
drift test checks the manifest, lockfile, backend pin and base-image tag agree.

## Formatting, Linting and Typechecking

Formatting is `bun fmt` (configured by the `[fmt]` section of `bunfig.toml`),
linting is oxlint, and typechecking is `bun check` (TypeScript 7, the same
version as the `typescript` dev dependency). Run them from the repo root with
`mise run format`, `mise run format:check`, `mise run lint`, `mise run lint:fix`,
`mise run typecheck`, or `mise run check` (format, lint and typecheck). Package
`typecheck` scripts call `bun check -p <tsconfig>`; do not add a `check` script
to a `package.json`, because `bun check` runs that script instead of the type
checker. Markdown and `docs/**` are not reformatted. Rationale and exclusions
are in [`docs/development/linting.md`](docs/development/linting.md).

Format with `bun fmt` (or `mise run format`) only: do not run `oxfmt`,
`npx oxfmt` or Prettier, and do not add an `.oxfmtrc.json` or `.prettierrc`,
which would take precedence over `bunfig.toml`.
To format or check only the files you touched, pass them to `bun fmt` or
`bun fmt --check`.

- Only `correctness` is enabled, as errors, including the seven React
  Compiler rules (`react/refs`, `react/set-state-in-effect`, …). The one
  warning is `no-unused-vars`, for its pre-existing backlog: clean up files you
  touch, never add new findings or silence it, and raise it to `error` only
  once the backlog is gone. Warnings do not fail the build, so read the output.
- Use a disable directive only when the rule is wrong about that site, with the
  reason above it. `oxlint-disable-next-line` sits above the **reported** line;
  `react-hooks/exhaustive-deps` needs a block `oxlint-disable`/`oxlint-enable`
  pair. Check first whether the dependency is genuinely missing — most were.
- Iterate a collection you are about to mutate with
  `for (const x of Array.from(collection))`, not a spread; lint's suggested fix
  for the spread form silently skips entries.
- Module boundaries are lint errors: no runtime import cycles
  (`import/no-cycle`; type-only imports are exempt), no new `export let`, no
  `node:`/`bun:` or `@orkestrator/protocol/node/*` value imports in the
  renderer, no raw `@/lib/native/backend` in components, and
  `@orkestrator/protocol/testing/*` only from tests. Top-level
  `packages/protocol/src/*.ts` is shared with the browser; Node- or
  Bun-dependent protocol code goes in `src/node/`, fixtures and fakes in
  `src/testing/`. Fix a finding by moving code, not with a disable directive.

## Application Version Bumps

Bump the Orkestrator version with `mise run release:version -- <version>`
(`scripts/set-version.ts`). It sets the top-level `version` field in all of
these package manifests, then regenerates and verifies the lockfiles as
described in **Updating Bun and lockfiles**:

- `package.json`
- `apps/backend/package.json`
- `apps/desktop/package.json`
- `apps/web/package.json`
- `apps/web-public/package.json`
- `bridges/acp-bridge/package.json`
- `bridges/cursor-bridge/package.json`
- `bridges/claude-bridge/package.json`
- `bridges/codex-bridge/package.json`
- `bridges/pi-bridge/package.json`
- `packages/cli/package.json`
- `packages/protocol/package.json`
- `packages/toolchain/package.json`

A new versioned manifest must be added to this list and to
`VERSIONED_MANIFESTS` in that script; `tests/unit/release/set-version.test.ts`
fails until both name it. To check a bump by hand:

```bash
rg -n '"version"\s*:' --glob 'package.json' --glob '!node_modules/**'
```

A bump made by hand must then follow **Updating Bun and lockfiles** above. A
version-only bump still changes the workspace metadata in the root `bun.lock`; leaving the old values
there causes a later non-frozen `bun install` to dirty an otherwise clean build
worktree.

## Public CLI contract

The `orkestrator` client commands reach the backend only through the
`public_action` registry command (`apps/backend/src/core/public-api/`); the
contract lives in `packages/protocol/src/public-api*.ts` and the guide in
[`docs/architecture/public-cli.md`](docs/architecture/public-cli.md). When
touching it:

- **Admit before acting.** A mutation's request key is reserved and its
  operation record published (under the store lock) before any side effect.
  Same key + same intent replays; different intent conflicts. Never mint a new
  key to retry ambiguous work.
- **Never treat missing history as "never ran".** Retired namespaces answer
  `namespace-expired`/`history-expired`; a corrupted store refuses admission;
  capacity refuses new work instead of evicting records.
- **Completion is request-specific.** A run settles only on its own dispatch
  journal, observed turn activity and turn-outcome record. An idle environment
  or the agent's wording is not evidence; missing evidence stays `unknown`.
  Only providers listed as qualified in `public-api/providers.ts` may report
  completion.
- **Client commands never start a backend** and the launcher decides service
  versus client before importing `dist/main.js`. Keep `dist/client.js` free of
  backend imports. Add every new service flag to `apps/backend/src/server-flags.ts`.
- **Receipts and summaries are content-free.** No prompts, tokens, file
  contents or provider session IDs in receipts, summaries, manifests or logs.

## Key Files Reference

### Frontend

| File                                                     | Purpose                     |
| -------------------------------------------------------- | --------------------------- |
| `apps/web/src/components/terminal/TerminalContainer.tsx` | xterm.js integration        |
| `apps/web/src/components/native-agent/AgentNativeTab.tsx` | Shared Native Mode chat   |
| `apps/web/src/stores/agentModelCatalogStore.ts`          | Model catalogues per agent platform |
| `apps/web/src/stores/nativeAgentProjectionStore.ts`      | Native agent projections for every native platform (Claude, Codex, OpenCode, Cursor, Grok, Pi) |
| `apps/web/src/lib/native/backend.ts`                     | Native IPC command wrapper  |

### Claude bridge

`bridges/claude-bridge` drives the Claude Agent SDK and serves the shared HTTP
session surface. When touching the session catalogue
(`session-manager-catalog.ts`):

- **A control that is still set is not necessarily usable.**
  `session.queryControl` lives until the turn's `finally`, but the CLI's stdin
  closes earlier, at the result boundary. Every control request issued in that
  window races the process exit and is rejected with
  `Query closed before response received`. Reads go through `readableControl`,
  which skips a control marked `queryControlDraining`. `closeTurnInput()` in
  `session-manager-prompt-turn-lifecycle.ts` is the one place that sets the marker, so a new
  stdin-close site cannot forget it.
- **Reads fall back, writes conflict.** `isClosedTransportError` maps a dead
  transport onto the cached answer for `/commands` and `/mcp`, and onto 409 for
  `/config` — a settings change that never reached the CLI must not look like it
  succeeded. Every other error still propagates; do not widen that match.
- **The no-control fallback costs a process.** `createProbe()` spawns a whole
  Claude CLI, so `commandInventory` caches the catalogue the way `mcpInventory`
  already did. The backend re-reads both on every session projection
  (`native-agent-transcript-projection.ts`), so an uncached fallback is one spawn
  per turn boundary rather than a one-off.
- **Every SDK frame has a declared fate.** `HANDLED_SDK_MESSAGE_TYPES` and
  `SYSTEM_SUBTYPE_DISPOSITIONS` (`src/types/index.ts`) are `Record`s over the
  SDK's own unions, so an SDK bump that adds a message type or `system`
  subtype fails the typecheck until someone decides whether it is handled,
  kept as a health notice, or ignored as inventory. Content blocks the parser
  has no branch for are counted as `block:<type>` drift.
- **The native tab never sees SSE.** The backend polls `GET /session/:id` and
  the transcript routes; `session.updated` frames only reach the legacy web
  client. Turn-scoped state the tab must show (activity, thinking estimate,
  background tasks) has to be in that snapshot. A row derived from a record
  the rollout keeps (a task report, an interruption marker) must be produced
  by both the live loop and `normalizePersistedSessionMessages`, or a reload
  will disagree with the live tab.
- **`DELETE /session/:id` is destructive.** It calls the SDK's
  `deleteSession`, which removes the `{sessionId}.jsonl` rollout. Tab close
  uses `POST /session/:id/close` (`closeSessionRetainingHistory`), which stops
  the query and keeps the rollout; nothing may fall back from close to DELETE.
  Close answers 503 pending, keeping the session registered and fenced, when
  it cannot prove the query stopped (`Query.close()` threw or did not settle,
  or a racing dispatch claim did not settle).
- **`app.onError` is registered on purpose.** Hono's default handler passes the
  raw error to `console.error`, which under Bun prints a source-context dump of
  whichever minified vendor file threw, with no indication of which request
  produced it.

### Codex bridge

The bridge supervises one persistent `codex app-server --stdio` child per
environment and talks to it over JSON-RPC on private stdio. There is no second
engine and no feature flag: the per-turn `codex exec` path and the
`@openai/codex-sdk` dependency were both removed once app-server reached parity.
See [`docs/architecture/agent-engines.md`](docs/architecture/agent-engines.md).

Session titles are generated by the backend, not the bridge
(`apps/backend/src/core/session-title-service.ts`); see
[agent-engines.md](docs/architecture/agent-engines.md#session-titles).

| File                                                           | Purpose                                            |
| -------------------------------------------------------------- | -------------------------------------------------- |
| `bridges/codex-bridge/src/index.ts`                            | Routes, SSE, composition root                      |
| `bridges/codex-bridge/src/app-server-runtime.ts`               | Session surface for the app-server engine          |
| `bridges/codex-bridge/src/app-server-runtime-rows.ts`          | A turn's assistant rows: open, render, publish     |
| `bridges/codex-bridge/src/event-ring.ts`                       | Bounded SSE replay buffer + cursor parsing         |
| `bridges/codex-bridge/src/app-server/process-supervisor.ts`    | Child lifecycle, generations, restart policy       |
| `bridges/codex-bridge/src/app-server/jsonl-rpc-client.ts`      | Transport; must never await consumer work          |
| `bridges/codex-bridge/src/app-server/approvals.ts`             | Approval descriptors + per-method response mapping |
| `bridges/codex-bridge/src/app-server/server-request-router.ts` | Answers every server request, exactly once         |
| `bridges/codex-bridge/src/app-server/notification-recorder.ts` | Opt-in capture of the inbound stream for fixtures  |
| `bridges/codex-bridge/src/sessions/dispatch-journal.ts`        | At-most-once prompt dispatch                       |
| `bridges/codex-bridge/src/messages/normalization.ts`           | Item → normalized part rendering                   |
| `bridges/codex-bridge/src/messages/diff-budget.ts`             | Caps the diff state, the largest memory consumer   |
| `bridges/codex-bridge/src/codex-item-types.ts`                 | Local thread-item types (was the Codex SDK)        |
| `bridges/codex-bridge/src/testing/replay-recording.ts`         | Replays a recording through the real pipeline      |

When touching the app-server engine:

- Never let the stdout read loop await a render, an SSE write, or the browser —
  app-server's outbound queue is bounded, so that stalls **every** thread.
- Never auto-retry an ambiguous dispatch. Only an explicit `-32001` overload means
  the turn definitely did not run; anything else must reconcile via `thread/read`.
- Never report `idle` for `cancelling`/`recovering`. Both map to `running`, which
  is what stops the build pipeline advancing on a turn that may still be executing.
- Never call `thread/delete`. Closing a session unsubscribes; deleting would
  destroy the user's rollout and its descendants.
- Never let a metadata scan read whole rollout files. `getSessionMetaFromTranscriptPath`
  reads only the head; full reads are for hydrating one specific thread. A 1.6GB
  Codex home cost ~5.3GB of retained heap before this.
- Idle threads are detached (`thread/unsubscribe` + state freed) and re-attached
  transparently on the next request. Detaching an **unmaterialized** thread must
  clear its id: it has no rollout, so `thread/resume` would fail forever.
- Never rely on `thread/resume` to change a **loaded** thread's configuration.
  app-server rejoins it and ignores every override, `mcp_servers.*` included, so
  the thread keeps the previous attempt's workflow-result MCP credential.
  `reloadThread` unsubscribes first so the resume rebuilds it from its rollout;
  an unmaterialized thread is replaced instead. A result turn whose thread
  still does not list its submit tool is refused with 424 before journaling.
  Verified against codex 0.158.0.
- Never poll a tab-facing route from a background reconciler. `/session/:id` and
  `/session/:id/status` are liveness touches — the codex bridge refreshes
  `lastAccessed` (which is what `detachableThreads` reads) and the claude bridge
  additionally hydrates the transcript. The backend's activity sweep runs every
  two seconds for every persisted session, so polling those would put idle
  detaching and transcript eviction permanently out of reach. Both bridges
  expose `GET /session/:id/activity` for exactly this: no touch, no hydration,
  no re-attach. Anything else the backend wants to poll needs the same
  treatment.
- `/session/:id/activity` answers an unknown session **in band** as
  `{"activity":"missing"}` and never 404s. The backend reads a 404 there as "this
  bridge predates the route" and fails the environment; if 404 also meant "session
  gone" it would delete a live session mapping against an older bridge. For the
  same reason the claude bridge answers a failed existence probe `idle`, never
  `missing` — an error is not evidence of deletion. Every HTTP bridge's
  `POST /sessions/activity` batch route answers each id from the exact same
  no-touch read (never omitting one: an unreadable id is `unavailable`), and
  only a 404/405 on that route means "older bridge".
- `GET /session/:id/dispatch?requestId=` answers `dispatched` **only** on an
  explicit positive from that bridge's own dispatch journal, `lost` only for a
  record an earlier process left without an outcome, and `absent` only while
  the session's journal is complete and holds no record of the id
  ([`bridges/AGENTS.md`](bridges/AGENTS.md) has the rules). No record in an
  incomplete journal, an unreadable journal and a missing route are all
  `unknown`. The backend re-sends a recovered request under the same id on
  `absent` alone, so reporting a *lost* record as "never sent" would have it
  run the same turn twice. Like `/activity`, it must never touch liveness,
  hydrate or re-attach.
- Prompt dispatch and `POST /session/:id/attach` share the same client timeout,
  because they do the same work. A bridge with no attached agent process pays a
  full spawn plus `initialize` plus `session/load` on whichever request arrives
  first; budgeting the prompt at the 30s default aborted cold dispatches
  mid-flight and reported them to the user as unresolvable. Attach exists to
  move that cost *outside* the at-most-once window, where a failure is
  unambiguous — nothing journaled, no prompt written. It must never dispatch a
  turn, and callers must treat it as best-effort: the prompt request performs
  the same work and is the one that answers authoritatively.
- A parked dispatch blocks its whole session, not just the prompt that created
  it: storage refuses every other request id until it is settled. Surface both
  ways out — retry under the same idempotency key, or discard — rather than the
  storage-level refusal, which names an invariant the user cannot act on.
- Agent version bumps follow [`docs/development/upgrade-agents.md`](docs/development/upgrade-agents.md);
  the generated protocol under `app-server/generated/` is a lockfile.
- Never resolve an approval to "approved" by default. Every timeout, disconnect,
  generation death and unparseable answer denies. Approving on a technicality would
  run a command the user never saw.
- Never offer or send an exec-policy or network-policy amendment. Codex writes
  an accepted one into `CODEX_HOME/rules/` for every later session on the host,
  and app-server has no method to list or remove it.
- Never answer an approval belonging to a **dead generation**. app-server has
  forgotten the request; withdraw the card and say so in the transcript instead
  (`abandonGeneration`). Conversely a *live* child must always be answered —
  closing a session declines on the way out rather than just forgetting.
- Never let the fast server-request backstop fire on a parked approval. It exists
  for a branch that failed to answer; a request awaiting a human has legitimately
  not answered yet, and answering there resolves a prompt the user is reading.
- Never treat an approval as visible just because the SSE frame was emitted. The
  tab may have been unmounted; `/session/:id/approvals` is the authoritative
  rehydration path and reconcile must call it.
- SSE frames carry `id: <revision>`. The `connected` frame must echo the
  **client's own cursor**, not the latest revision: a browser EventSource adopts
  every id it sees, so anchoring at the latest would permanently skip the frames it
  just asked to be replayed if the socket died mid-handshake.
- Subscribe *before* computing an SSE replay, buffering into an array, then flush
  past the replayed range. Replaying first and subscribing second drops anything
  emitted in between — the exact gap the cursor exists to close.
- Recordings (`CODEX_BRIDGE_RECORD_NOTIFICATIONS`, armed by
  `CODEX_BRIDGE_RECORD_CONFIRM=1`) contain prompts, file contents and absolute
  paths. Always run `scripts/scrub-codex-recording.ts` and read the diff before
  committing one as a fixture; a test scrubs the fixtures directory and fails on
  any hit, but the scrubber only catches secrets and identity — it does not
  redact prompt or file content unless you pass `--strip-content`. The recorder
  itself must stay O(1) in the read loop — buffer and flush off-loop, never await
  a write.

### Pi bridge

`bridges/pi-bridge` drives Pi's own TypeScript SDK
(`@earendil-works/pi-coding-agent`) in process and serves the same HTTP routes
and the same transcript shape as every other bridge, so the backend, the store
and the renderer cannot tell which engine is behind a session.

Pi differs from the other platforms in one way that matters, and it is confined
to two files. Pi is a *harness*, not a vendor: it fronts fifteen-odd model
providers using the user's own credentials. So a model is identified by a pair
rather than a name, and "signed in" is one answer per provider.

- `models.ts` encodes the pair as `provider/modelId`, split on the **first**
  slash only — an OpenRouter id contains its own. This is the same encoding
  OpenCode already uses, so one convention covers both pickers.
- The reasoning axis is Pi's **thinking level**, and the supported set per model
  comes from Pi's own `getSupportedThinkingLevels` rather than being derived
  from `thinkingLevelMap` here. The rule is not the obvious one: a `null`
  mapping excludes a level, but `xhigh` and `max` additionally require an
  *explicit* mapping, so an absent key excludes those two and includes every
  other. Getting that wrong offers controls the model then clamps away, and a
  clamped turn succeeds — it simply thinks less than the user asked. `off` is a
  real level, not an absence; the shared `default` id has no Pi equivalent.
- A fresh session's level is resolved the way Pi resolves it — per-model
  setting, then global default, then `medium` — reading the same
  `settings.json` that `/thinking` writes, so one preference serves both the
  model picker and a Pi terminal tab. `thinking_level_changed` is echoed back
  into the composer so the picker shows the level actually in force after Pi
  clamps it.
- A session with no explicit model starts on Pi's saved default
  (`defaultProvider`/`defaultModel`, what `/model` writes) when a signed-in
  provider serves it, then on `PI_BRIDGE_DEFAULT_MODEL`, then on the
  last resort from `lastResortModelId` in `models.ts` (`defaultModelIds` in
  `agent-session.ts` supplies the preferences). The last resort is the
  catalogue's first model, except when its provider uses a ChatGPT subscription
  login (`openai` with OAuth since Pi 1.2.0, or legacy `openai-codex`). Then
  it is the newest model in pi-ai's ChatGPT-backend catalogue (the
  `openai-codex` provider's built-in list) that the login offers: the login
  can refuse other models its provider lists. `models.test.ts` pins this
  premise against the real SDK; recheck it on every Pi bump. Project settings
  count only when the session trusts the project.
- Tests run with `src/testing/test-isolation.ts` preloaded (`test:bridge`). It points
  `PI_CODING_AGENT_DIR` at a temporary directory, so no test reads the
  developer's saved default or writes `auth.json`/`models-store.json` into
  their `~/.pi/agent`. A focused `bun test` outside `test:bridge` should add
  `--preload ./src/testing/test-isolation.ts` or isolate its own directory.
- `credentials.ts` reports per-provider status and deliberately implements no
  sign-in. Pi's login is an interactive multi-step prompt flow with no
  counterpart in Orkestrator's session surface, and the credential it writes is
  account-wide rather than per-environment. Users sign in with `/login` in a Pi
  terminal tab or by writing `auth.json`; containers are handed the resulting
  directory as a bind mount.

When touching the Pi bridge:

- The engine boundary is `src/translate.ts` and `src/tool-rendering.ts`. Every
  Pi-specific shape stops there; nothing downstream should learn a new field to
  render a Pi turn.
- `applySessionEvent` never awaits. It runs on the SDK's own listener, so an
  await there would let a large transcript back-pressure a live run.
- A tool variant Pi adds — or a custom tool from a project extension, whose
  shape this bridge cannot know at all — must degrade to a plain card, never
  throw. These branches run mid-turn.
- The conversation lives in Pi's own JSONL session file, not in this bridge.
  Losing the bridge's state costs a rendered transcript; it never costs the
  conversation. That is why `detachSession` keeps `sessionFile` and why a
  restart re-attaches to the same session rather than starting a new one.
- Approvals follow the session's execution policy: `ask` parks a call, `deny`
  refuses it, and a session with no policy runs as the host default,
  `auto-approve`. When the gate asks, every timeout,
  disconnect, closing session and unparseable answer **denies**. A turn that
  ends with a call still parked denies it too — leaving it unanswered wedges the
  turn and, with it, the environment's activity state.
- A prompt claims a process-local token (`promptClaim`) synchronously at route
  entry, before its body is read, when nothing else owns the session; an
  unused reservation (validation error, duplicate, local answer, busy refusal)
  is released with its own cancel record only. A cancel that arrives before Pi
  has produced a cancel handle is parked against that claim and answered 202
  `{ cancelled: false, pending: true }`, never `cancelled`; so is a provider
  abort that hangs or rejects (the next request retries it). The prompt route
  checks for it after every preparation await and settles without calling Pi.
  In Pi's preflight the cancel calls `session.abort()` at once (pinned SDK
  1.2 aborts an auto-compaction and pre-empts a run `_startRun` is preparing;
  that abort waits for the run to settle, so it is never awaited) and again
  when Pi accepts, because `_startRun` resets the abort flag when it begins.
  A run Pi reports settled with `aborted: true` — whoever aborted it,
  including an extension — ends the turn cancelled (idle, structured result
  `interrupted`), never completed. Acceptance is bounded by
  `PI_BRIDGE_STARTUP_TIMEOUT_MS` (default 5 min, floor 30 s): past it the route
  answers 424 with an explicit error, but the claim and `dispatching` are kept
  until Pi settles the prompt — a late acceptance is aborted and observed — so
  every status route reports running while something can still reach Pi.
  Config and compaction take no claim, so a cancel during them cannot stop a
  later prompt. Close and DELETE mark the session closed before their first
  await: new prompts get 409, one still preparing settles as cancelled, and
  `/close` keeps the session registered until its removal is published (503
  pending otherwise).
- Project-local `.pi/` resources load only when the session's execution
  policy turns `projectResources` on, on both host and container runs. Host
  project resources are off by default. Enabling them permits repository MCP processes and Pi extensions
  (arbitrary TypeScript) to run on the host.
- Pi's SDK sessions load no MCP client (only its CLI loads the built-in `mcp`
  extension) and have no plan/build mode. The bridge owns an MCP client (`src/mcp.ts`) and registers tools through the inline
  `orkestrator-mcp` extension: Orkestrator from env / per-tab `agentMcp`,
  user servers from `~/.pi/agent/mcp.json`, and project `.pi/mcp.json` only
  when the execution policy opts into project resources. A session records
  a fingerprint of the MCP files it was built from and rebuilds at the next
  turn start when they change (never mid-turn), which is how saved edits from
  the MCP servers settings reach a live session. Settings-pane
  discovery still reports an empty MCP list (pre-session fallback). The
  composer reports `mode: false` because plan/build is still something an
  extension adds. `agentMailCapabilities("agent-native", "pi")` is on;
  terminal `pi` stays off.
- The SDK and the pinned `pi` binary are the same program, so they are pinned to
  the same version and `tests/unit/version-drift.test.ts` enforces it — a bump
  that moves one and not the other gives a user two different agents behind one
  platform name.

### Cursor bridge

`bridges/cursor-bridge` is the only Cursor engine. It drives Cursor's TypeScript
SDK (`@cursor/sdk`) in process and serves the shared HTTP session surface on
container port 4099. Cursor has no managed CLI or terminal mode; the ACP bridge
is Grok-only.

When touching the SDK bridge:

- The engine boundary is `src/translate.ts` and `src/tool-rendering.ts`. Every
  Cursor-specific shape stops there; nothing downstream should learn a new
  field to render a Cursor turn.
- `applyInteractionUpdate` never awaits. It runs on the SDK's own callback, so
  an await there would let a large transcript back-pressure a live run. It also
  enforces the display budget itself (`boundTranscriptDuringStreaming`) after
  every top-level update — an inactive tab issues no reads, so a bound that
  waited for one would never run. Charge appended bytes as encoded upper bounds
  and name new parts with `nextPartOrdinal`, never `parts.length`.
- A tool variant the SDK adds must degrade to a plain card, never throw. The
  SDK is a fast-moving dependency and these branches run mid-turn.
- Sign-in runs the bridge's own `--login` mode as a short-lived child. Keeping
  `@cursor/sdk` out of the backend is deliberate: it is a five-megabyte bundle
  with native helpers, and a login needs no environment and no session.
- The credential lives in Orkestrator's data directory, not the SDK's default
  `~/.cursor/sdk/auth.json`, so a container can be handed exactly one file.
- Project settings (`.cursor/`) load only when the resolved environment
  execution policy enables project resources, on both host and container runs.
  Host project resources are off by default; enabling them permits repository
  configuration to start MCP processes on the host.
- The Orkestrator Agent MCP server is injected from a per-tab `agentMcp`
  body or, as fallback, `ORKESTRATOR_AGENT_MCP_URL` /
  `ORKESTRATOR_AGENT_MCP_TOKEN` as `AgentOptions.mcpServers.orkestrator`
  (`src/mcp.ts`). A repo's `.cursor/mcp.json` loads on the host only when
  the resolved environment policy enables project resources.
  Native Cursor mail is on (`{canPull,canSend,canInject}=true`). A rotated
  tab token detaches and re-attaches the SDK agent; the bearer is never
  persisted.
- The host launcher spawns the bridge in its own package directory, never in
  the worktree. `bun` reads `bunfig.toml` — `preload` included — and `.env`
  from its working directory before the entrypoint runs, so spawning there
  hands a cloned repository arbitrary code execution inside a process holding
  the credential path, the bridge token and the agent MCP token. The SDK's
  Shell tool does default to `process.cwd()`, but the bridge enters the
  workspace itself afterwards (`applyWorkingDirectory` in `config.ts`, called
  at module load and again from `start()`), which is why `index.ts` exports
  `./config.js` before anything that loads `@cursor/sdk`.
- Permanent close (`DELETE /session/:id` and `POST /session/:id/close`, which
  are the same non-destructive operation here) lives in `src/session-close.ts`.
  It sets `state.closed` before its first await, and every admission path —
  prompt, attach, config, steer, same-key create, resume — refuses a closed
  session. A late attach is disposed instead of installed, and a late
  `agent.send` result is cancelled and followed. The close answers 503
  `pending` until owned work has actually stopped, and it publishes the
  removal before it answers success. Idle detach (`detachAgent`) is not a
  close and never sets the marker. A method the bridge does not serve on a
  session it *does* have answers 405, so a real gap cannot hide as a missing
  session. A close a previous process recorded but did not finish (a restored
  tombstone) is finished by `src/session-tombstones.ts`, and resuming the same
  conversation waits for it first.
- `persistBarrier()` is a mandatory publication: it rejects when nothing
  reached disk, and prompt/steer dispatch, create, resume and identity-changing
  attach all wait for it. `schedulePersist()` is best-effort. Both share one
  serialized queue, so never write the state file directly. When the
  aggregate state outgrows `MAX_STATE_FILE_BYTES`, persisted transcript copies
  are cut to their newest whole messages, oldest-touched sessions first
  (`src/persistence-budget.ts`). If the recovery metadata alone does not fit,
  the publication fails with a typed error rather than being skipped. Each
  write uses a unique temporary file, flushed before the rename, and the
  directory is flushed after it: process-crash durable everywhere, power-loss
  durable on Linux.
- The steer journal is bounded by count and bytes (`src/steer-journal.ts`).
  Records that could still be retried against the running turn are never
  evicted. A new steer that does not fit is refused with 429
  `{ outcome: "rejected" }` before anything is journaled or sent. Do not
  replace this with a FIFO: an evicted record would turn an exact retry into
  a second delivery.
- Never compress a response the client did not ask for. `json` reads
  `Accept-Encoding` once per request; this repository already has a hop that
  asks for `identity` on purpose. Compression defers the write past the
  caller's return, so every write also has to survive a socket that is already
  gone.
- Giving up on a turn is not the same as the run stopping. Anything that fails
  a turn without the run acknowledging it — the prompt timeout above all — has
  to cancel that run, or it keeps writing to the workspace while `/activity`
  answers idle and `cancelTurn` has already been cleared.
- A cancel that arrives before `agent.send` resolves has no run to act on. It
  parks against the sequence of the turn it meant to stop and is honoured the
  moment the handle exists; answering it as `cancelled` would tell the user a
  turn stopped while it carried on.
- Every bridge that builds has to be listed in the root `package.json`'s
  `build.extraResources`. `getBridgePath` falls back to `resourceRoot/<name>`
  outside development and fails only at the moment a user selects it, while
  containers carry on working from `/opt/<name>`.
  `tests/unit/bridge-packaging.test.ts` enumerates them so the next one cannot
  be forgotten.

A background sub-agent is settled when its parent run ends. The SDK reports
children only through nested updates on that run, so once it is over there is
no channel left to observe them on — the card says the child was detached
rather than claiming it completed, because holding it active would report the
environment as permanently busy. The same applies across a restart: the live
child registry is deliberately not persisted, so a card restored at `active`
would spin forever with nothing left that could settle it, and `loadPersistedState`
closes those out on the way in.

### Tab close and conversation retention

Closing a tab retains the conversation on every platform. Every managed bridge
(Claude, Codex, Cursor, Grok/ACP, Pi) serves `POST /session/:id/close`; backend
tab teardown and `HttpBridgeProvider.closeSession` both go through
`closeBridgeSessionRetaining` (`apps/backend/src/core/bridge-session-close.ts`).
When touching any of them:

- **Close is non-destructive.** It stops owned work, denies parked approvals,
  questions and plan approvals, settles dispatch claims, and releases the
  bridge's live mapping. It never deletes vendor history: no Claude SDK
  `deleteSession`, no Codex `thread/delete`, no OpenCode
  `client.session.delete`.
- **Only a 2xx that affirms `closed: true` is a confirmed close.** 200
  `{ closed: true, retained: true }` or `{ closed: true, missing: true }`.
  Anything else, including an empty or malformed 2xx, is not a close.
- **An unknown session is answered in band, never 404.** 200
  `{ closed: true, missing: true }`. A 404/405 from the close route means the
  bridge predates it; it is never evidence that the session is gone.
- **503 `{ closed: false, pending: true, error }` keeps everything.** The
  bridge keeps the session registered (and refuses new work on it); the
  backend keeps its durable teardown intent and the tab mapping, and the
  periodic reconcile sweep retries. Errors are fixed, content-free strings.
- **Legacy fallback is per bridge.** On 404/405 the backend may send the old
  `DELETE /session/:id` only where `LEGACY_DELETE_RETAINS_HISTORY` is `true`
  (Codex, Cursor, Grok, Pi). **Never for Claude**, whose DELETE deletes the
  rollout: that teardown stays pending with a `bridge-upgrade-required`
  failure the renderer shows as a restart notice. Do not add a platform to
  that table without evidence from every released version of its DELETE.
- **The last owner closes.** Two tabs can map to one provider session. Backend
  teardown is serialized per (environment, agent, provider session) and only
  the tab that finds no other mapping performs the provider close.
- **Transcript v2 reads share one source and answer in band.** Every HTTP
  bridge serves `GET /session/:id/transcript?version=2` (summaries with detail
  locators, `@orkestrator/protocol/node/bridge-transcript-summary`) plus
  `/transcript/detail` and `/transcript/page`, all built from one per-bridge
  read source via `bridge-transcript-routes`. Detail/page answer an unknown
  session 200 `missing`/`expired`, never 404; absent `version` stays v1.
  The summary route's 404 must mean the session does not exist: load a
  persisted session that is not resident before answering, as `/messages`
  does (Claude materializes it). Older Claude bridges did not, which is why
  the backend's `/messages` fallback stays until the support window passes
  them ([version-compatibility.md](docs/architecture/version-compatibility.md#register)).

### Native slash commands

The contract is [`docs/architecture/native-agent-commands.md`](docs/architecture/native-agent-commands.md).
When touching command discovery or dispatch:

- **Never seed or guess rows.** A catalogue lists only what the provider
  reported and what its executor can run. A successful empty list stays
  empty; a failed read is `stale` or `unavailable`, never `ready: []`.
- **A selected command never becomes a prompt.** Removed, changed, forged or
  unverifiable selections are refused before journaling (bridges answer 422
  `command-unavailable`). Retries and queued items carry the resolved intent.
- **Private bindings stay private.** Skill paths, template bodies and
  provider command defaults never appear in a public descriptor.
- **Catalogue reads are metadata.** They must not touch `lastAccessed`,
  hydrate a transcript or re-attach an idle session; push freshness rides on
  `commandRevision` in the snapshot the backend already reads.

### Coordinator qualification

`apps/backend/src/core/coordinator-providers.ts` is the single table deciding
which platforms may run a coordinator, and at which tier. Every gate consults
it: the workspace service, the runtime resolver, the bridge launcher and the
trusted session input. Do not reintroduce a platform literal at any of those
call sites — that is what previously let a platform be half-qualified, allowed
to hold a conversation but refused a bridge.

Moving a platform to `enforced` is a claim that the provider or the OS blocks
the mutation whatever the agent attempts. It requires both:

- a translation of `capabilityPolicy` into that provider's own vocabulary, in
  the bridge, applied on create, resume, config and every turn; and
- `ORKESTRATOR_BRIDGE_EXECUTION_POLICY=coordinator-read-only` honoured as
  process authority, so a request body or a persisted record cannot widen a
  live conversation across a restart.

`toolPolicy` cannot carry that translation. Its strings are Codex's tool names
and it is also the user-editable override surface, so the same list means
"Write, Edit" on one bridge and nothing at all on another. Use
`capabilityPolicy`, which names the operation rather than the tool.

Where a platform cannot honour an axis, report it in the policy's `note` and
leave the tier at `provider-configured`. Do not silently drop the axis, and do
not claim a boundary the bridge is not holding — the tier is shown to the user
next to the platform they are choosing.

`delegation` is derived, not declared per platform. It is an MCP client *and* an
injectable native mailbox, because `launch_environment` goes out over MCP while
the worker's reply comes back as agent mail. Native Claude, Codex, OpenCode,
Pi, Cursor, and Grok all have both. Cursor and Grok consume per-tab
`agentMcp` the same way Claude and Pi do; the process-env token is only the
fallback. Deriving delegation from the outbound half alone is what would
let the coordinator prompt promise workers whose mailbox cannot receive the
answer.

### Coordinator shell allowlist

`bridges/claude-bridge/src/services/read-only-policy.ts` holds the read-only
boundary for shell, because no tool-name rule can separate `git log` from
`git commit` — which is why `capabilityPolicy`'s `shell.mutate` maps to no tool
names at all. Three invariants keep it honest:

- **The command checked must be the command that runs.** `COMPOSITION_PATTERN`
  refuses anything that can become several commands, and a newline counts: the
  shell treats it exactly as `;` does, while a whitespace split would reduce
  `ls\nrm -rf .` to a harmless-looking `ls`.
- **The program name is not the whole command.** A program that launches another
  program does not belong in `READ_ONLY_COMMANDS` whatever it is called — `env`
  is absent for that reason, and a path (`bin/cat`) names whatever the checkout
  put there, so programs run by bare name only. Where a reading tool has a
  writing flag, name it in `MUTATING_ARGUMENTS` (`find -delete`, `sort -o`,
  `yq -i`) rather than dropping the tool; a one-letter flag there also matches
  inside a cluster or with its value attached (`-no out`, `-oout`). A tool that
  writes a positional (`uniq in out`) belongs in `POSITIONAL_LIMITS`, and one
  with too many writing options to list (gawk) in `OPTION_ALLOWLISTS`. Git
  subcommands whose effect depends on their arguments belong in
  `CONDITIONAL_GIT_SUBCOMMANDS`, not the flat read-only set: `branch`, `tag`,
  `remote` and `config` all read in one form and write in another.
- **Assume no sandbox behind it.** The SDK sandbox lets a command write its
  working directory, which for a coordinator is the user's checkout, so
  `claudeReadOnlySandbox` denies writes there (`filesystem.denyWrite`). Where
  the sandbox cannot run commands at all (Windows; Linux without bubblewrap
  and socat, or whose bubblewrap cannot nest the CLI's user namespace; the
  launcher says so in `ORKESTRATOR_COORDINATOR_COMMAND_SANDBOX`) it is left
  off and this allowlist is the whole boundary. A command it admits must neither write
  nor reach the network on its own, which is why `gh`, `curl` and
  `git ls-remote` are refused rather than left to the sandbox.

### Backend

| File                                   | Purpose                                                  |
| -------------------------------------- | -------------------------------------------------------- |
| `apps/backend/src/core/commands.ts`    | Backend command registry and Docker/local env management |
| `apps/backend/src/core/tmux.ts`        | Claude tmux mode backend                                 |
| `apps/backend/src/core/storage.ts`     | `StorageService` (SQLite-backed; see `docs/architecture/storage.md`) |
| `apps/desktop/electron/ipc.ts`         | Main-process IPC handlers                                |
| `apps/desktop/electron/preload-api.ts` | Renderer-facing native API                               |

Desktop `BrowserWindow` preloads are bundled as ESM, so the main window and
toolchain bootstrap windows keep `sandbox: false`. Sandboxed Chromium evaluates
preloads as CommonJS and cannot load `import` from `electron`. Browser preview
views stay sandboxed.

### Docker

| File                           | Purpose                                                  |
| ------------------------------ | -------------------------------------------------------- |
| `docker/Dockerfile`            | Base image definition                                    |
| `docker/entrypoint.sh`         | Container entrypoint                                     |
| `docker/workspace-setup.sh`    | Repo clone, `.env` files, project config, shown in terminal |
| `docker/init-firewall.sh`      | Network firewall rules applied at startup                |
| `docker/orkestrator-egress-gateway.sh` | Entrypoint of a restricted runtime's egress gateway |
| `docker/update-firewall.sh`    | Operator-only allowlist edits via `docker exec --user root` |
| `docker/runtime-env.sh`        | PATH/env snapshot so `docker exec` sees setup-time tools |
| `docker/git-branch-helpers.sh` | Makes a bare `git push` publish and track the branch     |
| `docker/verify-playwright.cjs` | Launches Chromium; run at build time and on demand        |

## Docker Base Image

The image is built from `oven/bun:1.4.4-debian`, pinned by its multi-architecture
index digest on both stages, matching the Bun version managed in `mise.toml`
for development and CI. Refresh the digest deliberately (`docker buildx
imagetools inspect oven/bun:<tag>`) for a Bun bump or a base security update;
`mise run docker:check-base` reports when the tag has moved past the pin.
`tests/unit/version-drift.test.ts` requires both `FROM` lines to agree. After
any image change, `bash docker/tests/final-image-smoke.sh <image>` runs the
built image (CI runs it on both architectures). Every
agent CLI version below is pinned by an `ARG` in `docker/Dockerfile`, which is
its container source of truth.

The bridges are built in a separate `bridge-build` stage (manifests and
patches first, then a `--frozen-lockfile` filtered install, then sources), and
the delivered image receives only each bridge's runtime directory. Do not move
bridge builds back into the final stage: the workspace install and build
layers would ship in the image's history even when deleted later.

Runtimes:
- Bun, installed in mise's shared system tool directory. The matching base-image
  runtime bootstraps the image build before mise is installed.
- Node.js 24 LTS, installed over the base image and verified against the
  published checksum. The agent CLIs need genuine Node, not bun's node shim.

Agent CLIs, one per supported platform:
- Claude Code (`claude`), Codex (`codex`), OpenCode (`opencode`), and Pi
  (`pi`), whose runtime paths the backend reads from `CLAUDE_CLI_PATH`,
  `CODEX_CLI_PATH`, `OPENCODE_CLI_PATH`, and `PI_CLI_PATH`.
- Grok Build (`grok`) is downloaded as a hash-verified pinned artifact. Pi is
  downloaded the same way, as a bundle rather than a single file.
- The image build fails immediately if any managed CLI is not runnable, and if
  Codex did not vendor `codex-code-mode-host` beside its binary.

Prebuilt bridge servers, so a container never builds them at runtime:
- `/opt/claude-bridge`, `/opt/codex-bridge`, `/opt/cursor-bridge`,
  `/opt/pi-bridge`, and `/opt/acp-bridge` (used only by Grok Build).

Developer tooling:
- Git, GitHub CLI (`gh`), git-delta, and SSH with GitHub/GitLab/Bitbucket host
  keys already known.
- `mise`, installed from a pinned, checksum-verified release. `/workspace` is a
  trusted mise config path because repository setup already runs inside the
  container boundary. The `node` user's interactive zsh loads the hook, and
  backend-launched processes promote mise shims through the shared runtime-env
  helper; root terminals have the CLI but do not load the interactive hook.
- Playwright CLI plus its pinned Chromium build (see below).
- ripgrep, fzf, jq, tmux, nano, vim, less, curl, wget, and `en_US.UTF-8`.

Users and isolation:
- Non-root `node` user (uid/gid 1000, matching the workspace bind mount), with
  Zsh and a pinned, checksum-verified Starship prompt. The image installs the
  shared hook through `/etc/zsh/zshrc`, reads prompt configuration from
  `/etc/starship.toml` through `STARSHIP_CONFIG`, and retains repository-owned
  Git aliases plus native Zsh completion without Oh My Zsh.
- `orkroot`, a uid-0 user for root terminal sessions. The backend opens those
  terminals with `docker exec --user orkroot`; `node` has no sudoers path to
  become `orkroot`.
- Network firewall (iptables/ipset) for security isolation. `node` has
  passwordless sudo for exactly two things: the image entrypoint
  (`/usr/local/bin/network-policy-entrypoint.sh`, which records the network
  policy once, root-owned, runs the firewall step as root and only then drops
  to `node`) and `/usr/local/bin/run-root-setup.sh` (only when the recorded
  mode is `full`). There is no grant for `init-firewall.sh`. The container
  boundary, not a reusable root shell, is what isolates an agent. Runtime
  allowlist edits use `docker exec --user root /usr/local/bin/update-firewall.sh`
  in the container that owns the network namespace: the runtime's egress
  gateway when it has one.
- `/usr/local/bin/orkestrator-egress-gateway` is the entrypoint of a restricted
  runtime's egress gateway: the same image, run as root with `NET_ADMIN` and a
  tmpfs `/run`, records the policy (`network-policy-entrypoint.sh
  --record-only`), applies the unchanged `init-firewall.sh` and idles. The
  runtime joins its namespace with no added capability; the runtime's root
  entrypoint then only verifies that the gateway rejects an unlisted
  destination (`egress-unverified` / `egress-gateway-unavailable` boot
  failures otherwise).

### Playwright

The image installs `playwright` globally and pre-downloads its Chromium build to
the shared `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, because the restricted
network firewall does not reach Playwright's CDN by default — a container that
had to run `playwright install` itself would fail.

A default `chromium.launch()` works as-is for both the `node` user and the uid-0
root terminal user. The image build proves it by running
`docker/verify-playwright.cjs` once as each of those identities — Chromium
refuses to start as uid 0 without `--no-sandbox`, so the root path is a separate
claim and is not inferred from the `node` one. The same script stays in the image
at `/usr/local/share/verify-playwright.cjs`, so a container can answer "does
Playwright work here?" without reconstructing it:

```bash
NODE_PATH=/usr/local/share/npm-global/lib/node_modules \
  node /usr/local/share/verify-playwright.cjs
```

Three constraints apply:

- Do not set `chromiumSandbox: true`. Playwright defaults it to `false`, which is
  what makes this work: containers get neither `CAP_SYS_ADMIN` nor unprivileged
  user namespaces, so enabling Chromium's own sandbox fails with "Chromium
  sandboxing failed!". The container is the isolation boundary.
- Containers are created with `--shm-size=1g`
  (`apps/backend/src/core/commands-containers.ts`), because Chromium keeps
  renderer shared memory in `/dev/shm` and Docker's 64MB default is far below
  what a real page needs. That failure surfaces as a renderer crash part-way
  through a run ("Target page, context or browser has been closed"), not as a
  launch error, so it is invisible to a trivial smoke page. `--ipc=host` is the
  other documented fix and is deliberately not used: it shares the host IPC
  namespace and weakens the container boundary.
- A project that pins a different Playwright version resolves a different
  Chromium revision and has to download it. `cdn.playwright.dev` is in the
  default allowlist for that case, but keeping the project on the image's pinned
  version avoids the download entirely. `tests/unit/version-drift.test.ts` pins
  the image's `PLAYWRIGHT_VERSION` to the minor `bun.lock` actually resolves, so
  the repo's own harness never drifts into that download.

Branded Google Chrome (`channel: "chrome"`) is deliberately absent: Google
publishes no linux/arm64 package, so installing it would break the image build
on Apple Silicon.

### Environment storage and lifecycle

New runtimes of a capable image keep `/workspace` and the provider session
paths in `PROVIDER_STATE_LAYOUT` on two owner-labelled volumes; credentials and
configuration stay in the container layer, staged per environment from the
entrypoint's allowlist. Every container mutation is a durable lifecycle
operation (`container-lifecycle-service.ts`). A preserving rebuild copies and
verifies into a new storage set before one commit write; earlier runtimes and
sets become recovery copies that only the user or environment deletion
removes. Never add a code path that removes an environment's container or
volumes outside those operations, and never prune by owner, age or state.
The living reference is
[`docs/architecture/container-lifecycle.md`](docs/architecture/container-lifecycle.md).

### Network Isolation

Containers in `restricted` mode (the default) reach only an allowlist; anything
else is rejected outright. `full` mode skips the firewall entirely.

- GitHub's own published ranges are always allowed: from the backend's hourly
  seed (`github-ranges-cache.ts`) when it is under a day old, else a live
  fetch of `api.github.com/meta`, else a cached copy under a week old; with
  none the firewall fails closed.
- Everything else comes from the environment's `ALLOWED_DOMAINS`, which the
  backend builds from the per-environment or global `allowedDomains` plus the
  hosts the enabled agent platforms require (`requiredAgentNetworkDomains`
  re-adds Codex's (`chatgpt.com`, `auth.openai.com`, for ChatGPT sign-in),
  Cursor's, OpenCode's (`opencode.ai`, its own Zen and Go providers), Grok's
  and Pi's hosts only when those platforms are enabled). Pi's list is necessarily partial: it fronts the user's own model
  providers, so a self-hosted endpoint or a regional mirror is a host only the
  user knows and belongs in `allowedDomains` rather than being guessed at.
- A new install persists `DEFAULT_ALLOWED_DOMAINS`
  (`packages/protocol/src/network-allowlist.ts`): GitHub, npm, Bun, the
  Anthropic API, Sentry/Statsig, the VS Code marketplace, Context7, and
  Playwright's CDN. It is the only default list. The renderer seeds its
  unloaded config from the same constant, and the firewall's fallback for a
  container with no `ALLOWED_DOMAINS`, `docker/default-allowed-domains`, is
  generated from it plus every platform's required hosts
  (`bun scripts/generate-default-allowed-domains.ts`).
  `tests/unit/version-drift.test.ts` fails when the committed file is stale or
  a copy of the list reappears elsewhere. A stored user list is never widened
  to match the defaults.
- DNS (to Docker's resolvers and the upstreams its embedded resolver names)
  and localhost are always allowed. There is no general outbound SSH
  exception: SSH reaches GitHub's published ranges and, under policy 3, only
  hosts whose entry names port 22 (under earlier policies, any allowed
  address).
- A container created from an image with `network-policy=3` allows address,
  protocol and port tuples (`@orkestrator/protocol/network-allowlist`,
  `docker/firewall-domains.sh`): a bare domain is reachable on TCP 443 only,
  an entry such as `db.example.com:5432` (TCP) or `example.com:443/udp`
  opens exactly that port, and GitHub's ranges are open on TCP 443 and 22.
  A container on an earlier policy receives each entry's domain without its
  port and still accepts any traffic to an allowed address; it changes only
  when rebuilt on a policy 3 image, after which a saved list that
  relied on another port needs a `host:port` entry. The environment's network
  status says which applies. `ORKESTRATOR_NETWORK_POLICY=2` keeps new
  containers on policy 2.
- The list is of addresses, not names: a domain on a shared CDN address also
  opens the same ports to every other site served from that address. An empty
  allowlist means nothing beyond GitHub (`ALLOWED_DOMAINS=none`); an
  environment whose own list is empty uses the global list.
- Host access depends on the container's network policy. A container created
  from an image with `network-policy=2` or later runs on its own labelled Docker
  network with IPv6 disabled; it may reach the host only on the backend's
  agent-tools port (kept current by `update-firewall.sh --host-ports`) and
  accepts inbound connections only on its published ports. Older containers
  (policy 1, default bridge) still allow the whole gateway `/24`, which
  includes sibling containers, until they are rebuilt.
- Images with `network-refresh=1` keep the allowlist current in place:
  resolved addresses expire six hours after their domain last returned them,
  a root refresher re-resolves on the record TTL, and saving an environment's
  domains applies them to the running container (`update-firewall.sh
  --set-domains`), swapping the set atomically, revoking open connections to
  removed addresses (under policy 3, to removed ports) and storing the list
  for the next boot. Keep that state in
  root-only `/run/orkestrator-firewall/`; node owns `/run/orkestrator`.
- The firewall limits destinations. It does not stop data leaving through an
  allowed service. Where it runs depends on the image. A restricted runtime
  from an image with `egress-gateway=1` (and network policy 2 or later) joins
  the namespace of its own egress gateway, a small companion container that
  holds `NET_ADMIN`, the environment network, the published ports and the
  firewall (`apps/backend/src/core/egress-gateway.ts`); the runtime gets no
  capability, so nothing in it, a root terminal included, can change the
  rules. Older runtimes, and any created with `ORKESTRATOR_EGRESS=in-container`
  (a rollout cap), keep the firewall inside the runtime with `NET_ADMIN`,
  where a root terminal (`orkroot`) can change it. Full-mode containers get
  neither `NET_ADMIN` nor a gateway. Do not describe a runtime with an
  in-container firewall as unable to change it.

## Configuration Storage

Application data is stored in:
- **macOS**: `~/Library/Application Support/orkestrator-v2/`
- **Linux**: `${XDG_CONFIG_HOME:-~/.config}/orkestrator-v2/`

Files:
- `orkestrator.sqlite` - Every backend store (projects, environments, sessions,
  Kanban, agent mail, queues, drafts, reviews, pipelines, …). Living reference:
  [`docs/architecture/storage.md`](docs/architecture/storage.md)
- `config.json` - Global and per-repo settings (stays a file: Electron reads it)
- `toolchains/` - Versioned, hash-verified Codex, OpenCode, and Claude Code executables shared by local environments

Storage rules:
- Never hold a SQLite transaction across an `await`; `bun:sqlite` blocks the
  event loop while it waits for a lock. Use `updateStore` (or `updateStoreRow`
  for one row) for a synchronous read-modify-write, `serialize` (a lease,
  usually through the owning repository's `enqueue*Mutation`) for one that
  awaits, and `atomically` to commit several stores together. Under a per-key
  lease, write only that key's row.
- Give each store one kind of writer: `saveJson`/`saveSensitiveJson`/
  `deleteStore` awaited inside the store's lease, or `updateStore`/
  `updateStoreRow`, never both. `storage-writer-guards.test.ts` enforces it.
- `StorageService` is a facade over per-store repositories sharing one
  `StorageContext`; add store code to the owning repository and expose it
  through that repository's area type (`KanbanStorage`, a `Pick` reached as
  `storage.kanban`) or, for repositories without one yet, a forwarder on the
  facade, never a base class (`docs/architecture/storage.md`, "Code layout").
- An older record shape is upgraded once by a migration
  (`storage-record-upgrades.ts`), not by a reader on every load.
- Tests seed and inspect stores through `storage-test-support.ts`, never by
  writing JSON into a data directory.

## Testing

Follow
[`docs/development/testing-guide.md`](docs/development/testing-guide.md) for the
complete test-selection and diagnostic workflow. The commands below summarize
the common paths; the guide owns the operational detail.

For the complete repository suite, always invoke the mise task with
`mise run test`; never substitute a bare root-level `bun test`. Direct
`bun test` is appropriate only with an explicit focused path, as in the logged
root and bridge subset commands below.

```bash
mise run test
mise run test:changed # Fast affected-only feedback; not final handoff proof.
mise run test:all # Includes the serial iOS suite when Xcode is available.
mise run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures
mise run test:logged -- --name bridge-tests -- bun test bridges --parallel=2 --only-failures
mise run test:logged -- --name web-typecheck -- bun run --cwd apps/web typecheck
mise run test:logged -- --name desktop-typecheck -- bun run --cwd apps/desktop typecheck
mise run test:logged -- --name backend-typecheck -- bun run --cwd apps/backend typecheck
```

Run each command separately so its exit status maps to one suite. `mise run test`
is the complete concurrent cross-platform suite; `test:all` adds iOS at the end.
The explicit `./tests` path avoids package tests.

When running any test, typecheck, build verification, or smoke suite, always
use `test:logged`. It streams stdout/stderr to a private bounded file, preserves
the child status, deletes raw passing output, and compresses failing evidence.
Terminal and conversation buffers are not authoritative. Do not add a second
`tee`, because that recreates an unbounded duplicate:

```bash
mise run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures
```

If a tool buffer maxes out, do not infer success or failure from the visible
status. On failure, inspect the unique compressed artifact path printed by the
runner with bounded reads such as:

```bash
ORK_TEST_ARTIFACT_DIR=/path/printed/by/the/runner
gzip -cd "$ORK_TEST_ARTIFACT_DIR/root-tests.log.gz" | tail -n 200
```

The exit status is authoritative; text matching is only a diagnostic aid because
some tests intentionally exercise and print error paths. See
[`docs/development/testing-guide.md`](docs/development/testing-guide.md#logged-commands-and-failure-artifacts)
for limits and retention.

When running tests for a code review, `mise run test` is normally adequate. Use
focused logged tests while investigating specific areas. By review time those
focused checks should already have been done, so the aggregate suite is the
normal final proof.

### Driving the app with the `orkestrator` CLI

The `orkestrator` client commands can do anything the UI does to projects,
environments, settings, agent sessions, interactions, transcripts and
in-environment commands, and they return JSON and stable exit codes. Use them
against an isolated `dev:test` profile (`--profile NAME`) to set up test state,
exercise backend behavior without the UI, check what a reloaded UI should show,
and read an environment's real workspace. Follow
[`docs/development/cli-testing.md`](docs/development/cli-testing.md) for setup
from a worktree, safety rules and recipes. Never point it at a production
instance while testing.

### Required frontend-to-browser test cycle for agents

Use this cycle whenever a change affects rendered UI, routing, browser gateway
behavior, frontend state, terminal presentation, environment controls, or any
interaction a user can perform in the desktop window. The goal is to test the
actual Vite renderer against a real isolated backend, not only component mocks.
The detailed operational reference is
[`docs/development/agent-testing.md`](docs/development/agent-testing.md).

#### Safety boundaries

- Use `dev:test`, not a production Orkestrator instance, for agent-driven QA.
- Choose a unique, task-specific profile such as `agent-settings-dialog`. Do not
  reuse a profile owned by another agent or workspace.
- Always pass `--fixture` for UI workflows that need a project. Use only the
  returned `testProject`; never add this Orkestrator checkout as a project.
- Agent-test profiles authorize the host credentials for Claude, Codex, Cursor,
  Grok, and OpenCode by default so live agent paths can be tested. This is
  authorized for this repository's isolated `dev:test` profiles. Use
  `--credential-source <name>`
  to narrow a run to one provider, or `--no-agent-credentials` only when the
  scenario specifically requires a credential-free state. Credentials permit
  real external requests, so keep prompts and mutations scoped to the seeded
  fixture and never place secrets in logs or artifacts. Managed toolchains are
  provisioned separately, for every platform by default, so Cursor and Grok —
  which have no PATH fallback — are launchable; `--agent-platforms` narrows it.
- Do not assume ports, profile paths, browser URLs, or process IDs. Discover them
  through `dev:status --json` on every run.
- Sign the browser in with `mise run dev:login --profile <profile>` and open
  the single-use `loginUrl` it prints. Never print, paste into chat, add to a
  URL, or save the gateway token itself. The status manifest contains only the
  path to the mode-`0600` auth file.
- Do not use broad cleanup commands (`docker prune`, recursive removal of a
  development root, killing by executable name, or killing by port). Use the
  profile lifecycle commands below.

#### 1. Run the fast checks before starting the UI

At minimum, typecheck the web package and run the owning test file. Add backend
or desktop typechecks when the change crosses those boundaries.

```bash
mise run test:logged -- --name web-typecheck -- bun run --cwd apps/web typecheck
mise run test:logged -- --name changed-component -- \
  bun --cwd=apps/web test src/path/to/ChangedComponent.test.tsx \
  --parallel=2 --only-failures
```

Do not proceed to browser QA with a known type error or deterministic focused
test failure. A browser pass cannot compensate for a broken static or unit check.

#### 2. Start or reuse an isolated real stack

For automated review validation, use `mise run test:agent:browser:isolated`, or
`mise run test:agent:design:isolated` for design-only changes. These repository-owned
one-shot tasks start a disposable profile, wait for readiness, run the relevant
browser suite, and always stop/reset it. Select their exact commands and resources
from `.orkestrator-test-scheduler.json`; do not construct lifecycle shell wrappers.
The full task covers the design task, so select only the required one.

The manual workflow below is for interactive exploration. `dev:test` stays
attached after `ready`: never sequence it before Playwright using `;` or `&&`.

Start the profile in a long-lived terminal/tool session. The command remains
alive to supervise Vite, Electron, the backend, bridges, and their process trees.

```bash
mise run dev:test --profile agent-settings-dialog --fixture
```

Startup is idempotent: running the same command for a live profile reports the
existing instance instead of creating a second backend. In another command
session, discover its state:

```bash
mise run dev:status --profile agent-settings-dialog --json
```

Wait until the manifest says `status: "ready"` and its liveness block reports
the launcher, Vite, Electron, and backend as live. Use these returned fields:

- `browserUrl` — exact URL for browser testing; never substitute a remembered port.
- `electronTitle` — exact native window to target only for Electron-specific QA.
- `testProject` — the only repository allowed for destructive/manual fixture work.
- `logDir` — bounded launcher, Vite, Electron, and backend diagnostics.
- `loginCommand` — the `dev:login` invocation that signs a browser into this
  profile. Use it instead of touching `authFile`.
- `authFile` — owner-only JSON whose `token` property is the durable gateway
  token, and the fallback for the login form when the launcher is unavailable.
  It is not an OTP and no other code needs to be generated. Read it locally,
  enter that exact value in the gateway-token password field, and do not echo,
  paste into chat, or save it in artifacts.

On startup, `dev:test` also fills any missing isolated-profile caches from the
installed, bounded model-catalog caches when they exist: Orkestrator's
host-agent and OpenCode catalogues, Codex's CLI and bridge model caches, and
Grok's CLI model cache. Cursor's cached catalogue is already part of the shared
Orkestrator host-agent file; Cursor has no separate portable model-cache file.
The setup does not copy projects, sessions, prompts, application settings, or
any extra credential files, and it never replaces catalogue state already
updated inside the profile. A credential-free run therefore still has
last-known model metadata.

`dev:test` also provisions a managed toolchain for every agent platform,
seeding each one from the host installation when it has the same pinned version
so the default normally costs a local copy rather than a download, and enabling
that same selection in the profile so the platforms it provisions are the ones
the app offers. Narrow it with `--agent-platforms cursor,grok` when a run does
not need all six; the flag is rejected by `mise run dev`, which keeps the
durable per-installation selection. An agent-test profile runs only agents
present in its own managed toolchain. Claude, Codex, OpenCode and Pi fall back
to a PATH lookup only outside agent-test profiles; inside one, a missing agent
fails with `<Agent> is not installed in this agent-test profile's toolchain`.
Cursor and Grok resolve only through the managed toolchain everywhere.
Anything the host cannot seed is downloaded at
startup, which needs network access; an agent-test profile that cannot prepare
its toolchains logs the reason and exits rather than waiting on a retry dialog.

If startup reports `failed`, inspect the manifest and files below its `logDir`.
Do not search arbitrary production application-data directories for diagnostics.

#### 3. Establish a green real-stack baseline

Run the browser smoke suite against the already-running profile before or during
manual exploration. It authenticates through a short-lived single-use exchange,
creates a real local worktree, exercises a backend-owned terminal operation,
reloads during progress, verifies authoritative rehydration and diff state, and
cleans up its environment.

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=agent-settings-dialog \
ORKESTRATOR_AGENT_TEST_RUN_ID=agent-settings-dialog \
mise run test:logged -- --name agent-browser -- mise run test:agent:browser
```

Use the optional suites only when their layer is in scope:

```bash
# Real Electron main process, preload, IPC, clipboard, title, userData, and shutdown
mise run test:logged -- --name agent-electron -- mise run test:agent:electron

# Requires a profile started with --fixture-environments local,container
ORKESTRATOR_AGENT_TEST_PROFILE=agent-container-qa \
mise run test:logged -- --name agent-docker -- mise run test:agent:docker
```

The Docker suite is opt-in because it builds/starts the workspace-specific
development image. It must never use or retag `orkestrator-v2:latest`.

#### 4. Test the changed frontend in a real browser

Use the in-app Browser or Playwright against the exact discovered `browserUrl`;
do not use internet browsing/search tools for a loopback page. This browser
client is the default for all normal Orkestrator UI workflows, including agent
chat. Do not open or drive the Electron desktop window with Computer Use unless
the change specifically concerns native-only behavior such as the window,
menus, clipboard, preload, IPC, or shutdown. For repeatable assertions prefer
Playwright and accessible roles/names.

If the login page appears, do not read the token and do not drive the password
field. Run `mise run dev:login --profile <profile>` (add `--json` for
`{ loginUrl, expiresAt }`) and navigate the browser under test to the printed
`loginUrl`. That URL carries a single-use bootstrap code — not the gateway token
— which the gateway consumes on the first request before redirecting to the app,
and which expires within two minutes. If a link is spent or expired, mint another
rather than reusing one. The login page repeats this command for the running
profile, so a browser that lands there can always recover.

Typing the token remains the fallback when the launcher is not available: it is
the `token` property of the JSON file at `authFile`, entered only into the
gateway-token password field. Never put the token in a query string, screenshot,
shell argument, test report, or commentary. Confirm the page displays the orange
DEV identity and the expected profile before changing any state.

For a frontend change, exercise at least:

1. The primary user path changed by the implementation.
2. Empty, loading, success, and error/disabled states that are reachable safely.
3. A page reload after the state change, proving the UI rehydrates from the
   backend instead of depending on the event that originally produced it.
4. A narrow viewport and a normal desktop viewport for layout-affecting changes.
5. Keyboard focus, labels, and the relevant accessible role/name for new controls.

Use only the seeded fixture for environment, terminal, server, preview, Git, and
file-change workflows. To test a preview, create/start a fixture environment,
open its terminal, run the fixture's `bun run dev`, and open the reported preview
through Orkestrator. Do not run fixture commands in the Orkestrator source root.

#### 5. Test inactive-environment rehydration

Any change involving background work must explicitly exercise the inactive path:

1. Start the operation in one fixture environment or tab.
2. Switch to another environment/tab so the initiating React tree can unmount.
3. Let the backend-owned operation progress or complete while it is inactive.
4. Return and verify status, output, pending interactions, and controls.
5. Reload once more and verify the same result from an authoritative snapshot.

Do not accept a result that works only while the initiating component stays
mounted. Live SSE/IPC events are incremental hints; the verification must prove
that a missed event can be recovered.

#### 6. Iterate without restarting unnecessarily

- Frontend-only edits should arrive through Vite HMR in the running profile.
  Wait for the update, then re-run the affected path. Hard-reload the page if the
  test specifically needs a clean mount.
- Changes to Electron main/preload code, backend startup/options, profile wiring,
  or installed dependencies require stopping and starting the profile again.
- Backend business-logic changes generally require a restart because the
  supervised backend is not a Vite module.
- Bridge changes need a profile restart: a profile runs local bridges from
  `bridges/<name>/dist/index.js`, which `dev:test` builds (through Turbo) only
  when it starts. The browser and coordinator agent-testing Playwright configs
  (including the browser-derived Claude warm and paused-interactions configs)
  refuse to run against a profile whose bridge sources or `dist` changed since
  then; restart it with `dev:stop` and `dev:test`. The Electron config does not
  use this freshness guard.
- Use `dev:reset` only when the scenario requires pristine persisted state. A
  normal implementation loop should preserve the profile so reload and
  rehydration behavior remain testable.
- After every restart, call `dev:status --json` again; ports may have changed.

#### 7. Minimum verification by change type

| Change scope                                    | Minimum required verification                                                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| CSS, layout, or visual component                | Web typecheck; owning tests; real browser at desktop and narrow viewport; screenshot of non-sensitive UI if useful      |
| Frontend interaction or Zustand/Context state   | Web typecheck; owning tests; browser smoke; primary path; reload; inactive-tab path when background state is involved   |
| Browser gateway or backend command              | Backend and web typechecks; focused gateway/command tests; browser smoke; authenticated real-browser path               |
| Electron main, preload, IPC, or window behavior | Desktop typecheck; focused Electron tests; `test:agent:electron`; native-window check when visual behavior changed      |
| Docker lifecycle or container UI                | Backend typecheck; exact-owner focused tests; local browser smoke; opt-in Docker fixture/suite when Docker is available |
| Cross-cutting or release-sensitive change       | All relevant checks above, then `mise run test`; use `mise run test:all` for release validation including iOS             |

#### 8. Evidence and failure reporting

Record enough evidence for another agent to reproduce the result:

- Profile name and tested commit/worktree.
- Exact commands and pass/fail counts.
- The logged runner's compressed failure artifact path, when a command fails.
- Browser or Electron route used and viewport when layout matters.
- Short reproduction steps, expected result, and actual result.
- Artifact paths under `output/agent-testing/<run-id>/`.
- Any skipped flow, with the concrete reason (for example Docker unavailable).

Artifacts and reports must not contain gateway tokens, credentials, prompts,
terminal contents, file contents, or attachment data. Failure screenshots should
show only the UI needed to establish the issue. Browser traces are automatically
redacted, but agents must still avoid adding secrets to test names, annotations,
console messages, or filenames.

If an automated suite fails, inspect its saved log and owning test first. If it
failed in an aggregate/parallel run, rerun the owning file alone before calling
it flaky, then follow the flaky-test procedure below.

#### 9. Stop and clean up

Always stop a profile when browser/manual QA is finished, even after a failed
test. Reset it as well unless preserving state is intentional and stated in the
handoff.

```bash
mise run dev:stop --profile agent-settings-dialog
mise run dev:reset --profile agent-settings-dialog
```

`dev:stop` validates launcher PID plus process start time and reports surviving
owned processes. `dev:reset` refuses live or unsafe targets, validates the
profile sentinel, and removes only that profile's exact-owner containers and
state. Use `--stop-first` only when intentionally combining those steps; use
`--keep-toolchains` when downloaded toolchains should survive the reset. It also
unregisters worktrees the profile created in an outside repository, and deletes
their branches only when already merged.

A forgotten reset is not permanent: every `dev`/`dev:test` start prunes stopped
profiles whose checkout no longer exists, and `mise run dev:prune` does the
same on demand (`--older-than <days>` also removes idle ones, `--dry-run`
lists). `mise run disk:report` shows everything Orkestrator work leaves on disk
and who cleans it; see
[`docs/development/disk-usage.md`](docs/development/disk-usage.md).

Before handing off, confirm there is no live launcher for the test profile and
report whether its state was reset or deliberately retained.

### Flaky Test Tracking

Keep the flake registry in [`docs/tests/flaky-tests/`](docs/tests/flaky-tests/0000-index.md)
current whenever test behavior shows a credible flake. That directory is the
only flake registry — do not start a second one. Cases live in ten group
folders, each with its own `0000-index.md` table; the top-level index only
names the groups and what they cover, and never holds case rows. Search the
group indexes by test name or owning file
(`rg '<name>' docs/tests/flaky-tests/*/0000-index.md`); read the **Status**
column before opening a case file. Do not read every `NNNN-*.md` file.

If a test fails in the normal aggregate or parallel suite but passes when its
owning file is rerun alone, add or update the matching numbered case file in
its group folder and that group's index row in the same change. Append new
rows at the end of the group table and change status in place, so parallel
branches touch different lines. Record the exact test name and file, the
original command and worker configuration, the failure message and duration when
available, suite counts, the isolated rerun command and result, the observation
date, and any evidence-backed hypothesis or reproduction notes.

Do not call a test flaky merely because it failed once: run the owning file alone
first and preserve both results. Do not hide a flake by deleting, skipping, or
loosening the test. When a flake is fixed, update its existing case file with the
root cause, fix reference, and stress or parallel verification, then mark it
resolved in both the case file and the index instead of silently removing its
history.

### Parallelism

The suite is dominated by I/O waits (tests that boot real backend processes, bind
ports, drive happy-dom) rather than CPU, so it parallelizes well:

- **Within a group** — `bun test --parallel` spreads test *files* across worker
  processes. This is where nearly all of the win is (the root suite alone goes
  from ~100s to ~30s).
- **Across groups** — `scripts/test-all.ts` runs the workspace, root, bridge and
  protocol groups concurrently, with bounded worker pools (`planWorkers`) so
  the three worker-consuming groups cannot oversubscribe a small CI runner.
  Larger hosts give remaining capacity to the root long pole while keeping at
  most two package tasks active. iOS is opt-in through `test:all` and runs
  last and alone because the simulator is a single shared resource.

Group output streams to private bounded files while only a failure tail stays in
memory. Passing groups print a summary; failing groups retain compressed
artifacts. **Every** failing group is reported rather than stopping at the first.

Always add `--parallel` when running a suite directly; a sequential run of
`tests/` takes roughly three times as long.

**`--parallel` implies `--isolate`.** Each test file gets a fresh module registry,
which removes the cross-file `mock.module()` leakage described below — but it also
means a test that only passed because a *sibling* file had mutated a global will
now fail. That is a real bug being exposed, not a parallelism problem: fix the
test to set up what it needs itself. `bridges/claude-bridge/src/routes/events.test.ts`
is the worked example — it guarded its `globalThis.TransformStream` polyfill with
`if (!globalThis.TransformStream)`, so it silently depended on another suite
installing that global first.

Before assuming a parallel-only failure is a race, run the file on its own:

```bash
bun test path/to/one.test.ts   # if this fails alone, it was never self-sufficient
```

### Bun `mock.module()` Rules

Bun's module mocking is **global at the module-cache level**. In this repo, top-level `mock.module()` calls can leak across test files even when `mock.restore()` is used later.

Use this stable pattern:

1. Put truly shared mocks in `tests/setup.ts`.
   - Example: native wrapper mocks from `@/lib/native/*` are registered once there so files do not fight over competing global mocks.
2. If some tests need a mocked module but other tests need the real module, keep the module real in `tests/setup.ts` and put **shared mock functions** in `tests/mocks/*`.
   - Example: `tests/mocks/clipboard-paste.ts` exports reusable mock functions, and `terminal-paste.test.ts` wires them up per-file with `mock.module(...)`.
3. Prefer mocking narrow dependencies, not broad app modules or shared UI components.
   - Avoid top-level mocks for modules like `@/components/chat/NativeMessage` unless the whole suite should use that fake. These are especially likely to pollute unrelated tests.
4. Do not assume `mock.restore()` fixes module-cache pollution.
   - It is useful for resetting function state, but it is not a reliable isolation boundary for `mock.module(...)` in Bun.
5. Before adding a new `mock.module(...)`, search for existing comments/patterns in `tests/setup.ts` and `tests/mocks/`.
   - If the same module is mocked in multiple files, centralize it or convert to shared mock functions.

Practical rule:
- If a mock must be visible to many suites, register it once in `tests/setup.ts`.
- If only one file should use the mock, keep the `mock.module(...)` local and back it with reusable mock fns from `tests/mocks/*` when helpful.
- If another suite imports the real module, do **not** add a competing global mock for that module in a random test file.

### Snapshot-and-restore pattern for unavoidable sibling-component stubs

When a test *must* stub a sibling component that has its own test file (e.g. `ChatTab.test.tsx` stubbing `./ComposeBar`, when `ComposeBar.test.tsx` needs the real module), snapshot the real module before installing the stub and restore it in `afterAll`. Bun caches the first `mock.module` factory result, but a subsequent `mock.module(path, () => snapshot)` call does override the cache for future imports.

```typescript
import { afterAll, mock } from "bun:test";

// 1. Snapshot the real module BEFORE any mock.module call that would replace it.
import * as realComposeBar from "./ComposeBar";
const realComposeBarSnapshot = { ...realComposeBar };

// 2. Install the stub.
mock.module("./ComposeBar", () => ({ ComposeBar: () => <button>Stub</button> }));

// 3. Restore when this file's tests finish so later files see the real module.
afterAll(() => {
  mock.module("./ComposeBar", () => realComposeBarSnapshot);
});
```

Use this only as a last resort — prefer not mocking sibling components at all when feasible (see rule 3 above).

## Development Commands

For agent-driven real-stack QA, follow
[`docs/development/agent-testing.md`](docs/development/agent-testing.md). Never use
the live source checkout as the test project.

```bash
# Install dependencies
bun install

# Run the Electron application
mise run dev

# Build for production
mise run build

# Build Docker base image
docker build -t orkestrator-v2:latest -f docker/Dockerfile .
```

## UI Components

This project uses **shadcn/ui** components. When adding new UI:
1. Check if a shadcn/ui component exists first
2. Components are in `apps/web/src/components/ui/`
3. Follow existing patterns in the codebase
4. Use Tailwind CSS v4 for styling

## State Management

- **Zustand** for global state (`apps/web/src/stores/`)
- **React Context** for component-tree state (`apps/web/src/contexts/`)
- Stores use `Map<string, T>` pattern for per-environment/per-session state

# Code review

- When asked to code review, do not make changes to files until the user has specifically asked you to address issues or coverage gaps. A request for review is a request to just identify issues. It should not involve changes until approved.

# General guidance

- Avoid files larger than 2000 lines of code. Where files get this big, split them into smaller files, groups around a logical boundary. Also split the tests so that they line up with the split on the file they are testing.
- Do not log secrets such as API keys, tokens, SSH keys, or credential file contents.

## Orkestrator

Operating decisions the user approved in Orkestrator coordinator conversations. Every agent working in this repository, workers included, must follow them. Agents change this section only through a coordinator proposal that the user approves as a pull request.
