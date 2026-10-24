# Agent accounts across machines

Checked against `main` at `71227437` (2026-10-24), with both rounds of this
work applied on top.

The goal is to see and change which agent login each machine uses, from
wherever the user is working. How it works now is in
[agent-accounts.md](../../architecture/agent-accounts.md#machines); this file
keeps only what is left.

## Current state

Done on 2026-10-24, first round:

- Claude coordinators never receive a credential file or a refresh token:
  `applyCoordinatorClaudeAccount` hands over the active login's access token
  only, refreshes a lapsed login first, and removes a Keychain entry an
  earlier build left under the coordinator home. `ContainerClaudeLoginKeeper`
  keeps the login refreshed while a coordinator runs on a handed-over token.
  This was the cause of a leaf coordinator's "OAuth session expired and could
  not be refreshed": the copied `~/.claude/.credentials.json` was stale beside
  the Keychain login.
- A failed `claude auth login` / `codex login` names the CLI's reason
  (`loginFailureMessage`) instead of only `exit code 1`.
- Claude's auth status reports `expired` after a turn failed authentication
  while a credential is still present.
- `get_native_agent_session_account` and the agent information panel's
  account card: which account the session runs on, a pending move, a
  machine-wide switch, and signing in again.
- A "Sign-ins on" machine picker over every Settings sign-in section (Claude
  and Codex accounts, OpenCode providers, Cursor, GitHub CLI), defaulting to
  the machine on screen.
- `list_machine_agent_accounts` and Settings → Machines → Agent accounts: every
  machine against Claude and Codex, with a switch per cell; the same row in
  each machine's settings dialog.

Done on 2026-10-24, second round (every code item this file listed):

- Codex coordinators receive an access-only `auth.json`
  (`coordinatorCodexLogin`, the container form), with the access token's
  expiry recorded and loginless launches retried, as for Claude. The
  `chatgptAuthTokens` handoff was not used because it needs `experimentalApi`;
  writing a refreshed login back was not used because two refreshers of one
  rotating token can still race.
- `agent-accounts-changed` on every account change; the overview re-reads
  only the machine that announced it, and the panel and composer chip re-read
  their own machine.
- A "By account" toggle groups the overview by email, with a switch where a
  machine has the login and a sign-in where it does not.
- The composer chip (`SessionAccountChip`) beside the model picker.
- Grok and Pi columns in the overview (`read_host_agent_sign_ins`) with "Sign
  in on <machine>" (`open_agent_sign_in_terminal`). This is a file and
  variable-name read on the backend, not the settings auth card of
  [0003](0003-agent-accounts-and-sign-in.md) item 3, which stays open.
- Cursor's sign-in opens its link in the client (`openBrowser: false`,
  `NO_OPEN_BROWSER`), from any machine.

How all of it works is in
[agent-accounts.md](../../architecture/agent-accounts.md#machines).

## Outstanding work

No code items remain. What is left is qualification and the open questions
below.

### Qualification

Batched with the two-machine runs in
[0031](../cross-cutting/0031-live-provider-and-platform-qualification.md):

- A leaf whose `~/.claude/.credentials.json` is stale beside a live Keychain
  login: a coordinator on the leaf answers.
- With no container running, a coordinator idle past its access token's
  expiry comes back on a refreshed token.
- From the command node, switch the leaf's Claude account in the overview, in
  Settings with the leaf chosen, and in a leaf tab's information panel. The
  next idle prompt runs on the new account, and the panel shows it.
- Add an account on the leaf from the command node's Settings, with the
  browser on the client machine. The same for Cursor's sign-in: no browser
  opens on the leaf's desktop.
- A Codex coordinator on an added account answers, its `auth.json` has an
  empty `refresh_token`, and the account's own Codex sessions keep working
  across the coordinator's lifetime.
- Switching an account on the leaf from its own Settings updates the command
  node's open overview within a second, and the leaf tab's composer chip.
- "Sign in on <leaf>" for Grok opens `grok login` in a local environment's
  terminal on the leaf, and the window shows that environment.
- A sign-in on a leaf whose login keychain is locked names the keychain.

## Constraints and rationale

- **Credentials never cross machines.** Lending the command node's login to a
  leaf was considered and rejected: the leaf cannot renew a lent token, and the
  command node would have to keep pushing credentials between machines.
- **Switching stays machine-wide per platform.** Bridge keys, plan-usage
  folding and Keychain naming rely on one account per platform per machine,
  so per-project accounts are out of scope.
- **Never copy a refresh token,** including into a coordinator home.
- **Switching never kills work,** and login URLs, codes and CLI output are
  never logged.

## Open questions

- Should the command node keep a **preferred identity** per platform (for
  example "Claude: work@x.com") as an inherited preference, so each leaf
  activates its own account with that email and the overview flags machines
  not signed in to it? Only the email would travel, never a credential.
- Should a leaf's own window, with a leaf as the target, show the overview
  limited to itself?

## Needs verification

- On the leaf that failed (MBP3): whether `~/.claude/.credentials.json` was
  older than the Keychain login, and why `claude auth login` exited 1 there.
  The new failure message should now name the reason; a locked login keychain
  under a LaunchAgent started from SSH is the likely one.
- Whether `accountInfo()` in the pinned Claude Agent SDK returns an email.
  Today the panel takes the email from the account registry.
- That the pinned Cursor SDK still skips its browser launch under
  `NO_OPEN_BROWSER` (`bridges/cursor-bridge/src/login-cli.ts` says it does;
  the backend test only checks that the variable is set).
- That the pinned Codex accepts an access-only `auth.json` in a local
  coordinator home as it does in containers (checked live there on
  2026-10-21 with 0.162), and reads its blanked `refresh_token` without
  attempting a refresh before the access token expires.

## Related

- [0003-agent-accounts-and-sign-in.md](0003-agent-accounts-and-sign-in.md)
- [agent-accounts.md](../../architecture/agent-accounts.md),
  [command-nodes.md](../../architecture/command-nodes.md),
  [coordinator.md](../../architecture/coordinator.md)
