# Orkestrator AI

A desktop application for managing isolated Docker-based development environments for Claude Code, Codex, and OpenCode. Create multiple sandboxed environments per repository, each with its own terminal session, Git branch, and PR workflow.

## Features

- **Project Management**: Add Git repositories and manage multiple environments per project
- **Isolated Environments**: Each environment runs in its own Docker container with network isolation
- **Embedded Terminal**: Full xterm.js terminal with ANSI color support
- **GitHub Integration**: Create and view pull requests directly from the UI
- **Remote Web Gateway**: Access the app from another browser on your Tailscale network
- **Configuration**: Global and per-repository settings for SSH keys, resource limits, and branches
- **Security**: Network firewall restricts outbound traffic to approved domains only

## Screenshots

```
+------------------+----------------------------------------+
| < Back           |  my-repo [gear]           [Create PR] |
+------------------+----------------------------------------+
| + Create New     |                                        |
|   Environment    |  $ claude                              |
+------------------+                                        |
| [green] my-repo- |  Welcome to Claude Code!               |
|   20260106  [x]  |                                        |
+------------------+  > _                                   |
| [grey] my-repo-  |                                        |
|   20260105  [x]  |                                        |
+------------------+----------------------------------------+
```

## Prerequisites

- [Bun](https://bun.sh) 1.3.14 or newer - JavaScript runtime, package manager, and native PTY provider
- [Docker](https://docker.com) - Container runtime
- [Tailscale](https://tailscale.com) - Optional, required for remote browser access through the gateway

## Quick Start

```bash
# Clone the repository
git clone <repo-url>
cd orkestrator-ai

# Install dependencies
bun install

# Build the Docker base image (required for container functionality)
docker build -t orkestrator-v2:latest -f docker/Dockerfile .

# Run the application
bun run dev
```

## Usage

### Adding a Project

1. Click "Add Project" in the sidebar
2. Enter the Git repository URL or select a local folder
3. The project appears in the sidebar

### Creating an Environment

1. Click on a project to expand it
2. Click "Create New Environment"
3. A new container is provisioned with:
   - Your `~/.claude` credentials (read-only)
   - SSH key for Git operations
   - Repository cloned to `/workspace`
   - Claude Code CLI ready to use

### Working with Environments

- Click an environment to open its terminal
- The terminal connects to the running container
- Use "Create PR" to run `gh pr create` interactively
- After PR creation, the button becomes "View PR"

### Shared Backend And Web Access

The backend is a standalone-capable Bun service in `apps/backend` and is the authoritative owner of Docker, terminal, storage, and agent state. There are two supported launch modes:

- `bun run dev` starts Electron, and Electron supervises one backend instance. That same instance serves the Electron renderer and authenticated web clients. It binds to Tailscale on port `34121` when available and otherwise falls back to local-only access at `127.0.0.1:34121`.
- `bun run start:web` builds and starts the backend without Electron. The backend serves the built React app directly to authenticated browsers.

For local web development with Vite and the backend in one Turbo invocation:

```bash
bun run dev:web
```

Open the backend URL printed in the logs (normally `http://127.0.0.1:34121/` without Tailscale), not the internal Vite URL on port `1420`.

To build and start the standalone service on a machine connected to your tailnet:

```bash
bun run start:web
```

By default the service detects and binds to the first Tailscale address on port `34121`. For a local-only development instance, bind explicitly:

```bash
bun run --cwd apps/backend start --host 127.0.0.1 --port 34121 --unsafe-allow-non-tailscale-bind
```

By default the gateway listens on port `34121`. Look for a startup log like:

```text
[RemoteGateway] Listening on http://100.x.y.z:34121/
[RemoteGateway] Auth token stored at /path/to/gateway-auth.json
```

Open the logged URL from another browser on the same tailnet, then enter the token from the host machine. See [Standalone Backend and Remote Gateway](docs/remote-gateway.md) for service flags, environment variables, security notes, and troubleshooting.

### Configuration

Access settings via the gear icon:

**Global Settings:**
- SSH key path (default: `~/.ssh/id_rsa`)
- CPU cores limit (default: 2)
- Memory limit (default: 4GB)
- .env file patterns

**Per-Repository Settings:**
- Default branch to clone
- PR base branch

**Per-Environment Settings:**
- Debug mode - enables verbose logging during container startup

### Debug Mode

Each environment can have debug mode enabled, which provides verbose logging during container startup. This is useful for troubleshooting credential injection, configuration copying, and other initialization issues.

When debug mode is enabled, the container entrypoint will output:
- List of files copied from `~/.claude`
- `.claude.json` processing details (file sizes, keys)
- Credential injection status

Debug mode only takes effect when the container is created. Changing it on a running environment requires recreating the container.

## Development

```bash
# Run with hot reload
bun run dev

# Run tests
bun test

# Build for production
bun run build
```

## Monorepo Layout

```text
apps/backend/   Standalone Bun service and authoritative long-running state
apps/desktop/   Electron shell, preload API, native IPC, and backend supervision
apps/web/       React/Vite application used by Electron and remote browsers
packages/       Shared cross-runtime contracts and validation
bridges/        Claude and Codex native-mode bridge services
```

The web application is independently built. Electron loads it as its renderer while the Electron-supervised backend serves the same renderer to authenticated browsers. The same backend can instead run standalone without Electron.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Electron shell and/or web browsers: React + Zustand     │
│             HTTP commands + server-sent events          │
├─────────────────────────────────────────────────────────┤
│ One Bun backend service (Electron-supervised or standalone) │
│ Docker · PTY sessions · agent bridges · JSON storage    │
├─────────────────────────────────────────────────────────┤
│                    Docker Containers                     │
│  ┌────────────────────────────────────────────────────┐ │
│  │ orkestrator-v2:latest                              │ │
│  │ - Node.js 20 + Claude Code CLI                     │ │
│  │ - Git + GitHub CLI                                 │ │
│  │ - Network firewall (GitHub, npm, Anthropic only)   │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Network Security

Containers have restricted network access via iptables firewall:

**Allowed domains:**
- GitHub (api.github.com, github.com)
- npm registry (registry.npmjs.org)
- Anthropic API (api.anthropic.com, statsig.anthropic.com)
- VS Code marketplace (for extensions)
- Sentry.io (error reporting)

All other outbound traffic is blocked.

The remote gateway binds only to Tailscale addresses by default and requires a gateway token before serving the app, backend API, event stream, or loopback proxy routes.

## Configuration Storage

Application data is stored in:
- **macOS**: `~/Library/Application Support/orkestrator-ai/`
- **Linux**: `~/.config/orkestrator-ai/`

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, shadcn/ui, Zustand, xterm.js
- **Backend**: Electron, Node.js, TypeScript
- **Container**: Docker with custom base image

## License

MIT
