# Orkestrator AI

A desktop application for managing isolated Docker-based development environments for Claude Code, Codex, and OpenCode. Create multiple sandboxed environments per repository, each with its own terminal session, Git branch, and PR workflow.

## Features

- **Project Management**: Add Git repositories and manage multiple environments per project
- **Isolated Environments**: Each environment runs in its own Docker container with network isolation
- **Embedded Terminal**: Full xterm.js terminal with ANSI color support
- **GitHub Integration**: Create and view pull requests directly from the UI
- **Remote Web Gateway**: Access the app from another browser on your Tailscale network
- **Static Public Client**: Deploy `apps/web-public` to Vercel and connect the browser directly to a tailnet backend
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

- macOS or Linux. Windows is not supported because terminal sessions use Bun's native PTY.
- [Bun](https://bun.sh) 1.4.0 or newer - JavaScript runtime, package manager, and native PTY provider
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

### Packaging the macOS app

For a fast local build, package and install the unpacked app with local ad-hoc
signing, without Apple Developer ID signing, notarization, or DMG creation:

```bash
bun run package
```

For a distributable DMG, opt into both Developer ID signing and Apple
notarization:

```bash
bun run package:release
```

The release command relies on electron-builder's standard signing identity and
Apple notarization environment variables. It is expected to fail when the
required certificate or notarization credentials are unavailable.

### Published container image

Release images are published for AMD64 and ARM64 through GitHub Container
Registry. Pull the current stable image and give it the local tag expected by
Orkestrator:

```bash
docker pull ghcr.io/orkestrator-ai/orkestrator-v2:latest
docker tag ghcr.io/orkestrator-ai/orkestrator-v2:latest orkestrator-v2:latest
```

Versioned images are also available, for example
`ghcr.io/orkestrator-ai/orkestrator-v2:2.8.1`. Pin a version or digest when a
reproducible environment is more important than automatically receiving the
latest release.

#### Publishing a release

The `Publish container image` GitHub Actions workflow runs when a semantic
version tag is pushed. The tag must match the version in the root
`package.json`:

```bash
git tag v2.8.1
git push origin v2.8.1
```

Stable releases receive full, major/minor, major, `latest`, and commit-SHA
tags. Pre-release versions receive version and commit-SHA tags but do not move
`latest`. The workflow also publishes build-provenance attestations.

GitHub creates a new container package as private. After the first successful
publish, an owner of the `orkestrator-ai` organization must open **Packages >
orkestrator-v2 > Package settings > Change visibility** and select **Public**.
This is a one-time operation, and GitHub does not allow a public package to be
made private again.

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

### Connecting `orkestrator.dev` to a Local Instance

[`orkestrator.dev`](https://www.orkestrator.dev) is a static web client. It loads the Orkestrator interface in your browser, then connects directly to a backend running on your machine. Your commands, terminal traffic, and agent sessions are not relayed through the website.

Both the machine running Orkestrator and the device with the browser must be signed in to the same [Tailscale](https://tailscale.com) network. The hosted client also requires a tailnet-only HTTPS address; a plain `http://100.x.y.z:34121` gateway URL will be blocked by the browser as mixed content.

1. Make sure Tailscale is connected on both devices.
2. In the Electron app, open **Settings > Web client**, enable **Allow web access**, and save. The app keeps its existing backend running, allows the hosted Orkestrator origins, and publishes it through Tailscale Serve.
3. Copy the HTTPS backend address and gateway token shown in that settings panel.
4. Open [`https://www.orkestrator.dev`](https://www.orkestrator.dev) from a browser on the same tailnet.
5. Enter the HTTPS address as the **Backend address** and the token as the **Gateway token**, then select **Connect directly**. Use the origin only—do not add a path, query string, or token to the URL.

For a standalone backend without Electron, run:

```bash
bun run start:web-public
```

To install Bun when necessary and run the published backend without cloning the
repository, use:

```bash
curl -fsSL https://orkestrator.dev/install.sh | \
  bash -s -- --tailscale-serve \
  --allowed-origins https://orkestrator.dev,https://www.orkestrator.dev
```

If Bun is already installed, the equivalent command is:

```bash
bunx orkestrator \
  --tailscale-serve \
  --allowed-origins https://orkestrator.dev,https://www.orkestrator.dev
```

On macOS, Orkestrator automatically detects the CLI bundled with `/Applications/Tailscale.app`. If Tailscale is installed somewhere else, provide its executable explicitly:

```bash
ORKESTRATOR_TAILSCALE_BIN="/custom/path/to/tailscale" bun run start:web-public
```

With the standalone macOS Tailscale client, you can instead install its [command-line integration](https://tailscale.com/docs/reference/tailscale-cli?tab=macos) from **Tailscale > Settings > CLI integration** and then use the shorter command on future runs.

Keep this process running while using the web client. It builds the backend, allows requests from both `https://orkestrator.dev` and `https://www.orkestrator.dev`, and publishes the local service through Tailscale Serve. Do not run it alongside Electron with the same data directory. Do not use Tailscale Funnel; the backend is intended to remain private to your tailnet.

For the standalone command, copy these two values from the startup output:

- The HTTPS address shown by `[TailscaleServe] Available at`, such as `https://workstation.example-tailnet.ts.net`
- The token in the `gateway-auth.json` file shown by `[RemoteGateway] Auth token stored at`

On macOS, print only the token value with:

```bash
bun -e 'console.log((await Bun.file(process.env.HOME + "/Library/Application Support/orkestrator-v2/gateway-auth.json").json()).token)'
```

On Linux, the default file is `~/.config/orkestrator-v2/gateway-auth.json`. If the startup log shows a different path, read that file instead. Keep the token private; it grants access to the local Orkestrator backend.

The backend address is remembered in the browser. The token lasts for the current browser tab unless you enable **Remember token**. Once connected, use the connection indicator at the bottom of the page to change or forget the backend.

If the connection fails:

- **Could not reach the backend:** Confirm the backend process is still running, both devices are on the same tailnet, and the address starts with `https://`.
- **Site is not in the backend's allowed origins:** Enable web access in Electron settings, or start the standalone backend with `bun run start:web-public`; both allow the apex and `www` Orkestrator origins.
- **Gateway token was rejected:** Reopen the current `gateway-auth.json` file and copy its `token` value without quotes or extra whitespace.
- **`Executable not found in $PATH: "tailscale"`:** Install Tailscale's CLI integration or set `ORKESTRATOR_TAILSCALE_BIN` to the executable's absolute path.
- **Tailscale Serve fails to start:** Confirm the Tailscale app is connected and that HTTPS/Serve is enabled for the tailnet. The first Serve setup may require approval from a tailnet administrator.

For custom ports, origins, service management, and more troubleshooting, see [Standalone Backend and Remote Gateway](docs/remote-gateway.md#vercel-hosted-public-client).

### Shared Backend And Web Access

The backend is a standalone-capable Bun service in `apps/backend` and is the authoritative owner of Docker, terminal, storage, and agent state. There are two supported launch modes:

- `bun run dev` starts Electron, and Electron supervises one backend instance. Electron talks to an ephemeral loopback control listener, while authenticated browser clients use a separate Tailscale listener on port `34121` (or a local-only fallback). Losing Tailscale or encountering a browser-port conflict does not take down the desktop control channel.
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
bun run --cwd apps/backend start --host 127.0.0.1 --port 34121 --allow-non-tailscale-bind
```

By default the gateway listens on port `34121`. Look for a startup log like:

```text
[RemoteGateway] Listening on http://100.x.y.z:34121/
[RemoteGateway] Auth token stored at /path/to/gateway-auth.json
```

Open the logged URL from another browser on the same tailnet, then enter the token from the host machine. See [Standalone Backend and Remote Gateway](docs/remote-gateway.md) for service flags, environment variables, security notes, and troubleshooting.

To deploy a static frontend separately, use `apps/web-public`. Vercel only delivers its asset bundle; the browser connects directly to the selected HTTPS backend on the user's local or Tailscale network. The backend traffic is never routed through Vercel. See the public-client section in [Standalone Backend and Remote Gateway](docs/remote-gateway.md#vercel-hosted-public-client).

The standalone backend can configure the tailnet-only HTTPS listener itself. The convenience script assumes the public client is hosted at `https://orkestrator.dev`:

```bash
bun run start:web-public
```

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

For isolated real-stack development and agent QA, including disposable fixtures,
dynamic ports, status manifests, Playwright, Electron smoke testing, and safe
cleanup, see [Isolated development and agent testing](docs/development/agent-testing.md).

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
bridges/        Claude, Codex, Cursor SDK, Pi SDK, and Grok ACP bridge services
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
│  │ - Node.js 24 LTS + Claude Code CLI                 │ │
│  │ - Git + GitHub CLI                                 │ │
│  │ - Network firewall (GitHub, npm, Anthropic only)   │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Agent engines

Orkestrator supports five coding agents — Claude Code, Codex, OpenCode, Cursor
Agent, and Grok Build — and they do not share one integration mechanism. Each
vendor exposes a different surface (a TypeScript SDK, a JSON-RPC app-server, an
HTTP server, or a raw stdio protocol), so each gets its own adapter behind a
common contract.

[**docs/technical-architecture/agent-engines.md**](docs/technical-architecture/agent-engines.md)
explains how all five work: process topology, transport, session and approval
handling, and the invariants they share.

| Related | Document |
| --- | --- |
| Bumping an agent SDK, CLI, or pinned binary | [`docs/upgrade-agents.md`](docs/upgrade-agents.md) |
| Contributing agent guidance and invariants | [`AGENTS.md`](AGENTS.md) |

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
- **macOS**: `~/Library/Application Support/orkestrator-v2/`
- **Linux**: `${XDG_CONFIG_HOME:-~/.config}/orkestrator-v2/`

On first launch, Orkestrator downloads the pinned Codex, OpenCode, and Claude Code
executables into the versioned `toolchains/` directory under this location. Each
archive and extracted executable is checked against hashes embedded in the signed
desktop application before it is activated. The cache is shared by all local
worktree environments and reused across application upgrades. Bun remains bundled
with the desktop application so the backend can always start and report download
or recovery errors.

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, shadcn/ui, Zustand, xterm.js
- **Backend**: Electron, Node.js, TypeScript
- **Container**: Docker with custom base image

## License

MIT
