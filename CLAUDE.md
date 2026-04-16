# Orkestrator AI

A Tauri desktop application for managing isolated development environments for AI coding agents (Claude, Codex, and OpenCode).

## Environment Types

Orkestrator supports two types of development environments:

### Containerized Environments (Docker)

Containerized environments run in isolated Docker containers with network firewall restrictions. These provide:
- Full isolation from the host system
- Network access control (only allowed domains can be accessed)
- Reproducible development environments
- Custom base image with Claude Code CLI pre-installed

### Local Environments (Git Worktrees)

Local environments run directly on the host machine using Git worktrees. These provide:
- Direct access to the local filesystem
- Faster startup times (no container overhead)
- Access to local tools and configurations
- Git worktree-based isolation for multiple environment branches

## Agent Modes

Claude, Codex, and OpenCode agents can run in different modes:

### Terminal Mode (Standard)

Terminal mode runs the agent's CLI interface inside an xterm.js terminal. This is the traditional command-line experience where you interact with the agent through text input/output in a terminal emulator.

- **Claude**: Runs `claude` CLI in the terminal
- **Codex**: Runs `codex` CLI in the terminal
- **OpenCode**: Runs `opencode` CLI in the terminal

### Native Mode

Native mode provides a custom chat-style UI that communicates with a backend server instead of running the CLI directly:

- **Claude Native Mode**: Uses a bridge server (`claude-bridge`) that wraps the Claude Agent SDK. The frontend communicates via HTTP/SSE to the bridge server which manages Claude sessions.
- **Codex Native Mode**: Uses a bridge server (`codex-bridge`) that manages Codex sessions over HTTP/SSE for the custom frontend UI.
- **OpenCode Native Mode**: Uses the OpenCode server (`opencode serve`) which exposes an HTTP API. The frontend uses `@opencode-ai/sdk` v2 to communicate with the server.

Native mode benefits:
- Rich UI with message rendering, tool visualization, and file attachments
- Interactive question/answer cards for agent questions
- Better control over session management
- Real-time streaming via Server-Sent Events (SSE)

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, shadcn/ui, Zustand, xterm.js
- **Backend**: Rust, Tauri v2, Bollard (Docker client)
- **Containerization**: Docker with custom base image
- **Native Bridges**: Node.js bridge servers for Claude and Codex native mode
- **OpenCode Integration**: `@opencode-ai/sdk` v2 (use `@opencode-ai/sdk/v2/client` import path)

## Project Structure

```
orkestrator-ai/
├── src/                    # React frontend
│   ├── components/         # UI components (shadcn/ui based)
│   │   ├── codex/          # Codex Native Mode components
│   │   ├── opencode/       # OpenCode Native Mode components
│   ├── hooks/              # React hooks
│   ├── stores/             # Zustand state stores
│   ├── contexts/           # React contexts
│   └── lib/                # Utilities and Tauri wrappers
├── src-tauri/              # Rust backend
│   └── src/
│       ├── commands/       # Tauri IPC commands
│       ├── docker/         # Bollard Docker client (containerized envs)
│       ├── local/          # Local environment management (worktrees, servers)
│       ├── pty/            # Terminal session management
│       ├── storage/        # JSON file persistence
│       └── models/         # Data models
├── bridges/                # Bridge servers for native agent modes
│   ├── claude-bridge/      # Claude Native Mode bridge server (Node.js)
│   └── codex-bridge/       # Codex Native Mode bridge server (Node.js)
├── docker/                 # Docker configuration
│   ├── Dockerfile          # Base image definition
│   ├── entrypoint.sh       # Container entrypoint
│   └── init-firewall.sh    # Network firewall setup
└── docs/                   # Documentation and stories
```

## Development

### Prerequisites

- [Bun](https://bun.sh) (package manager and runtime)
- [Rust](https://rustup.rs) (for Tauri backend)
- [Docker](https://docker.com) (for container functionality)

### Setup

```bash
# Install dependencies
bun install

# Build the Docker base image
docker build -t orkestrator-ai:latest -f docker/Dockerfile .
```

### Running

```bash
# Run the full Tauri application (recommended)
bun run tauri dev

# Run just the frontend (for UI development)
bun run dev
```

### Testing

```bash
# Run frontend tests
bun test

# Run Rust tests
cd src-tauri && cargo test

# Run TypeScript type checking
bunx tsc --noEmit
```

### Building

```bash
# Build for production
bun run tauri build
```

## Bun Preferences

Default to using Bun instead of Node.js:

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install`
- Use `bun run <script>` instead of `npm run <script>`
- Use `bunx <package>` instead of `npx <package>`
- Bun automatically loads .env files

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
- Allowed: GitHub, npm registry, Anthropic API, VS Code marketplace
- All other outbound traffic is blocked

## Key Files by Environment Type

### Containerized Environments (Docker)

| File | Purpose |
|------|---------|
| `src-tauri/src/docker/client.rs` | Core Docker API client using Bollard |
| `src-tauri/src/docker/container.rs` | Container provisioning and lifecycle |
| `docker/Dockerfile` | Base image definition |
| `docker/entrypoint.sh` | Container startup script |
| `docker/init-firewall.sh` | Network firewall setup |
| `docker/workspace-setup.sh` | Workspace initialization in container |
| `src-tauri/src/pty/mod.rs` | PTY session management for containers |
| `src-tauri/src/commands/terminal.rs` | Container terminal Tauri commands |

### Local Environments (Git Worktrees)

| File | Purpose |
|------|---------|
| `src-tauri/src/local/worktree.rs` | Git worktree creation and management |
| `src-tauri/src/local/pty.rs` | PTY management for local environments |
| `src-tauri/src/local/process.rs` | Process management for local servers |
| `src-tauri/src/local/ports.rs` | Port allocation and management |
| `src-tauri/src/local/servers.rs` | Local server lifecycle (OpenCode/Claude bridge) |
| `src-tauri/src/commands/local_terminal.rs` | Local terminal Tauri commands |
| `src-tauri/src/commands/local_servers.rs` | Local server management commands |

### Shared Environment Files

| File | Purpose |
|------|---------|
| `src-tauri/src/models/mod.rs` | Environment types (`EnvironmentType` enum) |
| `src-tauri/src/commands/environments.rs` | Environment CRUD commands |
| `src/stores/environmentStore.ts` | Environment state management |
| `src/components/environments/CreateEnvironmentDialog.tsx` | Environment creation UI |

## Key Files by Agent Mode

### Terminal Mode (Both Agents)

| File | Purpose |
|------|---------|
| `src/components/terminal/TerminalContainer.tsx` | Main terminal container with tabs |
| `src/components/terminal/PersistentTerminal.tsx` | Terminal session persistence |
| `src/components/terminal/ComposeBar.tsx` | Terminal compose bar |
| `src/stores/terminalSessionStore.ts` | Terminal session state |

### Claude Native Mode

| File | Purpose |
|------|---------|
| `src/components/claude/ClaudeChatTab.tsx` | Main chat interface |
| `src/components/claude/ClaudeComposeBar.tsx` | Message input with attachments |
| `src/components/claude/ClaudeMessage.tsx` | Message rendering with tools |
| `src/components/claude/ClaudeQuestionCard.tsx` | Interactive question/answer UI |
| `src/lib/claude-client.ts` | Claude bridge server client wrapper |
| `src/stores/claudeStore.ts` | Zustand store for Claude sessions |
| `src-tauri/src/commands/claude.rs` | Claude bridge commands (container) |
| `bridges/claude-bridge/src/index.ts` | Bridge server entry point |
| `bridges/claude-bridge/src/services/session-manager.ts` | Claude Agent SDK integration |
| `bridges/claude-bridge/src/routes/session.ts` | Session API endpoints |
| `bridges/claude-bridge/src/routes/events.ts` | SSE event subscription |

### Codex Native Mode

| File | Purpose |
|------|---------|
| `src/components/codex/CodexChatTab.tsx` | Main Codex chat interface |
| `src/components/codex/CodexComposeBar.tsx` | Message input for Codex sessions |
| `src/components/codex/CodexPlanModeCard.tsx` | Plan-mode controls for Codex |
| `src/components/codex/CodexResumeSessionDialog.tsx` | Resume-session UI |
| `src/lib/codex-client.ts` | Codex bridge client wrapper |
| `src/stores/codexStore.ts` | Zustand store for Codex sessions |
| `src-tauri/src/commands/codex.rs` | Codex bridge commands (container) |
| `src-tauri/src/commands/local_servers.rs` | Local Codex bridge commands |
| `bridges/codex-bridge/src/index.ts` | Codex bridge entry point |

## Claude Store Session Identifiers

The Claude store uses two different types of session identifiers. Understanding the distinction is critical to avoid bugs.

### Identifier Types

| Type | Format | Example | Usage |
|------|--------|---------|-------|
| `ClaudeSessionKey` | `env-{environmentId}:{tabId}` | `env-a33f9026-8cfe-4077-aefd-4db2c2637dcc:default` | Store Map keys |
| `ClaudeSdkSessionId` | `session-{uuid}` | `session-e4abc3ee-b0a9-4328-9bf3-28376ddb7b3d` | Claude SDK/API |

### When to Use Each

**ClaudeSessionKey** (store key):
- Accessing/modifying data in the Zustand store Maps
- Parameters to store actions: `addMessage()`, `setSession()`, `setSessionLoading()`, etc.
- Created via `createClaudeSessionKey(environmentId, tabId)`

**ClaudeSdkSessionId** (SDK session ID):
- Received from SSE events (`event.sessionId`)
- Sent to the Claude bridge server API
- Stored in `ClaudeSessionState.sessionId`

### Converting Between Types

When handling SSE events, you receive a `ClaudeSdkSessionId` but need to update the store which is keyed by `ClaudeSessionKey`. Use the store helper:

```typescript
// In SSE event handler
const matchedSessionKey = getSessionKeyBySdkSessionId(eventSessionId);
if (matchedSessionKey) {
  addMessage(matchedSessionKey, systemMessage);
}
```

### Store Map Key Reference

| Map | Key Type | Notes |
|-----|----------|-------|
| `sessions` | `ClaudeSessionKey` | Session state including messages |
| `attachments` | `ClaudeSessionKey` | File attachments for compose bar |
| `draftText` | `ClaudeSessionKey` | Unsent message text |
| `thinkingEnabled` | `ClaudeSessionKey` | Extended thinking toggle |
| `planMode` | `ClaudeSessionKey` | Plan mode toggle |
| `selectedModel` | `ClaudeSessionKey` | Selected model per session |
| `serverStatus` | `environmentId` | Server running state (raw UUID) |
| `clients` | `environmentId` | HTTP client instances (raw UUID) |
| `eventSubscriptions` | `environmentId` | SSE subscription state (raw UUID) |
| `pendingQuestions` | `requestId` | Question ID from SDK |
| `pendingPlanApprovals` | `requestId` | Approval ID from SDK |

### OpenCode Native Mode

| File | Purpose |
|------|---------|
| `src/components/opencode/OpenCodeChatTab.tsx` | Main chat interface |
| `src/components/opencode/OpenCodeComposeBar.tsx` | Message input with attachments |
| `src/components/opencode/OpenCodeMessage.tsx` | Message rendering with tools |
| `src/components/opencode/OpenCodeQuestionCard.tsx` | Interactive question/answer UI |
| `src/lib/opencode-client.ts` | OpenCode SDK v2 client wrapper |
| `src/stores/openCodeStore.ts` | Zustand store for OpenCode sessions |
| `src-tauri/src/commands/opencode.rs` | OpenCode server commands (container) |

## OpenCode SDK v2

We use the **v2 API** of the `@opencode-ai/sdk` package. This is important because v1 and v2 have different API structures.

**Import path**: Always import from `@opencode-ai/sdk/v2/client`:

```typescript
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
```

**Key differences from v1**:
- Session methods use `sessionID` parameter directly instead of `path: { id: sessionId }`
- Create session uses flat parameters: `{ title }` instead of `{ body: { title } }`
- v2 includes the `question` API for interactive prompts (v1 doesn't)

**SDK features used**:
- `client.session.*` - Session management (create, messages, promptAsync, abort, delete)
- `client.config.providers()` - Get available models
- `client.event.subscribe()` - SSE event stream for real-time updates
- `client.question.*` - Interactive question/answer handling (list, reply, reject)

## Configuration Storage

Application data is stored in:
- **macOS**: `~/Library/Application Support/orkestrator-ai/`
- **Linux**: `~/.config/orkestrator-ai/`

Files:
- `config.json` - Global and per-repo settings
- `projects.json` - Repository metadata
- `environments.json` - Environment metadata and container IDs

## Bun `mock.module()` Rules

Bun's module mocking is **global at the module-cache level**. In this repo, top-level `mock.module()` calls can leak across test files even when `mock.restore()` is used later.

Use this stable pattern:

1. Put truly shared mocks in `tests/setup.ts`.
   - Example: `@tauri-apps/api/*` and `@tauri-apps/plugin-clipboard-manager` are registered once there so files do not fight over competing global mocks.
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

## Rust Logging

The backend uses the `tracing` crate for structured logging. **Never use `println!` for logging** - always use the appropriate tracing macros.

### Log Levels

Use the appropriate log level for each message:

| Level | Macro | Use Case |
|-------|-------|----------|
| `error!` | Critical failures that need immediate attention |
| `warn!` | Unexpected conditions that don't prevent operation |
| `info!` | Important operational events (container started, removed, etc.) |
| `debug!` | Detailed information useful for debugging |
| `trace!` | Very detailed information (loop iterations, state changes) |

### Usage Pattern

```rust
use tracing::{debug, info, warn, error, trace};

// Structured logging with named fields (preferred)
debug!(container_id = %id, status = %status, "Container status updated");
warn!(environment_id = %env_id, error = %e, "Failed to rename git branch");
info!(container_id = %id, "Removed orphaned container");

// Simple messages (acceptable for straightforward cases)
debug!("Starting background naming task");
```

### Import Convention

Only import the log levels you need:

```rust
use tracing::{debug, warn};  // Good - only what's needed
use tracing::*;              // Avoid - imports everything
```

### Guidelines

1. **Use structured fields** for IDs, errors, and key values - this enables log filtering and analysis
2. **Keep messages concise** - the structured fields provide context
3. **Don't log sensitive data** - avoid logging API keys, tokens, or credentials
4. **Use `%` for Display trait** and `?` for Debug trait in field values
5. **Prefer `debug!` over `trace!`** for most development logging
