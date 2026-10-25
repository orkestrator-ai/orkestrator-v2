# Credentials and model catalogues

Status: Living — credential and catalogue inventory.

This report describes the current credential and model-metadata behavior for
Claude Code, Codex, OpenCode, Cursor Agent, and Grok Build. It covers normal
local worktrees, Docker environments, and isolated `dev:test` profiles.

The main implementation points are:

- `apps/desktop/electron/backend-process.ts` — backend environment isolation.
- `apps/backend/src/core/commands.ts` — provider launch, credential delivery,
  live catalogue discovery, and container mounts.
- `apps/backend/src/core/storage.ts` — durable application-level catalogues.
- `docker/entrypoint.sh` — bounded host-state import into writable containers.
- `bridges/codex-bridge/src/models-cache.ts` and
  `bridges/codex-bridge/src/index.ts` — Codex-native cache and refresh order.
- `bridges/cursor-bridge/src/models.ts` and `bridges/acp-bridge/src/index.ts` —
  Cursor SDK and Grok ACP live catalogue projection.
- `apps/desktop/scripts/dev/profile-io.ts` — model-cache seeding for agent-test
  profiles.

## Terminology

- **Credential** means a token, API key, OAuth record, or provider login state
  used to authenticate a real agent request.
- **Live catalogue** means model metadata obtained from a running provider or
  bridge.
- **Application catalogue cache** means normalized model metadata persisted by
  Orkestrator for pickers and launchers.
- **Provider-native cache** means a cache owned by the provider CLI, such as
  Codex or Grok `models_cache.json`.
- **Preference state** means the selected/recent model, not a catalogue.
  OpenCode's `model.json` is preference state.

Model metadata is not a credential. Copying a catalogue can populate a picker,
but it cannot make a signed-out provider capable of running a request.

## Summary

| Platform | Normal local credential source | Container credential source | Durable Orkestrator catalogue | Provider-native cache | `dev:test` default credential access |
| --- | --- | --- | --- | --- | --- |
| Claude | macOS Keychain or `~/.claude/.credentials.json`; optional `ANTHROPIC_API_KEY` | Host OAuth synchronized over stdin; optional `ANTHROPIC_API_KEY` | Shared cache plus per-environment snapshot | No additional portable model cache used here | Enabled |
| Codex | `CODEX_HOME`/`~/.codex/auth.json`; optional `OPENAI_API_KEY` | Read-only Codex home import | Shared cache | `models_cache.json` and bridge `models-cache.json` | Enabled |
| OpenCode | XDG config/data state; optional `OPENCODE_API_KEY` | Read-only XDG imports copied into the container | Project-scoped cache | Provider state and `model.json` preferences | Enabled |
| Cursor | Stored or ambient `CURSOR_API_KEY`, else the in-app SDK login in Orkestrator's data directory | Effective key or stored SDK login over stdin | Shared cache | No separate portable model catalogue found or used | Enabled via an owner-only key snapshot |
| Grok | `~/.grok` and `~/.config/grok` | Bounded import of Grok auth/config | Shared cache | `~/.grok/models_cache.json` | Enabled via an isolated auth snapshot |
| Pi | `~/.pi/agent/auth.json` (or `PI_CODING_AGENT_DIR`); provider API-key variables | Bounded import of `~/.pi` | Shared cache | Pi's own `models-store.json` | Enabled: the host `auth.json` and its saved default model only |

Credential authorization and UI platform selection are separate. Agent-test
profiles authorize all six credential sources by default, while the initial
enabled-platform setting remains the legacy Claude/Codex/OpenCode set. Cursor
and Grok must still be enabled in profile settings before their UI paths and
managed toolchains are available.

## Application-level catalogue storage

Orkestrator has two durable stores:

### `agent-model-catalog.json`

This host-level cache can contain entries for:

- Claude
- Codex
- Cursor
- Grok

Each platform entry contains a timestamp and normalized model list. The web
client reads this file through the backend before the first React render, so a
recent catalogue can populate model pickers without waiting for a bridge to
start. A later live catalogue replaces the in-memory presentation and refreshes
the persisted entry.

Malformed entries are discarded by the storage parser. A provider's valid
entry remains usable when another provider's entry is invalid.

### `opencode-model-catalog.json`

OpenCode is stored separately because its providers and available models can
vary by project configuration. The file is a project-ID-keyed store of
normalized snapshots. Each snapshot has a content-derived version, update time,
and model list.

The backend filters OpenCode models against `openCodeModelProviders` when it
reads the cache. It keeps the wider raw catalogue on disk, allowing a later
provider-allowlist expansion to reveal models without waiting for another live
discovery.

## Platform details

### Claude Code

#### Credentials

For local environments, Claude uses the backend process's Claude configuration
and environment. On macOS, the primary OAuth credential normally resides in the
login Keychain. Linux can use `~/.claude/.credentials.json`. An
`ANTHROPIC_API_KEY` may also come from the process environment or the stored
global setting. The stored value wins, and local/container launch paths use the
same resolver.

For containers:

1. The host Claude configuration directory is mounted read-only.
2. The entrypoint copies a bounded allowlist of portable configuration and
   user-authored extension directories into writable container state.
3. `.claude.json` is filtered to remove host project paths and establish the
   `/workspace` trust/onboarding state.
4. The backend reads the macOS Keychain or host credential file and sends the
   OAuth JSON through `docker exec` stdin.
5. The credential is atomically written as owner-only
   `~/.claude/.credentials.json` inside the container.
6. The sync runs on every container start so a refreshed host token can replace
   stale container state.

The OAuth payload is not placed in Docker command arguments or long-lived
container environment variables. An effective `ANTHROPIC_API_KEY`, however,
is forwarded as a container environment variable. Like Cursor's key, it is
write-only to the renderer: settings reads expose only configured/effective
source metadata. `useHostClaudeCredentials` can disable host OAuth propagation
into normal containers.

#### Models

The Claude bridge queries the installed SDK/CLI for the live catalogue. A
successful SDK result is persisted in two places:

- the environment's `claudeModelCatalog` snapshot, used as the authoritative
  last-known result for that environment;
- the Claude entry in `agent-model-catalog.json`, used to warm later launchers.

If live refresh fails, the environment snapshot is returned as stale
last-known-good data. The bridge also has bundled fallback models, but fallback
results are marked stale and are not written into the shared host cache.

### Codex

#### Credentials

For local environments, Codex uses `CODEX_HOME` when set, otherwise
`~/.codex`. The normal file credential is `auth.json`; `OPENAI_API_KEY` is also
supported through the inherited process environment.

For containers, the Codex home is mounted read-only and the entrypoint copies a
bounded allowlist into writable `~/.codex`. The allowlist includes `auth.json`,
configuration, user-authored rules/skills/prompts, the platform-neutral plugin
cache, and `models_cache.json`. Session rollouts, logs, worktrees, generated
images, and platform-specific plugin-appserver binaries are not copied.

#### Models

The Codex bridge resolves models in this order:

1. its in-memory cache;
2. `CODEX_HOME/orkestrator-bridge/models-cache.json`;
3. Codex CLI's `CODEX_HOME/models_cache.json`;
4. the bridge's bundled fallback catalogue.

It launches `codex debug models` in the background to refresh the live result.
Successful live data refreshes the bridge cache and is also normalized into the
Codex entry in `agent-model-catalog.json` by the backend.

The bridge serves cached or fallback data immediately; model discovery does not
block the first `/global/models` response on the CLI subprocess.

### OpenCode

#### Credentials

For local environments, OpenCode uses its XDG locations:

- configuration: `${XDG_CONFIG_HOME:-~/.config}/opencode`;
- data and authentication: `${XDG_DATA_HOME:-~/.local/share}/opencode`;
- state and preferences: `${XDG_STATE_HOME:-~/.local/state}/opencode`.

`OPENCODE_API_KEY` can also be inherited from the host process.

For containers, configuration and data directories are mounted read-only, while
the state mount exposes only `model.json`. Every imported entry goes through the
shared bounded, symlink-safe copy helpers. Configuration excludes host
`node_modules`; data includes the bounded `auth.json`, `account.json`, storage,
and snapshot allowlist. The host session database, prompt history, frecency,
locks, and other mutable state are not imported.

#### Models

OpenCode's live provider/model list is normalized and cached per project in
`opencode-model-catalog.json`. Provider filtering is applied when the backend
returns models to the client, not when it persists the wider discovered list.

`~/.local/state/opencode/model.json` records recent/favorite/variant choices. It
is not the source of the complete model catalogue.

### Cursor Agent

#### Credentials

Cursor is SDK-only. For local environments, Orkestrator resolves credentials in
this order:

1. the stored global Cursor API-key setting;
2. the backend process's `CURSOR_API_KEY` environment variable;
3. an authorized agent-test host credential snapshot, when present and unexpired; or
4. a login minted through the Cursor SDK browser flow and stored in
   Orkestrator's data directory.

The stored Cursor key is write-only through the renderer API. Reads return only
whether a key is configured and whether the effective source is `config`,
`host-env`, `host-snapshot`, or `none`. Auth status uses the same precedence as
bridge launches.

For containers, the backend sends either the effective API key or the stored SDK
login over stdin to an owner-only temporary file. The key value is not placed in
the Docker command line. A fingerprint restarts the SDK bridge when the
effective credential changes.

Normal containers also import a small, bounded Cursor configuration allowlist,
but do not import host sessions, project state, caches, downloads, or
platform-specific binaries.

#### Models

The Cursor SDK exposes models and their effort/speed parameters. The SDK bridge
normalizes those into the shared composer contract, keeps the live catalogue in
memory, and exposes it through `/global/models`. The backend persists successful
live data in the Cursor entry of `agent-model-catalog.json`.

There is no separate portable Cursor model-cache file in the current host state
or container import. The shared Orkestrator catalogue is the durable warm-start
source for Cursor model pickers.

### Pi

#### Credentials

Pi fronts other vendors' models, so its login is one credential per provider
in `~/.pi/agent/auth.json`, written by `/login` in a Pi terminal, plus any
provider API-key variable. A local Pi bridge leaves `PI_AGENT_DIR` unset and
reads that directory as `pi` does. Containers mount `~/.pi` as a portable
input and the entrypoint copies a bounded allowlist. A container's
`auth.json` is access-only: OAuth logins other than GitHub Copilot and Meta
have their refresh token blanked (Anthropic, OpenAI and xAI rotate theirs),
expired ones are left out, and the host's current copy is pushed again before
every Pi bridge start (`restrictPiAuthSnapshot` in
`packages/protocol/src/login-snapshots.ts`). OpenCode's `auth.json` is handled
the same way. Run `pi` (or `opencode`) on the host to refresh a login a
container needs. The bridge never serves
sign-in itself; see [agent-engines.md](../architecture/agent-engines.md) § Pi.

`PI_BRIDGE_AUTH_FILE` moves the credential file alone out of the agent
directory. Only agent-test uses it (see below), together with
`PI_BRIDGE_DEFAULT_MODEL`.

#### Default model

A Pi tab that names no model starts where `pi` itself would: on the saved
default in `settings.json` (`defaultProvider`/`defaultModel`, what `/model`
writes), as long as a signed-in provider serves it. A project's
`.pi/settings.json` counts only when the session trusts the project. With no
usable default, the bridge falls back to `PI_BRIDGE_DEFAULT_MODEL`, then to the
catalogue's first model. Pi's own fallback table of per-provider defaults is
not exported by the SDK, so the bridge does not reproduce it. The first model
can be one the login refuses. Pi 1.2.0 signs ChatGPT in under the `openai`
provider, whose catalogue starts with `gpt-4`, and the ChatGPT backend
rejects it. The legacy `openai-codex` provider lists `gpt-5.3-codex-spark`
first and rejects that. See
[0062](../todo/agent-engines/0062-pi-chatgpt-login-without-saved-default.md).

### Grok Build

#### Credentials

For local environments, Grok uses its normal host state under `~/.grok` and
`~/.config/grok`. Its file credential is `~/.grok/auth.json`.

For normal containers, both host directories are mounted read-only and copied
into writable container state using bounded, symlink-safe helpers. The primary
allowlist includes `auth.json`, `config.toml`, `trusted_folders.toml`,
`agent_id`, `models_cache.json`, hooks, and skills. Runtime session databases,
logs, and other
mutable host state are not imported.

#### Models

Grok publishes live model configuration through ACP. Orkestrator normalizes
that data and persists it in the Grok entry of
`agent-model-catalog.json`.

Grok also owns `~/.grok/models_cache.json`. Agent-test startup copies that file
into the isolated local home, and the Docker entrypoint includes it in the same
bounded allowlist. Containers therefore have both the shared Orkestrator warm
start and Grok's native cache before live discovery completes.

## Agent-test credential policy

`mise run dev:test` creates a profile with isolated application data, worktrees,
runtime files, logs, Docker ownership, and an isolated replacement `HOME`. It
also removes ambient cloud, GitHub, package-registry, Kubernetes, and similar
credential locations from the backend environment.

### Defaults and command-line controls

Agent-test startup enables all provider credential sources by default:

- Claude
- Codex
- Cursor
- Grok
- OpenCode
- Pi

Use `--credential-source <name>` to narrow a profile to any one of those providers.
Use `--no-agent-credentials` for a deliberately signed-out profile. The two
forms cannot be combined.

### What “enabled” means

For an enabled source, local agent processes receive only the provider-specific
host state below. Every provider home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, the
XDG directories OpenCode uses, Grok's and Pi's directories under `HOME`) is the
profile's own whether or not its source is enabled; an enabled source adds the
host's login to it, never the host directory. Pi is the one exception, below:

| Platform | Agent-test host state exposed |
| --- | --- |
| Claude | Process-scoped OAuth access token read from the host `CLAUDE_CONFIG_DIR`/`~/.claude` (or Keychain), and `ANTHROPIC_API_KEY` when inherited. The bridge keeps the profile's own `CLAUDE_CONFIG_DIR`. |
| Codex | Owner-only snapshot of host `CODEX_HOME`/`~/.codex` `auth.json` in the profile's own `CODEX_HOME`: an API key, or the ChatGPT access and id tokens with a placeholder refresh token; `OPENAI_API_KEY` when inherited |
| Cursor | Owner-only snapshot of the host's effective Orkestrator Cursor key (`CURSOR_API_KEY` when inherited still wins) |
| Grok | Owner-only snapshot of host `~/.grok/auth.json`, with each refresh token blanked and expired logins dropped, for local runs and for containers |
| OpenCode | Owner-only snapshot of host `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json` in the profile's own XDG data directory: API keys and well-known tokens, OAuth access tokens with the refresh token blanked; `OPENCODE_API_KEY` when inherited. Host OpenCode config and state are not copied. |
| Pi | Host `~/.pi/agent/auth.json` (or `PI_CODING_AGENT_DIR`), shared in place; nothing else from the host Pi directory. Tilde overrides expand against the host home and relative overrides resolve before HOME changes. |

Cursor, Grok, Codex and OpenCode snapshots refresh on every profile start.
Opting out or losing the host credential removes the previous snapshot. A failed
refresh also removes the old snapshot; a Cursor removal failure stops startup,
the others warn. Codex and OpenCode remove only a snapshot an earlier start
published (recorded in an `auth.json.orkestrator-host-snapshot` marker beside
it), so a login made inside a profile that does not authorize the host's
survives. Cursor snapshots preserve a
minted key's expiry, and the backend stops resolving the key when it expires.
A Grok snapshot carries access tokens only (`restrictGrokAuthSnapshot` in
`packages/protocol/src/login-snapshots.ts`, shared with container staging). xAI refresh tokens are single-use:
on 2026-10-18 a profile that refreshed with a copy of the host's token spent
it, the next copy failed its refresh, and Grok cleared that login. So a
profile may use the host's current access token until it expires, but it can
never refresh, and the launcher warns and seeds nothing when the host access
token has already expired. Run `grok` on the host to refresh it (or
`grok login` if the host is signed out), then restart the profile.
Codex and OpenCode snapshots follow the same rule
(`restrictCodexAuthSnapshot` and `restrictOpenCodeAuthSnapshot`). ChatGPT
refresh tokens rotate, so the Codex copy carries a placeholder refresh token
(non-empty, because the Codex bridge treats a login without one as signed out)
and a `last_refresh` of the copy time, so Codex does not attempt its interval
refresh; one it still attempts after a 401 fails and signs only the profile
out. An access token that expires within a minute is withheld with a warning:
run `codex` on the host, then restart the profile.

Cursor settings identify this source separately from an environment key. To remove
it, narrow the profile's credential sources or clear the host Cursor credential,
then restart the profile.

So nothing a profile does writes to the host's Claude, Codex, OpenCode or Grok
directories: sessions, trust grants, MCP editor saves, preferences and caches
land in the profile's own homes, and no refresh can rotate the host's login.
Pi is the exception: its bridge reads and refreshes the host `auth.json` in
place, as described below, and writes nothing else there.

For a container test environment, the same provider homes (the profile's
snapshots for Codex and OpenCode, the host's `~/.claude` read-only for Claude)
are mounted read-only and copied into writable container state using the
normal production allowlists. Claude's Keychain credential is synchronized
separately over stdin. Claude, Codex and Grok logins reach any container
(test or not) access-only, with the refresh token removed or blanked and
expired logins withheld, because their refresh tokens are single-use and a
container refresh would sign the host out. An agent-test profile never
refreshes the host's Claude login for its containers; they sign out when the
host's access token expires
([Container lifecycle](../architecture/container-lifecycle.md), "Portable
inputs").

When credentials are disabled, provider paths point into empty profile-owned
directories, Cursor's inherited key is removed, and no Grok auth is copied.
This prevents ambient provider logins from being discovered while still
allowing model metadata to be seeded separately.

Cursor, Grok and Pi follow the same explicit authorization gate as the other
providers. A narrowed or credential-free profile removes `CURSOR_API_KEY`,
removes the Cursor key snapshot, does not mount their host directories, does
not copy Grok auth, and names no host Pi file. The isolated Orkestrator config
never inherits the production stored Cursor key; the snapshot below is a
separate file the profile's settings do not show or store.

Pi shares the host `auth.json` in place rather than copying it. Pi's OAuth
providers rotate refresh tokens, so a copy that refreshed would sign the host's
`pi` out. The bridge's `PI_BRIDGE_AUTH_FILE` names that one file, and
`PI_AGENT_DIR` stays unset, so settings, `models.json`, `mcp.json` and
extensions come from the isolated HOME's own `~/.pi/agent`. The desktop records
only the host directory path (`ORKESTRATOR_AGENT_TEST_HOST_PI_AGENT_DIR`). The
backend names the file to the bridge, and to the host catalogue probe, only
when it already exists, because Pi creates a missing one. A login made after
startup applies from the next bridge start. The host side sees only what the
host's own `pi` does: Pi's transient `auth.json.lock` directory beside the file
on each read or write, and a refreshed login when a token expires.

The host's saved default model goes with its login, because the profile's own
settings name none and the catalogue's first model may be one the login
refuses. When the backend names the host `auth.json`, it also reads
`defaultProvider` and `defaultModel` from the host's `settings.json`, and
nothing else from that file, and passes them as `PI_BRIDGE_DEFAULT_MODEL`
(`readPiDefaultModel` in `host-agent-credentials.ts`). The bridge uses it only
when the profile's own settings name no default, or name one that no
signed-in provider serves. It is read again on
every bridge start, so a changed host default applies from the next one.

Cursor's login is Orkestrator's own rather than a provider home: the stored key
in production `config.json`, else the in-app SDK login's minted key in
production `cursor-sdk/auth.json`. `dev:test` writes the effective key, and
nothing else, to `<profile data>/agent-credentials/cursor/host-api-key.json`
(mode `0600`, directory `0700`) on every start, and deletes the file when Cursor
is not authorized or the host key is missing or expired. The backend reads it
once at startup in place of an inherited `CURSOR_API_KEY`. It is not exported
into `process.env`, which terminals and other child processes inherit. A key
stored in the profile's own settings still wins. Settings report the snapshot
as `host-env`, and the sign-in card as `api-key-env`.

Grok is the deliberate local-path exception: its CLI has no documented
provider-home override, so pointing its process at the host `HOME` would also
expose unrelated credentials. Startup instead copies only `auth.json` through a
bounded, no-final-symlink, stable-descriptor path into the isolated home. It is
refreshed from the host on each profile start and installed mode `0600`.

### macOS Keychain credential brokering

Claude's host login normally lives in the macOS login Keychain. The
backend and its terminals keep an isolated `HOME`; startup never links the host
Keychain directory or its writable database into that tree. Instead, each
authorized provider uses an explicit lookup against the host login Keychain path
and its own fixed service names. Cursor is SDK-only and uses no Keychain record.

Pinning the lookup to `<host home>/Library/Keychains/login.keychain-db` is what
makes an isolated profile deterministic, because that profile's `HOME` holds no
Keychain preferences for an unqualified lookup to resolve against. An ordinary
install has no such isolation and may legitimately keep the record in another
keychain, so only the non-agent-test container path retries the default search
list after the pinned lookup misses. An agent-test profile never falls back.

Claude's credential JSON is parsed and only its OAuth access token is added to
the Claude bridge process as `ANTHROPIC_AUTH_TOKEN`. A recorded `expiresAt` that
has already passed — or lapses within a 30-second startup grace period — yields
no token, because the value is read once at bridge start and never refreshed; a
stale bearer token would be preferred over every other source and turn an
expired host login into opaque authentication failures rather than the
signed-out state the agent reports clearly. The general backend and terminal
environments receive no Keychain path or OAuth token. Container sync uses the
same explicit Claude service lookup and still sends the complete JSON over stdin
so the container can retain refresh information. When the launching shell set
`CLAUDE_CONFIG_DIR` explicitly, lookup uses that directory's hashed Keychain
entry or its `.credentials.json` only, as Claude itself does; otherwise it reads
the default login and the host home.

Startup also removes the legacy `<isolated HOME>/Library/Keychains` symlink from
profiles created by earlier builds. Real profile-owned directories at that path
are left untouched.

## Agent-test model-cache seeding

Before the isolated backend starts, `dev:test` fills each missing destination
below from the corresponding available regular file. A destination already
present in the profile is never replaced, preserving newer data discovered by
live providers during earlier runs:

| Source | Isolated destination | Purpose |
| --- | --- | --- |
| Production `agent-model-catalog.json` | Profile application data | Claude, Codex, Cursor, and Grok picker warm start |
| Production `opencode-model-catalog.json` | Profile application data | Existing project-scoped OpenCode snapshots |
| Host Codex `models_cache.json` | Isolated Codex home | Codex CLI-native cache |
| Host Codex bridge `models-cache.json` | Isolated Codex bridge cache | Immediate bridge warm start |
| Host Grok `models_cache.json` | Isolated `HOME/.grok` | Grok CLI-native cache |

Each seed source is opened without following a final symlink, must remain the
same regular file throughout the copy, and is read through that descriptor with
a hard limit of 16 MiB. The destination is installed atomically without
replacement and with mode `0600`. Missing, unreadable, oversized, changing, or
failed optional copies do not prevent profile startup. Normal storage and bridge
parsers still validate the copied content before using it.

The cache seeding copies model metadata only. The separately gated Grok,
Codex and OpenCode auth snapshots each copy exactly one restricted `auth.json`; neither path copies Orkestrator projects,
environments, sessions, prompts, or general provider configuration.

One limitation is that OpenCode snapshots remain keyed by their production
project IDs. A newly seeded fixture has a new project ID, so the copied
OpenCode store may not warm that fixture's picker until a live OpenCode bridge
discovers and caches the fixture's own catalogue. That profile-local discovery
is then preserved across restarts.

## Browser gateway credential in agent testing

The browser gateway credential is separate from all provider credentials. The
agent-test status manifest contains only the path to an owner-only `authFile`.
The JSON file's `token` property is the exact gateway login code.

The token must be entered only in the gateway-token password field. It must not
be placed in a URL, command argument, screenshot, trace, report, or chat
message. The automated browser suite reads the file outside the browser, mints
a short-lived single-use bootstrap, and exchanges it by POST so the durable
gateway token does not enter browser history or persistent browser state.

## Security and lifecycle properties

- Agent-test application data is separate from the production Orkestrator data
  directory.
- Provider credentials and gateway tokens must not be written to logs, status
  manifests, test reports, screenshots, or artifacts.
- Docker credential delivery uses read-only mounts or stdin where practical.
- Allowlisted container copies are bounded and reject symlinked
  sources/destinations. OpenCode imports only its allowlisted configuration and
  exact model-preference file rather than copying the full state directory.
- Claude OAuth and Cursor bridge credentials synchronized over stdin are written
  owner-only and redacted from command diagnostics. API-key environment values
  are likewise redacted wherever container commands are reported.
- The renderer receives only credential presence/source for stored Anthropic
  and Cursor API keys, never either stored value. Replacement and clearing use
  dedicated write-only commands, and ordinary config writes preserve both.
- Model catalogue corruption is non-fatal: consumers reject invalid entries and
  retain live, last-known-good, or bundled fallback data as available.
- Resetting an agent-test profile deletes only its isolated state. It does not
  remove or roll back changes a live local provider already wrote into its real
  host provider directory.

## Remaining intentional constraints and follow-up considerations

1. **Allowed local provider homes are usually shared with the host.** This
   enables real Claude/Codex/OpenCode testing, but local test sessions can add
   or update provider-owned host state. Grok avoids this through its isolated
   auth snapshot. Pi shares only `auth.json`, so the one host write it can make
   is a refreshed login. Changing the other providers requires
   provider-specific writable overlays or supported home splits.
2. **OpenCode cache seeding is project-scoped.** Production project IDs do not
   automatically map to a new fixture project. Falling back to another
   project's catalogue would incorrectly expose models added by that project's
   `opencode.json`, so a live fixture discovery remains the safe path.
3. **Credential mechanisms remain provider-native where possible.** Claude and
   Cursor expose optional write-only API-key overrides because those are needed
   for headless/container paths. Codex, OpenCode, and Grok continue to use their
   own login state rather than accumulating duplicate secrets in Orkestrator.
4. **Signed-out Cursor runs have no host key to fall back to.** The agent-test
   gate removes inherited Cursor keys and the key snapshot when Cursor is not
   authorized. The bridge is pinned to the profile's own SDK login file, so it
   never reads the SDK's default `~/.cursor/sdk/auth.json`.

These are descriptions of current behavior, not assumptions that a visible
cached model implies a usable credential.
