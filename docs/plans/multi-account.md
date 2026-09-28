# Multiple Claude and Codex accounts

Status: slices 1–4 implemented (2026-09-28).

## Goal

Keep more than one Claude and more than one Codex login in Orkestrator, see
each account's plan usage, and switch which one agents run on. Switching is
global per platform: one active Claude account and one active Codex account.
Accounts never run side by side in the same platform, which keeps bridge keys,
tab records and the agent settings tiers exactly as they are.

## Design

Each added account is its own provider configuration directory:

```
<dataDir>/agent-accounts/claude/<id>/   CLAUDE_CONFIG_DIR for that account
<dataDir>/agent-accounts/codex/<id>/    CODEX_HOME for that account
```

The implicit `default` account is the host login (`~/.claude`, `~/.codex`),
launched exactly as before: `CLAUDE_CONFIG_DIR`/`CODEX_HOME` stay unset.

Only the login differs between accounts. Everything the user authored and
every transcript is symlinked back to the host directory, so a conversation
started on one account resumes on another:

- Claude: `settings.json`, `settings.local.json`, `CLAUDE.md`, `agents`,
  `commands`, `skills`, `plugins`, `hooks`, `rules`, `output-styles`,
  `keybindings.json`, `projects`, `todos`, `file-history`, `plans`,
  `history.jsonl`.
- Codex: `config.toml`, `AGENTS.md`, `skills`, `rules`, `prompts`,
  `hooks.json`, `plugins`, `sessions`, `archived_sessions`,
  `session_index.jsonl`, `history.jsonl`. SQLite state is never linked: its
  `-wal`/`-shm` sidecars would be created next to the link, not the database.

Claude's `.claude.json` is per account (it holds `oauthAccount`), but it is also
where Claude reads user- and local-scope MCP servers once `CLAUDE_CONFIG_DIR`
is set. Orkestrator copies `mcpServers` and the per-project MCP and trust keys
from the host file before every bridge launch, under Claude's own
`.claude.json.lock` directory lock.

Credentials are never copied between directories. Refresh tokens rotate, so a
copy goes stale the moment the original refreshes.

### Switching

`set_active_agent_account` records the choice. Nothing is killed. The next
`start_local_<agent>_server_cmd` for an environment compares the account its
bridge was started with; an idle bridge is replaced, a bridge with observed
live work keeps running on the old account until it goes idle. The replaced
bridge's sessions resume from the shared transcripts on the next prompt.

### Login

Both logins are driven by the backend, one at a time:

- Claude: `claude auth login` with `CLAUDE_CONFIG_DIR` set. It prints the
  authorize URL and reads the pasted code from stdin. `open` is shimmed so the
  browser is opened by the renderer, not the CLI.
- Codex: `codex login --device-auth` with `CODEX_HOME` set. It prints a
  verification URL and a one-time code and exits once approved. Device code
  avoids the browser flow's fixed `127.0.0.1:1455` callback.

A login that resolves to an identity already present (the host account
included) is discarded.

### Plan usage

`get_plan_usage` reads the active account. `get_agent_account_usage` reads any
account from its own directory. Claude access tokens last hours and Orkestrator
never refreshes them, so an inactive Claude account's usage goes stale until it
is used again; Codex tokens last days.

## Phase 0 findings (Claude Code 2.1.283, Codex 0.158.0)

- Claude's Keychain service for a config directory is
  `Claude Code-credentials-<first 8 hex of sha256(CLAUDE_CONFIG_DIR)>`. The hash
  is over the literal string, so a symlinked or trailing-slash spelling is a
  different entry, and setting `CLAUDE_CONFIG_DIR=~/.claude` explicitly reads
  as signed out. Without a Keychain entry Claude falls back to
  `<dir>/.credentials.json` and does not migrate it.
- With `CLAUDE_CONFIG_DIR` set, `.claude.json` and its `mcpServers` are read
  from inside that directory only.
- Symlinked `projects/`, `CLAUDE.md` and `skills/` load; `claude --resume` from
  a second directory resumed the first directory's session.
- Codex `account/login/start` writes `$CODEX_HOME/auth.json`; logout deletes
  it. `chatgptAuthTokens` login requires the `experimentalApi` capability,
  which the bridge deliberately leaves off, and is memory-only.
- With `sessions/` symlinked, a second `CODEX_HOME` with a fresh state
  database listed, resumed and continued the first home's thread.

## Slices

1. Registry, account directories, backend-driven login, active-account launch,
   per-account usage, Settings UI.
2. Containers.
3. Coordinator conversations.
4. Terminal tabs.

### Containers

A container receives the active account's login instead of the host's at three
points (`agent-accounts-containers.ts`):

- Creation: staging reads the login files (`auth.json`, `.credentials.json`,
  `.claude.json`) from the account directory and everything else from the
  host directory. Two sources feed one stage; it is still one mount.
- Every start: before `docker start`, the login files in the container's
  current staged revision are rewritten for the active account, so the
  entrypoint imports it. The staged `.claude.json` is a single-file bind mount
  and is rewritten in place to keep its inode. Nothing is rewritten for a
  platform that never had an account added. After start, Claude's credential
  is piped in as before, now for the active account.
- Bridge start: each container records the account its login belongs to in
  `/tmp/orkestrator-<platform>-account` (missing means the host login). When
  it differs from the active account and the in-container bridge is idle, the
  new login is written into the container, the staged revision updated and the
  bridge replaced. A busy bridge keeps its account until idle.

`useHostClaudeCredentials: false` keeps every Orkestrator-held Claude token out
of containers, whichever account it belongs to. A revoked provider is never
handed a login.

### Coordinator conversations

A coordinator's private directory is seeded from the active account's
directory instead of the host's, after removing a login an earlier launch
copied. Claude logins kept only in the macOS Keychain cannot be copied (the
entry is named after its directory), so the account's current access token is
passed as `CLAUDE_CODE_OAUTH_TOKEN` — never the refresh token, which would
rotate away from the account's own login. The token cannot be renewed; an idle
coordinator bridge is replaced five minutes before it expires. Coordinator
bridges also move to a newly active account once idle, like other bridges.

This also fixes coordinators on macOS with the host login, which previously
started signed out: they relied on the plain Keychain entry, which a custom
`CLAUDE_CONFIG_DIR` does not read.

### Terminal tabs

Local terminal tabs start with `CLAUDE_CONFIG_DIR`/`CODEX_HOME` pointing at the
active accounts (nothing is set for host logins). A terminal keeps the account
that was active when it opened. Claude tmux mode exports the active Claude
account per session, because a local tmux server keeps the environment it was
first started with. Container terminals use whatever login the container holds.

## Known gaps

- Older container images without staged inputs mount the host homes, so a
  restart brings the host login back until the next bridge start re-applies the
  account.
- A container's `~/.claude.json` keeps the previous account's `oauthAccount`
  after a live switch until the container restarts, so `claude auth status`
  inside it can name the old email while using the new token.
- `claude`/`codex` run from a container terminal, with no in-container bridge
  started since the switch, stay on the previous account until the container
  restarts or its bridge next starts.
- A settings or config write that the CLI performs by atomic rename replaces
  the symlink with a regular file inside the account directory, so that one
  file stops being shared for that account.
- Session-reported usage windows from a bridge still finishing a turn on the
  previous account are folded into the new account's card until it restarts.
- Claude stores OAuth logins for HTTP MCP servers (`mcpOAuth`) inside the same
  Keychain credential as the account login, so those servers need signing in
  again once per added Claude account.
