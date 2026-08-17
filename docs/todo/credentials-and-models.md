# Credentials and model catalogues

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
- `bridges/acp-bridge/src/index.ts` — Cursor/Grok live catalogue projection.
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
| Cursor | Host login where supported; stored or ambient `CURSOR_API_KEY` | `CURSOR_API_KEY`; host macOS login is not portable to Linux | Shared cache | No separate portable model catalogue found or used | Enabled |
| Grok | `~/.grok` and `~/.config/grok` | Bounded import of Grok auth/config | Shared cache | `~/.grok/models_cache.json` | Enabled via an isolated auth snapshot |

Credential authorization and UI platform selection are separate. Agent-test
profiles authorize all five credential sources by default, while the initial
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

For local environments, the managed Cursor agent can use its normal host login
where the platform supports it. Orkestrator additionally resolves
`CURSOR_API_KEY` from either:

1. the stored global Cursor API-key setting; or
2. the backend process's `CURSOR_API_KEY` environment variable.

The stored Cursor key is write-only through the renderer API. Reads return only
whether a key is configured and whether the effective source is `config`,
`host-env`, or `none`.

For Linux containers, the macOS Cursor login is not portable because it is held
in Keychain. Cursor therefore requires the headless `CURSOR_API_KEY` path. The
backend sends the key over stdin to an owner-only temporary container file; the
ACP bridge reads it into its environment when it starts. The key value is not
placed in the Docker command line. A fingerprint is used to restart a bridge
when the effective key changes.

Normal containers also import a small, bounded Cursor configuration allowlist,
but do not import ACP sessions, project state, caches, downloads, or
platform-specific binaries.

#### Models

Cursor advertises model and reasoning options through ACP session
configuration. The ACP bridge keeps the current catalogue in memory and exposes
it through `/global/models`. The backend normalizes successful live data and
persists it in the Cursor entry of `agent-model-catalog.json`.

There is no separate portable Cursor model-cache file in the current host state
or container import. The shared Orkestrator catalogue is the durable warm-start
source for Cursor model pickers.

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

Like Cursor, Grok publishes live model configuration through ACP. Orkestrator
normalizes that data and persists it in the Grok entry of
`agent-model-catalog.json`.

Grok also owns `~/.grok/models_cache.json`. Agent-test startup copies that file
into the isolated local home, and the Docker entrypoint includes it in the same
bounded allowlist. Containers therefore have both the shared Orkestrator warm
start and Grok's native cache before live discovery completes.

## Agent-test credential policy

`bun run dev:test` creates a profile with isolated application data, worktrees,
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

Use `--credential-source <name>` to narrow a profile to any one of those providers.
Use `--no-agent-credentials` for a deliberately signed-out profile. The two
forms cannot be combined.

### What “enabled” means

For an enabled source, local agent processes receive only the provider-specific
host state below. Grok uses a snapshot because its CLI cannot isolate its home
from the rest of `HOME`:

| Platform | Agent-test host state exposed |
| --- | --- |
| Claude | Host `CLAUDE_CONFIG_DIR`/`~/.claude`, process-scoped OAuth access token, and `ANTHROPIC_API_KEY` when inherited |
| Codex | Host `CODEX_HOME`/`~/.codex` and `OPENAI_API_KEY` when inherited |
| Cursor | Provider-scoped owner-only `auth.json` copied from named Keychain records, or `CURSOR_API_KEY` when inherited; host Cursor configuration is mounted read-only for containers |
| Grok | Owner-only snapshot of host `~/.grok/auth.json` for local runs; bounded read-only host imports for containers |
| OpenCode | Host XDG config/data/state directories and `OPENCODE_API_KEY` when inherited |

For Claude, Codex, and OpenCode this makes real local agent calls work, but it
also means a local provider can
write provider-owned state such as refreshed credentials, preferences, caches,
or session records back into the real host provider directory. Application
projects, Orkestrator sessions, and Orkestrator configuration remain isolated.

For a container test environment, those host provider directories are mounted
read-only and copied into writable container state using the normal production
allowlists. Claude's Keychain credential is synchronized separately over stdin.

When credentials are disabled, provider paths point into empty profile-owned
directories, Cursor's inherited key is removed, and no Grok auth is copied.
This prevents ambient provider logins from being discovered while still
allowing model metadata to be seeded separately.

Cursor and Grok follow the same explicit authorization gate as the other
providers. A narrowed or credential-free profile removes `CURSOR_API_KEY`, does
not mount their host directories, and does not copy Grok auth. The isolated
Orkestrator config still does not inherit the production stored Cursor key.

Grok is the deliberate local-path exception: its CLI has no documented
provider-home override, so pointing its process at the host `HOME` would also
expose unrelated credentials. Startup instead copies only `auth.json` through a
bounded, no-final-symlink, stable-descriptor path into the isolated home. It is
refreshed from the host on each profile start and installed mode `0600`.

### macOS Keychain credential brokering

Claude's and Cursor's host logins normally live in the macOS login Keychain. The
backend and its terminals keep an isolated `HOME`; startup never links the host
Keychain directory or its writable database into that tree. Instead, each
authorized provider uses an explicit lookup against the host login Keychain path
and its own fixed service names.

Claude's credential JSON is parsed and only its OAuth access token is added to
the Claude bridge process as `ANTHROPIC_AUTH_TOKEN`. The general backend and
terminal environments receive no Keychain path or OAuth token. Container sync
uses the same explicit Claude service lookup and still sends the complete JSON
over stdin so the container can retain refresh information. On hosts that keep
credentials on disk, lookup prefers the recorded host `CLAUDE_CONFIG_DIR` before
the host home fallback.

Cursor's supported `AGENT_CLI_CREDENTIAL_STORE=file` mode provides a narrower
path. Startup reads only `cursor-access-token`, `cursor-refresh-token`, and
`cursor-api-key` for account `cursor-user`, then atomically writes those fields
mode `0600` beneath a Cursor-specific process HOME. The Cursor bridge alone gets
that HOME. A missing host record or disabled Cursor source removes the prior
snapshot before launch, so host logout and profile opt-out revoke access.

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

The cache seeding copies model metadata only. The separately gated Grok auth
snapshot copies exactly `auth.json`; neither path copies Orkestrator projects,
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
   auth snapshot; changing the other providers requires provider-specific
   writable overlays or supported home splits.
2. **OpenCode cache seeding is project-scoped.** Production project IDs do not
   automatically map to a new fixture project. Falling back to another
   project's catalogue would incorrectly expose models added by that project's
   `opencode.json`, so a live fixture discovery remains the safe path.
3. **Credential mechanisms remain provider-native where possible.** Claude and
   Cursor expose optional write-only API-key overrides because those are needed
   for headless/container paths. Codex, OpenCode, and Grok continue to use their
   own login state rather than accumulating duplicate secrets in Orkestrator.
4. **Signed-out Cursor runs use the provider's file-store control.** The
   agent-test gate removes inherited Cursor keys, assigns a Cursor-specific HOME,
   selects `AGENT_CLI_CREDENTIAL_STORE=file`, and removes any prior imported
   `auth.json` when Cursor is not authorized. The CLI therefore cannot fall back
   to the host macOS Keychain.

These are descriptions of current behavior, not assumptions that a visible
cached model implies a usable credential.
