# Security Review — Orkestrator v2

Date: 2026-10-27
Commit reviewed: `1aabf049` (`2.33.0-beta`, branch `security-review-report-70a2015bc9a7-r1`)
Type: static source review (no code was run against live services, no network
probing). `bun audit` was run for dependency advisories.

## 1. Scope, method and threat model

The review covered the whole monorepo, split into seven surfaces that were each
traced end to end:

1. Backend HTTP/WebSocket gateway and authentication (`apps/backend/src/gateway*.ts`, `packages/cli`)
2. Browser previews, transcript artifacts and XSS in `apps/web` / `apps/web-public`
3. Electron desktop shell (`apps/desktop`)
4. Command injection and filesystem safety in the backend (`apps/backend/src/core`), plus the coordinator shell allowlist
5. Containers, image and egress firewall (`docker/`, container lifecycle code)
6. Control MCP, agent mail, coordinator, scheduled jobs, bridges and execution policy (`bridges/*`)
7. Secret storage, logging, CI and supply chain

The highest-impact findings were re-read against the source after the first
pass. Each finding is marked:

- **Verified**: the defect was confirmed by reading the cited code during the
  verification pass.
- **Reported**: traced during the review pass but not independently re-checked.
  Treat it as likely, and confirm before fixing.
- **Potential**: depends on runtime behaviour (browser cookie rules, Docker
  symlink resolution, image contents) that was not exercised.

Threat actors considered:

| Actor | Example |
| --- | --- |
| **A1. Untrusted agent** | A coding agent prompt-injected by repo content, a web page, a PR body, a ticket or mail. It runs inside a container (the stated isolation boundary) or a local worktree. |
| **A2. Malicious repository** | A cloned project or branch whose committed files (`.env` symlinks, `orkestrator-ai.json`, git config) are hostile. |
| **A3. Network peer** | Another host on the tailnet or LAN. |
| **A4. Malicious web page** | A page in the user's browser (CSRF, DNS rebinding, cross-origin WebSocket). |
| **A5. Local co-tenant** | Another local process or user on the host. |
| **A6. Supply chain** | npm or GitHub release compromise, dependency advisories. |

**Key framing.** A *local worktree* agent already runs as the user on the host,
so for it most "agent → host" escalations add nothing. The findings that matter
most break the **container boundary** (A1 in a container reaching the host or
the user's credentials), or let **repository content** (A2) act on the host
without the user's consent.

## 2. Executive summary

No Critical issues were found. Overall the codebase is well defended:

- tokens are compared in constant time;
- strict Origin/CORS gating;
- realpath- and `O_NOFOLLOW`-confined file access;
- git ref validation;
- the Electron IPC sender is checked on every handler;
- previews and artifacts are sandboxed;
- toolchain downloads are pinned to SHA-256;
- CI actions are pinned to a SHA with minimal permissions;
- approvals fail closed;
- there is an explicit, tested coordinator read-only policy.

There are no committed secrets.

The material risks are concentrated in four themes:

1. **Container → host escape paths, given one user action.** The gateway auth
   cookie *is* the durable gateway token and is not scoped by port. A browser
   that logged into the gateway-served client on `127.0.0.1` sends it to any
   container dev server the user opens on `127.0.0.1:<published port>` (H1).
   Legacy loopback previews also run agent HTML on the gateway origin with only
   a client-side iframe sandbox between them and the token (M1).
2. **Privilege boundaries inside the container are softer than documented.**
   Root-run scripts resolve binaries from `node`-writable directories, and root
   terminals source a `node`-owned file (H2). The bridge-control token can be
   read by the agent it controls, which defeats `approvals: "ask"` (H4).
3. **Repository content acting on the host.** `.env`/`.env.local`/`opencode.json`
   symlinks in the project checkout are bind-mounted into containers without
   `lstat` (H3). `setupLocal` commands from a branch run automatically on the
   host (M5). `.env` seeding writes through symlinks (L1).
4. **Breadth of credentials handed to agents.** The host `gh` token goes into
   every container by default (H5). The host `~/.claude.json` is staged
   unfiltered (M8). One settings command returns every stored secret unredacted
   (M3).

### Findings at a glance

| ID | Severity | Area | Title | Status |
| --- | --- | --- | --- | --- |
| H1 | High | Gateway | Auth cookie is the durable token and leaks to other ports on the same host | Verified (browser behaviour: standard) |
| H2 | High | Container | `node` can get code executed as root (PATH hijack of root scripts, `node`-owned runtime-env sourced by root) | Verified |
| H3 | High | Container | `.env` / `.env.local` / `opencode.json` symlinks bind-mount arbitrary host paths into the container | Verified code / Potential runtime |
| H4 | High\* | Bridges | Agent can read its own bridge token, then self-approve or widen its execution policy | Verified |
| H5 | High (design) | Container | Host GitHub CLI token injected into every container by default | Reported |
| M1 | Medium | Previews | Legacy loopback previews serve agent content on the gateway origin, CSP stripped, no server-side sandbox | Verified |
| M2 | Medium | Previews | Legacy loopback route reaches any host loopback port; credentialed CORS for `Origin: null` | Verified code / Potential |
| M3 | Medium | Secrets | `update_agent_messaging_settings` returns unredacted config (GitHub PAT, API keys) | Verified |
| M4 | Medium | Coordinator | Claude coordinator git allowlist admits `--git-dir` / `--work-tree` and similar | Fixed (see §4) |
| M5 | Medium | Host exec | Repo-provided `setupLocal` runs automatically on the host with no trust gate | Fixed (see §4) |
| M6 | Medium | Web/Electron | No CSP on the main renderer or the gateway-served app, which hold a generic command bridge | Verified |
| M7 | Medium | Electron | OS sandbox disabled for every window that loads the preload | Reported |
| M8 | Medium | Container | Host `~/.claude.json` staged unfiltered and readable in the container | Reported |
| M9 | Medium | Container | Legacy images still mount whole host agent homes | Reported |
| M10 | Medium | Mail | Coordinator mail can target the project-home environment (local path) | Potential |
| M11 | Medium (design) | Mail | Prompt injection can propagate worker → coordinator → other worker | Reported |
| M12 | Medium (design) | Firewall | IP-based allowlist (shared CDN fronts), allowed APIs accept attacker credentials, DNS tunnelling | Reported |
| M13 | Medium | Bridges | Codex worker shells inherit `*_TOKEN` env; ACP advertises write/terminal to read-only sessions | Potential |
| L1–L18 | Low | Various | See §5 | Mixed |
| I1–I7 | Info | Various | See §6 | — |

\* H4 is High for environments the user has hardened with `approvals: "ask"`
or a sandbox. With the default policy (`auto-approve`, `sandbox: none`) it
grants nothing new.

## 3. High severity

### H1. The gateway auth cookie is the durable token and is sent to every port on the host

**Status:** Verified (cookie port scoping is standard browser behaviour)
**Actors:** A1 (container agent), A5

**Where**
- `packages/protocol/src/gateway-token.ts:5-6, 52-55`: `COOKIE_ATTRIBUTES = "HttpOnly; SameSite=Strict; Path=/"`. The cookie value is `encodeURIComponent(token)`, the durable 256-bit gateway token itself.
- `apps/backend/src/gateway-auth.ts:778-783`: login sets `gatewayTokenCookieHeader(this.ctx.token)`, except in agent-test mode, which already issues a scoped session (`issueAgentTestSession`).
- `apps/backend/src/gateway-auth.ts:591-603`: `GET /__orkestrator/gateway-settings` returns the token settings to any cookie-authenticated caller. So `HttpOnly` gives no protection against same-origin script.
- `apps/backend/src/core/commands-containers.ts:154, 159`: container ports are published on `127.0.0.1:<host>:<container>`.

**Scenario**
1. The user runs the gateway-served web client (`mise run start:web`, `dev:web`, or the documented local-only mode). They log in at `http://127.0.0.1:34121/`.
2. A container agent starts a dev server on a published port and asks the user to open `http://127.0.0.1:<port>`. This is a normal step in agent work.
3. Cookies are scoped to the host, not the port. A typed navigation is same-site, so `SameSite=Strict` does not stop it. The container's server receives `orkestrator_gateway_auth=<durable token>`.
4. With the token, the agent calls `POST /__orkestrator/invoke` from inside the container, which reaches the host through published or loopback ports. It can open host terminals: **container → host code execution**.

The cookie has no `Secure` flag, so the same leak applies over the Tailscale
address to any HTTP service bound on that host.

**What limits it:** the gateway's own proxies strip this cookie before
forwarding (`gateway-support-extra.ts:303-334`). Electron injects a bearer
header instead of using the cookie. The hosted `orkestrator.dev` client keeps a
bearer token in `sessionStorage`.

**Fix**
- Put an opaque, server-side session ID with a TTL in the cookie (reuse the agent-test session mechanism), and revoke it on token rotation.
- Add `Secure` and the `__Host-` prefix on HTTPS.
- Require a bearer header, not the cookie, to read or rotate the durable token via `gateway-settings`.

### H2. The unprivileged `node` user can get code executed as root inside the container

**Status:** Verified
**Actor:** A1

**Where**
- `docker/Dockerfile:133-134`: `chown -R node:node /usr/local/share`.
- `docker/Dockerfile:231`: `ENV PATH="/usr/local/share/npm-global/bin:/home/node/.opencode/bin:$PATH"`. Two `node`-writable directories come first, and that PATH is inherited by every `docker exec`.
- `apps/backend/src/core/container-readiness.ts:313-323`: on every stop, `docker exec --user root <id> /usr/local/bin/orkestrator-drain.sh`. This is not a login shell, so the image PATH applies. The drain script calls bare `awk`, `ps`, `cat`, `date` and `sleep` (`docker/orkestrator-drain.sh:35, 44, 62`).
- `apps/backend/src/core/container-network.ts:498-512`: `update-firewall.sh` is run as root and calls bare `iptables`/`ipset`. This only matters when firewall enforcement runs inside the workload container (`ORKESTRATOR_EGRESS=in-container`, or images without the egress gateway).
- `apps/backend/src/core/container-scripts.ts:31-35` and `docker/runtime-env.sh:8, 295-305`: root (`orkroot`, uid 0) terminals run `orkestrator_source_runtime_env`. That function `.`-sources `/tmp/orkestrator-ai/runtime-env.sh`, a file written and owned by `node`.
- `docker/container-zshrc.zsh:14-19`: `compinit -u` for root, over the `node`-writable `/usr/local/share/zsh/site-functions`.

**Scenario:** a prompt-injected agent writes `/usr/local/share/npm-global/bin/awk`,
or writes a `runtime-env.sh` with a `v3` header. The next environment stop, or
the next root terminal the user opens, runs it as uid 0. Where the firewall is
enforced in the workload, root can flush iptables. It can also rewrite
`init-firewall.sh` in the writable layer so later boots report `applied` with
no firewall in place. This contradicts `docker/AGENTS.md` ("`node` has no
sudoers path to become `orkroot`"). That statement is true for sudoers, but
these paths go around sudo.

**What limits it:** in egress-gateway mode the rules live in a separate
container, so the firewall still holds. Container root is still contained by
Docker, since there is no `--privileged` and no docker.sock mount.

**Fix**
- Pass `-e PATH=/usr/sbin:/usr/bin:/sbin:/bin` on every root `docker exec`, and use absolute paths in root scripts.
- Never source `node`-writable files when `EUID=0`.
- Make `/usr/local/share` root-owned and give `npm-global` its own `node`-owned subdirectory. Use `compinit -i` (or plain `compinit`) for root.
- Retire in-container firewall enforcement.

### H3. `.env`, `.env.local` and `opencode.json` symlinks in the project checkout bind-mount arbitrary host paths into the container

**Status:** Verified code / Potential runtime (Docker resolves bind-mount
source symlinks on the host; not exercised here)
**Actors:** A2, then A1

**Where:** `apps/backend/src/core/commands-containers.ts:422-424, 546-553`
```ts
const bindIfExists = async (source, target, readonly = true) => {
  if (await pathExists(source)) args.push("-v", `${source}:${target}${readonly ? ":ro" : ""}`);
};
for (const envFile of [".env", ".env.local"]) { await bindIfExists(path.join(project.localPath, envFile), `/project-env/${envFile}`); }
await bindIfExists(path.join(project.localPath, "opencode.json"), "/opencode-project-json");
```
`pathExists` uses `fs.access`, which follows symlinks. Neither the type nor the
real path of the source is checked.

**Scenario:** a malicious repository commits `.env -> ../../.ssh`, or
`.env.local -> /home/<user>/.aws`, or an absolute link. When the user creates a
container environment for it, the target is mounted read-only into the
container at `/project-env/.env`. A rootful daemon resolves the link as root,
so any host path is reachable, including `/var/run/docker.sock`. The agent
reads the user's SSH keys or cloud credentials and sends them out over an
allowed host (see M12). In `full` network mode `node` can become root via
`run-root-setup.sh`, and a mounted docker socket is usable despite `:ro`, which
amounts to host root.

**Fix:** `lstat` the source and require a regular, non-symlink file whose
`realpath` stays inside `project.localPath`. Better, copy the files in with
`docker cp`, which `stageConfiguredProjectFilesForContainer` already does with
realpath confinement, instead of bind-mounting them.

### H4. An agent can read its own bridge-control token, then self-approve or widen its execution policy

**Status:** Verified
**Actor:** A1
**Severity:** High only for hardened environments (see footnote in §2)

**Where**
- `apps/backend/src/core/commands-containers.ts:915-947`: the start script writes the token with `umask 077` (`printf '%s' <token> > /tmp/claude-bridge-token`) and exports `CLAUDE_BRIDGE_TOKEN`. The file belongs to `node`, the same user the agent CLI runs as, so `umask 077` does not keep it from the agent.
- Codex, Pi, Cursor and ACP bridges keep the token in `process.env` (`bridges/codex-bridge/src/index.ts:173`, `bridges/pi-bridge/src/config.ts:19`, `bridges/cursor-bridge/src/config.ts:17`, `bridges/acp-bridge/src/acp-context.ts:633`), and child processes inherit it. Claude deletes it from `process.env` (`bridges/claude-bridge/src/index.ts:56`), but the file and `/proc/<pid>/environ` remain readable to the same uid.
- `bridges/claude-bridge/src/routes/session.ts:510-515`: `POST /session/:id/config` replaces `sessionData.executionPolicy` with the policy from the request body. Only coordinator sessions are pinned, by `effectiveExecutionPolicy`.
- Interaction-answer routes let any token holder answer pending approvals: Claude `routes/session.ts:1486`, Codex `index.ts:1558`, ACP `acp-http.ts:509`, Pi `http.ts:738`.

**Scenario:** the user sets **Ask** on a container environment. The injected
agent gets one innocuous command approved. That command reads the token and
calls the bridge on localhost to set
`{approvals:"auto-approve", sandbox:"none"}`, or to approve its own later
requests. The human-approval control is gone.

**Fix**
- Keep the bridge-control credential out of the agent's uid: a root-owned file read by a bridge running under a separate user, or an inherited file descriptor.
- Delete the token from `process.env` at startup in every bridge.
- Make the execution policy fixed at session creation, or allow changes that only *narrow* it, and authorise widening through the backend rather than the bridge.

### H5. The host GitHub CLI token is injected into every container by default (design risk)

**Status:** Reported
**Actor:** A1

**Where**
- `apps/backend/src/core/github-credentials.ts:28-38`: `gh auth token` is used unless `useHostGitHubCredentials` is false.
- `apps/backend/src/core/commands-files.ts:2317-2350`: the token is written readable by `node` to `/tmp/orkestrator-ai/github-token` and into `~/.gitconfig` `insteadOf` URLs.
- `docker/init-firewall.sh:207`: GitHub ranges are always allowed on TCP 443 and 22.

**Scenario:** the host `gh` token usually carries `repo`, `workflow` and `gist`
scopes across *all* of the user's repositories and organisations. An injected
agent in any container can:
- read every private repository;
- push workflow files that dump CI secrets;
- add deploy keys or collaborators;
- send data out through a gist.

All of this travels over the always-allowed GitHub egress.

**Fix:** default to per-environment, repo-scoped credentials (a GitHub App
installation token or a fine-grained PAT), or make host-token sharing an
explicit opt-in with a scope warning. Avoid persisting the token in
`~/.gitconfig` (see I3).

## 4. Medium severity

### M1. Legacy loopback previews run agent HTML on the gateway origin, isolated only by the client's iframe sandbox

**Status:** Verified

**Where**
- `apps/backend/src/gateway-proxy.ts:204-211`: for browser previews the proxy deletes upstream `x-frame-options`, `content-security-policy` and `content-security-policy-report-only`, and adds no `Content-Security-Policy: sandbox` of its own.
- `apps/web/src/components/browser/BrowserTab.tsx:403-405`: the only isolation is the iframe `sandbox="allow-forms allow-pointer-lock allow-presentation allow-scripts"`.
- The newer, isolated preview transports are off by default (`docs/architecture/remote-gateway.md:384`). The gateway-served client builds legacy URLs (`apps/web/src/lib/gateway-url.ts:88-96`).

**Scenario:** the user opens a preview URL top-level, for example "open frame
in new tab" or a pasted link. The agent's page then runs **same-origin with the
gateway**. With the cookie (H1) it can call
`fetch('/__orkestrator/gateway-settings')` or `/__orkestrator/invoke`, which
leads to host code execution.

**Fix:** send `Content-Security-Policy: sandbox allow-scripts allow-forms
allow-pointer-lock allow-presentation` on every `browser/loopback` response, so
the document stays opaque-origin even when loaded top-level. Then turn on the
isolated preview transport by default and retire the legacy route.

### M2. The legacy loopback route reaches any host loopback port, with credentialed CORS for `Origin: null`

**Status:** Verified code / Potential (depends on whether browsers send the
`Strict` cookie from opaque-origin frames)

**Where**
- `apps/backend/src/gateway-handlers.ts:395-419`: only checks the port is between 1 and 65535.
- `apps/backend/src/gateway-auth.ts:346-357` and `gateway-proxy.ts:208-211`: `access-control-allow-origin: null` plus `access-control-allow-credentials: true`.
- The reserved-port filter in `apps/backend/src/core/preview-target-resolver.ts:448-452` (gateway, Control MCP, bridges) is not applied on this route.
- In Electron preview-only mode, `apps/desktop/electron/remote-gateway-request-auth.ts:50-53` attaches the bearer to any `mainFrame` request into any loopback scope.

**Scenario:** a preview page navigates or fetches
`/__orkestrator/browser/loopback/<N>/…`, where N is another environment's
published port, a bridge, or an unauthenticated host-only service. That gives
a container a pivot into the host's loopback, at minimum for blind requests.

**Fix**
- Restrict the route to ports that resolve to a known preview target of the requesting environment, and refuse reserved ports.
- Drop credentialed CORS for `Origin: null`.
- Scope Electron's main-frame auth injection to the view's original port.

### M3. `update_agent_messaging_settings` returns the full unredacted config

**Status:** Verified

**Where:** `apps/backend/src/core/commands-registry-mail.ts:269-276`.
```ts
return storage.updateGlobalConfig({ ...current.global, agentMessaging: normalized });
```
`updateGlobalConfig` (`storage-config.ts:560-705`) returns the raw `AppConfig`.
Every other config-returning command wraps its result in `redactAppConfig` or
`redactGlobalConfig` (`commands-registry-projects.ts:505, 938, 970-1075`). There
is no global response-redaction layer.

**Scenario:** any authenticated client receives plaintext `githubToken`,
`anthropicApiKey`, `cursorApiKey` and `openCodeZenApiKey` when it saves
messaging settings. That includes a tailnet browser, a remote desktop
connection, a federated command node, or a short-lived workspace grant. The
secrets then sit in renderer memory and devtools. This breaks the design rule
that secrets never reach clients.

**Fix**
- Return `normalizeAgentMessagingSettings(updated.global.agentMessaging)`.
- Add a guard test that calls every registered command with canary secrets planted (`tests/helpers/auth-secret-canaries.ts` already exists) and asserts the canaries never appear in any response.

### M4. The Claude coordinator git allowlist admits options that select another repository

**Status:** Fixed. Since 2026-10-28 (`7e3ceb7ce`) Git is refused outright unless
the command sandbox is `required`, so the unsandboxed case below no longer
arises. Options before the subcommand are now an exact-match allowlist
(`GIT_GLOBAL_OPTIONS`: `-P`, `--no-pager`, `--no-optional-locks`,
`--literal-pathspecs`), and every read-only turn's CLI runs with
`core.fsmonitor=false` and `core.hooksPath=/dev/null` through `GIT_CONFIG_COUNT`
plus `GIT_OPTIONAL_LOCKS=0` (`withReadOnlyGitConfig`). Driver programs named
through `.gitattributes` (`diff.<driver>.command`, filters) cannot be listed
that way and stay with the sandbox; `diff.external` was not blanked, because an
empty value replaces `git diff`'s patch output with nothing. The original finding follows.

**Where:** `bridges/claude-bridge/src/services/read-only-policy.ts:219-226, 574-606`.
The subcommand is the first token after `git` that does not start with `-`.
Global options before it are only checked against `GIT_MUTATING_ARGUMENTS`
(`--config-env`, `--exec-path`, `--ext-diff`, `--filters`, `--output`,
`--textconv`). Attached forms such as `--git-dir=…`, `--work-tree=…`,
`--namespace=…` and `--attr-source=…` pass. A separate `-c`/`-C` happens to be
caught, because its value becomes the subcommand.

**Scenario:** a prompt-injected coordinator runs an admitted read-only
subcommand (`git --git-dir=<dir> status`) against a git directory whose
`config` the attacker controls. For example, a bare-repo layout committed into
the checkout, with `core.fsmonitor` or `diff.external` naming a program. Git
runs that program on the host.
- With the Seatbelt or bubblewrap command sandbox active, the program is confined (no network, workspace not writable).
- Where the sandbox is reported `unavailable`, the allowlist is the only boundary.

**Fix**
- Allowlist git *global* options (realistically none) instead of skipping them.
- Always run admitted git with `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c diff.external= -c core.pager=cat` and `GIT_CONFIG_NOSYSTEM=1`. `change-tracking/capture.ts:362` already does this.

### M5. Repository-provided `setupLocal` runs automatically on the host

**Status:** Fixed. A local environment's `setupLocal` runs unasked only when
it is exactly the default branch's or a list the user approved for the
project on that machine; otherwise setup is held for the user, who can run it
once, approve it for the project, approve it on every machine with the
project, or skip it. `orkestrator-ai.json` is opened with `O_NOFOLLOW`. See
[setup-approval.md](../architecture/setup-approval.md). The original finding
follows.

**Where**
- `apps/backend/src/core/commands-environment.ts:436-448`: `readSetupLocalCommands` reads `orkestrator-ai.json` from the *new worktree* (with `fs.readFile`, which follows symlinks).
- `apps/backend/src/core/commands-environment.ts:670-692`: runs the commands with `$SHELL -ilc`, unsandboxed.
- Triggered on environment creation, and reachable via Control MCP `launch_environment` with `environmentType: "local"` (`control-mcp-tools.ts:1266`).

**Scenario:** a local environment is created from a branch an attacker
controls. That might be a contributor's branch, or a branch a *container*
worker pushed that a coordinator then launches locally. The branch's commands
run as the user on the host. For container workers this crosses the container
boundary.

**Fix**
- Gate new or changed `setupLocal` content on user approval: pin a hash per project and prompt when it changes.
- Or read setup configuration only from the project's default branch.
- Open the file with `O_NOFOLLOW`.

### M6. No CSP on the main renderer or the gateway-served app, which hold a generic command bridge

**Status:** Verified

**Where**
- `apps/web/index.html` has no CSP. No CSP header is added in Electron (`file://`) or by `serveStatic` (`apps/backend/src/gateway-proxy.ts:668+`).
- The hosted client, by contrast, has a strict CSP (`apps/web-public/vercel.json`).
- `apps/desktop/electron/ipc.ts:287-296`: `orkestrator:invoke` forwards *any* command string to the backend. The only gate is the sender-URL check.

**Impact:** the renderer shows attacker-influenced markdown, Mermaid/SVG,
transcripts and file content. The sanitisation is strong today: DOMPurify,
Mermaid `securityLevel: "strict"`, no `rehype-raw`, and escaped
`innerHTML` in `MentionableInput`. But a single bypass in any of the sinks
(`MermaidBlock.tsx:398`, `ArtifactPartBodies.tsx:417`, `MentionableInput.tsx:382`)
becomes host code execution through `window.orkestrator.invoke` or the gateway
token.

**Fix**
- Add `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`, with explicit `frame-src`/`connect-src` lists, to both the Electron renderer and the gateway-served HTML.
- Consider Trusted Types.
- Consider a main-process allowlist of renderer-invokable commands.

### M7. The OS sandbox is disabled for every window that loads the preload

**Status:** Reported

**Where:** `apps/desktop/electron/window.ts:120`, `workspace-views.ts:230`
(realms rendering another node's content), `toolchain-bootstrap-window.ts:133, 219`.
`app.enableSandbox()` is never called. `AGENTS.md` documents this as a
consequence of ESM preloads.

**Impact:** a Chromium or V8 renderer bug triggered by attacker content runs as
the user, with no sandbox escape needed.

**Fix:** bundle the preloads as CommonJS and set `sandbox: true`. The two
bootstrap windows only use `ipcRenderer.on`/`send` and can switch now.

### M8. Host `~/.claude.json` is staged unfiltered and stays readable in the container

**Status:** Reported

**Where:** `apps/backend/src/core/portable-inputs.ts:259-268` (no filter for the
`claude.json` stage). `docker/entrypoint.sh:904-909` strips `projects` only from
the copy written to `~/.claude.json`. The raw read-only `/claude-config.json`
stays readable by `node`.

**Impact:** host project paths, user and per-project `mcpServers` entries
(often with API keys in headers or env), and any Control MCP operator token
the user configured are all exposed to the agent.

**Fix:** stage `.claude.json` through an allowlist filter that keeps only
`oauthAccount`, onboarding flags and container-safe MCP entries.

### M9. Legacy (pre-staged-inputs) images still mount whole host agent homes

**Status:** Reported

**Where:** `apps/backend/src/core/commands-containers.ts:470-535`. `~/.claude`,
`~/.codex`, `~/.pi`, `~/.config/opencode` and `~/.local/share/opencode` are
mounted read-only. That exposes refresh tokens, `history.jsonl` and every host
transcript. The mounts persist until the environment is rebuilt.

**Fix:** refuse to start legacy images with home mounts, or force a rebuild,
and surface a warning listing the affected environments.

### M10. Coordinator mail can target the project-home environment (local node)

**Status:** Potential

**Where**
- `apps/backend/src/core/commands-registry-coordinator.ts:381-384` checks only `destination.projectId !== project`.
- `coordinatorInvoker` (`control-mcp-server.ts:461-491`) checks `projectHome` only for arguments named `environmentId`, but `send_message` uses `toEnvironmentId`.
- The node path does refuse it (`commands-registry-coordinator-nodes.ts:138`).

**Impact:** a prompt-injected coordinator can mail a project-home tab, which is
woken on the `coordinator` route and told to follow delegated work. That
session writes the user's canonical checkout, which the documented invariant
forbids.

**Fix:** reject `projectHome` destinations in `send_coordinator_agent_mail`,
and in the mail store for coordinator senders.

### M11. Prompt injection can spread worker → coordinator → another worker (design)

**Status:** Reported

**Where**
- Same-project worker mail wakes the main coordinator unconditionally (`packages/protocol/src/agent-mail.ts:208-220`).
- The coordinator can `send_prompt_to_tab` or `send_message` to any non-home environment in the project, including user-created ones (`commands-registry-coordinator.ts:634-655`).
- Its mail is framed as an authenticated delegation (`agent-mail.ts:829-833`).

**Impact:** an injected worker asks the coordinator to have environment B run
something. B follows it under B's own, possibly looser, policy.

**What limits it:** worker-originated mail is labelled untrusted. There are hop
and hourly budgets, per-tab Off, and mute.

**Fix:** limit coordinator delegation to environments the coordinator created
unless the user opts in, and mark delegations that originated from worker mail.

### M12. Egress firewall limitations (design)

**Status:** Reported

- **IP-based allowlist.** Domains are resolved into an ipset, with no SNI or Host check (`docker/firewall-domains.sh`). Default hosts on shared fronts (Google front-ends, Azure Blob, Cloudflare-fronted npm/OpenAI) let traffic reach other tenants on the same edge IPs.
- **Allowed APIs accept attacker credentials.** Examples: `sentry.io` with an attacker DSN, `api.anthropic.com` or `openrouter.ai` with an attacker key, GitHub gists. `init-firewall.sh:21-22` acknowledges this.
- **DNS tunnelling.** `init-firewall.sh:136-152` sends DNS to Docker's recursive resolver, so `<data>.attacker.tld` lookups exfiltrate.

**Fix:** an SNI/Host-enforcing egress proxy and a filtering resolver in the
egress gateway, plus a smaller default allowlist. Document the residual
exfiltration risk prominently.

### M13. Bridge policy gaps for non-coordinator sessions

**Status:** Potential

- **Codex.** The `shell_environment_policy` exclusions (including `*_TOKEN`) are only applied for coordinators (`bridges/codex-bridge/src/codex-config.ts:447, 570-582`). Worker shells may inherit secrets from the bridge environment, including the bridge token (H4).
- **ACP (Grok).** Always advertises `writeTextFile` and `terminal` (`bridges/acp-bridge/src/acp-context.ts:1141`) and serves them without a policy check (`:1366`). Read-only depends on the provider's own tool profile.

**Fix:** apply environment scrubbing to every Codex session, and refuse ACP
write and terminal calls when the policy denies them.

## 5. Low severity

| ID | Title | Where | Notes / fix | Status |
| --- | --- | --- | --- | --- |
| L1 | `.env` seeding and `filesToCopy` write through symlinks in a fresh local worktree | `commands-environment.ts:2214-2221`, `commands-project-files.ts:80-82` | A branch-committed `.env` symlink to a non-existent path makes the backend copy the user's real `.env` there. `filesToCopy` can overwrite existing host files. Use `writeConfinedFile(..., {exclusive:true})` or `O_NOFOLLOW\|O_EXCL`. | Fixed: seeding checks with `lstat`, and `filesToCopy` refuses a destination with a link at or above it (`unlinkedDestination`) |
| L2 | Bridge and agent-MCP tokens passed in `docker exec` argv | `commands-containers.ts:921-947`, `commands-registry-servers.ts:407-699` | Visible to local users via `ps`/`/proc` while the CLI runs. Use stdin, as `syncContainerCursorApiKey` already does. | Reported |
| L3 | Only the `runAsNode` Electron fuse is set | `package.json:52-54` | `--inspect` works in packaged builds, which lets a local process inherit the app's macOS TCC grants. Disable `enableNodeCliInspectArguments` and `enableNodeOptionsEnvironmentVariable`, and enable asar integrity and `onlyLoadAppFromAsar`. | Verified |
| L4 | `ELECTRON_DEV=1` is honoured in packaged builds | `apps/desktop/electron/main.ts:177` | With `VITE_DEV_SERVER_URL`, a packaged app can load a remote page as the trusted renderer. Gate on `!app.isPackaged`. | Verified |
| L5 | Renderer and realm sessions keep Electron's default permission handler, which grants every request | `browser-preview-startup.ts`, `artifact-host-session.ts` only | Default-deny on renderer partitions. | Reported |
| L6 | Unsigned release and update paths | `electron-builder.release.linux.config.ts`, `auto-update.ts:147-148`, `apps/web-public/public/install.sh`, `scripts/publish-cli.ts`, `host-standalone-updater.ts` | Linux AppImage auto-updates trust only the release's sha512. `install.sh` runs `bunx orkestrator` with no version pin. npm publishes from a workstation without provenance. The standalone updater runs `bun install` with no lockfile. Add detached signatures, pin versions, publish from CI with provenance. | Reported |
| L7 | Project `gitUrl` reaches `git ls-remote`/`fetch` without `--`; `add_project` skips URL validation | `commands-environment-fork.ts:127, 141`, `commands-agent-support.ts:275`, `commands-registry-projects.ts:421` | Argument injection if a stored URL starts with `-`. Clone already uses `--`. | Reported |
| L8 | `read_local_file`/`write_local_file` accept any client-supplied root | `commands-registry-terminal.ts:896, 938-960` | Relative paths are confined, but the root is not tied to a registered environment. Resolve the root as `read_file_base64` does. | Reported |
| L9 | Host-side git scans of local worktrees inherit worktree config | `commands-files.ts:977`, `1268-1295` | Use the hardened `-c` set from `change-tracking/capture.ts`. | Potential |
| L10 | No Host-header allowlist (DNS rebinding) and no login throttling | `gateway-auth.ts:263, 737-776` | Brute force is infeasible against the default 256-bit token, but a weak user-chosen token (min 16 chars) is at risk. | Reported |
| L11 | `--tailscale-serve` / `--desktop-web-client` disable the Tailscale-only bind guard | `apps/backend/src/main.ts:127-128` | `--tailscale-serve --host 0.0.0.0` serves plain HTTP on the LAN. Relax the guard only for loopback binds. | Reported |
| L12 | CLI trusts the instance descriptor (owner/mode unchecked; `EPERM` counted as alive) | `packages/cli/src/client/targets.ts:120-184` | A local co-tenant on a stale port could receive the bearer token. | Reported |
| L13 | A `javascript:` href hidden by a tab or control character passes the markdown URL transform | `apps/web/.../markdown-plugins.ts:112-117`, `file-url.ts:74, 83` | Not exploitable today, because `MarkdownLink` calls `preventDefault()`. Strip control characters, or check `new URL().protocol`. | Reported |
| L14 | Malformed relay credit frame can crash the backend | `preview-relay-supervisor.ts:389` | Relay is off by default. Validate frame lengths and catch errors in `onData`. | Reported |
| L15 | Agent-tools MCP server binds `0.0.0.0` on the host | `apps/backend/src/core/agent-tools.ts:642` | Token-protected, but reachable from the LAN or tailnet. Bind to the Docker bridge or loopback addresses. | Verified |
| L16 | Control MCP and scheduling soft spots | `control-mcp-confirm.ts`, `control-mcp-credentials.ts:330-345`, `scheduled-jobs/executor.ts:681-689`, `read-only-policy.ts:537` | **Confirmation:** the agent can complete it itself (HMAC-bound, but a speed bump, not human approval). **Operator token:** readable by the coordinator; add `denyRead` for the data directory. **Self-reminders:** presented as authenticated `system` notices. **Cursor/Pi:** accept some policy fields from the request body. | Reported |
| L17 | Provider secrets stored in plaintext in SQLite (0600) | `storage-config.ts:786-824` | Consider `safeStorage`/libsecret. Remote-connection tokens already use `safeStorage`. | Reported |
| L18 | Dependency advisories | `bun audit` | `undici@8.10.2` (via `pi-bridge`): 1 high (DoS on excessive content-encodings), 2 moderate (GHSA-xjj6-f33q-929c, -4qv8-2p9j-2685, -f72v-6w45-q472). `postcss-selector-parser@6.0.10` (dev, moderate). Electron is locked at `45.0.0`; check for later 45.x security releases. Run `bun audit fix`. | Verified |

## 6. Informational

- **I1. Workspace grants are not an administration boundary.**
  `nodes/client-grants.ts:15` says grants are "never valid for administration",
  but the deny-list in `nodes/node-routing.ts:21-119` still allows
  `start_local_terminal_session`, `local_terminal_write`, `update_global_config`
  and `request_host_update`. Switch to an allowlist, or correct the documented
  guarantee.
- **I2. Doc drift.** `docs/architecture/coordinator.md:111`, `control-mcp.md`
  and the README say side agents get only `discovery` and `mail`. The code also
  grants `schedules` (`control-mcp-tools.ts:144-146`).
- **I3. GitHub token in the container's `~/.gitconfig`.** It is persisted in
  `insteadOf` URLs (`commands-files.ts:2334-2345`). Prefer a credential helper
  that reads the token file, as the host-side `github-git-credentials.ts` does.
- **I4. Container hardening.** Workload containers lack
  `--security-opt no-new-privileges`. Legacy network policy 1 allows the host
  /24 in both directions.
- **I5. Preview publication domain.** It is not checked for being same-site
  with the app origin (`preview-publication.ts:240-246`), unlike the artifact
  content origin.
- **I6. CI.** `actions/checkout` keeps `persist-credentials: true` in jobs with
  `packages: write`. Set it to `false`.
- **I7. Log redaction is best-effort.** Internal base64url tokens have no
  recognisable prefix, and container bridge log tails
  (`get_claude_server_log`, `commands-registry-servers.ts:296-300`) are
  returned without `redactBridgeOutput`. Give internal tokens a prefix
  (e.g. `okb_`) and redact those tails.

## 7. Controls reviewed that look correct

**Gateway**
- Tokens are 32 random bytes, compared with `timingSafeEqual`.
- Grants are stored hashed with a ≤15-minute TTL, and rotation revokes WebSockets, SSE streams and proxy requests.
- The auth file and instance descriptor are written 0600 via temp file and rename.
- No tokens appear in URLs or logs.
- `/__orkestrator/*` refuses disallowed Origins before any processing, which also blocks login CSRF.
- Terminal WebSockets check Origin and require in-band authentication within 5 s.
- Control-only routes return 404 on other listeners; Tailscale Funnel is detected.
- The federation relay uses a path allowlist and does not follow redirects.

**Electron**
- `contextIsolation: true` and `nodeIntegration: false` everywhere; no `webviewTag` and no `webSecurity: false`.
- Every IPC handler validates the sender URL.
- `openExternal` is limited to http/https.
- `will-navigate`, `will-frame-navigate` and `setWindowOpenHandler` guards are in place.
- Preview views run sandboxed, with no preload and a per-service partition.
- The artifact host uses a throwaway partition, denies all permissions, and has no devtools.
- There is no certificate-error override.

**Previews and artifacts**
- Service previews never let the client choose the host or port, and refuse reserved ports.
- Upstream TLS uses `rejectUnauthorized: true`.
- Artifacts are served from a separate content origin with a CSP `sandbox` header, and postMessage is checked for source, origin and nonce.
- Mermaid runs `strict` with secure config keys, and SVG output is sanitised twice.
- The design canvas renders sandboxed srcdoc with a nonce CSP and `connect-src 'none'`.

**Filesystem and exec**
- `path-safety.ts` provides cwd-pinned, `O_NOFOLLOW|O_EXCL` writers with identity rechecks.
- `validateGitRefName` is applied on every branch path.
- `quoteShell` is correct.
- Clone uses `--`, and `runRemoteGit` disables prompts and submodules.
- Worktree deletion is realpath-confined.
- The coordinator allowlist otherwise blocks composition, `find -exec`, `rg --pre`, `difftool`, network tools and `dangerouslyDisableSandbox`.

**Containers**
- No `--privileged`, docker.sock mount, host PID or IPC namespace, or `seccomp=unconfined`.
- The firewall fails closed, and policy is recorded root-owned.
- The egress gateway holds `NET_ADMIN`, and the workload drops `NET_RAW`.
- IPv6 is disabled.
- Each environment gets its own network on policy 2 and later, and ports are published on `127.0.0.1` only.
- The host SSH agent is not forwarded.
- Staged agent logins are reduced to access tokens only.
- The artifact preview worker runs with `--network none --read-only --cap-drop ALL`, `no-new-privileges` and seccomp.

**MCP, mail and policy**
- Control MCP tokens are 256-bit, compared in constant time, on a loopback-only listener with a body cap.
- Coordinator credentials live in memory, have an idle TTL, and are revalidated per request.
- Cross-project and external mail is never auto-injected.
- Schedule owners come from the authenticated scope.
- The coordinator policy cannot be overridden by request, restore or resume.
- Approvals fail closed on timeout, disconnect or malformed answers.
- Bridges fail closed when the token is missing.

**Secrets and supply chain**
- No committed secrets; history scans matched only test fixtures.
- No telemetry SDK ships.
- Keychain writes go via stdin.
- Account homes are 0700; credential files are 0600 and written with `wx`.
- Toolchain downloads are SHA-256 pinned, with host allowlists re-checked after redirects and tar path, size and count limits.
- CI pins every action to a SHA, uses per-job `permissions`, has no `pull_request_target`, and uses `--frozen-lockfile`.
- Base images are pinned by digest.
- No install lifecycle scripts; `patches/` is benign.

## 8. Not covered / follow-up

- `user-command-container.ts` / `commands-registry-user-commands.ts` were not reviewed. User commands are presumably user-authored.
- The review validation worker was only spot-checked: commands are passed as argv to `bash -lc`.
- `tmux-hooks` `find` invocations were not reviewed.
- Pi's `grep`/`find` tools live in the Pi SDK, outside this repo.
- The iOS app (`apps/ios`) was not reviewed.
- No dynamic testing was done. In particular, run H1/M1/M2 in Chromium and Safari, H3 against rootful and rootless Docker, and H2 against a built image.

## 9. Recommended remediation order

1. **H1 + M1.** Replace the token-valued cookie with an opaque session. Add a server-side `CSP: sandbox` on legacy previews and make the isolated transport the default. Together these close the cleanest container → host path.
2. **H3.** `lstat` and realpath the `.env`/`opencode.json` sources and copy them instead of bind-mounting. This is a small change with large impact.
3. **H2.** Fix the root PATH on root execs, stop root sourcing `node`-owned files, and make `/usr/local/share` root-owned.
4. **M3.** Redact the `update_agent_messaging_settings` response and add the all-commands canary test.
5. **H4 + M13.** Move bridge-control credentials out of the agent's uid, and make policy changes narrow-only.
6. **M4, M5, L1.** Harden the coordinator git allowlist, gate `setupLocal` on approval, and use confined writers for seeding.
7. **M6, M7, L3, L4.** CSP on the renderer and gateway HTML, CommonJS preloads with `sandbox: true`, Electron fuses, and the packaged-build dev flag.
8. **H5, M8, M9.** Narrow the credentials handed to containers.
9. Dependency updates (L18) and the remaining Low and Info items.
