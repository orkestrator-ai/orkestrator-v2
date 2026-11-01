# Agent accounts

Status: Living — `apps/backend/src/core/agent-accounts*.ts`,
`apps/backend/src/core/agent-sign-in-status.ts`,
`apps/web/src/components/settings/AgentSignInCard.tsx`,
`apps/backend/src/core/local-server-runtime.ts` (per-bridge launch facts),
`packages/protocol/src/agent-accounts.ts`,
`apps/web/src/components/settings/AgentAccountsSection.tsx`,
`apps/web/src/components/settings/account-machine.tsx`,
`apps/web/src/components/settings/machines/MachineAgentAccountsSection.tsx`,
`apps/web/src/components/layout/AgentInfoAccountSection.tsx`,
`apps/backend/src/core/agent-sign-ins.ts`;
`apps/backend/src/core/opencode-provider-login.ts`,
`packages/protocol/src/opencode-provider-auth.ts`,
`apps/web/src/components/settings/OpenCodeProvidersSection.tsx`.

Claude and Codex can each hold more than one login. The user sees each
account's plan usage and picks which one agents run on. Switching is global
per platform: there is one active Claude account and one active Codex account,
and no tab, environment or settings tier records an account. Accounts never
run side by side in one platform, so bridge keys, tab records and the agent
settings tiers are unchanged by accounts.

Every machine (node) keeps its own accounts and its own active account per
platform; see [Machines](#machines). Outstanding work and known gaps are in
[0003-agent-accounts-and-sign-in.md](../todo/agent-engines/0003-agent-accounts-and-sign-in.md)
and [0722-per-machine-agent-accounts.md](../todo/agent-engines/0722-per-machine-agent-accounts.md).

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

Every shared entry that is a directory (`SHARED_DIRECTORIES`) is created on
the host when missing, so an account's first transcript, saved plan or skill
does not grow a private copy. Files are not: an empty `settings.json` or
`config.toml` is not the same as a missing one. A directory an account already
created while the host had none (before this rule, or from a CLI racing the
launch) is moved to the host and linked. It is never merged into a host
directory that exists. Directories containing relative symlinks are kept
private, because moving them can change the links' targets. This guard is
conservative even for apparently internal links, whose resolution may pass
through other symlinks. A directory that cannot be inspected or moved is also
kept private, and an empty host directory is created for other accounts.
If a required host directory is occupied by a regular file or dangling symlink,
that entry is left intact and not linked; preparation continues with the other
entries and preserves any private account copy.

`linkSharedEntries` is otherwise conservative: a regular file already in the
account directory is left alone, because a CLI that saves by atomic rename
replaces the link with one, and that content is the account's now. A link
whose host target has gone is removed. Such an entry, and a directory that
could not be moved, is reported rather than re-linked: `privateSharedEntries`
lists it, `listAgentAccounts` returns the names as the
account's `privateEntries`, and its row in Settings says the entry is no longer
shared with the host login. Re-linking would race a CLI still writing it.

Claude's `.claude.json` is per account, because it holds `oauthAccount`. Once
`CLAUDE_CONFIG_DIR` is set it is also the only place Claude reads user- and
local-scope MCP servers from. `syncClaudeAccountSettings` therefore copies
`mcpServers`, `hasCompletedOnboarding` and each project's MCP, trust and
allowed-tools keys from the host file before every launch. It holds Claude's
own `.claude.json.lock` directory lock while it does, and never touches the
account's own keys. The copy replaces the account's `mcpServers`, so a server
added inside an account home (`claude mcp add` in an account's terminal) is
overwritten; the MCP editor says so on Claude's user and private-local
sources while an added Claude account exists.

The bridge keeps reading the host file (`homedir()/.claude.json`) at every
turn and hands its servers to the running CLI, so an MCP editor save reaches a
running account session on its next message. The CLI itself loads the
account's copy only when it starts, and a bridge starts many CLIs (one after
each idle close), so the MCP editor also refreshes every account's copy after
each save of the host file (`mcp-management/claude-account-copies.ts`). When
the copy's source is the file the bridge reads, the backend also sets
`ORKESTRATOR_CLAUDE_ACCOUNT_HOME` to the account directory; the bridge then
reports a server only the copy names (`claudeAccountOnlyMcpServerNames`) as
stale from launch and refuses its tools, so removing a server that a copy
still names is never reported `applied` while the account's CLI runs it. Proven on the pinned CLI, without
credentials, by the `account` case of `mise run verify:claude:mcp-live`.

Credentials are never copied between account directories. Refresh tokens
rotate, so a copy goes stale as soon as the original refreshes.

## Switching

`set_active_agent_account` records the choice; nothing is killed. The next
`start_local_<agent>_server_cmd` for an environment asks
`localBridgeIsOnActiveAccount` whether the running bridge was launched on the
active account (`LocalServerRuntime.launchedAccountId`, recorded by
`adoptProcess` at launch). An idle bridge on another account is
replaced. A bridge with observed live work keeps running on the old account
until it is idle. The replacement resumes its sessions from the shared
transcripts on the next prompt.

The replacement also needs the bridge's own record of which thread each tab is
on. Claude's bridge keeps those under HOME (`~/.claude/orkestrator`), which no
account changes. Codex's keeps them under `CODEX_HOME/orkestrator-bridge`, so
on an added account `applyActiveAgentAccountEnvironment` also sets
`CODEX_BRIDGE_STATE_DIR` to the host login's `orkestrator-bridge`. The bridge
(`codexBridgeStateDir`) keeps session records, dispatch journals, session
titles, change evidence and command-change journals there; its model cache and
app-server pid file stay under the account's own `CODEX_HOME`, because they
belong to the login. Records an account wrote in its own directory before this
(2026-10-26) are moved over the next time a bridge on it loads its sessions,
without replacing a newer record or a tombstone, and earlier titles and
command-change badges are still read from there. Without this, a tab whose
bridge was replaced after a switch showed "Unable to connect to Codex" and
**Retry** opened an empty session.

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

When the CLI exits unsuccessfully, the failure names the CLI's own reason
(`loginFailureMessage`): the last output line that reads as a failure, with
any line holding a URL or a device code skipped and anything token-shaped cut
out. It goes only to the client that asked, in `AgentAccountLoginProgress.error`,
and adds what to do for a locked macOS keychain or a code from another
attempt. Without a recognisable line it stays `exit code <n>`.

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

- Live local Claude bridges are flagged (`LocalServerRuntime.markLoginStale`).
  `localBridgeIsOnActiveAccount` treats a flagged bridge as being on another
  account, so it is replaced the next time it is used while idle; a busy one
  finishes first.
- When containers share the host login (`useHostClaudeCredentials` on), every
  container environment is flagged
  (`LocalServerRuntime.markContainerLoginStale`).
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
link-and-code panel and resumes a sign-in already running. When the card
answers `Not logged in`, a successful sign-in sends the refused prompt again,
from whichever client signs in and whether or not the tab is open. Claude ran
nothing for that prompt, so sending it again cannot repeat work. The backend owns
this (`native-agent-sign-in-resend.ts`): it remembers each accepted plain prompt
in memory, exactly as sent, because Claude's transcript stores an attached image
as inline data rather than its path, and records it durably on the session
(`signInResend`) only when the turn ends in the notice. An accepted later dispatch
clears it in the same write. The sign-in sends it once, under a request id derived
from the refused one, only while the notice is still the latest exchange and the
draft is empty. An ambiguous resend parks for the user like any other dispatch. The
card promises the resend only when `get_native_agent_sign_in_resend` says the
backend holds the prompt, and otherwise asks the user to resend, as it does after a
backend restart lost the memory, for a terminal sign-in (the backend does not see
one) and for a container with its own login. Its compact form,
`ClaudeAccountSignInAction`, is the **Sign in to Claude** action on the Agent
Info account card and on the Claude settings sign-in card. Claude's bridge
hint names those cards rather than a terminal; its route kind stays
`terminal`, because the CLI's own `/login` is still the fallback they offer.

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
| Codex | `account/read` confirms a sign-out | the next account read; a visible locked tab asks every 10 s, so a `codex login` made elsewhere unlocks it |
| Cursor | no stored or environment credential | each status read |
| Claude | an `accountInfo()` probe finds no credential | a probe that finds one, at most every 30 s while locked; a replaced bridge |
| Pi | the model catalogue read succeeds with no models | the next catalogue read, at most every 30 s |
| Grok | no `$GROK_HOME/auth.json`, `XAI_API_KEY` or auth-provider command | each status read (a file check) |
| OpenCode | OpenCode reports no allowed provider connected | the picker's catalogue read, cached 30 s |

- Claude's probe spawns a CLI, so it runs only on an auth read or when Claude
  answers a turn with `error: "authentication_failed"`. `accountInfo()`
  reports a signed-out directory as `tokenSource: "none"` with
  `apiProvider: "firstParty"`, and it cannot see an expired token, so an
  expired login stays a turn error with the transcript card. After such a
  turn, an auth read that still finds a credential reports `expired` instead
  of `signed-in` until a model answers again (`claude-sign-in.ts`). That
  never locks the composer.
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

### Turn-time auth notice

A login that stops working during a turn is shown as the tab's `auth` notice
(`NativeAgentNotice { kind: "auth", state, message, occurrenceId }`), a warning
beside the transcript's sign-in card, rather than as a failed spawn. Claude and
Codex put an `authNotice` on their session read (`GET /session/:id`,
`/session/:id/status`), and the backend reads it field by field
(`normalizeProviderAuthNotice`) into the first snapshot notice.

| Platform | Raised by | Cleared by |
| --- | --- | --- |
| Claude | `auth_status` with an `error` (`expired`) or `isAuthenticating` (`needs-auth`); a turn refused with `authentication_failed` (`expired`) | `auth_status` reporting the authentication finished; any real model answer |
| Codex | `modelProvider/authRecoveryStarted` (`expired`); a turn failed with `unauthorized` or a forwarded 401 (`needs-auth`, worded for the refused login) | `authRecoveryCompleted`, unless its text says the renewal failed, which keeps a `needs-auth` notice; a completed turn; a successful sign-in (`account/login/completed`); a different login stored in `CODEX_HOME` (stored-login reload, `account.signedIn`) |

Codex's completion carries no outcome field (codex 0.162 says succeeded,
failed-permanent or failed-transient only in its message), so the failure check
reads its text; a real sign-out still locks the composer through readiness. The
notice is in memory on the bridge: a restarted bridge starts without one.

A login the API refuses outright sends no recovery at all. Codex 0.162 and
0.164 treat an invalid API key as signed in (`account/read` reports it), retry
the request and fail the turn with `codexErrorInfo: { httpConnectionFailed:
{ httpStatusCode: 401 } }`. `toTurnError` keeps that status (`httpStatusCode`),
and a turn failed with `unauthorized`, or with a 401 on any variant that
forwards one (`httpConnectionFailed`, `responseStreamConnectionFailed`,
`responseStreamDisconnected`, `responseTooManyFailedAttempts`), raises the
`needs-auth` notice (`refusedLoginNotice`, `sessions/auth-recovery-notice.ts`).
Only a 401: a failure with no status or a 5xx never locks the composer. A
second refusal keeps the occurrence, so a dismissed notice stays dismissed.

The notice names the login `account/read` reports (`account.type`); the
turn's error does not say. The engine keeps the kind from every signed-in
answer (`getAccountLoginKind`) and emits `account.loginKind` when it changes,
because the refusal's own read usually answers after the turn has failed. The
runtime then rewords the notice in place, keeping its occurrence
(`withRefusedLoginKind`):

| Login | Notice |
| --- | --- |
| API key | "Codex's API key was refused. Replace it with codex login --with-api-key, or sign in to Codex with ChatGPT instead." |
| ChatGPT | "Codex's ChatGPT login was refused. Sign in to Codex again to keep working." |
| Not known yet | "Codex's login was refused. Sign in to Codex again to keep working." |

The banner's **Sign in to Codex** is the ChatGPT sign-in, which replaces an
API key with a ChatGPT login. Orkestrator's Settings have no Codex key field.
A key stored in `CODEX_HOME` (what `codex login --with-api-key` writes) clears
the notice without a sign-in: after a refusal the engine fingerprints the
stored login, and the next `account/read` that finds a different one replaces
the app-server child and emits `account.signedIn` (checked live on 2026-10-29).

A ChatGPT login refused mid-turn is different: Codex 0.164.0 can recover it.
Its binary has the refresh reason `unauthorized_recovery` and recovery
outcomes `recovery_succeeded`, `recovery_failed_permanent` and
`recovery_failed_transient`. An API key has no recovery steps ("No more
recovery steps available."). So a ChatGPT 401 sends `authRecoveryStarted` and
`…Completed`, and a refused refresh ends the turn with `RefreshTokenFailed`
("Your access token could not be refreshed … Please log out and sign in
again."). The renewal-failed check and the 401 rule both cover that. Which
`codexErrorInfo` that turn carries (probably `unauthorized`) has not been seen
live.

How each tab shows it:

- Claude: the notice pins `ClaudeAuthRecoveryCard` above the composer, beside
  the warning, without locking the composer. Claude Code 2.1.310 ends a turn
  whose login is dead with an ordinary reply ("Failed to authenticate. API
  Error: 401 OAuth access token is invalid.", `error: "authentication_failed"`),
  not a terminal error row, so the notice is the only thing that can ask for
  the card. A terminal auth error row after the last prompt already carries
  the card in the transcript, so nothing is pinned then. The CLI also blanks
  the stored credential once it fails to refresh it.
- Codex: the notice is treated like readiness: the banner offers the in-tab
  sign-in and the composer locks. Because no turn can complete while it is
  locked, a successful sign-in clears every thread's notice.

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

An abandoned sign-in is cancelled on Codex's side too. The bridge keeps the
`loginId` of the browser or device-code login it started (never logged or
returned), and `POST /global/auth/login/cancel` sends
`account/login/cancel` and answers only `{ cancelled }`. The backend command
is `cancel_native_agent_sign_in`; on a bridge without the route it is a no-op.
The tab banner's **Cancel sign-in** and the panel's device-code toast call it,
and a device code that lapses cancels its login on the bridge by itself.

## Settings sign-in card

Each enabled platform's settings page opens with a sign-in card
(`AgentSignInCard`) read without a session or a bridge
(`get_agent_sign_in_status`, `agent-sign-in-status.ts`), so it is there before
any environment runs the platform. It reads the same evidence the launchers
hand to bridges:

- Claude and Codex: the active account's login, as `listAgentAccounts` reports
  it. The card sits above the accounts list. Claude is signed in again from it
  (`ClaudeAccountSignInAction`); Codex points to the tab's in-app sign-in and
  to adding an account.
- Cursor: the credential `cursorSdkAuthStatus` resolves. The card wraps
  `CursorSdkSignIn`, which keeps its own sign-in and sign-out.
- Grok: the bridge's checks before `authenticate` (a stored login,
  `XAI_API_KEY`, an auth-provider command).
- Pi and OpenCode: the provider entries in `~/.pi/agent/auth.json` and
  OpenCode's `auth.json` (ids and credential kinds only; a key-shaped id is
  dropped). An empty store reads `unknown`, never `signed-out`, because an
  environment variable or configuration may still hold a key. OpenCode's
  logins are managed under Provider Sign-in below the card.

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
change, `markLocalBridgesForLoginRefresh(context, "opencode")` flags each live
local OpenCode server. These refresh flags live in `LocalServerRuntime`, and
`localBridgeIsOnActiveAccount` has the next `start_local_opencode_server_cmd`
replace it once idle, as for a renewed Claude login. A container copies
`auth.json` in when it starts, so it needs a restart.

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
  arguments or results. Every local bridge's stdout and stderr, which Debug
  logging writes to `<dataDir>/logs`, is reassembled into whole lines and
  scrubbed of credential shapes before it reaches the console
  (`forwardBridgeOutput`, `redactBridgeOutput`). A bare OAuth or device code
  has no recognisable shape, so the rule that bridges never print one stays
  the guard for those.
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
these points (`agent-accounts-containers.ts`). Nothing is rewritten for a
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
- **Older images.** A container created before staged inputs mounts the host
  homes read-only and its entrypoint copies them into `/home/node`, so a
  restart would bring the host login back. On every start of such a container
  (no inputs-revision label) the active Claude identity is pushed in, and the
  active Codex login too while its marker proves an unreconciled boot and
  Codex has no live work (`applyActiveCodexLoginAfterLegacyBoot`). Only the
  container's own copy is written; the marker is left for the next bridge
  start. Retiring the legacy mount removes this step.
- **Terminal open.** `start_terminal_session` first runs
  `applyActiveAgentAccountsForContainerTerminal`, so `claude` and `codex` in a
  new container terminal use the active account. It writes the login and the
  staged copy but neither stops the bridge nor writes the marker, waits behind
  the platform's bridge operations, is skipped while that platform has live
  work and gives up after 10 s.

`useHostClaudeCredentials: false` keeps every Orkestrator-held Claude token
out of containers, whichever account it belongs to, and the terminal hand-off
then leaves Claude alone, because the container's own login was signed in
from a terminal inside it.

## Coordinator conversations

A coordinator's private Claude directory (`prepareCoordinatorClaudeHome`)
never holds a login. `applyCoordinatorClaudeAccount` removes any login an
earlier build copied in, and on macOS removes once per process any Keychain
entry Claude saved under that directory. It then reads the active account's
login (Keychain first, then file; for the host login exactly as Claude does)
and passes only the access token, as `CLAUDE_CODE_OAUTH_TOKEN`. A refresh token
is never handed over: a copy rotates away from the account's own login, and on
macOS `~/.claude/.credentials.json` is often stale beside the Keychain login,
so a copy of it fails with "OAuth session expired and could not be refreshed".

A login whose access token has lapsed is refreshed first, through the
keeper's `refreshLocalLoginIfDue` (the same `claude -p` refresh containers
use). While any coordinator runs on a handed-over token or waits for one,
`ContainerClaudeLoginKeeper` keeps the active login refreshed even with no
container running and with the container opt-out on.

A Codex coordinator gets the same treatment through a file, because Codex
has no access-token variable: `prepareCoordinatorCodexHome` writes the active
login's `auth.json` into the coordinator's private `CODEX_HOME` access-only
(`coordinatorCodexLogin`, the `restrictCodexAuthSnapshot` form containers
receive). The refresh token is blanked and `last_refresh` set to now, so Codex
uses its access token until it actually expires instead of refreshing early.
Codex rotates the refresh token on every refresh, so a coordinator refreshing
a whole copy would retire the account's own login. An API-key login is copied
as is. Before startup, or reuse of a bridge whose token is near expiry, the
backend renews a due login in its owning home with Codex app-server's
`account/read { refreshToken: true }`. Requests are serialized per owning home,
re-read the saved login before refreshing, and back off after failed renewal.
The owner retains the rotated refresh token; only the renewed access token is
handed over. Agent-test profiles never renew a borrowed host login.
App-server's `chatgptAuthTokens` login would avoid the file but needs the
`experimentalApi` capability, which the bridge leaves off.

Either token cannot be renewed by the coordinator, so its expiry is recorded
(`LocalServerRuntime.launchedTokenExpiry`). Within five minutes of expiry an idle
coordinator bridge is replaced if a fresher login is available, and otherwise
once the token has expired. Coordinator bridges also move to a newly active
account once idle, like other bridges.

When there is no live token to hand over (signed out, or an access token that
lapsed while nothing used the account), the bridge launches without one and
answers "Not logged in". It is recorded as loginless (`LocalServerRuntime.isLoginless`), and every
later use checks the account again, so an idle bridge is replaced as soon as a
token exists. This covers sign-ins Orkestrator is never told about, such as
`claude auth login` in a terminal. A Codex coordinator with an inherited
`CODEX_API_KEY` or `OPENAI_API_KEY` is not recorded as loginless.

## Coordinator switching

A main coordinator can list and switch accounts (Control MCP capability
`accounts`; `control-mcp-account-tools.ts`), so "switch to an account with
usage left when the workers hit their limit" needs no one at the keyboard
when the user said so in advance.

- `list_provider_accounts` calls `list_agent_accounts` and, per signed-in
  account, `get_agent_account_usage` on this machine, or on another through
  `invoke_on_node` (`nodeId`; a node needs no copy of the project, because
  accounts belong to the machine). Each account reports its quota windows
  with `remainingPercent`, `exhausted` and `hasAllocationLeft` (`true`,
  `false`, or `"unknown"` when no current reading exists, which is common for
  an idle Claude account whose access token lapsed).
- `switch_provider_account` calls `set_active_agent_account`, the command the
  Settings switch calls, so a coordinator switch is exactly a user switch:
  machine-wide for that provider, idle sessions move on their next turn, a
  running turn finishes on the old account, nothing restarts, and
  `agent-accounts-changed` updates every open view. It never writes a
  credential. The result says so (`scope: "machine"`, `effect`).
- **Approval.** A switch changes which subscription pays, so by default it is
  a `switch-agent-account` request (`nodes/node-action-requests.ts`) the user
  approves in the coordinator-request dialog; its executor
  (`nodes/node-account-switch.ts`) runs the same command, and the outcome is
  mailed back to the coordinator. The one exception is a self-timer that
  carries the user's permission ([scheduled-jobs.md](scheduled-jobs.md#self-timers)):
  set with `authorizeAccountSwitch` in a turn the user started, naming the
  providers and any other machines, and used within two hours of firing.
- `get_usage_limits` (`agent-usage-limits.ts`, command
  `get_project_usage_limits`) finds the tabs that need it. No provider reports
  a usage limit as structured state, so it classifies each session's last
  recorded turn error (`classifyUsageLimitError`: Claude's "hit your limit",
  Codex's `usageLimitExceeded`, Grok's `USAGE_EXHAUSTED`, OpenCode's "limit
  reached" retry) and adds the plan-usage cache's windows at 100 % that have
  not reset. A tab stays listed until a later turn completes; after a switch
  it needs a new prompt to run again.

Grok, Pi, OpenCode and Cursor have no accounts to switch; the tools say so.

## Machines

Every machine (node) has its own registry, host logins, account directories
and active account per platform. Nothing moves a credential between machines
(see [command-nodes.md](command-nodes.md#settings)); each machine signs in for
itself. Where each surface acts:

- **A leaf's workspace** talks to the leaf, so the transcript sign-in card,
  in-tab sign-in and the agent information panel act on the machine the
  session runs on. With more than one machine, the card and panel name it.
- **Settings** belongs to the command node. Each sign-in section (Claude and
  Codex accounts, OpenCode providers, Cursor sign-in, GitHub CLI) sits under a
  "Sign-ins on" machine picker (`AccountMachineScope`). It defaults to the
  machine on screen; closing Settings forgets a choice. Another machine is
  asked through the command node (`portalStore.invokeOnNode`, so an
  ambiguous write reports an unknown outcome rather than retrying); the
  command node itself through the portal transport (`machine: null`); an omitted
  target follows the current workspace's backend. A sign-in runs on
  the chosen machine, and its link opens in this client's browser. That
  includes Cursor: `cursor_sdk_login_start { openBrowser: false }` starts its
  login child with `NO_OPEN_BROWSER`, and the settings pane opens the link
  with `openInBrowser`. Cursor's sign-in polls for approval, so it completes
  from a browser on any machine. An older client omits the flag and the
  machine's own desktop opens the link, as before.
- **Settings → Machines → Agent accounts** shows every machine against Claude
  and Codex, with each machine's active account and a switch
  (`list_machine_agent_accounts`). The command node asks each enabled machine
  for `list_agent_accounts` and `read_host_agent_sign_ins` in parallel, eight
  seconds each; one that cannot answer shows as not connected. A node in leaf mode lists only itself,
  and a leaf's own window shows the section with that one row (its machines
  are its command node's to manage). Each machine's own settings dialog shows
  its row. Registry changes reload the
  overview so attached and removed machines are reflected immediately. Peer
  account summaries and live sign-in rereads are rebuilt from validated fields;
  a malformed account row shows an error for that machine.
  - **Live.** Every machine announces a change to its accounts as
    `agent-accounts-changed` `{ platform }` (`AGENT_ACCOUNTS_CHANGED_EVENT`):
    a switch, an added, renamed or removed account, a renewed login. The
    event never carries the state. The overview watches each listed machine
    through the command node's relay (`subscribeNodeEvents`, so the command
    node's own events arrive directly) and re-reads only that machine, with
    `list_agent_accounts` and `read_host_agent_sign_ins`, on an event or a
    resync. Each machine is re-read once its subscription is in place, which
    covers a change between the overview read and the subscription. A
    sign-in made outside Orkestrator is never announced; the refresh button
    and reopening still re-read everything.
  - **By account.** A toggle groups the overview by email instead of by
    machine: each login, the machines it is on, which of them use it, a
    switch to it on a machine that has it, and a sign-in (that platform's
    settings, on that machine) on each connected machine that lacks it. A
    login without an email cannot be matched across machines and is listed
    alone.
  - **Preferred login.** A star on an email group in By account makes that
    email the platform's preferred login (`set_preferred_agent_identity`
    `{ platform, email | null }`). The machine answering the overview keeps
    it in its own `agent-accounts.json` (`preferred`) and returns it with
    `list_machine_agent_accounts`; it is an email only and is never sent to
    another machine. Above both views a line per platform says how many
    machines use it and how many lack it, with a switch for every machine
    that has it but uses another. By machine, a cell off it shows **Use
    preferred** where the machine has that login and **No preferred login**
    where it does not. Nothing switches by itself: a leaf adding or removing
    a login, or a machine coming back online, never changes which account it
    uses. A preference change made in another client shows on the next full
    read (opening the page or the refresh button), not live. A machine's own
    settings dialog does not flag its row. Older command nodes reject the
    command, so the star reports an error there.
  - **Grok and Pi** have no accounts. Each machine reports whether it has a
    login a local bridge would use (`read_host_agent_sign_ins`,
    `agent-sign-ins.ts`), from files and variable names only, never a value:
    for Grok the bridge's own rule (`XAI_API_KEY`, an auth-provider command or
    `$GROK_HOME/auth.json`), for Pi the provider ids in `~/.pi/agent/auth.json`
    and then a common provider key in the backend's environment. Nothing is
    checked against the provider, so an expired login still reads as signed
    in. The command node rebuilds another machine's answer field by field,
    and a machine that predates the read shows no Grok or Pi column.
    "Sign in on <machine>" calls `open_agent_sign_in_terminal`: the machine
    opens a plain terminal tab running its fixed login command (`grok login`,
    or `pi` for Pi's own `/login`) through `launch_terminal_job`, in the
    environment on screen when it is a running local one there, otherwise its
    most recently active one. A container's terminal would sign the container
    in, so only local environments qualify. The window then shows that
    environment.
- **The agent information panel** places account controls below usage. It reads
  `get_native_agent_session_account` for container or unknown-source messages
  and pending moves to a newly active account. When the machine holds multiple
  logins, it offers a machine-wide active-account switcher, except for isolated
  containers. It shows read or switch errors. Outside isolated containers, it
  offers **Manage accounts** or, with at most one login, **Add an account**,
  opening the platform's Settings section. Claude reauthentication lives in
  Settings. The composer shows no account control. The panel re-reads on its own machine's
  `agent-accounts-changed` (`useAgentAccountsChanged`), on event-stream reconnect,
  when opened, and when the turn or bridge changes. Reads are fenced against
  newer requests, and a different environment or provider starts with fresh state.

## Terminal tabs

Local terminal tabs start with `CLAUDE_CONFIG_DIR`/`CODEX_HOME` pointing at
the active accounts (`activeAgentAccountShellEnvironment`); nothing is set for
host logins. A terminal keeps the account that was active when it opened.
Claude tmux mode exports the active Claude account per session, because a
local tmux server keeps the environment it was first started with. A container
terminal is handed the active login when it opens (see
[Containers](#containers)); one opened while that platform has live work, or
one already open, keeps the login the container held.

## Provider behaviour relied on

Checked against Claude Code 2.1.283 and Codex 0.158.0, except where a line
names another version.

- Claude's Keychain service for a config directory is
  `Claude Code-credentials-<first 8 hex of sha256(CLAUDE_CONFIG_DIR)>`
  (`claudeKeychainService`). The hash is over the literal string, so a
  symlinked or trailing-slash spelling is a different entry, and setting
  `CLAUDE_CONFIG_DIR=~/.claude` explicitly reads as signed out. Account
  directories are therefore always built the same way (`agentAccountHome`),
  and the host login never sets the variable. Without a Keychain entry Claude
  falls back to `<dir>/.credentials.json` and does not migrate it while it
  stays valid (2.1.310 writes it to the Keychain entry after a failed
  refresh; see below).
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
- Codex 0.164.0 accepts the access-only `auth.json` in a local home: `codex
  login status` reads it as a ChatGPT login and backend requests carry its
  access token. It refreshes proactively only once the access token is
  within five minutes of its `exp`; `last_refresh` counts only for a token
  without a readable `exp`. Inside that window, or after a 401, it tries the
  blank refresh token once, the attempt fails, and the file is left as it
  was. A coordinator is replaced at the same five-minute lead
  (`TOKEN_REPLACEMENT_LEAD_MS`) when next used while idle, so only a turn
  running across that point sees the failed attempt. Checked offline with
  `scripts/codex-access-only-auth-probe.ts` on 2026-10-25.
- The Claude Agent SDK's `accountInfo()` returns the login's email (0.3.309,
  host OAuth login, with organization, subscription type and API provider;
  checked 2026-10-25). The panel still takes the email from the account
  registry, which has it before any session starts.
- The Cursor SDK's login (1.0.40) skips spawning the system opener when
  `NO_OPEN_BROWSER` is set or an SSH variable is present, and still publishes
  the URL (`bridges/cursor-bridge/src/login-no-open-browser.test.ts`).
- With `sessions/` symlinked, a second `CODEX_HOME` with a fresh state
  database lists, resumes and continues the first home's threads.
- Claude Code 2.1.310 (checked 2026-10-26 with a throwaway
  `CLAUDE_CONFIG_DIR` holding a made-up OAuth login with a future
  `expiresAt`): `claude auth status` and the readiness probe read it as signed
  in, and a turn ends with an assistant reply carrying
  `error: "authentication_failed"` ("OAuth session expired and could not be
  refreshed" from `claude -p`; "Failed to authenticate. API Error: 401 OAuth
  access token is invalid." through the bridge). After the failed refresh the
  CLI wrote the credential, blanked, to that directory's hashed Keychain entry
  and removed `.credentials.json`.
- Codex 0.162.1 app-server with an invalid API key (checked 2026-10-26):
  `codex login --with-api-key` stores it unchecked and `account/read` reports
  it signed in. A turn retries and then fails with
  `codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }`
  (`responseStreamDisconnected` with 401 on the retries), not `unauthorized`,
  and sends no `modelProvider/authRecovery*`, so no `auth` notice is raised.
