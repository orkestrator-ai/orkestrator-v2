# Agent Instructions

This file provides specific guidance for AI agents working on this codebase.

## Project Overview

Orkestrator AI is an Electron desktop application for managing isolated Docker-based and local-worktree development environments for Claude Code, Codex, and OpenCode.

## Background Environment Reliability

Environments can keep doing work while another environment is active in the UI. Do not assume the active React tree is mounted, subscribed to events, or able to receive every Electron IPC/SSE/tmux update.

When adding or changing background behavior (agent sessions, tmux sessions, terminals, local servers, Docker operations, file watchers, PR monitoring, build pipelines, etc.):

1. Keep the authoritative long-running state in the backend, bridge, persistent store, or external process — not only in mounted React component state.
2. Make foreground UI components rehydrate from an authoritative snapshot when they mount or become active again.
3. Treat live events as incremental updates, not the only source of truth. If events are missed while inactive, the UI must be able to catch up from status/transcript/history APIs.
4. Test the inactive-environment path: start work, switch to another environment/tab, let the work progress or finish, then return and verify status, messages, pending prompts, and controls are correct.
5. Avoid cleanup tied only to component unmount unless the user explicitly stopped the work. Unmount often means "not currently visible", not "cancel the background task".

## Tech Stack

| Layer    | Technology                                                |
| -------- | --------------------------------------------------------- |
| Frontend | React 19, TypeScript, Tailwind CSS v4, shadcn/ui, Zustand |
| Backend  | Electron, Node.js, TypeScript                             |
| Terminal | xterm.js                                                  |
| Docker   |                                                           |
| OpenCode | `@opencode-ai/sdk` v2                                     |

## Project Structure

```
src/                        # React frontend
├── components/             # UI components (shadcn/ui based)
│   ├── codex/              # Codex Native Mode components
│   ├── opencode/           # OpenCode Native Mode components
│   ├── terminal/           # Terminal/xterm.js components
│   └── ui/                 # shadcn/ui primitives
├── stores/                 # Zustand state stores
├── contexts/               # React contexts
├── hooks/                  # Custom React hooks
├── lib/                    # Utilities and native IPC wrappers
└── types/                  # TypeScript type definitions

electron/                   # Electron main process and backend
├── backend/                # Command registry, Docker/local env management, storage
├── ipc.ts                  # Main-process IPC handlers
├── preload.ts              # Preload entrypoint
└── preload-api.ts          # Renderer-facing native API

bridges/                    # Native-mode bridge servers
├── claude-bridge/          # Claude Native Mode bridge server
└── codex-bridge/           # Codex Native Mode bridge server

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

## Electron Backend

- Register backend commands in `electron/backend/commands.ts` through `createCommandRegistry()`.
- Keep long-running process state in the Electron backend, bridge process, persistent store, or external process; renderer state should rehydrate from backend snapshots.
- Use the existing `CommandContext` and `StorageService` patterns instead of adding renderer-only state for Docker, tmux, terminal, or local server lifecycles.
- Do not log secrets such as API keys, tokens, SSH keys, or credential file contents.

## Key Files Reference

### Frontend

| File                                            | Purpose                     |
| ----------------------------------------------- | --------------------------- |
| `src/components/codex/CodexChatTab.tsx`         | Codex Native Mode chat      |
| `src/components/terminal/TerminalContainer.tsx` | xterm.js integration        |
| `src/components/opencode/OpenCodeChatTab.tsx`   | OpenCode Native Mode chat   |
| `src/lib/codex-client.ts`                       | Codex bridge client wrapper |
| `src/lib/opencode-client.ts`                    | OpenCode SDK v2 wrapper     |
| `src/stores/codexStore.ts`                      | Codex state management      |
| `src/stores/openCodeStore.ts`                   | OpenCode state management   |
| `src/lib/native/backend.ts`                     | Native IPC command wrapper  |

### Backend

| File                           | Purpose                                      |
| ------------------------------ | -------------------------------------------- |
| `electron/backend/commands.ts` | Backend command registry and Docker/local env management |
| `electron/backend/tmux.ts`     | Claude tmux mode backend                     |
| `electron/backend/storage.ts`  | JSON file persistence                        |
| `electron/ipc.ts`              | Main-process IPC handlers                    |
| `electron/preload-api.ts`      | Renderer-facing native API                   |

### Docker

| File                      | Purpose                |
| ------------------------- | ---------------------- |
| `docker/Dockerfile`       | Base image definition  |
| `docker/entrypoint.sh`    | Container entrypoint   |
| `docker/init-firewall.sh` | Network firewall rules |

## Docker Base Image

The container includes:
- Node.js 20
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
- **macOS**: `~/Library/Application Support/orkestrator-ai/`
- **Linux**: `~/.config/orkestrator-ai/`

Files:
- `config.json` - Global and per-repo settings
- `projects.json` - Repository metadata
- `environments.json` - Environment metadata and container IDs

## Testing

```bash
bun test                      # Test suite
bunx tsc --noEmit             # Renderer TypeScript type checking
bunx tsc -p tsconfig.electron.json # Electron TypeScript type checking
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
2. Components are in `src/components/ui/`
3. Follow existing patterns in the codebase
4. Use Tailwind CSS v4 for styling

## State Management

- **Zustand** for global state (`src/stores/`)
- **React Context** for component-tree state (`src/contexts/`)
- Stores use `Map<string, T>` pattern for per-environment/per-session state
