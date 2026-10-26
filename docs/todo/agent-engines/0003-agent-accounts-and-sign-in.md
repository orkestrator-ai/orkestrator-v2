# Agent accounts and sign-in

Checked against `main` at `2459b05c` (2026-10-15); account-switching gap 4
against `9b3f53a2` (2026-10-21). Every code item and switching gap was
implemented on 2026-10-24 against `8454d18b` (branch
`todo-0003-accounts-sign-in-cf5acbb74387`, node mbp3). The live
qualification was run on 2026-10-26 against `93018933` (branch
`todo-0003-agent-accounts-sign-in-7ea5f29c4c61`, node mbp3, macOS, Docker
Desktop 29.7.2, Claude Code 2.1.310, Codex 0.162.1 on PATH and 0.164.0 in the
profiles), and fixed the four defects it found (see
[Qualification](#qualification)).

Each platform should report a normalized sign-in state. Sign-in should happen
in the app wherever the vendor has an API for it, and losing auth mid-turn
should show in the tab, not as a spawn failure. Claude and Codex can also hold
more than one login, switched globally per platform. All of that is now in the
tree: the status type, the bridge routes, the per-session and settings account
cards, the turn-time `auth` notice, Codex sign-in cancel, the bridge-output
scrub and the four switching gaps, each checked on the real stack. What is left
needs a person to approve a Codex sign-in, and a Claude turn that reports
rate-limit windows (see [What is left](#what-is-left)). How accounts work is in
[agent-accounts.md](../../architecture/agent-accounts.md).

## Current state

- Normalized status: `NativeAgentAuthStatus` (`state`, `account`, `providers`,
  `signIn.kind`, `signOut`) in `packages/protocol/src/native-agent.ts`.
  `authStatus?`, `beginSignIn?`, `cancelSignIn?` and `signOut?` are on the
  provider contract (`agent-provider-contract.ts`). They are wired through
  `http-bridge-catalog.ts` and `native-agent-service.ts`, and OpenCode answers
  through `OpenCodeCapabilities.authStatus` (`opencode-capabilities.ts`).
- Bridge routes `GET /global/auth`, `POST /global/auth/login` and
  `POST /global/auth/logout` exist on Claude, Codex, Cursor, ACP and Pi, each
  with route tests. Codex also serves `POST /global/auth/login/cancel`.
  - Claude: `readClaudeAuthStatus` reads `accountInfo()` on a probe query
    (`claude-sign-in.ts`). It reports `signIn.kind: "terminal"` with the hint
    "Sign in to Claude from the sign-in card in this tab or from Settings →
    Claude."
  - Codex: `account/read`, `account/login/start` (`browser-url`),
    `account/login/cancel` and `account/logout`
    (`bridges/codex-bridge/src/engine/app-server-engine.ts`).
  - Cursor: `Cursor.me` and the SDK credential (`credentials.ts`).
  - Grok: a stored login, `XAI_API_KEY` or an auth-provider command
    (`acp-credentials.ts`), checked before `authenticateIfRequired`
    (`acp-context.ts`). Sign-in is `terminal`.
  - Pi: per-provider `method` (`credentials.ts`). Sign-in is `terminal`, and
    login stays out by design.
  - OpenCode: per-provider state with `signIn.kind: "terminal"` and a hint
    naming Settings → OpenCode, where the provider sign-in runs
    (`opencode-provider-login.ts`).
- Renderer:
  - The per-session account card with sign-in and sign-out is in Agent Info
    (`AgentInfoButton.tsx`). For Claude it now offers the in-app account
    sign-in (`ClaudeAccountSignInAction`), and Codex's device-code toast has a
    **Cancel sign-in** action.
  - Each enabled platform's settings page opens with a session-free sign-in
    card (`AgentSignInCard.tsx`, backend `get_agent_sign_in_status` in
    `agent-sign-in-status.ts`). `AgentAccountsSection.tsx` (Claude and Codex),
    `OpenCodeProvidersSection.tsx` and `CursorSdkSignIn.tsx` (wrapped by the
    card) stay as each platform's own sign-in surface.
- Prompt admission: every platform reports a confirmed missing login as
  `readiness: { state: "authentication-required", message, signIn }`; see
  [agent-accounts.md](../../architecture/agent-accounts.md#sign-in-readiness).
- Turn-time auth: Claude (`auth_status`, and a turn refused with
  `authentication_failed`) and Codex (`modelProvider/authRecovery*`) put an
  `authNotice` on the session read, which the backend turns into
  `NativeAgentNotice { kind: "auth" }` (`normalizeProviderAuthNotice`). The tab
  shows it as a warning beside the transcript's sign-in card.
- Accounts (`apps/backend/src/core/agent-accounts*.ts`): registry, per-account
  directories with shared entries, backend-driven CLI login, active-account
  launch and stale-login flags in `LocalServerRuntime` (`local-server-runtime.ts`), container hand-off, Claude reauthentication.
  Shared entries a CLI replaced with its own copy are now reported per account
  (`privateEntries`).
  A Codex bridge on an added account keeps its session records in the host
  login's `orkestrator-bridge` (`CODEX_BRIDGE_STATE_DIR`), so a tab keeps its
  conversation when its bridge is replaced after a switch (2026-10-26).

## Outstanding work

### Code

1. **Emit the `auth` notice.** Done (2026-10-24).
   - Claude: `handleAuthStatus` (`session-manager-prompt-handlers/leaf.ts`)
     keeps its status row and now sets `SessionState.authNotice`
     (`session-auth-notice.ts`): an `error` raises `expired`,
     `isAuthenticating` raises `needs-auth`, and a finished authentication
     clears it. A turn Claude refuses with `authentication_failed`
     (`assistant.ts`) raises `expired`, and any real answer clears it.
     `GET /session/:id` serves it.
   - Codex: `modelProvider/authRecoveryStarted|Completed` are off the ignore
     list. The reducer emits `thread.authRecovery`; `nextThreadAuthNotice`
     (`sessions/auth-recovery-notice.ts`) raises `expired` on start, clears on
     a completion or a completed turn, and keeps a `needs-auth` notice when
     Codex's own text says the renewal failed. `/session/:id/status` serves it.
   - Backend: `normalizeProviderAuthNotice` (`http-bridge-transport.ts`) reads
     it field by field into the first snapshot notice on the Claude, Codex and
     progressive reads.
   - Evidence: `leaf.test.ts`, `claude-sign-in.test.ts` ("a login refused
     mid-turn raises the session's auth notice until a model answers"),
     `routes/session.test.ts`, `event-reducer.test.ts`,
     `auth-recovery-notice.test.ts`, `app-server-runtime-sessions.test.ts`
     ("turn-time auth notice"), `http-bridge-provider.test.ts`,
     `AgentNativeTab.test.tsx` ("shows a turn-time sign-in notice as a warning
     the user can act on"). Real CLI: the Claude bridge from this branch, run
     against Claude Code 2.1.309 with an empty `CLAUDE_CONFIG_DIR`, answered a
     prompt's `GET /session/:id` with
     `authNotice: { state: "expired", message: "Claude's login was refused. …" }`
     beside the readiness lock carrying the new hint. The bridge log held no
     credential.
2. **Claude sign-in route.** Done (2026-10-24). The bridge hint (and its
   `POST /global/auth/login` 405 body) now point at the in-app sign-in. The
   Agent Info account card shows **Sign in to Claude**, which runs the
   backend's `claude auth login` for the active account
   (`ClaudeAccountSignInAction`, the compact form of `ClaudeAuthRecoveryCard`),
   and the settings card uses the same action. Evidence: `AgentInfoButton.test.tsx`
   ("offers Claude's in-app account sign-in instead of a terminal"),
   `AgentSignInCard.test.tsx` ("Claude signs the active account in again from
   the card"), `claude-sign-in.test.ts`.
3. **Settings-pane auth card.** Done (2026-10-24). `get_agent_sign_in_status`
   reads each platform on the host without a session: the active account for
   Claude and Codex, the resolved Cursor credential, Grok's login checks, and
   the provider entries in Pi's and OpenCode's credential stores (ids and
   kinds only). `AgentSignInCard` sits at the top of each enabled platform's
   page, above `AgentAccountsSection` for Claude and Codex, and wraps
   `CursorSdkSignIn` for Cursor. Evidence: `agent-sign-in-status.test.ts`
   (with the credential canaries and the strict shape check),
   `AgentSignInCard.test.tsx` (all five states on all six platforms),
   `e2e/GlobalSettings.spec.ts` ("the Claude page shows its sign-in card
   without a session", Playwright).
4. **Codex cancel.** Done (2026-10-24). The bridge tracks the `loginId` of the
   browser or device-code login it started, `POST /global/auth/login/cancel`
   sends `account/login/cancel` and answers only `{ cancelled }`, and a device
   code that lapses cancels its login too. The backend command is
   `cancel_native_agent_sign_in` (a no-op for bridges without the route). The
   tab banner shows **Cancel sign-in** while a link or code is up, and the
   Agent Info device-code toast has the same action. Evidence:
   `app-server-engine.test.ts`, `index-routes.test.ts`,
   `http-bridge-auth-secrets.test.ts`, `native-agent-service-projection.test.ts`,
   `AgentNativeTab.test.tsx`, `AgentInfoButton.test.tsx`.
5. **Scrub bridge output before the debug log.** Done (2026-10-24).
   `forwardBridgeOutput` (`commands-servers.ts`) reassembles each local
   bridge's stdout and stderr into whole lines and passes them through
   `redactBridgeOutput` (`bridge-output-redaction.ts`: `redactSecrets` plus
   `xai-`, Cursor `key_` and `rt_` shapes) before `console.debug` /
   `console.error`. Evidence: `bridge-output-redaction.test.ts` (every canary
   shape, a token split across chunks, the line bound, the final flush, and
   nothing planted reaching the console).

### Account switching gaps

All four were closed in code on 2026-10-24. Gaps 1, 2 and 4 passed live on
2026-10-26 (see [Qualification](#qualification)); gap 3 needs no live run.

1. **Older images without staged inputs.** Done. A legacy image mounts the
   host homes read-only and the entrypoint copies them into `/home/node`, so
   the container's live home is its own copy. On every start of a container
   with no inputs-revision label, `syncContainerAgentAccountsOnStart` now also
   pushes the active Claude identity (`oauthAccount`) and, through
   `applyActiveCodexLoginAfterLegacyBoot`, the active Codex login, but only
   when the Codex marker proves an unreconciled boot and Codex has no live
   work. The marker is left as is, so the next bridge start still replaces the
   bridge. The legacy mount path is kept for images that predate staged
   inputs, so this code stays while they are supported
   ([container lifecycle](../../architecture/container-lifecycle.md#rollout-switches-and-legacy-runtimes)).
   Evidence: `agent-accounts-containers.test.ts` (three
   legacy-boot tests).
2. **`claude` / `codex` run from a container terminal.** Done.
   `start_terminal_session` calls `applyActiveAgentAccountsForContainerTerminal`
   before spawning the shell. It writes the active login into the container
   and its staged copy, queued behind the platform's bridge operations,
   skipped while that platform has live work, capped at 10 s, and never for
   Claude when the container keeps its own isolated login. It neither stops
   the bridge nor writes the marker. Evidence: `agent-accounts-containers.test.ts`
   (three terminal hand-off tests); `tests/commands-registry-terminal.test.ts`
   still passes.
3. **An atomic-rename write by the CLI.** Done. `privateSharedEntries`
   (`agent-accounts-homes.ts`) lists the shared entries an added account now
   keeps as its own file or directory; `listAgentAccounts` returns them as
   `privateEntries` (names only), and the account row says "No longer shared
   with the host login: …". Nothing is re-linked. Evidence:
   `agent-accounts-homes.test.ts`, `agent-accounts.test.ts`,
   `AgentAccountsSection.test.tsx`.
4. **An agent-test profile can use the wrong Claude account.** Done. The
   profile follows the shell's account. The desktop now also sets
   `ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_EXPLICIT=1` when the
   inherited `CLAUDE_CONFIG_DIR` was set (an explicit `~/.claude` included) and
   never passes an inherited value through. `runtimeHostClaudeConfigDir` and
   `claudeLoginLookupOptions` choose the hashed Keychain service and that
   directory's `.credentials.json`, with no fallback to the default login,
   for local launches (`applyClaudeHostCredentialEnvironment`), container sync
   (`readRuntimeHostClaudeCredentials`) and the CLI scenario harness
   (`packages/cli/scenarios/provider-homes.ts`). Evidence:
   `apps/desktop/tests/backend-process.test.ts`,
   `apps/backend/tests/claude-credential-injection.test.ts` (including a
   macOS test with a stubbed `security` tool).

### Qualification

All runs below used disposable `dev:test` profiles and made-up logins in
throwaway directories; no real login was signed out, renewed or written. Each
profile was stopped and reset afterwards, and the throwaway Keychain entry one
probe created was deleted.

- Each auth state from fixtures, visible in the per-session card and in the
  settings card for every enabled platform. Done (2026-10-24):
  `AgentInfoButton.test.tsx` ("shows the %s auth fixture in the session's
  account card", five states) and `AgentSignInCard.test.tsx` (five states ×
  six platforms); the Claude settings card also renders in Playwright
  (`e2e/GlobalSettings.spec.ts`).
- **A Codex sign-out then sign-in round trip.** Done except approving the
  sign-in (2026-10-26, profile `qa-0003-auth`, `--no-agent-credentials`, the
  profile's own `CODEX_HOME` holding a made-up API key from
  `codex login --with-api-key`, so no host login was involved):
  - Agent Info showed `apiKey · signed in`. **Sign out** removed the profile's
    `auth.json` (the host `~/.codex/auth.json` was untouched), the card turned
    to `needs auth`, the composer locked ("Sign in to Codex before sending")
    and the banner offered **Sign in to Codex**.
  - Browser flow: **Sign in to Codex** opened OpenAI's sign-in page and the
    profile's app-server listened on `127.0.0.1:1455`. **Cancel sign-in**
    cleared the link and the button, and the listener closed within a second
    while app-server kept running, so app-server cancelled the login.
  - Device-code flow (`begin_native_agent_sign_in` with `deviceCode: true`, as
    a remote or container tab sends): OpenAI issued a 10-character code, the
    banner recovered it with the link and **Cancel sign-in**, and after Cancel
    the bridge reported `pendingSignIn: null` and the code left the banner.
    The code was never logged or screenshotted.
  - Unlock: storing a login outside the tab (`codex login --with-api-key`)
    unlocked the tab within one 10-second read (three runs; one earlier run
    right after a page reload did not re-read, and did not reproduce). That
    needed a fix, below.
  - Still open: approving a real browser or device-code sign-in, which needs a
    person (see [What is left](#what-is-left)).
- **An expired Claude login mid-turn shows the `auth` notice and the sign-in
  card, not a spawn failure.** Done (2026-10-26, profile `qa-0003-auth`): the
  profile's `CLAUDE_CONFIG_DIR` held a made-up OAuth login with a future
  `expiresAt`, which Claude Code 2.1.310 reads as signed in and refuses on the
  first request. The turn ended with Claude's own reply "Failed to
  authenticate. API Error: 401 OAuth access token is invalid.", and the tab
  showed the warning "Claude's login was refused. Sign in to Claude again to
  keep working." The sign-in card was missing; after the fix below the card
  is pinned above the composer next to the warning, survives a reload, and
  clears with the notice once a model answers (seen in `qa-0003-gap4`). **Sign
  in to Claude** answered "The host login cannot be signed in again from this
  profile.", which is the documented agent-test refusal. The bridge and
  profile logs held no part of the made-up token.
- **Usage windows after a switch** ([Needs verification](#needs-verification)).
  Done for Codex (2026-10-26, profile `qa-0003-usage`): account A was the
  profile's host Codex login (an access-only snapshot), B an added account
  with a made-up key. After one turn A's usage read `ok`, `primary 10%`.
  During a 40-second turn on A the active account was switched to B; B's usage
  read "Sign in to Codex to see plan usage" with no windows at every 5-second
  poll for 80 s, through the end of A's turn and the bridge's replacement, so
  A's windows were never folded into B's card. Claude could not be exercised:
  its turns on this login reported no rate-limit windows to fold (see
  [What is left](#what-is-left)).
- **Switching gap 1 (an image without staged inputs).** Done (2026-10-26,
  profile `qa-0003-ctr`, Codex and Claude authorized). No supported release
  image lacks staged inputs (v2.21.0, the support floor, already declares
  `staged-inputs=1`), so the run used the profile's current dev image with
  `staged-inputs` removed from its image manifest, which is what the backend
  reads. The environment created from it had no inputs-revision label and the
  host homes bound read-only at `/codex-home` and `/claude-config`, the legacy
  shape. With added accounts B (made-up Codex key) and C (made-up Claude
  login) made active, the container was stopped and started with no terminal
  attached: the entrypoint copied the host logins at boot and, 0.8 s later,
  the container held B's Codex login (`apikey …BBBBB`) and C's Claude
  identity (`qa-0003-ctr@example.invalid`) and token, with the Codex marker
  left `unstaged` as designed.
- **Switching gap 2 (a container terminal after a switch).** Done (2026-10-26,
  profile `qa-0003-ctr`). After switching Codex to B, opening a terminal in
  `fixture-container` wrote B's login into it (`codex login status`: "API key
  configured - sk-proj-***BBBBB"), while the second container, with no
  terminal opened, kept the host's ChatGPT login. Switching back and opening
  another terminal restored the ChatGPT login. For Claude, switching to C and
  opening a terminal gave `claude auth status`: "Email:
  qa-0003-ctr@example.invalid", again only in that container.
- **Switching gap 4 (`dev:test` from a shell naming an added account).** Done
  (2026-10-26, profile `qa-0003-gap4`, `--credential-source claude`):
  - With `CLAUDE_CONFIG_DIR` naming a throwaway directory holding a made-up
    login, the backend received `ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR`
    with `…_EXPLICIT=1`, the Claude bridge's `ANTHROPIC_AUTH_TOKEN` hashed to
    the made-up token, and the turn was refused with a 401 rather than
    answered by the default login.
  - From this agent's own shell, whose `CLAUDE_CONFIG_DIR` names one of this
    machine's added Claude accounts, the bridge's token matched that account's
    hashed Keychain entry (sha256 prefix `0f5822…`), not the default login's
    (`86725d…`), and the turn answered "pong", so the profile spent that
    account's quota. Only hashes were compared; no credential was printed.

Defects the runs found, all fixed in this branch with tests:

- **Claude's sign-in card never appeared for an expired login.** The card was
  pinned only for a terminal error row or Claude's exact "Not logged in"
  reply; a dead login ends the turn with an ordinary reply. The turn-time
  `auth` notice now pins `ClaudeAuthRecoveryCard`, without locking the
  composer, unless a terminal auth error row after the last prompt already
  carries one (`AgentNativeTab.controller.tsx`). Evidence:
  `AgentNativeTab.test.tsx` ("shows a turn-time sign-in notice as a warning
  the user can act on", "pins Claude's sign-in card for a turn-time auth
  notice until it clears", "does not pin a second Claude sign-in card over a
  terminal auth error row") and the live run above.
- **A Codex tab locked for sign-in did not notice a login made elsewhere.**
  Its account was re-read only while a sign-in it started was pending. A
  visible locked Codex tab now re-reads every 10 s; that read lets the bridge
  pick up the stored login and clear the lock. Evidence: `AgentNativeTab.test.tsx`
  ("a visible signed-out Codex tab asks again, so a login made elsewhere
  unlocks it", which fails without the change) and the live run above.
- **A Codex tab lost its conversation when its bridge was replaced after a
  switch.** The bridge kept the tab-to-thread records under
  `CODEX_HOME/orkestrator-bridge`, which is per account, so the replacement
  did not know the session: the tab showed "Unable to connect to Codex" and
  **Retry** opened an empty session (reproduced twice). Session records,
  dispatch journals, titles, change evidence and command-change journals now
  live in the host login's directory (`CODEX_BRIDGE_STATE_DIR`, set by
  `applyActiveAgentAccountEnvironment`; `bridges/codex-bridge/src/bridge-state-dir.ts`).
  Records an account kept in its own directory are adopted on load. Live
  re-run after the fix: the turn finished on A, the tab kept "pong" and
  "finished", survived a reload, and the next prompt ran on B in the same
  conversation. Evidence: `bridge-state-dir.test.ts`,
  `sessions/persistence.test.ts` ("BridgeSessionStore across Codex accounts"),
  `session-titles.test.ts`, `sessions/command-changes.test.ts`,
  `agent-accounts-active.test.ts`.
- **A Codex `needs-auth` notice could never clear.** It locks the composer and
  was cleared only by a completed turn. A successful `account/login/completed`
  now clears every thread's notice (`account.signedIn` engine event).
  Evidence: `app-server-runtime-sessions.test.ts` ("a failed renewal's notice
  clears once the user signs in again", which fails without the change).

A gap the runs found and left for its own file: a Codex turn refused for its
login (an invalid API key) shows its 401 only while running, and the tab then
renders neither the error row the projection holds nor a sign-in prompt
([0235](0235-codex-refused-login-turn-invisible.md)).

### What is left

1. **Approve a real Codex sign-in from the tab.** Needs a person. Start
   `mise run dev:test --profile codex-auth-qa --fixture --no-agent-credentials --agent-platforms codex`,
   store a made-up key in the profile's Codex home
   (`CODEX_HOME=<dataDir>/agent-credentials/codex codex login --with-api-key`),
   open a Codex tab, sign out from Agent Info, then press **Sign in to Codex**
   and finish the ChatGPT sign-in in the browser (or a device code, through a
   remote browser). Confirm the composer unlocks without a send, then sign out
   again so the profile holds no real login, and reset the profile. Everything
   before the approval passed on 2026-10-26.
2. **Usage windows after a switch, for Claude.** Repeat the Codex run above
   with Claude once a Claude turn reports rate-limit windows (Claude sends
   them only sparsely, near a limit): a long turn on account A, a switch to B
   mid-turn, and B's card must not show A's windows. The gate is the same
   function for both platforms (`contextUsageWithPlanUsage`).

## Assumptions and decisions

Each decision lists the options considered, the choice, why, and its pros and
cons.

1. **Where the turn-time notice lives.**
   - Options: (a) a runtime-health notice promoted by `providerAdvisoryNotices`;
     (b) a session-scoped `authNotice` field on the session read the backend
     already polls; (c) a new SSE event only.
   - Chosen: (b).
   - Why: runtime health is cached for minutes and only promotes `error`
     advisories, so a sign-in notice would arrive late and in the wrong
     shape. The session read is fresh on every projection, and a field keeps
     the snapshot authoritative (AGENTS.md invariant 3).
   - Pros: no new route, one normalizer for both bridges, and an older bridge
     simply omits the field. Cons: one more field on two session payloads.
2. **Which Claude events raise the notice, and with which state.**
   - Options: `auth_status` only, as the item said; or `auth_status` plus a
     turn refused with `authentication_failed`.
   - Chosen: both. `auth_status` error → `expired`; `isAuthenticating` →
     `needs-auth`; finished → cleared; `authentication_failed` → `expired`;
     any real answer → cleared.
   - Why: the qualification asks for an *expired login mid-turn* to show the
     notice, and Claude reports that as `authentication_failed` on the turn,
     not as `auth_status` (which covers `apiKeyHelper` and cloud-credential
     refreshes).
   - Pros: the case users actually hit is covered. Cons: a confirmed missing
     login shows the notice beside the readiness lock, which says much the
     same.
3. **Codex `authRecoveryCompleted` has no outcome field.**
   - Options: always clear; always keep; classify Codex's own text.
   - Chosen: clear, unless the text says the renewal failed (`fail`,
     `could not`, `unable`, `sign in again`, …), in which case keep a
     `needs-auth` notice. A completed turn also clears it.
   - Why: codex 0.162.1's binary settles a renewal as succeeded,
     failed-permanent or failed-transient and says which only in the message.
   - Pros: a failed renewal stays visible. Cons: a text heuristic; a reworded
     failure would clear early, though a real sign-out still locks the
     composer through `account/read`.
4. **Claude's route kind.**
   - Options: add a new `NativeAgentSignInRoute` kind for a backend-driven
     login; or keep `terminal` and change the hint.
   - Chosen: keep `terminal`, change the hint and the 405 body, and give
     Claude its own action in Agent Info and settings.
   - Why: a protocol kind would touch every bridge, the backend normalizer
     and every renderer branch, while the tab already routes Claude to
     `ClaudeAuthRecoveryCard`. The terminal `/login` remains a valid fallback
     that card offers.
   - Pros: no protocol change. Cons: the kind under-describes Claude's route,
     so Claude-specific UI checks the platform.
5. **How settings reads sign-in state without a session.**
   - Options: start a bridge per platform; reuse any running environment's
     bridge; read the same host evidence the launchers use.
   - Chosen: host evidence (`agent-sign-in-status.ts`).
   - Why: settings must work before any environment exists, and starting
     bridges to render a page is costly and has side effects.
   - Pros: cheap (file and accounts reads), works offline, no process
     started. Cons: Pi and OpenCode can only list stored provider logins, so
     an empty store reads `unknown` rather than `signed-out`; Cursor and Grok
     report a credential's presence, not its validity.
6. **How the card sits with the existing sections.**
   - Options: replace `AgentAccountsSection`, `CursorSdkSignIn` and
     `OpenCodeProvidersSection`; or put a compact card above them.
   - Chosen: a compact card above them. It wraps `CursorSdkSignIn` (answering
     the open question "replace or wrap": wrap) and points OpenCode to its
     Provider Sign-in section.
   - Why: those sections already own add, switch, remove and provider logins;
     rebuilding them would duplicate tested behaviour.
   - Pros: one uniform state line per platform with little new UI. Cons:
     Cursor's status is shown twice (the card badge and Cursor's own line).
7. **Codex in the settings card.**
   - Options: extend `reauthenticate` to Codex; or show the state and point
     to the tab's in-app sign-in and the accounts list.
   - Chosen: the latter.
   - Why: Codex already signs in from the tab through app-server, and adding
     an account is an in-app device-code login. A Codex promotion path would
     be new credential-writing code with its own failure modes.
   - Pros: no new credential handling. Cons: a signed-out active Codex login
     cannot be repaired from settings in one click.
8. **Provider ids from credential stores.**
   - Options: show every key; allow a broad pattern; allow only short
     lowercase slugs that the secret redactor leaves untouched.
   - Chosen: the last. The canary test caught a key-shaped string passing
     the broad pattern.
   - Pros: a hand-edited store cannot leak a key into the UI. Cons: a provider
     with an unusual id would be left out of the list.
9. **Codex cancel (from the item 4 work).**
   - Options: a new bridge route; reuse `/logout`; dismiss in the renderer
     only.
   - Chosen: a new route plus an optional contract method that other bridges
     treat as a no-op, tracking the login id for both flows and cancelling
     when a device code lapses.
   - Why: the login id must stay in the bridge, and logging out would end a
     valid login.
   - Pros: an abandoned browser login is released as well. Cons: one more
     route and piece of state; Agent Info has no cancel for the browser flow,
     which shows no toast (the tab banner's cancel covers it).
10. **Bridge-output scrub (item 5).**
    - Options: change the protocol's `redactSecrets`; wrap it in the backend.
    - Chosen: wrap it, adding `xai-`, Cursor `key_` and `rt_` shapes, and
      reassemble whole lines first so a token split across chunks is caught.
    - Pros: other bridges' redaction is unchanged. Cons: two pattern lists; a
      bare OAuth or device code has no recognisable shape, so the
      never-log-it rule and its canary tests stay the guard; a line over
      64 KiB is cut at the bound.
11. **Gap 1.**
    - Options: leave it to 0021; reconcile with a bridge stop at start; push
      only, gated.
    - Chosen: push only, gated on the legacy label, the Codex marker and live
      work.
    - Why: the legacy mount is read-only and copied in by the entrypoint, so
      writing the container's copy never touches the host login.
    - Pros: a restart no longer brings the host login back. Cons: one more
      `docker exec` per legacy start, until 0021 removes the path.
12. **Gap 2.**
    - Options: reconcile when a container terminal opens; or say so in the UI.
    - Chosen: reconcile, without stopping the bridge or writing the marker.
    - Why: a note asks the user to work around a fix the backend can make
      safely.
    - Pros: a new terminal runs on the active account. Cons: up to 10 s of
      extra latency on a slow container; a terminal opened while that
      platform has live work, or one already open, keeps the old login.
13. **Gap 3** (answers the open question "report or re-link").
    - Options: report; re-link when the content matches the host's; both.
    - Chosen: report only.
    - Why: re-linking races a concurrent CLI write and could lose it.
    - Pros: no data-loss path. Cons: the user re-links by hand if they want
      the entry shared again.
14. **Gap 4.**
    - Options: always use the default login; follow the shell's account; add
      a profile flag.
    - Chosen: follow the shell's explicit `CLAUDE_CONFIG_DIR`.
    - Why: that is the account `claude` in that shell uses, and the desktop
      already records the directory.
    - Pros: the profile spends the quota the user expects. Cons: a backend
      that itself inherited an explicit `CLAUDE_CONFIG_DIR` now reads that
      directory's hashed Keychain entry with no fallback to `~/.claude`,
      which matches what the CLI it launches does.

Decisions from the 2026-10-26 qualification:

15. **How to qualify without touching a real login.**
    - Options: use the host logins as the profiles allow by default; ask for a
      person and a spare account; drive the real CLIs and the real app with
      made-up logins in throwaway homes, and use real logins only where a run
      must reach the provider, read-only.
    - Chosen: the last. Made-up Codex API keys, made-up Claude OAuth logins
      and fixture-only accounts in the profiles' own stores; the host Codex
      login only as the profile's access-only snapshot (never signed out); a
      real Claude account only for gap 4, compared by hash.
    - Why: signing out a profile's copy of a real login could revoke the
      host's, and the brief forbids changing a real login.
    - Pros: every flow up to the provider's own approval ran on the real
      stack with no risk to a real account. Cons: a made-up login is
      "revoked", not "expired" (Claude reports both the same way, as
      `authentication_failed`); approving a sign-in still needs a person.
16. **Where to show Claude's turn-time notice as a card.**
    - Options: match Claude's 401 reply text in the transcript; pin the card
      while the backend's structured `auth` notice is up; lock the composer.
    - Chosen: pin on the notice, never lock, and skip it when a terminal auth
      error row after the last prompt already has the card.
    - Why: assistant prose must never activate sign-in UI (the existing rule
      in `claude-auth.ts`), and the notice is authoritative state that clears
      once a model answers.
    - Pros: one card, rehydrates after reload, no false positives. Cons: an
      older bridge without `authNotice` still shows no card for this case.
17. **How a locked Codex tab notices a login made elsewhere.**
    - Options: a backend poll for every Codex bridge; watch `auth.json`; have
      the visible locked tab re-read its account every 10 s.
    - Chosen: the visible tab re-reads.
    - Why: the existing account read already makes the bridge reload a stored
      login; only visible, locked tabs need it.
    - Pros: no new process-wide timer, no cost when unlocked or hidden. Cons:
      a hidden tab stays locked until shown (it reads again on activation).
18. **Where the Codex bridge keeps per-conversation state across accounts.**
    - Options: link the whole `orkestrator-bridge` into each account home as a
      shared entry; a state-directory override for the bookkeeping only;
      re-resolve sessions from the backend's tab records after a 404.
    - Chosen: the override (`CODEX_BRIDGE_STATE_DIR`), keeping the model cache
      and app-server pid file per login, and adopting an account's own earlier
      records on load (if absent, so a newer record or tombstone wins).
    - Why: conversations are shared across accounts but the model cache is
      per login, and moving the pid file would change the handover between
      the old and new bridge. Claude already keeps its state under HOME.
    - Pros: a switch keeps every tab; no change for a user without added
      accounts. Cons: one more environment variable; a record an account
      wrote before the change is adopted only when a bridge on that account
      next loads, so switching away right after upgrading can still lose an
      older tab's mapping once.
19. **Clearing a Codex thread's `auth` notice.**
    - Options: also on any `account/updated`; on a successful
      `account/login/completed`; on a bridge restart only.
    - Chosen: a successful login completion clears every thread's notice.
    - Why: `account/updated` also fires on a sign-out, and the notice locks
      the composer, so without this a `needs-auth` notice could only clear by
      restarting the bridge.
    - Pros: signing in from the banner unlocks the tab. Cons: a login made
      outside app-server (a terminal) does not clear an existing thread
      notice until the bridge restarts or a turn completes.
20. **The refused-login turn on Codex.**
    - Options: fix it here; record it.
    - Chosen: record it in [0235](0235-codex-refused-login-turn-invisible.md).
    - Why: the missing error row is in the transcript update path and may
      affect every provider; the notice for a 401 needs that row visible and
      a careful rule so the composer lock follows only a refused login.
    - Pros: this change stays about accounts and sign-in. Cons: a Codex user
      with a bad key still sees no error after the turn.

Assumptions:

- Claude reports an expired or revoked login on a turn as
  `error: "authentication_failed"` (seen with a missing login on Claude Code
  2.1.309, and with a made-up OAuth login on 2.1.310 on 2026-10-26; a
  genuinely expired token was not produced on this node).
- Codex 0.162 sends `modelProvider/authRecovery*` with `threadId` and a
  human-readable `message`, as the generated protocol types say.
- Pi's and OpenCode's `auth.json` keep one entry per provider id with a
  `type` field, as their bridges and `opencode-provider-login.ts` read them.

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
  and Cursor login drivers, Control MCP, the public API and the renderer, and
  extended on 2026-10-24 to the settings read (`agent-sign-in-status.test.ts`),
  the `authNotice` field and the cancel route. The rule and its guards are in
  [agent-accounts.md](../../architecture/agent-accounts.md#credentials-in-auth-answers).
  - Answers are allowlisted field by field, at the bridge and again in the
    backend, rather than redacted by pattern.
  - The URL and code go only to the client that asked. Logs never carry them,
    not even redacted.
  - Redaction runs where a log line is written: Codex `app.onError` and its
    account-read warnings, `open_in_browser`, and now every local bridge's
    forwarded output (`forwardBridgeOutput`).
  - The guard is permanent tests: canary credentials in each fake, a strict
    shape check of each answer, and capture of console and stdio
    (`tests/helpers/auth-secret-canaries.ts`, `tests/unit/auth-secret-guards.test.ts`).
  - Login progress (`get_agent_account_login`, `cursor_sdk_login_status`,
    `get_github_cli_login`) is one global value that any gateway client can
    read. That is accepted: the gateway credential already grants full
    control of the backend.

## Open questions

- ~~Should a replaced shared entry be reported in the accounts section, or
  re-linked when its content matches the host's?~~ Reported, not re-linked
  (decision 13).
- ~~Should the settings auth card replace the Cursor-specific sign-in component
  outright, or wrap it?~~ Wrap (decision 6).

## Needs verification

- **Usage windows after a switch.** The old multi-account plan listed "usage
  windows reported by a bridge still finishing a turn on the previous account
  are folded into the new account's card". The code gates folding on the
  reporting bridge's account: `contextUsageWithPlanUsage`
  (`plan-usage-cache.ts`) folds only when the connection's `accountId`
  (`LocalServerRuntime.launchedAccountId`, set at launch) matches the active account. Container
  bridges report `"unknown"`, so their windows never fold. Confirmed live for
  Codex on 2026-10-26 (see [Qualification](#qualification)): windows A's
  bridge reported during and after the switch never reached B's card. The
  gap as stated does not happen. What remains is the same run for Claude,
  whose turns reported no windows to fold (item 2 of
  [What is left](#what-is-left)).

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
- [0235-codex-refused-login-turn-invisible.md](0235-codex-refused-login-turn-invisible.md)
  (a Codex turn refused for its login shows no error or sign-in prompt; found
  by this file's qualification).

## Replaces

- `docs/plans/sdk-coverage/08-auth-and-account-status.md`
- `docs/plans/multi-account.md` (known gaps here; the design is now
  `docs/architecture/agent-accounts.md`)
- `docs/plans/sdk-coverage-2026-09-06.md` (§1 theme 2, Claude §3.4 `auth_status`,
  Codex §4.3 auth recovery, OpenCode §5.4, Grok §7.4, Pi §8.13, Tier 3 row 32's
  sign-in half)
