# Agent Instructions

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
| `docker/`, container lifecycle, firewall, Playwright in containers | [`docker/AGENTS.md`](docker/AGENTS.md) |
| OpenCode provider, SDK pin or `patches/` | [`docs/architecture/agent-engines.md`](docs/architecture/agent-engines.md#maintaining-the-opencode-integration) |
| Coordinator qualification (`coordinator-providers.ts`) | [`docs/architecture/coordinator.md`](docs/architecture/coordinator.md#changing-qualification) |
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
(`src/core/`); shared contracts in `packages/protocol`; the published
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
mise run test            # Complete suite; NOT bare root-level `bun test`
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

- Documentation-only changes (`*.md`, `docs/**`, `plans/**`) need no test
  suite: `mise run format:check` is enough.
- Every change to code or configuration runs `mise run format:check`,
  `mise run lint`, and `mise run typecheck`.
- Code changes under `apps/`, `bridges/`, `packages/`, `scripts/`, or `tests/`
  run `mise run test` (the complete non-iOS suite).
- Treat dependency, lockfile, `mise.toml`, Turbo, test-runner, or
  `packages/protocol` changes as wide-reaching even when the diff is small;
  they always need `mise run test`.
- Add a scenario suite from the testing guide's **Verification by change type**
  table only when the change touches that area: browser-visible renderer flows
  (`mise run test:browser`, or `mise run test:agent:browser:isolated` for
  real-stack flows), the design canvas (`mise run test:agent:design:isolated`),
  Electron main/preload/IPC (`mise run test:agent:electron`), Docker lifecycle
  (`mise run test:agent:docker`), the published CLI
  (`mise run test:cli:scenarios`), and iOS (`mise run test:all`, macOS only).
  Omit them otherwise and say so in one limitation.

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

Flakes are tracked only in
[`docs/tests/flaky-tests/0000-index.md`](docs/tests/flaky-tests/0000-index.md).
Search the index by test name or owning file; do not read every case file. A
failure is a flake only if the owning file passes when rerun alone; record it in
the same change, and never hide one by skipping or loosening the test.

For real-stack UI QA use isolated `dev:test` profiles with `--fixture`, never a
production instance or this checkout as the project. Never print, paste, or save
the gateway token — sign in with `mise run dev:login`. Never use broad cleanup
(`docker prune`, killing by name or port); stop and reset the profile with
`dev:stop`/`dev:reset` when done. The
[`orkestrator` CLI](docs/development/cli-testing.md) can drive the same profiles
without the UI.

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

## Formatting and Linting - oxc

Formatting is oxfmt and linting is oxlint; run them from the repo root with
`mise run format`, `mise run format:check`, `mise run lint`, `mise run lint:fix`,
or `mise run check` (format, lint and typecheck). Markdown and `docs/**` are not
reformatted. Rationale and exclusions are in
[`docs/development/linting.md`](docs/development/linting.md).

- Only `correctness` is enabled, as errors. `no-unused-vars` is a warning for
  the pre-existing backlog: clean up files you touch, never silence it or raise
  it to `error`. Warnings do not fail the build, so read the output.
- Use a disable directive only when the rule is wrong about that site, with the
  reason above it. `oxlint-disable-next-line` sits above the **reported** line;
  `react-hooks/exhaustive-deps` needs a block `oxlint-disable`/`oxlint-enable`
  pair. Check first whether the dependency is genuinely missing — most were.
- Iterate a collection you are about to mutate with
  `for (const x of Array.from(collection))`, not a spread; lint's suggested fix
  for the spread form silently skips entries.

## Application Version Bumps

When bumping the Orkestrator version, keep the top-level `version` field in all
of these package manifests synchronized:

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

After a bump, run the following to verify every package manifest was included
and has the intended version:

```bash
rg -n '"version"\s*:' --glob 'package.json' --glob '!node_modules/**'
```

Then follow **Updating Bun and lockfiles** above. A version-only bump still
changes the workspace metadata in the root `bun.lock`; leaving the old values
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

# Code review

- When asked to code review, do not make changes to files until the user has specifically asked you to address issues or coverage gaps. A request for review is a request to just identify issues. It should not involve changes until approved.

# General guidance

- Avoid files larger than 2000 lines of code. Where files get this big, split them into smaller files, groups around a logical boundary. Also split the tests so that they line up with the split on the file they are testing.
- Do not log secrets such as API keys, tokens, SSH keys, or credential file contents.
