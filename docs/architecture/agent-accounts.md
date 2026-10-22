# Agent accounts

Status: Living — `apps/backend/src/core/agent-accounts*.ts`,
`apps/backend/src/core/agent-account-bridge-state.ts`,
`packages/protocol/src/agent-accounts.ts`,
`apps/web/src/components/settings/AgentAccountsSection.tsx`;
`apps/backend/src/core/opencode-provider-login.ts`,
`packages/protocol/src/opencode-provider-auth.ts`,
`apps/web/src/components/settings/OpenCodeProvidersSection.tsx`.

Claude and Codex can each hold more than one login. The user sees each
account's plan usage and picks which one agents run on. Switching is global
per platform: there is one active Claude account and one active Codex account,
and no tab, environment or settings tier records an account. Accounts never
run side by side in one platform, so bridge keys, tab records and the agent
settings tiers are unchanged by accounts.

Outstanding work and known gaps are in
[0003-agent-accounts-and-sign-in.md](../todo/agent-engines/0003-agent-accounts-and-sign-in.md).

## Account directories

Each added account is its own provider configuration directory:

```
<dataDir>/agent-accounts/claude/<id>/   CLAUDE_CONFIG_DIR for that account
<dataDir>/agent-accounts/codex/<id>/    CODEX_HOME for that account
```

The implicit `default` account is the host login (`~/.claude`, `~/.codex`).
It has no directory of its own, cannot be removed, and launches exactly as it
did before accounts existed: `CLAUDE_CONFIG_DIR` and `CODEX_HOME` stay unset.
Ids are lowercase UUIDs because they name a directory. A platform holds at
most 16 added accounts (`MAX_AGENT_ACCOUNTS_PER_PLATFORM`).

The registry is `agent-accounts.json` (`agent-accounts-store.ts`): accounts,
the active id per platform and a per-platform `loginGeneration`. It is kept
out of `config.json` because the renderer writes the whole global config back
and would overwrite a list it never edits. It holds no credential.

### Shared entries

Only the login differs between accounts. `prepareAgentAccountHome` runs before
every launch and links everything the user authored, and every transcript,
back to the host directory, so a conversation started on one account resumes
on another:

- Claude (`CLAUDE_SHARED_ENTRIES`): `settings.json`, `settings.local.json`,
  `CLAUDE.md`, `agents`, `commands`, `skills`, `plugins`, `hooks`, `rules`,
  `output-styles`, `keybindings.json`, `projects`, `todos`, `file-history`,
  `plans`, `history.jsonl`.
- Codex (`CODEX_SHARED_ENTRIES`): `config.toml`, `AGENTS.md`, `skills`,
  `rules`, `prompts`, `hooks.json`, `plugins`, `sessions`,
  `archived_sessions`, `session_index.jsonl`, `history.jsonl`. SQLite state is
  never linked: SQLite creates its `-wal`/`-shm` sidecars next to the path it
  opened, so a linked database would be written from two directories.

`projects` (Claude) and `sessions` (Codex) are created on the host when
missing, so an account's first session does not grow a private copy.
`linkSharedEntries` is conservative: a regular file already in the account
directory is left alone, because a CLI that saves by atomic rename replaces
the link with one, and that content is the account's now. A link whose host
target has gone is removed.

Claude's `.claude.json` is per account, because it holds `oauthAccount`. Once
`CLAUDE_CONFIG_DIR` is set it is also the only place Claude reads user- and
local-scope MCP servers from. `syncClaudeAccountSettings` therefore copies
`mcpServers`, `hasCompletedOnboarding` and each project's MCP, trust and
allowed-tools keys from the host file before every launch. It holds Claude's
own `.claude.json.lock` directory lock while it does, and never touches the
account's own keys.

Credentials are never copied between account directories. Refresh tokens
rotate, so a copy goes stale as soon as the original refreshes.

## Switching

`set_active_agent_account` records the choice; nothing is killed. The next
`start_local_<agent>_server_cmd` for an environment asks
`localBridgeIsOnActiveAccount` whether the running bridge was launched on the
active account (`localAgentAccountIds`). An idle bridge on another account is
replaced. A bridge with observed live work keeps running on the old account
until it is idle. The replacement resumes its sessions from the shared
transcripts on the next prompt.

`applyActiveAgentAccountEnvironment` sets `CLAUDE_CONFIG_DIR` or `CODEX_HOME`
for an added account. It also strips inherited bearer credentials
(`INHERITED_CREDENTIAL_ENV`: Anthropic, Claude OAuth, OpenAI and Codex keys),
which the CLI would otherwise prefer over the account's own login.

An account cannot be removed while it is active, while a live local bridge was
launched on it, or while a terminal opened on it is still running. Removal
deletes its directory and, on macOS, its Keychain entry.

## Login

`start_agent_account_login` drives the provider CLI's own login from the
backend (`agent-accounts-login.ts`). One sign-in runs at a time across both
platforms. The renderer polls `get_agent_account_login`, opens the URL itself,
and sends Claude's code with `submit_agent_account_login_code`.

- **Claude:** `claude auth login` with `CLAUDE_CONFIG_DIR` set. It prints the
  authorize URL and reads the pasted code from stdin. `open`, `xdg-open` and
  `BROWSER` point at a no-op shim so the CLI never opens a browser on the
  backend's desktop.
- **Codex:** `codex login --device-auth` with `CODEX_HOME` set. It prints a
  verification URL and a one-time code and exits once approved. Device code
  avoids the browser flow's fixed `127.0.0.1:1455` callback.

The CLI owns the OAuth exchange and writes the credential where it always does
for that directory. The backend never sees the token, and CLI output is
bounded and never logged. A login is given 16 minutes; Codex's device code
lasts 15.

A login that resolves to an identity already listed, including the host
login, is refused and its directory removed. So is any failed or cancelled
add.

The same driver signs in the host GitHub CLI (kind `"github"`; see
[github-cli.md](github-cli.md)).

### Signing the active account in again

`start_agent_account_login` with `reauthenticate: true` (Claude only) renews
the **active** account, host login or added, instead of creating one:

1. `claude auth login` runs against a temporary directory,
   `<dataDir>/agent-accounts/.reauth/<operationId>`, so a failed or cancelled
   attempt never touches the existing login.
2. The new login must be signed in, carry an identity, and not belong to the
   host or another listed account.
3. `promoteClaudeLogin` writes the credential and `oauthAccount` into the
   account (its `.credentials.json`, its `.claude.json`, and its Keychain
   entry when one exists) under the registry lock. If persisting the registry
   fails, the previous login is restored.
4. The stored identity is refreshed. A label that was only the old email
   follows the new one. The platform's `loginGeneration` is set to the
   operation id, and the account's usage cache is dropped.

An agent-test profile refuses to renew the host login, because it may only
read the host login its harness granted.

Every bridge that may hold the previous login is then flagged:

- Live local Claude bridges go into `staleLoginLocalBridges`.
  `localBridgeIsOnActiveAccount` treats a flagged bridge as being on another
  account, so it is replaced the next time it is used while idle; a busy one
  finishes first.
- When containers share the host login (`useHostClaudeCredentials` on), every
  container environment goes into `staleLoginEnvironmentIds`.
  `reconcileContainerAgentAccount` then pushes the new login in and replaces
  the idle in-container bridge even when its marker already matches. The
  in-process flag is only a hint: the durable `loginGeneration` in the
  container marker catches a renewal missed across a backend restart.

A container with its own isolated login is not touched; it is still signed in
from a terminal inside it.

The UI is `ClaudeAuthRecoveryCard`. It shows under a Claude authentication
error in the transcript, and pinned above the composer while Claude's `Not
logged in · Please run /login` reply is the latest exchange or Claude reports
`authentication-required` readiness (below). It reuses the settings pane's
link-and-code panel and resumes a sign-in already running.

## Sign-in readiness

Every platform reports a missing login before a send as
`readiness: { state: "authentication-required", message, signIn }` on its
session status (`NativeAgentReadiness`). The tab locks the send button and
shows the message with the route `signIn` names: an in-tab sign-in for
`browser-url` and `device-code` (Codex, Cursor), and otherwise the hint plus a
terminal tab running the platform's login command (`agent-sign-in.ts`; the
commands are fixed in the renderer, never taken from a bridge). Claude shows
`ClaudeAuthRecoveryCard` instead. A bridge or backend that predates `signIn`
leaves it out, and the tab then reads the platform's auth status for the route.

Readiness is reported only when the login is confirmed missing, because it
locks the composer: a missing value means unknown and never locks. Each
platform re-reads its evidence cheaply, so a login made in a terminal unlocks
the tab without a send.

| Platform | Locked when | Cleared by |
| --- | --- | --- |
| Codex | `account/read` confirms a sign-out | the next account read |
| Cursor | no stored or environment credential | each status read |
| Claude | an `accountInfo()` probe finds no credential | a probe that finds one, at most every 30 s while locked; a replaced bridge |
| Pi | the model catalogue read succeeds with no models | the next catalogue read, at most every 30 s |
| Grok | no `$GROK_HOME/auth.json`, `XAI_API_KEY` or auth-provider command | each status read (a file check) |
| OpenCode | OpenCode reports no allowed provider connected | the picker's catalogue read, cached 30 s |

- Claude's probe spawns a CLI, so it runs only on an auth read or when Claude
  answers a turn with `error: "authentication_failed"`. `accountInfo()`
  reports a signed-out directory as `tokenSource: "none"` with
  `apiProvider: "firstParty"`, and it cannot see an expired token, so an
  expired login stays a turn error with the transcript card.
- Grok's ACP `authenticate` does not fail without a login: it waits on an
  interactive sign-in. The bridge refuses before asking, and a session created
  without a login is deferred (no agent, empty `acpSessionId`) until the first
  attach or prompt after one exists.
- OpenCode's own `opencode` provider is connected with no login, so the default
  allowlist never locks. A local tab sends the user to Settings → OpenCode
  rather than a terminal (see [OpenCode provider sign-in](#opencode-provider-sign-in)).
  OpenCode cannot tell an expired key from a valid one, so that stays a turn
  error, which offers the provider's sign-in inside its row.
- Background work never sees the banner. A bridge refusing a prompt for a
  missing login answers 401 with `kind: "authentication-required"`, and the
  backend passes that message through unwrapped on every platform.

### Codex in-tab sign-in: browser or device code

Codex's browser sign-in finishes on a callback app-server serves on its own
loopback (`127.0.0.1:1455`), so it works only when the browser runs on the
same machine as the bridge. `begin_native_agent_sign_in` therefore asks for a
device code (`deviceCode: true`, sent to the bridge as
`POST /global/auth/login {"method":"device-code"}`, which starts
`account/login/start {"type":"chatgptDeviceCode"}`) when:

- the renderer is connected to a remote backend (`isRemoteGatewayConnection`),
  from both the tab banner and the agent information panel; or
- the environment is containerized, which the backend decides itself.

Otherwise it keeps the browser flow. The tab banner keeps the code visible
beside the sign-in link, and the panel's code toast stays until a read finds
the account signed in. Bridges without a device flow ignore the body.

## OpenCode provider sign-in

OpenCode has no accounts. It keeps one login per model provider (OpenCode Go,
OpenAI, …) in the host's own store, `~/.local/share/opencode/auth.json` for
the bundled 1.x, which every local environment's server shares. Settings →
OpenCode → Provider Sign-in lists the providers and signs each in, replaces its
login or signs it out (`OpenCodeProvidersSection`).

Each operation starts a private server from the bundled binary in the
model-catalogue probe directory (`withHostOpenCodeServer`) and calls its own
auth routes (`opencode-provider-login.ts`):

- **List:** `provider.list` and `provider.auth`, read field by field. A
  provider without sign-in methods takes an API key. `storedLogin` means the
  login is in OpenCode's store (`source` `api`, or `custom` for a plugin's
  OAuth login); one from an environment variable or configuration cannot be
  signed out here.
- **API key:** `auth.set` with `{ type: "api", key }`. The key goes straight
  through; nothing in Orkestrator stores, returns or logs it. A method's
  prompts (an account id, say) are sent as `metadata`.
- **OAuth:** `provider.oauth.authorize` returns the link and OpenCode's
  instruction text (a device code is lifted out of it for a copy button).
  `auto` methods then wait in `provider.oauth.callback` until the user
  approves; `code` methods wait for the pasted code first. The renderer polls
  `get_opencode_provider_login`, like the account sign-in. One sign-in runs at
  a time and is given 16 minutes. The callback is sent without Bun's
  five-minute fetch idle timeout, and the private server lives until it
  settles. A browser method whose callback is a loopback (ChatGPT's browser
  sign-in) only completes when the browser is on the backend's machine; the
  headless method works from anywhere.
- **Sign out:** `auth.remove`.

OpenCode reads a provider's credentials once per directory instance and keeps
them until the instance is disposed: a key replaced in the store is not used by
a running server, though a newly connected provider is listed. After every
change, `markLocalBridgesForLoginRefresh("opencode")` flags each live local
OpenCode server, and `localBridgeIsOnActiveAccount` has the next
`start_local_opencode_server_cmd` replace it once idle, as for a renewed Claude
login. A container copies `auth.json` in when it starts, so it needs a
restart.

An OpenCode model request refused with HTTP 401 (or a 403 or OpenCode's own
auth error that says so) gets the failed provider's sign-in inside its error
row (`OpenCodeAuthRecoveryAction`). The inline error row carries the failed
message's `providerID/modelID` as `modelId` for this
(`openCodeCredentialFailureProvider`).

The CLI on the user's PATH is not used: it may be OpenCode 2.x, which keeps
its logins in its database and never writes `auth.json`. See
[0008-opencode-v2.md](../todo/agent-engines/0008-opencode-v2.md) for what moves with 2.x.

## Credentials in auth answers

An auth answer never carries a credential. `GET /global/auth` and
`get_native_agent_auth_status` hold only the fields of `NativeAgentAuthStatus`.
`POST /global/auth/login` and `begin_native_agent_sign_in` hold only the URL to
open and the device code (Cursor's bridge also repeats the URL as
`loginUrl`). The URL and code go back to the client that asked and are never
logged, because the URL carries the OAuth `state` and the code completes a
device login.

- **Allowlist, twice.** Each bridge builds its answer field by field from what
  the provider reported, and the backend parses it the same way again
  (`HttpBridgeCatalog.authStatus` / `beginSignIn`), so a bridge that starts
  passing through a provider object cannot reach the renderer. OpenCode is
  read the same way in `OpenCodeCapabilities.authStatus`.
- **Logs.** Auth paths log fixed text or a redacted reason only. The Codex
  bridge redacts its route-failure line (`app.onError`) and its account-read
  warnings with `redactSecrets`. Hono's default handler would otherwise print
  the whole `AppServerRpcError`, including app-server's `data`.
  `open_in_browser` redacts the URL from a failed launch. Nothing logs command
  arguments or results.
- **Recordings.** `scripts/scrub-codex-recording.ts` removes `authUrl`,
  `authorizationUrl`, `verificationUrl`, `userCode` and `loginId`. The opt-in
  notification recorder writes those verbatim.
- **Tests.** `tests/helpers/auth-secret-canaries.ts` plants credential-shaped
  canaries in each fake (environment, credential store, SDK answer), checks the
  answer's shape against the allowlist and captures console and stdio output.
  Every bridge's auth routes, the backend parser and OpenCode use it, and
  `tests/unit/auth-secret-guards.test.ts` fails if a bridge serving
  `/global/auth` has no such test.

## Plan usage

`get_plan_usage` reads the active account. `get_agent_account_usage` serves
the active account from the same shared reader, and reads any other account
from its own directory, cached for two minutes (ten seconds after an error).
Orkestrator never refreshes a token itself. Claude access tokens last hours,
so an inactive Claude account reports "refreshed while it is in use" once its
token lapses, until it is used again. Codex tokens last days.

Each account's last successful reading is kept in
`<agent-accounts>/last-usage.json` (`agent-accounts-last-usage.ts`). The active
account's reading is saved when it is read and when the user switches away from
it. Whenever a fresh read fails, including the lapsed-token case above, the last
reading is served instead with `stale: true`, its original `fetchedAt` and the
failure as `message`. Any window whose reset time has passed is shown empty.
Removing an account deletes its entry.

A 429 from a usage endpoint is not retried until its `Retry-After` has passed
(clamped to 1–30 minutes; 5 minutes if absent), even by a forced refresh. The
endpoint's allowance is shared with the account's running Claude Code sessions.
Switching accounts clears the wait. Meanwhile the shared reader serves the
active account's last good reading as stale.

Session-reported usage windows are folded into the platform's card only when
the reporting bridge was launched on the active account
(`contextUsageWithPlanUsage` in `plan-usage-cache.ts`).

## Containers

A container receives the active account's login instead of the host's at
three points (`agent-accounts-containers.ts`). Nothing is rewritten for a
platform that never had an account added, renewed or made active, and a
provider the environment has revoked is never handed a login.

- **Creation.** `activeAgentAccountInputRoots` makes staging read the login
  files (`auth.json`, `.credentials.json`, `.claude.json`) from the account
  directory and everything else from the host directory. It is still one
  stage and one mount.
- **Every start.** Before `docker start`, `refreshStagedAgentAccountLogins`
  rewrites the login files in the container's current staged revision, so the
  entrypoint imports the active account. The staged `.claude.json` is a
  single-file bind mount and is rewritten in place to keep its inode. After
  start, `syncContainerAgentAccountsOnStart` pipes Claude's credential in for
  the active account and writes the marker.
- **Bridge start.** Each container records the login it holds in
  `/tmp/orkestrator-<platform>-account` as `<accountId>[:<loginGeneration>]`;
  a missing marker means the host login. When it differs from the active
  account and the in-container bridge is idle,
  `reconcileContainerAgentAccount` writes the new login into the container,
  updates the staged revision, stops the bridge and only then writes the
  marker. A busy bridge keeps its account until idle.

`useHostClaudeCredentials: false` keeps every Orkestrator-held Claude token
out of containers, whichever account it belongs to.

## Coordinator conversations

`applyCoordinatorClaudeAccount` seeds a coordinator's private Claude directory
from the active account's directory instead of the host's, after removing any
login an earlier launch copied. A Claude login kept only in the macOS Keychain
cannot be copied, because the entry is named after its directory. The
account's current access token is passed as `CLAUDE_CODE_OAUTH_TOKEN` instead,
never the refresh token, which would rotate away from the account's own login.

That token cannot be renewed, so its expiry is recorded
(`localAgentAccountTokenExpiry`). Within five minutes of expiry an idle
coordinator bridge is replaced if a fresher login is available, and otherwise
once the token has expired. Coordinator bridges also move to a newly active
account once idle, like other bridges.

When there is no live token to hand over (signed out, or an access token that
lapsed while nothing used the account), the bridge launches without one and
answers "Not logged in". It is recorded in `loginlessLocalBridges`, and every
later use checks the account again, so an idle bridge is replaced as soon as a
token exists. This covers sign-ins Orkestrator is never told about, such as
`claude auth login` in a terminal.

## Terminal tabs

Local terminal tabs start with `CLAUDE_CONFIG_DIR`/`CODEX_HOME` pointing at
the active accounts (`activeAgentAccountShellEnvironment`); nothing is set for
host logins. A terminal keeps the account that was active when it opened.
Claude tmux mode exports the active Claude account per session, because a
local tmux server keeps the environment it was first started with. Container
terminals use whatever login the container holds.

## Provider behaviour relied on

Checked against Claude Code 2.1.283 and Codex 0.158.0.

- Claude's Keychain service for a config directory is
  `Claude Code-credentials-<first 8 hex of sha256(CLAUDE_CONFIG_DIR)>`
  (`claudeKeychainService`). The hash is over the literal string, so a
  symlinked or trailing-slash spelling is a different entry, and setting
  `CLAUDE_CONFIG_DIR=~/.claude` explicitly reads as signed out. Account
  directories are therefore always built the same way (`agentAccountHome`),
  and the host login never sets the variable. Without a Keychain entry Claude
  falls back to `<dir>/.credentials.json` and does not migrate it.
- With `CLAUDE_CONFIG_DIR` set, `.claude.json` and its `mcpServers` are read
  from inside that directory only.
- Symlinked `projects/`, `CLAUDE.md` and `skills/` load, and `claude --resume`
  from a second directory resumes the first directory's session.
- Claude keeps HTTP MCP server OAuth logins (`mcpOAuth`) inside the same
  Keychain credential as the account login, so each added Claude account signs
  in to those servers again.
- Codex keeps its login in `$CODEX_HOME/auth.json`. Its `chatgptAuthTokens`
  login needs the `experimentalApi` capability, which the bridge leaves off,
  and is memory-only.
- With `sessions/` symlinked, a second `CODEX_HOME` with a fresh state
  database lists, resumes and continues the first home's threads.
