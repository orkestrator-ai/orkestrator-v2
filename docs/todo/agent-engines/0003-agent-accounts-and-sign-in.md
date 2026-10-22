# Agent accounts and sign-in

Checked against `main` at `2459b05c` (2026-10-15); account-switching gap 5
against `9b3f53a2` (2026-10-21).

Each platform should report a normalized sign-in state. Sign-in should happen
in the app wherever the vendor has an API for it, and losing auth mid-turn
should show in the tab, not as a spawn failure. Claude and Codex can also hold
more than one login, switched globally per platform. The status type, the
bridge routes, the per-session account card and multi-account switching all
exist, and every platform reports a missing login before a send. Still
missing: the turn-time `auth` notice, a session-free settings card and Codex
sign-in cancel. A handful of account-switching gaps remain,
mostly inside containers. How accounts work is in
[agent-accounts.md](../../architecture/agent-accounts.md).

## Current state

- Normalized status: `NativeAgentAuthStatus` (`state`, `account`, `providers`,
  `signIn.kind`, `signOut`) in `packages/protocol/src/native-agent.ts`.
  `authStatus?`, `beginSignIn?` and `signOut?` are on the provider contract
  (`agent-provider-contract.ts`). They are wired through `http-bridge-catalog.ts`
  and `native-agent-service-dispatch.ts`, and OpenCode answers through
  `OpenCodeCapabilities.authStatus` (`opencode-capabilities.ts`).
- Bridge routes `GET /global/auth`, `POST /global/auth/login` and
  `POST /global/auth/logout` exist on Claude, Codex, Cursor, ACP and Pi, each
  with route tests.
  - Claude: `readClaudeAuthStatus` reads `accountInfo()` on a probe query
    (`claude-sign-in.ts`). It reports `signIn.kind: "terminal"` with the hint
    "Open a Claude terminal tab and run /login."
  - Codex: `account/read`, `account/login/start` (`browser-url`) and
    `account/logout` (`bridges/codex-bridge/src/engine/app-server-engine.ts`).
  - Cursor: `Cursor.me` and the SDK credential (`credentials.ts`).
  - Grok: a stored login, `XAI_API_KEY` or an auth-provider command
    (`acp-credentials.ts`), checked before `authenticateIfRequired`
    (`acp-context.ts`). Sign-in is `terminal`.
  - Pi: per-provider `method` (`credentials.ts`). Sign-in is `terminal`, and
    login stays out by design. A prompt whose model's provider is signed out
    is refused (401) before Pi is asked, and a turn Pi ends on a failed
    response, such as an expired OAuth refresh, fails with Pi's error.
  - OpenCode: per-provider state with `signIn.kind: "terminal"` and a hint
    naming Settings → OpenCode, where the provider sign-in runs
    (`opencode-provider-login.ts`). A local tab offers that settings pane
    instead of a terminal, because the `opencode` on PATH may be 2.x.
- Renderer:
  - The per-session account card with sign-in and sign-out is in Agent Info
    (`AgentInfoButton.tsx`).
  - The settings pane has `AgentAccountsSection.tsx` (Claude and Codex
    accounts), `OpenCodeProvidersSection.tsx` (OpenCode provider logins) and
    `CursorSdkSignIn.tsx`. Nothing in settings reads
    `NativeAgentAuthStatus` without a session.
- Prompt admission: every platform reports a confirmed missing login as
  `readiness: { state: "authentication-required", message, signIn }`
  (`NativeAgentReadiness`); how each one detects it is in
  [agent-accounts.md](../../architecture/agent-accounts.md#sign-in-readiness). An
  expired login is not detectable ahead of a turn on Claude, Pi, Grok or
  OpenCode and stays a turn error. The tab offers in-tab sign-in, a terminal
  tab running the login command, or Claude's `ClaudeAuthRecoveryCard`. An
  OpenCode model request refused with HTTP 401 offers the provider's sign-in
  inside its error row (`OpenCodeAuthRecoveryAction`).
  `HttpBridgeProvider` passes any bridge's 401
  `kind: "authentication-required"` refusal through unwrapped.
- Turn-time auth: `NativeAgentNotice { kind: "auth" }` is defined, and the tab
  styles it as a warning, but nothing emits it. Claude `auth_status` becomes a
  runtime-health notice plus a status row (`handleAuthStatus`,
  `session-manager-prompt-handlers/leaf.ts`). Codex
  `modelProvider/authRecoveryStarted|Completed` are on the ignore list in
  `event-reducer.ts`.
- Accounts (`apps/backend/src/core/agent-accounts*.ts`):
  - Registry in `agent-accounts.json` (`agent-accounts-store.ts`), never in
    `config.json`.
  - Per-account config directories linked back to the host
    (`linkSharedEntries` in `agent-accounts-homes.ts`).
  - Backend-driven CLI login (`agent-accounts-login.ts`).
  - The active-account launch and the stale-login flags (`agent-accounts-active.ts`,
    `agent-account-bridge-state.ts`: `localAgentAccountIds`,
    `staleLoginLocalBridges`, `staleLoginEnvironmentIds`).
  - Container hand-off (`agent-accounts-containers.ts`:
    `refreshStagedAgentAccountLogins`, `syncContainerAgentAccountsOnStart`,
    `reconcileContainerAgentAccount`).
  - Reauthentication for Claude goes through `ClaudeAuthRecoveryCard`.

## Outstanding work

### Code

1. **Emit the `auth` notice.** Emit `NativeAgentNotice { kind: "auth" }` from
   Claude `auth_status` (keep the status row) and from Codex
   `modelProvider/authRecoveryStarted|Completed`, and take those two off the
   ignore list. The renderer already styles the notice.
2. **Claude sign-in route.** The tab already answers Claude's
   `authentication-required` readiness with `ClaudeAuthRecoveryCard`, which
   drives the backend's `claude auth login` for the active account
   (`start_agent_account_login` with `reauthenticate: true`). The bridge's
   `signIn` hint still says "run /login in a terminal tab"; point it, and the
   card in item 3, at that flow.
3. **Settings-pane auth card.** One card per enabled platform, read without a
   session, from `NativeAgentAuthStatus`. For Claude and Codex it should sit
   with `AgentAccountsSection` rather than duplicate it, and Cursor's
   `CursorSdkSignIn` becomes that platform's card.
4. **Codex cancel.** Send `account/login/cancel` when an in-tab sign-in is
   abandoned. Nothing calls it today.
5. **Scrub bridge output before the debug log.** `commands-servers.ts`
   forwards local bridge stdout and stderr unchanged to `console.debug` and
   `console.error`. With Debug logging on, `application-logging.ts` writes that
   output to `<dataDir>/logs` with no redaction. No bridge prints auth data
   today, and the canary tests hold each auth path to that. A credential-shape
   scrub at that forward would also cover a log line nobody has written yet.

### Account switching gaps

Each was checked against the current code.

1. **Older images without staged inputs** mount the host homes, so a restart
   brings the host login back until the next bridge start re-applies the
   account (header comment in `agent-accounts-containers.ts`). This goes away
   when the legacy host-mount path is retired; see
   [0021-container-rebuild-state-preservation.md](../containers-and-environments/0021-container-rebuild-state-preservation.md).
2. **A container's `~/.claude.json` keeps the previous `oauthAccount`** after a
   live switch, so `claude auth status` inside it names the old email while
   using the new token. `reconcileContainerAgentAccount` rewrites the staged
   `.claude.json` and pipes in the credential. The entrypoint, however, copies
   the mounted file into `$HOME/.claude.json` only at container start
   (`docker/entrypoint.sh`). A fix would update `oauthAccount` in the running
   container's `$HOME/.claude.json` during reconcile.
3. **`claude` / `codex` run from a container terminal** stay on the previous
   account until the container restarts or its bridge next starts. The login is
   written in only by `syncContainerAgentAccountsOnStart` and
   `reconcileContainerAgentAccount`, which runs at bridge start. Either
   reconcile when a container agent terminal opens, or say so in the UI.
4. **An atomic-rename write by the CLI** replaces a shared symlink with a regular
   file inside the account directory, and that file stops being shared for that
   account. `linkSharedEntries` leaves it alone on purpose, because the content
   is the account's now. Nothing reports that it happened.
5. **An agent-test profile can use the wrong Claude account** when `dev:test`
   is started from a shell whose `CLAUDE_CONFIG_DIR` names an added account
   (for example, an Orkestrator agent tab). The desktop records that directory
   as `ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR`, but
   `getHostClaudeCredentials` is called without
   `claudeKeychainService(configDir)`, so the token comes from the plain
   `Claude Code-credentials` Keychain entry, the default host login. The
   profile spends the default login's quota instead of the selected account's.
   Found on 2026-10-21 while preparing the live design rerun (see
   [0036-design-canvas-qualification.md](../design-canvas/0036-design-canvas-qualification.md#live-cycle-evidence-claude-rerun-2026-10-21)).
   At that baseline the bridge also wrote sessions into the host account's
   configuration directory, and the run used an empty scratch directory to
   avoid it. The merged host-home isolation change fixes those writes:
   `applyClaudeHostCredentialEnvironment` now keeps the profile's own
   `CLAUDE_CONFIG_DIR`. Account selection remains: decide whether the profile
   follows the shell's account or always the default, pass the desktop's
   knowledge of whether `CLAUDE_CONFIG_DIR` was explicit through to the
   backend (an explicit `~/.claude` has a hashed Keychain entry too), and use
   the matching credential entry for both local launches and container sync,
   with tests.

### Qualification

- Each auth state from fixtures, visible in the per-session card and, after
  item 3, in the settings card for every enabled platform.
- A Codex sign-out then sign-in round trip on a fixture profile with
  `--credential-source codex`.
- After item 1: an expired Claude login mid-turn shows the `auth` notice and
  the transcript sign-in card, not a spawn failure. A missing Claude login
  (`readiness`) already locks the composer behind the sign-in card.

## Constraints and rationale

- Pi login stays out by design (see
  [agent-engines.md](../../architecture/agent-engines.md) § Pi). Its status stays
  read-only.
- `authentication-required` readiness locks the composer, so a platform reports
  it only for a confirmed missing login and leaves it out when unsure. A
  terminal sign-in command comes from the renderer, never from a bridge.
- Orkestrator stores no credential beyond what Cursor already stores. Account
  logins stay in each account's own directory or Keychain entry.
- Credentials are never copied between account directories. Refresh tokens
  rotate, so a copy goes stale as soon as the original refreshes.
- Switching is global per platform and never kills work. An idle bridge is
  replaced; a bridge with live work keeps the old account until it is idle.
- A login that resolves to an identity already present is discarded.
- Claude's Keychain service name hashes the literal `CLAUDE_CONFIG_DIR` string,
  so spellings of one path are different entries. Never set
  `CLAUDE_CONFIG_DIR` for the host login.
- Claude keeps HTTP MCP server OAuth logins (`mcpOAuth`) inside the same Keychain
  credential as the account login, so each added Claude account has to sign in
  to those servers again. Copying them would break the rule above; this stays a
  known limitation unless Claude separates the two.

- **No credential in an auth answer; the login URL is never logged.** Checked
  at `9906db30` for every bridge, the backend boundary, OpenCode, the account
  and Cursor login drivers, Control MCP, the public API and the renderer. The
  rule and its guards are in
  [agent-accounts.md](../../architecture/agent-accounts.md#credentials-in-auth-answers).
  - Answers are allowlisted field by field, at the bridge and again in the
    backend, rather than redacted by pattern. A pattern cannot recognise a
    credential it has no rule for, and an allowlist cannot pass one through.
    Free-text fields (`label`, `plan`, `hint`) are taken from named provider
    fields that are not credentials. No secret-shape filter runs on them.
  - The URL and code go only to the client that asked. Logs never carry them,
    not even redacted: the URL is short-lived but holds the OAuth `state`, and
    the code completes a device login.
  - Redaction runs where a log line is written: Codex `app.onError` and its
    account-read warnings, and `open_in_browser`. Nothing redacts in the logger
    (see outstanding item 6) or at `assertOkWithErrorDetail`. Bridge error
    bodies on auth routes are fixed text, apart from Cursor's SDK login
    failure, whose messages are fixed strings in `@cursor/sdk` 1.0.37.
  - The guard is permanent tests, not a one-off check: canary credentials in
    each fake, a strict shape check of each answer, and capture of console and
    stdio (`tests/helpers/auth-secret-canaries.ts`). A static guard
    (`tests/unit/auth-secret-guards.test.ts`) keeps every bridge that serves
    `/global/auth` covered.
  - Login progress (`get_agent_account_login`, `cursor_sdk_login_status`,
    `get_github_cli_login`) is one global value that any gateway client can
    read. That is accepted: the gateway credential already grants full
    control of the backend.

## Open questions

- Should a replaced shared entry (gap 4) be reported in the accounts section, or
  re-linked when its content matches the host's?
- Should the settings auth card replace the Cursor-specific sign-in component
  outright, or wrap it?

## Needs verification

- **Usage windows after a switch.** The old multi-account plan listed "usage
  windows reported by a bridge still finishing a turn on the previous account
  are folded into the new account's card". The code now gates folding on the
  reporting bridge's account: `contextUsageWithPlanUsage`
  (`plan-usage-cache.ts`) folds only when the connection's `accountId`
  (`localAgentAccountIds`, set at launch) matches the active account. Container
  bridges report `"unknown"`, so their windows never fold. Confirm with a live
  switch during a running turn, then drop the gap or restate it.

## Related

- [agent-accounts.md](../../architecture/agent-accounts.md) (account directories,
  switching, login, reauthentication, containers, coordinator token hand-off,
  terminal tabs, provider behaviour relied on).
- [github-cli.md](../../architecture/github-cli.md) (GitHub CLI sign-in through the
  same login driver).
- [0039-mcp-management.md](../mcp/0039-mcp-management.md) (MCP OAuth).
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
  for the Codex round trip and agent-test credential isolation.
- [agent-engines.md](../../architecture/agent-engines.md).

## Replaces

- `docs/plans/sdk-coverage/08-auth-and-account-status.md`
- `docs/plans/multi-account.md` (known gaps here; the design is now
  `docs/architecture/agent-accounts.md`)
- `docs/plans/sdk-coverage-2026-09-06.md` (§1 theme 2, Claude §3.4 `auth_status`,
  Codex §4.3 auth recovery, OpenCode §5.4, Grok §7.4, Pi §8.13, Tier 3 row 32's
  sign-in half)
