# Agent Instructions

This file provides specific guidance for AI agents working on this codebase.

## Project Overview

Orkestrator AI is an Electron desktop application for managing isolated Docker-based and local-worktree development environments for Claude Code, Codex, and OpenCode.

## Main Branch and Pull Request Policy

All changes to `main` must be integrated through a pull request. Agents must
never commit or push directly to `main`, and must not merge, squash, or rebase a
pull request into `main` themselves. Agents may prepare a feature branch, push
that branch explicitly, and open a pull request for review; the final merge into
`main` must be left to a human maintainer.

Before pushing, verify both the current branch and its configured upstream. If
either operation would update `main` directly, stop and correct the branch or
upstream configuration instead of pushing.

## Background Environment Reliability

Environments can keep doing work while another environment is active in the UI. Do not assume the active React tree is mounted, subscribed to events, or able to receive every Electron IPC/SSE/tmux update.

When adding or changing background behavior (agent sessions, tmux sessions, terminals, local servers, Docker operations, file watchers, PR monitoring, build pipelines, etc.):

1. Keep the authoritative long-running state in the backend, bridge, persistent store, or external process — not only in mounted React component state.
2. Make foreground UI components rehydrate from an authoritative snapshot when they mount or become active again.
3. Treat live events as incremental updates, not the only source of truth. If events are missed while inactive, the UI must be able to catch up from status/transcript/history APIs.
4. Test the inactive-environment path: start work, switch to another environment/tab, let the work progress or finish, then return and verify status, messages, pending prompts, and controls are correct.
5. Avoid cleanup tied only to component unmount unless the user explicitly stopped the work. Unmount often means "not currently visible", not "cancel the background task".

## Efficiency and Transport Invariants

When implementing `docs/efficiency-plan.md` or changing gateway, bridge,
terminal, streaming, replay, compression, or synchronization behavior, preserve
these non-negotiable invariants:

1. Long-running state lives in the backend, bridge, persistent store, or
   external process, not only in mounted React state.
2. A component unmount or inactive environment does not stop background work.
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

## Tech Stack

| Layer    | Technology                                                |
| -------- | --------------------------------------------------------- |
| Frontend | React 19, TypeScript, Tailwind CSS v4, shadcn/ui, Zustand |
| Backend  | Bun, Node.js APIs, TypeScript                             |
| Terminal | xterm.js                                                  |
| Docker   |                                                           |
| OpenCode | `@opencode-ai/sdk` v2                                     |

## Project Structure

```
apps/
├── web/                    # React/Vite frontend application
│   └── src/                # Components, stores, contexts, hooks, and client adapters
├── desktop/                # Electron desktop application
│   └── electron/           # Main process, preload, IPC, and backend supervisor
└── backend/                # Standalone Bun backend service
    └── src/core/           # Docker, worktree, PTY, storage, and agent lifecycle state

packages/
└── protocol/               # Shared gateway contracts and validation

bridges/                    # Native-mode bridge servers
├── claude-bridge/          # Claude Native Mode bridge server
└── codex-bridge/           # Codex Native Mode bridge server
    └── src/
        ├── index.ts            # Routes, SSE, composition root
        ├── app-server-runtime.ts  # Session surface for the app-server engine
        ├── engine/             # CodexEngine contract + AppServerEngine
        ├── app-server/         # Supervisor, JSONL RPC, reducer, generated protocol
        ├── sessions/           # Thread registry, turn accumulator, dispatch journal
        ├── messages/           # Normalized message model + renderer (engine-neutral)
        ├── prompts/            # Slash commands and prompt shaping
        └── history/            # Rollout transcript parsing

docker/                     # Docker configuration
├── Dockerfile              # Base image definition
├── entrypoint.sh           # Container entrypoint
└── init-firewall.sh        # Network firewall setup
```

## Package Manager - Bun

**Always use Bun, never npm or yarn.**

```bash
bun install              # NOT npm install
bun run <script>         # NOT npm run
bun test                 # NOT npm test
bunx <package>           # NOT npx
bun <file>               # NOT node <file>
```

Bun automatically loads `.env` files.

## Application Version Bumps

When bumping the Orkestrator version, keep the top-level `version` field in all
of these package manifests synchronized:

- `package.json`
- `apps/backend/package.json`
- `apps/desktop/package.json`
- `apps/web/package.json`
- `apps/web-public/package.json`
- `bridges/acp-bridge/package.json`
- `bridges/claude-bridge/package.json`
- `bridges/codex-bridge/package.json`
- `packages/cli/package.json`
- `packages/protocol/package.json`

After a bump, run the following to verify every package manifest was included
and has the intended version:

```bash
rg -n '"version"\s*:' --glob 'package.json' --glob '!node_modules/**'
```

## OpenCode SDK v2 - CRITICAL

**Always use v2 of the `@opencode-ai/sdk` package.**

```typescript
// CORRECT - v2 API
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";

// WRONG - v1 API (different parameter structure, missing features)
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
```

### v2 API Parameter Patterns

The v2 SDK uses flat parameters instead of nested `path`/`body` objects:

```typescript
// v2 (CORRECT)
await client.session.create({ title });
await client.session.messages({ sessionID: id });
await client.session.promptAsync({ sessionID: id, parts });
await client.session.abort({ sessionID: id });
await client.session.delete({ sessionID: id });
await client.question.reply({ requestID: id, answers });
await client.question.reject({ requestID: id });

// v1 (WRONG - do not use)
await client.session.create({ body: { title } });
await client.session.messages({ path: { id } });
```

### v2-Only Features

These APIs only exist in v2:
- `client.question.list()` - List pending questions
- `client.question.reply()` - Reply to a question
- `client.question.reject()` - Reject/dismiss a question

### OpenCode Components

| Component              | Purpose                                 |
| ---------------------- | --------------------------------------- |
| `OpenCodeChatTab`      | Main chat interface, SSE event handling |
| `OpenCodeComposeBar`   | Message input with attachments          |
| `OpenCodeMessage`      | Message rendering with tool display     |
| `OpenCodeQuestionCard` | Interactive question/answer UI          |
| `openCodeStore`        | Zustand store for sessions, questions   |
| `opencode-client.ts`   | SDK wrapper functions                   |

### SSE Event Types

The OpenCode server sends these event types:
- `message.updated` - Message content changed
- `message.part.updated` - Streaming part update
- `session.updated` - Session state changed
- `session.error` - Error occurred
- `question.asked` - AI is asking a question
- `question.replied` - Question was answered
- `question.rejected` - Question was dismissed

## Standalone Backend

- Register backend commands in `apps/backend/src/core/commands.ts` through `createCommandRegistry()`.
- Keep long-running process state in the standalone backend, bridge process, persistent store, or external process; renderer state should rehydrate from backend snapshots.
- Use the existing `CommandContext` and `StorageService` patterns instead of adding renderer-only state for Docker, tmux, terminal, or local server lifecycles.
- Do not log secrets such as API keys, tokens, SSH keys, or credential file contents.

## Key Files Reference

### Frontend

| File                                                     | Purpose                     |
| -------------------------------------------------------- | --------------------------- |
| `apps/web/src/components/codex/CodexChatTab.tsx`         | Codex Native Mode chat      |
| `apps/web/src/components/terminal/TerminalContainer.tsx` | xterm.js integration        |
| `apps/web/src/components/opencode/OpenCodeChatTab.tsx`   | OpenCode Native Mode chat   |
| `apps/web/src/lib/codex-client.ts`                       | Codex bridge client wrapper |
| `apps/web/src/lib/opencode-client.ts`                    | OpenCode SDK v2 wrapper     |
| `apps/web/src/stores/codexStore.ts`                      | Codex state management      |
| `apps/web/src/stores/openCodeStore.ts`                   | OpenCode state management   |
| `apps/web/src/lib/native/backend.ts`                     | Native IPC command wrapper  |

### Codex bridge

The bridge supervises one persistent `codex app-server --stdio` child per
environment and talks to it over JSON-RPC on private stdio. There is no second
engine and no feature flag: the per-turn `codex exec` path and the
`@openai/codex-sdk` dependency were both removed once app-server reached parity.
See [`docs/adr/0001-codex-app-server-engine.md`](docs/adr/0001-codex-app-server-engine.md).

`session-titles.ts` is the deliberate exception — it still spawns its own hermetic
`codex exec` with a custom model catalog, read-only sandbox and user config
ignored, so title generation cannot inherit the user's tools or instructions.

| File                                                           | Purpose                                            |
| -------------------------------------------------------------- | -------------------------------------------------- |
| `bridges/codex-bridge/src/index.ts`                            | Routes, SSE, composition root                      |
| `bridges/codex-bridge/src/app-server-runtime.ts`               | Session surface for the app-server engine          |
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
  `missing` — an error is not evidence of deletion.
- Agent version bumps follow [`docs/upgrade-agents.md`](docs/upgrade-agents.md);
  the generated protocol under `app-server/generated/` is a lockfile.
- Never resolve an approval to "approved" by default. Every timeout, disconnect,
  generation death and unparseable answer denies. Approving on a technicality would
  run a command the user never saw.
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

### Backend

| File                                   | Purpose                                                  |
| -------------------------------------- | -------------------------------------------------------- |
| `apps/backend/src/core/commands.ts`    | Backend command registry and Docker/local env management |
| `apps/backend/src/core/tmux.ts`        | Claude tmux mode backend                                 |
| `apps/backend/src/core/storage.ts`     | JSON file persistence                                    |
| `apps/desktop/electron/ipc.ts`         | Main-process IPC handlers                                |
| `apps/desktop/electron/preload-api.ts` | Renderer-facing native API                               |

### Docker

| File                      | Purpose                |
| ------------------------- | ---------------------- |
| `docker/Dockerfile`       | Base image definition  |
| `docker/entrypoint.sh`    | Container entrypoint   |
| `docker/init-firewall.sh` | Network firewall rules |

## Docker Base Image

The container includes:
- Node.js 24 LTS
- Claude Code CLI
- Codex CLI
- OpenCode CLI
- Git and GitHub CLI (gh)
- Network firewall (iptables/ipset) for security isolation
- zsh with powerlevel10k theme
- Non-root user (node) with sudo for firewall

### Network Isolation

Containers have restricted network access via iptables firewall:
- **Allowed**: GitHub, npm registry, Anthropic API, VS Code marketplace
- **Blocked**: All other outbound traffic

## Configuration Storage

Application data is stored in:
- **macOS**: `~/Library/Application Support/orkestrator-v2/`
- **Linux**: `${XDG_CONFIG_HOME:-~/.config}/orkestrator-v2/`

Files:
- `config.json` - Global and per-repo settings
- `projects.json` - Repository metadata
- `environments.json` - Environment metadata and container IDs
- `toolchains/` - Versioned, hash-verified Codex, OpenCode, and Claude Code executables shared by local environments

## Testing

```bash
set -o pipefail
bun run test 2>&1 | tee /tmp/orkestrator-full-tests.log
bun test ./tests --parallel 2>&1 | tee /tmp/orkestrator-root-tests.log
bun test bridges --parallel 2>&1 | tee /tmp/orkestrator-bridge-tests.log
bun run --cwd apps/web typecheck 2>&1 | tee /tmp/orkestrator-web-typecheck.log
bun run --cwd apps/desktop typecheck 2>&1 | tee /tmp/orkestrator-desktop-typecheck.log
bun run --cwd apps/backend typecheck 2>&1 | tee /tmp/orkestrator-backend-typecheck.log
```

Run each pipeline separately so its exit status maps to one suite. The comments
formerly shown beside these commands are summarized here: `bun run test` is the
complete concurrent suite followed by iOS; `./tests` is the root-only suite and
uses an explicit path to avoid package tests; the remaining commands cover the
bridges and package typechecks.

When running any test, typecheck, build verification, or smoke suite, always
capture complete stdout and stderr in a file. Terminal, tool-call, and agent
conversation buffers are routinely truncated and must never be treated as the
authoritative test record. Pipe through `tee` and enable `pipefail` so the saved
file is complete while the shell still returns the test command's failure:

```bash
set -o pipefail
bun test ./tests --parallel 2>&1 | tee /tmp/orkestrator-root-tests.log
```

Use a descriptive log name for each suite or rerun, and inspect the saved log for
the full failure context instead of relying only on buffered terminal output.
Use a unique suffix when concurrent agents might run the same suite. Keep these
transient logs in `/tmp`, not in the repository, and never commit them.

If a tool buffer maxes out, do not infer success or failure from the visible
tail and do not rerun merely to recover the missing text. Check the process exit
status, then inspect the saved file with bounded reads such as:

```bash
tail -n 200 /tmp/orkestrator-root-tests.log
rg -n "\(fail\)|error:|Failing groups:" /tmp/orkestrator-root-tests.log
```

The exit status is authoritative; text matching is only a diagnostic aid because
some tests intentionally exercise and print error paths.

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
- Agent-test profiles inherit the host login for Claude, Codex, and OpenCode by
  default so live agent paths can be tested. This is authorized for this
  repository's isolated `dev:test` profiles. Use `--credential-source <name>`
  to narrow a run to one provider, or `--no-agent-credentials` only when the
  scenario specifically requires a credential-free state. Credentials permit
  real external requests, so keep prompts and mutations scoped to the seeded
  fixture and never place secrets in logs or artifacts.
- Do not assume ports, profile paths, browser URLs, or process IDs. Discover them
  through `dev:status --json` on every run.
- Never print, paste into chat, add to a URL, or save the gateway token. The
  status manifest contains only the path to the mode-`0600` auth file.
- Do not use broad cleanup commands (`docker prune`, recursive removal of a
  development root, killing by executable name, or killing by port). Use the
  profile lifecycle commands below.

#### 1. Run the fast checks before starting the UI

At minimum, typecheck the web package and run the owning test file. Add backend
or desktop typechecks when the change crosses those boundaries. Capture complete
output in logs.

```bash
set -o pipefail
bun run --cwd apps/web typecheck 2>&1 | tee /tmp/orkestrator-web-typecheck.log
bun test ./apps/web/src/path/to/ChangedComponent.test.tsx --parallel \
  2>&1 | tee /tmp/orkestrator-changed-component.log
```

Do not proceed to browser QA with a known type error or deterministic focused
test failure. A browser pass cannot compensate for a broken static or unit check.

#### 2. Start or reuse an isolated real stack

Start the profile in a long-lived terminal/tool session. The command remains
alive to supervise Vite, Electron, the backend, bridges, and their process trees.

```bash
bun run dev:test -- --profile agent-settings-dialog --fixture
```

Startup is idempotent: running the same command for a live profile reports the
existing instance instead of creating a second backend. In another command
session, discover its state:

```bash
bun run dev:status -- --profile agent-settings-dialog --json
```

Wait until the manifest says `status: "ready"` and its liveness block reports
the launcher, Vite, Electron, and backend as live. Use these returned fields:

- `browserUrl` — exact URL for browser testing; never substitute a remembered port.
- `electronTitle` — exact native window to target only for Electron-specific QA.
- `testProject` — the only repository allowed for destructive/manual fixture work.
- `logDir` — bounded launcher, Vite, Electron, and backend diagnostics.
- `authFile` — owner-only JSON whose `token` property is the exact login code.
  It is not an OTP and no other code needs to be generated. Read it locally,
  enter that exact value in the gateway-token password field, and do not echo,
  paste into chat, or save it in artifacts.

On startup, `dev:test` also seeds the isolated profile from the installed,
bounded model-catalog caches when they exist: Orkestrator's host-agent and
OpenCode catalogues, Codex's CLI and bridge model caches, and Grok's CLI model
cache. Cursor's cached catalogue is already part of the shared Orkestrator
host-agent file; Cursor has no separate portable model-cache file. The setup
does not copy projects, sessions, prompts, application settings, or any extra
credential files. A credential-free run therefore still has last-known model
metadata.

If startup reports `failed`, inspect the manifest and files below its `logDir`.
Do not search arbitrary production application-data directories for diagnostics.

#### 3. Establish a green real-stack baseline

Run the browser smoke suite against the already-running profile before or during
manual exploration. It authenticates through a short-lived single-use exchange,
creates a real local worktree, exercises a backend-owned terminal operation,
reloads during progress, verifies authoritative rehydration and diff state, and
cleans up its environment.

```bash
set -o pipefail
ORKESTRATOR_AGENT_TEST_PROFILE=agent-settings-dialog \
ORKESTRATOR_AGENT_TEST_RUN_ID=agent-settings-dialog \
bun run test:agent:browser 2>&1 | tee /tmp/orkestrator-agent-browser.log
```

Use the optional suites only when their layer is in scope:

```bash
# Run each pipeline separately.
set -o pipefail

# Real Electron main process, preload, IPC, clipboard, title, userData, and shutdown
bun run test:agent:electron 2>&1 | tee /tmp/orkestrator-agent-electron.log

# Requires a profile started with --fixture-environments local,container
ORKESTRATOR_AGENT_TEST_PROFILE=agent-container-qa \
bun run test:agent:docker 2>&1 | tee /tmp/orkestrator-agent-docker.log
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

If the login page appears, the requested "code" is exactly the string in the
`token` property of the JSON file at `authFile`. Read it locally and type it only
into the gateway-token password field, then submit. Do not search for a separate
verification code and never put the token in a query string, screenshot, shell
argument, test report, or commentary. Confirm the page displays the orange DEV
identity and the expected profile before changing any state.

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
- Use `dev:reset` only when the scenario requires pristine persisted state. A
  normal implementation loop should preserve the profile so reload and
  rehydration behavior remain testable.
- After every restart, call `dev:status --json` again; ports may have changed.

#### 7. Minimum verification by change type

| Change scope | Minimum required verification |
| --- | --- |
| CSS, layout, or visual component | Web typecheck; owning tests; real browser at desktop and narrow viewport; screenshot of non-sensitive UI if useful |
| Frontend interaction or Zustand/Context state | Web typecheck; owning tests; browser smoke; primary path; reload; inactive-tab path when background state is involved |
| Browser gateway or backend command | Backend and web typechecks; focused gateway/command tests; browser smoke; authenticated real-browser path |
| Electron main, preload, IPC, or window behavior | Desktop typecheck; focused Electron tests; `test:agent:electron`; native-window check when visual behavior changed |
| Docker lifecycle or container UI | Backend typecheck; exact-owner focused tests; local browser smoke; opt-in Docker fixture/suite when Docker is available |
| Cross-cutting or release-sensitive change | All relevant checks above, then `set -o pipefail; bun run test 2>&1 \| tee /tmp/orkestrator-full-tests.log` |

#### 8. Evidence and failure reporting

Record enough evidence for another agent to reproduce the result:

- Profile name and tested commit/worktree.
- Exact commands and pass/fail counts.
- Saved `/tmp` log path for every automated command; this is the authoritative
  output when the agent/tool buffer is truncated.
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
bun run dev:stop -- --profile agent-settings-dialog
bun run dev:reset -- --profile agent-settings-dialog
```

`dev:stop` validates launcher PID plus process start time and reports surviving
owned processes. `dev:reset` refuses live or unsafe targets, validates the
profile sentinel, and removes only that profile's exact-owner containers and
state. Use `--stop-first` only when intentionally combining those steps; use
`--keep-toolchains` when downloaded toolchains should survive the reset.

Before handing off, confirm there is no live launcher for the test profile and
report whether its state was reset or deliberately retained.

### Flaky Test Tracking

Keep [`docs/flaky-tests.md`](docs/flaky-tests.md) current whenever test behavior
shows a credible flake. It is the only flake registry — do not start a second
one. If a test fails in the normal aggregate or parallel suite but passes when
its owning file is rerun alone, add or update its entry in that document in the
same change. Record the exact test name and file, the original command and
worker configuration, the failure message and duration when available, suite
counts, the isolated rerun command and result, the observation date, and any
evidence-backed hypothesis or reproduction notes.

Do not call a test flaky merely because it failed once: run the owning file alone
first and preserve both results. Do not hide a flake by deleting, skipping, or
loosening the test. When a flake is fixed, update its existing entry with the
root cause, fix reference, and stress or parallel verification, then mark it
resolved instead of silently removing its history.

### Parallelism

The suite is dominated by I/O waits (tests that boot real backend processes, bind
ports, drive happy-dom) rather than CPU, so it parallelizes well:

- **Within a group** — `bun test --parallel` spreads test *files* across worker
  processes. This is where nearly all of the win is (the root suite alone goes
  from ~100s to ~30s).
- **Across groups** — `scripts/test-all.ts` runs the workspace, root, bridge and
  protocol groups concurrently, with bounded worker pools (`planWorkers`) so
  the three worker-consuming groups cannot oversubscribe a small CI runner. iOS
  runs last and alone: the simulator is a single shared resource.

Group output is buffered and printed as a labelled block, and **every** failing
group is reported rather than stopping at the first — with concurrency the others
have already run.

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
bun run dev

# Build for production
bun run build

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
