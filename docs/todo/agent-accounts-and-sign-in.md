# Agent accounts and sign-in

Checked against `main` at `2459b05c` (2026-10-15).

Each platform should report a normalized sign-in state. Sign-in should happen
in the app wherever the vendor has an API for it, and losing auth mid-turn
should show in the tab, not as a spawn failure. Claude and Codex can also hold
more than one login, switched globally per platform. The status type, the
bridge routes, the per-session account card and multi-account switching all
exist. Still missing: the turn-time `auth` notice, actionable needs-auth on
four platforms, a session-free settings card, OpenCode sign-in and Codex
sign-in cancel. A handful of account-switching gaps remain, mostly inside
containers. The design reference for accounts is
[multi-account.md](../plans/multi-account.md).

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
    (`session-manager-catalog.ts`). It reports `signIn.kind: "terminal"` with
    the hint "Open a Claude terminal tab and run /login."
  - Codex: `account/read`, `account/login/start` (`browser-url`) and
    `account/logout` (`bridges/codex-bridge/src/engine/app-server-engine.ts`).
  - Cursor: `Cursor.me` and the SDK credential (`credentials.ts`).
  - Grok: the credential file plus `authenticateIfRequired` before
    `session/new` (`acp-context.ts`). Sign-in is `terminal`.
  - Pi: per-provider `method` (`credentials.ts`). Sign-in is `terminal`, and
    login stays out by design.
  - OpenCode: per-provider state with `signIn.kind: "none"`.
- Renderer:
  - The per-session account card with sign-in and sign-out is in Agent Info
    (`AgentInfoButton.tsx`).
  - The settings pane has `AgentAccountsSection.tsx` (Claude and Codex
    accounts) and `CursorSdkSignIn.tsx`. Nothing in settings reads
    `NativeAgentAuthStatus` without a session.
- Prompt admission: `readiness: { state: "authentication-required", message }`
  (`NativeAgentReadiness`) comes only from Codex
  (`app-server-runtime-sessions.ts`) and Cursor (`http.ts`). The backend
  normalizes it with `normalizeProviderReadiness` (`http-bridge-transport.ts`),
  and `AgentNativeTab.controller.tsx` renders it. `HttpBridgeProvider` keeps a
  Cursor-only 401 `authentication-required` branch.
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
2. **Actionable needs-auth everywhere.** Report
   `readiness: authentication-required` on Claude, Pi, ACP and OpenCode when
   their status is `needs-auth` or `expired`, as Codex and Cursor do.
   `NativeAgentReadiness` carries only a message, so either name the sign-in
   route in the message or add the `signIn` kind to the type. Once every bridge
   reports readiness, drop the Cursor-only 401 branch in `HttpBridgeProvider`.
3. **Claude sign-in route.** The bridge still says "run /login in a terminal
   tab", but the backend already drives `claude auth login` for the active
   account (`start_agent_account_login` with `reauthenticate: true`, surfaced by
   `ClaudeAuthRecoveryCard`). Point Claude's needs-auth state, and the card in
   item 4, at that flow.
4. **Settings-pane auth card.** One card per enabled platform, read without a
   session, from `NativeAgentAuthStatus`. For Claude and Codex it should sit
   with `AgentAccountsSection` rather than duplicate it, and Cursor's
   `CursorSdkSignIn` becomes that platform's card.
5. **OpenCode in-app sign-in.** `beginSignIn` per provider:
   - API key through `client.auth.set`, collected as a secret-input interaction
     (see [agent-interactions-and-permissions.md](agent-interactions-and-permissions.md)),
     never a renderer form;
   - OAuth through `provider.oauth.authorize`, returning the URL, then
     `provider.oauth.callback`.

   Neither is called today.
6. **Codex cancel.** Send `account/login/cancel` when an in-tab sign-in is
   abandoned. Nothing calls it today.

### Account switching gaps

Each was checked against the current code.

1. **Older images without staged inputs** mount the host homes, so a restart
   brings the host login back until the next bridge start re-applies the
   account (header comment in `agent-accounts-containers.ts`). This goes away
   when the legacy host-mount path is retired; see
   [container-rebuild-state-preservation.md](container-rebuild-state-preservation.md).
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

### Qualification

- Each auth state from fixtures, visible in the per-session card and, after
  item 4, in the settings card for every enabled platform.
- A Codex sign-out then sign-in round trip on a fixture profile with
  `--credential-source codex`.
- No token or key in any auth response body except the intended login `url`,
  and the URL itself is never logged.
- After items 1 and 2: an expired Claude login mid-turn shows the `auth` notice
  and an actionable readiness state, not a spawn failure.

## Constraints and rationale

- Pi login stays out by design (see
  [agent-engines.md](../architecture/agent-engines.md) § Pi). Its status stays
  read-only.
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

## Open questions

- Should a replaced shared entry (gap 4) be reported in the accounts section, or
  re-linked when its content matches the host's?
- Should the settings auth card replace the Cursor-specific sign-in component
  outright, or wrap it?

## Needs verification

- **Usage windows after a switch.** `multi-account.md` lists "usage windows
  reported by a bridge still finishing a turn on the previous account are
  folded into the new account's card". The code now gates folding on the
  reporting bridge's account: `contextUsageWithPlanUsage`
  (`plan-usage-cache.ts`) folds only when the connection's `accountId`
  (`localAgentAccountIds`, set at launch) matches the active account. Container
  bridges report `"unknown"`, so their windows never fold. Confirm with a live
  switch during a running turn, then drop the gap or restate it.

## Related

- [multi-account.md](../plans/multi-account.md) (design: account directories,
  switching, login, reauthentication, containers, coordinator token hand-off,
  terminal tabs, Phase 0 findings).
- [mcp-management.md](mcp-management.md) (MCP OAuth).
- [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md)
  for the Codex round trip and agent-test credential isolation.
- [agent-engines.md](../architecture/agent-engines.md).

## Replaces

- `docs/plans/sdk-coverage/08-auth-and-account-status.md`
- `docs/plans/multi-account.md` "Known gaps" (the rest of that file stays as the
  design reference)
- `docs/plans/sdk-coverage-2026-09-06.md` (§1 theme 2, Claude §3.4 `auth_status`,
  Codex §4.3 auth recovery, OpenCode §5.4, Grok §7.4, Pi §8.13, Tier 3 row 32's
  sign-in half)
