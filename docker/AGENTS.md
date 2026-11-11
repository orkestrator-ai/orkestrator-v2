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
| `orkestrator-egress-filter.pl` | The gateway's name checks: TLS SNI, HTTP Host and DNS against the allowlist |
| `update-firewall.sh`    | Operator-only allowlist edits via `docker exec --user root` |
| `runtime-env.sh`        | PATH/env snapshot so `docker exec` sees setup-time tools |
| `git-branch-helpers.sh` | Makes a bare `git push` publish and track the branch     |
| `orkestrator-git-credential.sh` | Git credential helper that reads the GitHub token file |
| `verify-playwright.cjs` | Launches Chromium; run at build time and on demand       |
| `verify-root-boundary.sh` | Build-time check that root uses nothing `node` can write |
| `tests/root-boundary-smoke.sh` | Plants files as `node` in a built image; root must run none |

## Image contents

The image is built from `oven/bun:1.4.4-debian`, matching the Bun version
managed in `mise.toml` for development and CI. Every agent CLI version below
is pinned by an `ARG` in `docker/Dockerfile`, which is its container source of
truth.

Runtimes:
- Bun, the base image's own binary, registered in mise's shared system tool
  directory with `mise link` (never downloaded a second time).
- Node.js 24 LTS, installed over the base image and verified against the
  published checksum. The agent CLIs need genuine Node, not bun's node shim.

Agent CLIs, one per supported platform (two for OpenCode while it moves to 2.x):
- Claude Code (`claude`), Codex (`codex`), OpenCode (`opencode`), and Pi
  (`pi`), whose runtime paths the backend reads from `CLAUDE_CLI_PATH`,
  `CODEX_CLI_PATH`, `OPENCODE_CLI_PATH`, and `PI_CLI_PATH`.
- Grok Build (`grok`) is downloaded as a hash-verified pinned artifact. Pi is
  downloaded the same way, as a bundle rather than a single file.
- OpenCode 1.x is root-owned in `/opt/opencode/bin`; `OPENCODE_CLI_PATH`
  (`/home/node/.opencode/bin/opencode`) is a symlink to it. The container's
  server runs it through the launcher (`opencode-launch=1`), so it must stay
  root-owned: a binary node could replace would run beside the password.
- OpenCode 2.x is installed beside 1.x as `opencode2`
  (`OPENCODE2_CLI_PATH`, `/home/node/.opencode/bin/opencode2`) from its
  hash-verified npm platform tarball, for the 2.x provider being built
  (`docs/todo/agent-engines/0008-opencode-v2.md`). The backend starts it on
  container port 4102 for OpenCode sessions on the 2.x line
  (`apps/backend/src/core/opencode2-container-server.ts`), with its own
  `OPENCODE_DB` (`opencode2.db`) and an `OPENCODE_CONFIG_DIR` holding only
  Orkestrator's plugins.
- The image build fails immediately if any managed CLI is not runnable, and if
  Codex did not vendor `codex-code-mode-host` beside its binary.

Prebuilt bridge servers, so a container never builds them at runtime:
- `/opt/claude-bridge`, `/opt/codex-bridge`, `/opt/cursor-bridge`,
  `/opt/pi-bridge`, and `/opt/acp-bridge` (used only by Grok Build). Root-owned:
  they run as `node`, and code `node` could replace would see every token presented
  to the bridge.
- `/run/orkestrator-bridge` holds each bridge's token, mode 700 root
  (`bridge-credential=1`), and with `bridge-launch=1` the private half of its
  authority key. Only the backend's root exec reads it; a bridge gets a hash and
  a public key (`apps/backend/src/core/container-bridge-credential.ts`). Never
  read a `node`-writable path as root to look for one: `node` can make it a
  symlink.
- `/usr/local/bin/orkestrator-bridge-launch` (`bridge-launch=1`) starts a bridge
  as `node` under `env -i`, with a fixed `PATH`, from `/`, with only the values
  the backend gives it on stdin. It must stay root-owned, run under `/bin/sh`
  (dash reads no startup file; bash would read `$BASH_ENV`), and call every
  program by a root-owned path. Never make it source anything `node` can write
  ([agent-approvals.md](../docs/architecture/agent-approvals.md#fixed-launch-bridge-launch1)).
  With `opencode-launch=1` it also starts OpenCode 1.x, from `/workspace`, with
  its configuration in root-owned `/run/orkestrator-opencode`. OpenCode takes a
  plain password, so that branch must never put a backend value in any argv
  (every argv is readable by `node`) nor leave a long-lived wrapper holding
  one in its environment
  ([agent-approvals.md](../docs/architecture/agent-approvals.md#opencode-under-the-launcher-opencode-launch1)).

Keep `COPY --chown=node:node patches /opt/bridge-build/patches` before the
filtered `bun install`: Bun validates root `patchedDependencies` even when the
filtered workspaces do not install OpenCode themselves.

Layer order is by how often a layer changes, rarest first, because a changed
layer re-pulls every layer after it: agent CLIs and the browser, then starship
and mise, then the vendored bridge SDKs (`/opt/bridge-deps/*`, one layer each),
then the bridge bundles, then the small scripts. Each global `npm install -g`
ends with `npm cache clean --force` in the same `RUN`, and there is one apt
layer; add packages to it rather than running `apt-get update` again.

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
- `workspace-setup.sh` clones from the project's read-only Git mirror when the
  backend names one in `ORKESTRATOR_GIT_MIRROR` (`git-mirror=1`). It must never
  stop setup: any problem falls through to the ordinary clone
  ([container-lifecycle.md](../docs/architecture/container-lifecycle.md#project-git-mirror)).
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
- Staged inputs (`staged-inputs=5`; 4 added `/agents-skills`, and 5 skips an input when
  copying it would change nothing, through `import_agent_input`): a new input goes through
  that wrapper unless it is a login, which uses `forget_unchanged_agent_login` and
  `remember_agent_login` around its copy
  ([container-lifecycle.md](../docs/architecture/container-lifecycle.md#input-stamps-staged-inputs5)).
  The backend's staged mounts are
  owner-only and belong to its user, so `node` cannot read them under
  rootless Docker (they are container root's) or on a rootful daemon whose
  host user is not uid 1000 (GitHub's runners). The root entrypoint relays
  each one `node` cannot read into `node`'s own
  `/run/orkestrator-inputs` before dropping privileges
  (`relay_staged_inputs`). `entrypoint.sh` reads a relayed copy in place of
  its mount (the copy helpers resolve their source root inline, and
  `staged_input_path` elsewhere); `workspace-setup.sh` uses `project_input`.
  Keep `STAGED_INPUT_MOUNTS` in step with the backend's mount targets
  (`apps/backend/tests/portable-inputs.test.ts` checks it). Never widen the
  mounts' permissions instead.
- `orkroot`, a uid-0 user for root terminal sessions. The backend opens those
  terminals with `docker exec --user orkroot`; `node` has no sudoers path to
  become `orkroot`.
- `node` cannot get code run as root through the files root uses either
  (security report H2). Keep these four rules when adding a root path:
  - Every root `docker exec` or `docker run` the backend makes passes
    `CONTAINER_ROOT_USER_ARGS` (`--env PATH=/usr/sbin:/usr/bin:/sbin:/bin
    --user root`, `apps/backend/src/core/container-scripts.ts`), and a root
    terminal gets the same PATH. The image `ENV PATH` puts `node`-writable
    `npm-global/bin` and `~/.opencode/bin` first, and every exec inherits it.
    `tests/unit/container-root-boundary.test.ts` fails on a bare
    `"--user", "root"` in the backend.
  - Every script root runs resets `PATH` to root-owned directories before
    its first command, so an older backend or a manual `docker exec -u root`
    is safe too. The entrypoint uses sudo's `secure_path`, which `node`'s
    `entrypoint.sh` inherits.
  - A root shell never sources a `node`-writable file. `runtime-env.sh` skips
    the `/tmp/orkestrator-ai` snapshot, `bash-env.sh` and the tool directories
    for uid 0, sets `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    and unsets `BASH_ENV`, `NPM_CONFIG_PREFIX` and `MISE_TRUSTED_CONFIG_PATHS`.
    It still reads the credential files, as data. Root zsh runs
    `compinit -i`.
  - Only the trees listed in `verify-root-boundary.sh` are `node`-writable.
    `/usr/local/share` is root-owned, with `npm-global` its own `node`-owned
    directory, because root zsh autoloads from
    `/usr/local/share/zsh/site-functions`. The image build fails when `node`
    can write anything else, or anything on a root PATH, root's `fpath` or
    sudo's `secure_path`.

  A root terminal therefore has no npm globals (`claude`, `codex`,
  `playwright`) or OpenCode on its PATH. Running one by absolute path runs
  `node`-writable code as root. `docker/tests/root-boundary-smoke.sh` (part of
  `final-image-smoke.sh`) plants files as `node` in a built image and fails if
  any root process runs them.
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

Run it as `node` in a live container. The Playwright package (under
`npm-global`) and the browsers in `/ms-playwright` are `node`-writable, so
launching them from a root terminal runs code the agent could have replaced.
The build-time root check is safe because nothing untrusted has run yet.

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
  Anthropic API, the VS Code marketplace, Context7, and
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
- Name checks (`egress-filter=1`, `orkestrator-egress-filter.pl`): a gateway
  on network policy 3 also runs a Perl daemon (base-system `perl-base`, so
  nothing new to download or pin) that the firewall redirects to. New TCP
  connections to an allowed tuple are DNATed to it, and it relays one only
  when the client's first bytes ask for an allowed name for that port: TLS
  SNI, or the Host of a plain HTTP request. Anything else is refused on TCP
  443 and relayed by address on any other named port (SSH to GitHub, a
  database). Every DNS query, to Docker's resolver or straight to any
  server, is redirected to it, and only allowlisted names (exact), GitHub's
  own names and `*.docker.internal` are forwarded; the rest get REFUSED with
  EDE 18. Its sockets carry `SO_MARK` (`0x6f726b`), which the workload
  cannot set (no `NET_ADMIN`, `NET_RAW` dropped), and only marked TCP and DNS
  pass the ACCEPT rules. Keep these when changing it:
  - It fails closed. With it dead, redirected connections are refused and
    queries get no answer; its supervisor restarts a dead worker within a
    second and the refresher a dead supervisor. Never add a fallback that
    lets unmarked traffic out.
  - Redirect to the namespace's own address, not to 127.0.0.1 (a
    non-loopback source routed to loopback is a martian, and
    `route_localnet` cannot be set from a container), and admit the
    redirected packet by its new destination: under iptables-nft the filter
    chain still sees the pre-NAT output interface.
  - Start it detached from the caller's jobs (`ork_start_filter`):
    `ork_resolve_all` waits for every background job.
  - `update-firewall.sh --set-domains` stages proposed DNS lookup names while
    retaining current connection permissions until the rebuild succeeds. A
    failure restores the prior names without revoking streams; success publishes
    the final permissions, and a name that leaves loses its open connections.
  - The gateway records `egress-filter` (`on`, or `off` when created with
    `ORKESTRATOR_EGRESS_FILTER=off`) at its first boot; a start never
    changes it, and an older image's gateway never runs it.
  - It counts refused connections and DNS queries since the gateway booted
    (`egress-refusals.json`, shown in the Network section) and records
    nothing else about them. Never add a refused name, part of one or a
    digest of one to a counter, log or report: a refused name can carry the
    data an agent tried to send. The firewall's own boot checks run under
    `egress-filter.quiet` so they are not counted.
  - It holds a first write of printable text that has no newline yet, so
    a request line sent a byte at a time cannot pass the Host check, and
    refuses it with no reply after `CLASSIFY_TIMEOUT` (30 s). A client-first
    text protocol on a named port must end its first command with `\n`
    (SMTP, Redis and the like already do); a live test must send whole
    lines, never a bare word. Do not relay a printable partial line early
    to make such a client work: that is the byte-at-a-time bypass.
  - It does not see a name hidden inside TLS (an encrypted ClientHello,
    domain fronting), checks only the first request of a kept-alive HTTP
    connection, and leaves UDP entries and other protocols to the address
    rules. A connection to an allowed address completes its handshake with
    the daemon first, so a closed upstream port reads as a reset rather than
    a refusal. Never describe it as preventing exfiltration.
- The one host port a restricted container may call is the backend's
  agent-tools server, at `host.docker.internal:<port>`
  (`host-service-ports`). That server listens on every host interface but
  closes, before reading the request, any connection whose peer is not
  loopback or, on native rootful Linux Engine only, inside a subnet of this
  backend's own Docker networks (the default `bridge` and every network carrying its
  owner label), so the LAN
  and a tailnet see a port that closes at once and no HTTP answer.
  On Linux Engine, a container on a hand-made network (a live test's, say)
  is refused unless the network carries the owner label; a labelled network
  the backend did not create itself is admitted by the next reload of the
  list, which a refused call triggers at most every 15 s. On Docker Desktop every container arrives from the host's
  loopback. Desktop, rootless daemons and non-Linux hosts use loopback-only admission,
  so VM/RootlessKit subnets overlapping host LAN/VPN ranges cannot admit outside
  peers. Linux refreshes check daemon topology and security options before
  reading subnets; unavailable topology clears subnet permissions. Details and the evidence are
  in [`container-lifecycle.md`](../docs/architecture/container-lifecycle.md#who-may-connect).

## Building

```bash
docker build -t orkestrator-v2:latest -f docker/Dockerfile .
```

Agent-test and fixture runs use the workspace-specific development image
(`mise run docker:build:dev --profile <name>`) and must never use or retag
`orkestrator-v2:latest`.
