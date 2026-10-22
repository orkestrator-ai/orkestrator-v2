# Container network and credential isolation

Checked against `main` at `2459b05c` (2026-10-15); Claude credentials
against `688f9f69` (2026-10-21).

Restricted mode limits where a container can connect with an in-container
IPv4 ipset firewall. Root sets it up through narrow sudo grants, and the
workload needs `NET_ADMIN` to have it. The remaining work makes one default
allowlist canonical and evaluates enforcement outside the workload. Only once
restricted containers no longer need `NET_ADMIN` can the sudo grants shrink or
`no-new-privileges` be considered.

## Current state

- Firewall: `docker/init-firewall.sh` (boot, policy 3), `docker/firewall-domains.sh`
  (shared library: per-address expiry, TTL refresh, atomic `ipset swap`,
  conntrack revocation), `docker/update-firewall.sh` (`--set-domains`,
  `--add`, `--remove`, `--host-ports`, `--refresh-loop`) and
  `docker/network-policy-entrypoint.sh` (records the policy once, root-owned).
- Allowed traffic sits in one ipset, `allowed-domains`. Under policy 3 it
  holds address, protocol and port tuples (`hash:net,port`): a bare domain is
  TCP 443, `host:port` or `host:port/udp` opens exactly that port, and
  GitHub's ranges are TCP 443 and 22. Policies 1 and 2 hold addresses, open
  on every port; the backend sends their containers each entry's domain
  without its port. A domain on a shared CDN address still opens the same
  ports to every other site on it. `AGENTS.md` "Network Isolation" and
  [Container lifecycle](../../architecture/container-lifecycle.md) "Port and
  protocol tuples" describe it.
- Backend: `apps/backend/src/core/container-network.ts`.
  - `ensureEnvironmentNetwork` creates one labelled bridge per environment.
  - `configuredAllowedDomains` is the saved list plus `requiredAgentNetworkDomains`;
    `containerAllowedDomains` is that list as the container's policy takes it.
  - `applyEnvironmentAllowedDomains` applies a saved list in place.
  - `environmentNetworkPolicy` reports `applied`, `pending` or
    `rebuild-required`. A mode change (restricted to full or back) is
    always `rebuild-required`.
- `NET_ADMIN`: `createDockerContainer` (`apps/backend/src/core/commands-containers.ts`)
  adds `--cap-add NET_ADMIN` to every container that is not in full mode,
  because the firewall needs it. The capability is container-wide, so a root
  terminal (`docker exec --user orkroot`) in restricted mode can change the
  firewall. `AGENTS.md` documents this as a product choice. Full-mode
  containers do not get `NET_ADMIN`.
- sudo: `docker/Dockerfile` writes `/etc/sudoers.d/node-firewall` with three
  `NOPASSWD` grants for `node`: `network-policy-entrypoint.sh *`,
  `init-firewall.sh` and `run-root-setup.sh *` (the last only acts when the
  recorded mode is `full`). `node` has no sudoers path to `orkroot`.
- Default allowlists come from four places:
  - `DEFAULT_ALLOWED_DOMAINS` in `apps/backend/src/core/storage-shared-core.ts`,
    persisted for a new install;
  - the renderer fallback `allowedDomains: [...]` in `apps/web/src/stores/configStore.ts`;
  - the firewall fallback `DOMAIN_ARRAY` in `docker/init-firewall.sh` (also
    read by `default_domains_csv` in `update-firewall.sh`), used when
    `ALLOWED_DOMAINS` is absent;
  - provider hosts in `AGENT_NETWORK_DOMAINS_BY_PLATFORM`
    (`apps/backend/src/core/constants.ts`), added by
    `requiredAgentNetworkDomains` only for enabled platforms.

  The first three differ. `tests/unit/version-drift.test.ts` requires only the
  image's own hosts (`github.com`, `registry.npmjs.org`, `cdn.playwright.dev`
  and the mise runtime hosts) to appear in all three.
- Host access: policy 2 allows the host only on the agent-tools port and
  inbound connections only on published ports, all published on
  `127.0.0.1`. `container-host-reachability.ts` (#885) probes that path and
  offers host firewall fixes.
- Credentials: staged inputs and credential syncs go only to providers that
  are enabled, authorized for agent-test profiles and not revoked
  (`providerCredentialsAllowed`, `apps/backend/src/core/portable-input-status.ts`).
  `revoke_provider_credentials` is durable and stops the provider's bridge;
  `restore_provider_credentials` allows it again. The Cursor key is not in a
  staged-inputs container's creation environment; the Anthropic key is a
  staged file there.
- Single-use refresh tokens (2026-10-21): Codex and Grok logins reach a
  container access-only (`restrictCodexAuthSnapshot` and
  `restrictGrokAuthSnapshot` in `packages/protocol/src/login-snapshots.ts`).
  Staging (`accessOnlyLogin` in `portable-inputs.ts`), the restage before
  every `docker start` (`refreshStagedAgentAccountLogins`, now for Codex and
  Grok whether or not an account was added), the account-switch push and a
  push before every Grok bridge start (`syncContainerGrokLogin`) all blank
  the refresh token and drop an expired login. Codex's `last_refresh` is set
  to now, so Codex uses its access token (ten days at issue) until it
  expires instead of trying a refresh it cannot make. The entrypoint
  (`restrict_imported_login`) blanks the refresh token again in the
  container's own copy. That covers `ORKESTRATOR_PORTABLE_INPUTS=host-mounts`
  and containers that imported a full copy before this change. A copy whose
  access token lapses signs out on its own (Grok 1.0.52 says "Not signed
  in", checked live), and the host login is never touched. The cost: a
  container that imports the host login cannot keep its own `grok login` or
  `codex login` across a restart, because that refresh token is blanked too.
  A container that needs its own login should have that provider's
  credentials revoked. Images older than staged inputs still mount the host
  homes and copy them whole with their old entrypoint; they go away with the
  host-mounts path
  ([0021-container-rebuild-state-preservation.md](0021-container-rebuild-state-preservation.md)).
- Claude (2026-10-21): containers get the Claude login access-only too
  (`restrictClaudeCredentialsSnapshot`), on every path that used to pipe or
  stage it whole. The keeper and the host-side refresh are described in
  [Container lifecycle](../../architecture/container-lifecycle.md), "Portable
  inputs". The evidence the design rests on:
  - Rotation. Anthropic rotates the Claude.ai refresh token on every refresh,
    and a refresh with a spent one fails with `invalid_grant` ("Refresh token
    not found or invalid") and signs that copy out (anthropics/claude-code
    #24317, #25609, #52202 and #54443, including a captured request whose
    token matched the file on disk). Claude Code 2.1.304's own
    `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` error says the token "was used for this
    attempt and cannot be used again". No Anthropic statement exists (#52202
    asks for one). Not tested with a disposable account: none was available,
    and the host's own could not be spent.
  - Access-only behaviour, from the CLI source (2.1.296 and 2.1.304) and a
    fake login in a 2.23.0 container (Claude Code 2.1.296). A `claudeAiOauth`
    with no `refreshToken` key counts as logged in and never refreshes
    (`no_refresh_token`), and the file is never rewritten, including after
    expiry and after a 401. An empty `refreshToken` is the CLI's dead-login
    marker, so the key is removed instead. A running CLI drops its cached
    login when the file's mtime changes, or after a 401.
  - Host refresh trigger. Claude Code has no refresh-only command and no
    force flag. `claude auth status` attempted a refresh once and not in
    repeat runs, so it is not used. Every `-p` run with a refreshable fake
    login near expiry attempted the refresh, including one for an unknown
    model with `--setting-sources ""` (which kept a user `SessionStart` hook
    from running), `--strict-mcp-config`, `--tools ""` and
    `--no-session-persistence`. The fake access token drew a 401, which also
    forces a refresh, so whether a real, unexpired token is refreshed
    proactively there is from the source, not observed.
  - Cost: a container's own `claude /login` no longer survives a restart while
    Claude credentials are allowed, because its refresh token is stripped too
    (as for Codex and Grok). Revoking the environment's Claude credentials
    keeps it, since nothing is then staged or synced.

## Outstanding work

### Code

2. One canonical default allowlist. Generate the shell and renderer fallbacks
   from the backend list (at image build and from the protocol package), or
   have the renderer read the backend's list, rather than keeping three
   copies. `requiredAgentNetworkDomains` stays the only provider-specific
   addition. Replace the partial drift test with an equality or generation
   check. Never widen a stored user list on a read.
3. External egress prototype, kept bounded. Enforce egress outside the
   workload with no workload `NET_ADMIN`. Prove a working path for non-HTTP
   Git/SSH, provider endpoints and the agent-tools callback, then measure
   overhead and failure recovery. A plain HTTP proxy does not constrain direct
   sockets without network enforcement beside it. Only after the prototype
   replaces the privileged init can `NET_ADMIN`, the `init-firewall.sh` grant
   or `no-new-privileges` be reconsidered.
4. Optional: change mode in place (restricted to full and back) instead of
   requiring a rebuild.
5. Stop containers spending the host's OpenCode and Pi OAuth refresh tokens
   (high). Both are staged in full (`opencode-data/auth.json`,
   `pi-config/agent/auth.json`). Pi's OAuth providers rotate refresh tokens:
   agent-test profiles share Pi's file in place for this reason (see
   [credentials and models](../../development/credentials-and-models.md)).
   OpenCode's OAuth entries (Anthropic, OpenAI, GitHub Copilot) carry the
   same providers' rotating tokens. API-key entries are safe to copy. Apply
   the same access-only treatment per entry type, or stage API-key entries
   only.
6. Keep container MCP OAuth logins signed in (medium). Claude's `mcpOAuth`
   entries now reach a container without refresh tokens, so a container's MCP
   server login lapses with its access token unless the host refreshes it
   first, which it only does when the host itself uses that server. Either
   have the keeper refresh near-expiry MCP logins on the host too, or keep a
   container-owned MCP login separate from the host's.
7. Read the host Claude login once per keeper pass (low, measure first). Each
   pass reads the active login (a `security` call on macOS) once to decide on
   a host refresh and again per running container it syncs. Pass the one read
   down if a host with many running containers shows it matters.

7. Tell a container user how to recover a lapsed Codex login (medium).
   When a container's access-only Codex login lapses, the tab now says
   "You've been signed out of Codex. Sign in again to keep working.", and the
   failed turn shows Codex's raw "workspace routing discovery unauthorized
   (401)". For a container that imports the host login, the fix is to run
   `codex` on the host and restart the environment, which restages the host's
   current login. Signing in inside the container works only until the next
   restart blanks that login's refresh token. Show the restart guidance for
   containers whose Codex credentials come from the host, and say the same
   for Grok.
8. Decide whether a host sign-out reaches a container that never added an
   account (medium). When the host's Codex or Grok login is missing or
   expired, the restage stages nothing and the container keeps the
   access-only copy it already had. If the host signed out deliberately, a
   still-valid copy keeps working until it expires (Codex access tokens last
   ten days from issue). A container that has used agent accounts now has its
   copy removed at the next bridge start. Options: remove the copy on every
   restage that stages nothing, or keep today's "leave it to expire"
   behaviour and document it.

### Qualification

- Claude host refresh and mid-session pickup, live (high; on by default).
  Nothing has yet run `refreshHostClaudeLogin` against a real login, because
  doing so spends the host's refresh token. On a host or disposable account
  whose access token is inside its last four minutes, with a Claude bridge
  running in a container: confirm the keeper's `-p` run renews the host login
  (new `expiresAt`, no model request billed, the user's `claude` still signed
  in afterwards), that the renewal reaches the container, and that the
  running container CLI uses it without a restart. Also confirm a run with
  more than five minutes left changes nothing. Re-check the trigger after
  each Claude Code upgrade.
- Claude access-only run on 2026-10-21. Host Claude Code 2.1.304 (Keychain
  login); container image `ghcr.io/orkestrator-ai/orkestrator-v2:2.23.0`
  (Claude Code 2.1.296) on Docker Desktop 29.8.2 (aarch64), with this
  change's `docker/entrypoint.sh` bind-mounted. One disposable container,
  `ork-live-0681-claude-access`, full network mode, removed afterwards; the
  CLI probes ran in throwaway `ork-live-0680-claude-probe` containers with
  fake tokens only. No profile or other environment was touched.
  - Host Keychain item and `~/.claude/.credentials.json`: SHA-256 prefix and
    modification time recorded before and after. Both were unchanged.
  - Entrypoint migration: a fake full-shape credential on the
    `/claude-config` mount was copied with its refresh token removed (mode
    600, sentinel absent).
  - `accessOnlyLoginText("claude", …)` over the real host login, pushed with
    the production stdin command: no `refreshToken` key, no MCP refresh
    tokens, the host refresh token nowhere in the payload.
  - In the container, `claude auth status` reported a Claude Max login and
    `claude -p … --model haiku` answered "pong" (exit 0). The credential file's
    hash and mtime were unchanged afterwards and it still had no refresh token.
  - The in-place restrict command removed both refresh tokens from a fake
    file (mode 600). The `oauthAccount` command replaced the identity, kept
    the other 25 keys of `~/.claude.json`, and `claude auth status` then named
    the new (fake) email.
  - Skipped: the host refresh and a mid-session token pickup (see above).
- Grok past expiry with a live login (medium). The 2026-10-21 run below could
  not use a real Grok login: the host's access token had expired about eight
  hours earlier, so staging rightly withheld it. Repeat on a host whose Grok
  token is fresh. Run a Grok tab in a container past the access token's
  expiry (about six hours, or edit `expires_at` in the container's copy).
  Confirm that the container signs out on its own, that a bridge restart
  after a host `grok` run signs it back in, and that the host's `auth.json`
  hash changes only when the host itself refreshes. Tried again on
  2026-10-21 at 07:38Z and 07:58Z: still skipped, because the host Grok access
  token expired at 2026-10-20T16:24:55Z and refreshing it would have spent the
  host's own refresh token. The profile launcher withheld the login and the
  opt-in live spec (`grok-container-login.spec.ts`) skipped explicitly. The
  Codex half of the same property passed live that day (next item).
- Codex past expiry, run on 2026-10-21 (details in
  [0019-container-platform-qualification.md](0019-container-platform-qualification.md),
  "Results, 2026-10-21"). With the container's own access token past its
  `exp`, Codex 0.162.1 tried a refresh with the blank refresh token, OpenAI
  answered 400 `empty_string`, and turns failed. The container held no
  refresh token, so nothing on the host could be spent; the host
  `~/.codex/auth.json` and `~/.grok/auth.json` hashes and mtimes were
  unchanged. A restart restaged the host login and signed it back in. The
  bridge reported that sign-out as "temporarily unavailable" until this
  change; it now reports `needs-auth`.
- Run on 2026-10-21 (single-use refresh tokens). Host Grok 1.0.62; container
  image `ghcr.io/orkestrator-ai/orkestrator-v2:2.23.0` (Grok 1.0.52,
  codex-cli 0.162.1) on Docker Desktop 29.8.2 (aarch64), with this change's
  `docker/entrypoint.sh` bind-mounted over the image's. The run used one
  disposable container, `ork-live-0600-grok-fix`, in full network mode,
  removed afterwards. No profile or other environment was touched.
  - Host `~/.grok/auth.json` and `~/.codex/auth.json`: SHA-256 prefix and
    mtime recorded before and after. Both were unchanged.
  - `stagePortableInputs` for Codex and Grok, from the real host home into a
    temporary data directory: Codex `auth.json` was staged with an empty
    refresh token. Grok was withheld (`login-withheld: 1`) because the host
    access token had expired.
  - The entrypoint boot reached `ready`. The container's Codex `auth.json`
    had an empty refresh token, a `last_refresh` seconds old and mode 600.
    `codex login status` reported "Logged in using ChatGPT", and
    `codex exec --skip-git-repo-check --sandbox read-only` answered "pong"
    (exit 0). The refresh token was still empty afterwards.
  - Migration from before the change: a fake full-shape Grok login (fake
    access and refresh tokens) was written into the container's
    `~/.grok/auth.json`, then the container was restarted. The entrypoint
    blanked the refresh token and kept the access token.
  - `grok -p` with that access-only fake login exited 1 with "Not signed in"
    within the 90-second limit, and left the file with no refresh token.
  - Skipped: a real Grok call, because the host is signed out of Grok (see
    above).
- The Desktop and arm64 packet matrix and live credential rotation are
  tracked in [0019-container-platform-qualification.md](0019-container-platform-qualification.md).
  Item 3 needs live packet tests on Linux Engine and Desktop: allowed provider
  access, blocked destinations, host callbacks, sibling isolation, DNS
  rotation, IPv6 and firewall initialisation failure.
- Policy 3 (port tuples, done 2026-10-15) has unit coverage only. C22 now
  checks that an allowed domain answers on 443, another port on the same
  address is rejected and Git over SSH reaches GitHub; C23 checks per-port
  edits and revocation. Neither has run on a real daemon (Docker Desktop
  would not start containers that day), and `hash:net,port` support on the
  Desktop and rootless kernels is unconfirmed (init fails closed without
  it). The live re-run in container-platform-qualification.md covers both.
- Review follow-up added regressions for explicit GitHub ports and UDP,
  HTTPS-aware startup probe selection, policy-3 creation metadata,
  host-service port updates, DNS validation and the settings editor. C23
  additionally uses a local TCP/UDP echo peer to distinguish protocols on
  one port, check blocked ports, compare the reported entry count with ipset,
  and remove one established TCP flow while retaining another and UDP on the
  removed TCP port. The live attempt on Docker Desktop 29.8.1 still could not
  start containers (120-second timeouts; a minimal `/bin/true` container also
  remained `Created`). It did not reach any packet assertions. Evidence:
  `/tmp/orkestrator-test-run.0g2KQN/live-firewall.log.gz`. Run again with a
  current qualification image on a working daemon:

  ```bash
  RUN_LIVE_DOCKER_TESTS=1 ORKESTRATOR_QUALIFICATION_IMAGE=<image> mise run test:logged -- --name live-firewall -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-live-firewall.test.ts --parallel=1 --only-failures
  ```

## Constraints and rationale

- Default ports (decided 2026-10-15): TCP 443 for allowed domains, TCP 443 and
  22 for GitHub's ranges. Everything on the default lists is HTTPS on 443, so
  anything else needs a `host:port` (or `host:port/udp`) entry; plain HTTP
  (80) and SSH to other Git hosts are not defaults. Lists that relied on
  another port are not rewritten; the network status and settings help say
  what applies.
- Never claim that IP allowlisting prevents exfiltration. Shared CDN
  addresses, allowed services and DNS remain channels.
- Never fall back to the shared default bridge when the environment network
  cannot be created; that is an explicit error.
- No allow-all or empty window during a refresh: build the next set beside
  the live one, swap it in, then revoke tracked connections of removed
  entries.
- IPv6 stays dropped unless equivalent IPv6 enforcement is implemented and
  tested.
- Keep the restricted-mode sudo policy exact. Never add blanket sudo, never
  mount the Docker socket, and do not remove sudo capabilities or enable
  `no-new-privileges` before the privileged firewall initialisation has
  actually been replaced.
- Do not describe a root workload as unable to change its firewall.
- Published ports stay on loopback and authenticated.
- A container never holds a refresh token it shares with the host or another
  container when that provider's refresh tokens are single-use. It gets the
  access token, re-read from the host on start, and signs out on its own when
  that expires. Only the host refreshes, through the provider's own CLI;
  Orkestrator never calls a token endpoint or writes a host credential store
  itself, and an agent-test profile never refreshes the host at all.
- Credentials go only to enabled, authorized, non-revoked providers.
  Revocation is recorded before anything else, so an interrupted revoke still
  gates staging and syncs. Never promise that removal retracts a credential a
  workload already read, and never revoke an account-wide key.

## Open questions

- Which external enforcement: a proxy, a per-environment gateway container on
  the environment network, or a privileged sidecar that joins the workload's
  network namespace and owns its rules (so the workload process itself lacks
  `NET_ADMIN`)?
- How far to narrow root-terminal `NET_ADMIN` in restricted mode. Today it is
  a documented product choice, and the capability cannot be removed from one
  `docker exec` while the container keeps it.

## Related

- [0019-container-platform-qualification.md](0019-container-platform-qualification.md),
  [0021-container-rebuild-state-preservation.md](0021-container-rebuild-state-preservation.md)
  (retiring the policy-1 shared-bridge path),
  [0042-service-preview-rollout.md](../previews-and-annotations/0042-service-preview-rollout.md) (the container
  preview relay), [0040-mcp-environment-delivery.md](../mcp/0040-mcp-environment-delivery.md)
  (network and auth for MCP outside the backend host).
- [Container lifecycle](../../architecture/container-lifecycle.md): "Environment
  networks", "Agent tools reachability" and "Portable inputs".
- Living-doc drift to fix: `docker/AGENTS.md` says `node` has passwordless
  sudo for "exactly two things" (`init-firewall.sh` and `run-root-setup.sh`),
  but `docker/Dockerfile` grants three, the third being
  `network-policy-entrypoint.sh *`. The root `AGENTS.md` is correct.

## Replaces

- `docs/improvements/containers/plan/09-environment-networks-and-egress-policy.md`
  (unfinished items: tuples, canonical defaults, external egress, privilege
  boundary, in-place mode change)
- `docs/improvements/containers/plan/08-portable-inputs-and-credential-lifecycle.md`
  (credential and revocation constraints)
- `docs/improvements/containers/plan/00-index.md` (networking and privilege
  decisions)
- `docs/improvements/containers.md` (finding 5 and its egress-proxy
  recommendation)
- `docs/reviews/2026-09-15-fable-review.md` (the `NET_ADMIN` residual; its
  sudo findings are fixed)
