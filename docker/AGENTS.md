# Docker base image

These rules apply to `docker/` and to container lifecycle code such as
`apps/backend/src/core/commands-containers.ts`. The root
[`AGENTS.md`](../AGENTS.md) still applies.

| File                    | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `Dockerfile`            | Base image definition                                    |
| `entrypoint.sh`         | Container entrypoint                                     |
| `workspace-setup.sh`    | Repo clone, `.env` files, project config, shown in terminal |
| `init-firewall.sh`      | Network firewall rules applied at startup                |
| `orkestrator-egress-gateway.sh` | Entrypoint of a restricted runtime's egress gateway |
| `update-firewall.sh`    | Operator-only allowlist edits via `docker exec --user root` |
| `runtime-env.sh`        | PATH/env snapshot so `docker exec` sees setup-time tools |
| `git-branch-helpers.sh` | Makes a bare `git push` publish and track the branch     |
| `verify-playwright.cjs` | Launches Chromium; run at build time and on demand       |

## Image contents

The image is built from `oven/bun:1.4.4-debian`, matching the Bun version
managed in `mise.toml` for development and CI. Every agent CLI version below
is pinned by an `ARG` in `docker/Dockerfile`, which is its container source of
truth.

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

Keep `COPY --chown=node:node patches /opt/bridge-build/patches` before the
filtered `bun install`: Bun validates root `patchedDependencies` even when the
filtered workspaces do not install OpenCode themselves.

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
- inotify-tools, for `orkestrator-worktree-signal`: the backend starts it per
  tracking lineage to ring when `/workspace` changes
  (`container-worktree-signal=1`, see
  [container-lifecycle.md](../docs/architecture/container-lifecycle.md#container-worktree-signal-container-worktree-signal1)).

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
  runtime joins its namespace with `NET_RAW` dropped, preventing packet sockets
  from bypassing OUTPUT filtering. Before admitting a workload, the gateway
  snapshots trusted resolver and host-service addresses on its private filesystem;
  all firewall lookups and updates use those snapshots across restarts, since
  Docker's shared network files can be modified by workload root. The runtime's root
  entrypoint then only verifies that the gateway rejects an unlisted
  destination (`egress-unverified` / `egress-gateway-unavailable` boot
  failures otherwise).

## Playwright

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

## Network isolation

Containers in `restricted` mode (the default) reach only an allowlist; anything
else is rejected outright. `full` mode skips the firewall entirely. A
restricted runtime from a current image is enforced from outside by its egress
gateway (root `AGENTS.md` "Network Isolation"); the scripts below run in
whichever container owns the network namespace.

- GitHub's own ranges are always resolved from `api.github.com/meta` at startup.
- Everything else comes from the environment's `ALLOWED_DOMAINS`, which the
  backend builds from the per-environment or global `allowedDomains` plus the
  hosts the enabled agent platforms require (`requiredAgentNetworkDomains`
  re-adds Codex's, Cursor's, OpenCode's, Grok's and Pi's hosts only when
  those platforms are enabled). Codex requires `chatgpt.com` and
  `auth.openai.com`; OpenCode requires `opencode.ai` for its own Zen and Go
  providers. Pi's
  list is necessarily partial: it fronts the user's own model providers, so a
  self-hosted endpoint or a regional mirror is a host only the user knows and
  belongs in `allowedDomains` rather than being guessed at.
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
- DNS and localhost are always allowed. There is no general SSH exception,
  and under network policy 3 an allowed domain is reachable on TCP 443 only
  unless its entry names a port (`host:port`, `host:port/udp`); GitHub's
  ranges also allow TCP 22. Earlier policies open every port of an allowed
  address. Host access and the rest of the policy are in the root
  `AGENTS.md` "Network Isolation".

## Building

```bash
docker build -t orkestrator-v2:latest -f docker/Dockerfile .
```

Agent-test and fixture runs use the workspace-specific development image
(`mise run docker:build:dev --profile <name>`) and must never use or retag
`orkestrator-v2:latest`.
