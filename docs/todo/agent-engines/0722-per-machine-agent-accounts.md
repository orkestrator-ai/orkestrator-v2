# Agent accounts across machines

Checked against `main` at `8454d18b` (2026-10-24), with the first round of
this work applied on top.

The goal is to see and change which agent login each machine uses, from
wherever the user is working. How it works now is in
[agent-accounts.md](../../architecture/agent-accounts.md#machines); this file
keeps only what is left.

## Current state

Done on 2026-10-24:

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

## Outstanding work

### Code

1. **Codex coordinators still copy a refresh token.**
   `prepareCoordinatorCodexHome` (`commands-servers.ts`) copies the account's
   `auth.json` whole into the coordinator's private `CODEX_HOME`. When the
   coordinator's Codex refreshes, it rotates the refresh token away from the
   account's own login, which then fails on its next refresh. Decide between
   an access-only handoff (only if app-server accepts one without
   `experimentalApi`), writing a refreshed coordinator login back to the
   account under a lock, or refreshing on the account's side and replacing an
   idle coordinator, as Claude does.
2. **Live updates for the overview.** The overview and the panel re-read on
   open and on refresh. Have each node emit an `agent-accounts.changed` event
   (switch, renewal, add, remove), and have the overview watch it through
   `watch_node_events`. The event triggers a re-read; it never carries the
   state.
3. **Group the overview by identity.** Add a toggle that groups the overview
   by email ("work@x.com: MBP3, Studio; VPS not signed in"), with a sign-in on
   each machine missing it.
4. **Composer chip.** Beside the model picker, show the session's account
   (for example `work@…`) when its machine has more than one account for the
   platform, or when the session is not on the active account. It opens the
   information panel.
5. **Grok and Pi in the overview.** Show their sign-in state read-only, with
   "Sign in on <machine>" opening a terminal tab on that machine with the
   fixed login command. This needs the session-free auth read from
   [0003](0003-agent-accounts-and-sign-in.md) item 3.
6. **Cursor's sign-in on another machine.** The Cursor SDK login opens a
   browser on the backend's own desktop. From another machine the panel's
   copy-link button is the only way in. Open the link in the client instead,
   as the Claude and Codex sign-ins do.

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
  browser on the client machine.
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

## Related

- [0003-agent-accounts-and-sign-in.md](0003-agent-accounts-and-sign-in.md)
- [agent-accounts.md](../../architecture/agent-accounts.md),
  [command-nodes.md](../../architecture/command-nodes.md),
  [coordinator.md](../../architecture/coordinator.md)
