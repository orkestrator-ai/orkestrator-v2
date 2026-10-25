# Agent accounts across machines

Checked against `main` at `71227437` (2026-10-24), with both rounds of this
work applied on top; the third round (2026-10-25) was built on `ba7cc8d4`.

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
  only the machine that announced it, and the panel re-reads its own machine.
- A "By account" toggle groups the overview by email, with a switch where a
  machine has the login and a sign-in where it does not.
- The composer chip (`SessionAccountChip`) beside the model picker, since
  removed: the account controls live in the agent information panel only.
- Grok and Pi columns in the overview (`read_host_agent_sign_ins`) with "Sign
  in on <machine>" (`open_agent_sign_in_terminal`). This is a file and
  variable-name read on the backend, not the settings auth card of
  [0003](0003-agent-accounts-and-sign-in.md) item 3, which stays open.
- Cursor's sign-in opens its link in the client (`openBrowser: false`,
  `NO_OPEN_BROWSER`), from any machine.

Done on 2026-10-25, third round (the open questions and the verification
this machine can produce):

- **Preferred login.** A star on an email in the overview's "By account" view
  records the platform's preferred login (`set_preferred_agent_identity`,
  kept in the answering machine's `agent-accounts.json`, returned by
  `list_machine_agent_accounts`). A summary line per platform counts the
  machines on it and switches every machine that has it but uses another;
  by machine, a cell off it offers **Use preferred** or says **No preferred
  login**. Nothing switches by itself. See
  [Assumptions and decisions](#assumptions-and-decisions).
- **A leaf's own window** shows Settings → Machines → Agent accounts limited
  to itself, where it showed nothing before.
- `accountInfo()`, Cursor's `NO_OPEN_BROWSER` and Codex's access-only
  `auth.json` were checked; the evidence is under
  [Needs verification](#needs-verification).

How all of it works is in
[agent-accounts.md](../../architecture/agent-accounts.md#machines).

## Outstanding work

No code items remain. What is left is qualification, which needs two real
machines, and the MBP3 check below.

### Qualification

Batched with the two-machine runs in
[0031](../cross-cutting/0031-live-provider-and-platform-qualification.md):

- A leaf whose `~/.claude/.credentials.json` is stale beside a live Keychain
  login: a coordinator on the leaf answers.
- With no container running, a coordinator idle past its access token's
  expiry comes back on a refreshed token.
- From the command node, switch the leaf's Claude account in the overview, in
  Settings with the leaf chosen, and in a leaf tab's information panel. The
  next idle prompt runs on the new account, and the panel shows it. In the
  overview, include a preferred login: star an email both machines have,
  then **Use on 1 more machine** moves the leaf, and starring an email only
  the command node has shows the leaf as **No preferred login**.
- Add an account on the leaf from the command node's Settings, with the
  browser on the client machine. The same for Cursor's sign-in: no browser
  opens on the leaf's desktop.
- A Codex coordinator on an added account answers, its `auth.json` has an
  empty `refresh_token`, and the account's own Codex sessions keep working
  across the coordinator's lifetime.
- Switching an account on the leaf from its own Settings updates the command
  node's open overview within a second, and the leaf tab's information panel.
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

None. Both questions this file listed were decided and built on 2026-10-25;
see [Assumptions and decisions](#assumptions-and-decisions).

## Needs verification

- On the leaf that failed (MBP3): whether `~/.claude/.credentials.json` was
  older than the Keychain login, and why `claude auth login` exited 1 there.
  The new failure message should now name the reason; a locked login keychain
  under a LaunchAgent started from SSH is the likely one. **Still open:** it
  needs MBP3 itself; nothing on another machine can show its Keychain or its
  file dates.
- ~~Whether `accountInfo()` in the pinned Claude Agent SDK returns an
  email.~~ **Done 2026-10-25.** With SDK 0.3.309 and this Mac's host OAuth
  login, `query(...).accountInfo()` returned `email` (an address),
  `organization`, `subscriptionType: "Claude Max"` and `apiProvider:
  "firstParty"`; no `tokenSource` or `apiKeySource`. Only the field names and
  the non-identifying values were printed. The panel keeps taking the email
  from the account registry, which has it before any session starts, so
  nothing changed.
- ~~That the pinned Cursor SDK still skips its browser launch under
  `NO_OPEN_BROWSER`.~~ **Done 2026-10-25.** `Cursor.auth.login` in 1.0.40
  spawns the opener only when `!process.env.NO_OPEN_BROWSER` and no
  `SSH_CONNECTION`/`SSH_CLIENT`/`SSH_TTY` is set, and publishes the URL
  first. `bridges/cursor-bridge/src/login-no-open-browser.test.ts` now runs
  the real SDK with a fake `open`/`xdg-open` first on `PATH` and a closed
  local backend: without the variable the fake opener runs (the control),
  with `NO_OPEN_BROWSER=1` it does not, and the URL is published both times.
- ~~That the pinned Codex accepts an access-only `auth.json` in a local
  coordinator home.~~ **Done 2026-10-25, offline.**
  `scripts/codex-access-only-auth-probe.ts` against the pinned
  `codex-cli 0.164.0`, with a synthetic login reduced by
  `restrictCodexAuthSnapshot` and a local server standing in for ChatGPT and
  the token endpoint:
  - the coordinator form (token three days from expiry): `codex login status`
    says "Logged in using ChatGPT", every backend request carries the access
    token, no refresh is attempted, and the file is unchanged;
  - the same with `last_refresh` nine days old: still no refresh. 0.164
    decides on the access token's `exp` (refresh within five minutes of it)
    and uses `last_refresh` only for a token without a readable `exp`
    (`proactive_refresh_reason` in `codex-rs/login/src/auth/manager.rs` at
    `rust-v0.164.0`). The comment on `restrictCodexAuthSnapshot` said eight
    days and was corrected;
  - a token three minutes from expiry (the positive control) and a 401 from
    the backend: Codex tries the refresh with an empty `refresh_token`, the
    attempt fails, and the file keeps its blank token.

  The run stops at Codex's workspace routing discovery, which needs a real
  ChatGPT backend, so no model turn ran. A real coordinator turn on an added
  account stays in the Qualification item above.

## Assumptions and decisions

### Preferred login across machines

- **Options.** (a) Do nothing: the "By account" view already shows which
  machines have which login. (b) The question's form: an inherited
  preference the command node hands down, and each leaf activates its own
  account with that email by itself. (c) A preference kept by the machine
  answering the overview that only flags machines and offers an explicit
  switch, here or for every machine at once.
- **Choice.** (c).
- **Why.** Switching is the one account action that changes which
  subscription pays for a machine's next prompt. A leaf that switched by
  itself (on attach, on a new login, on a settings sync) would do it while
  nobody is looking at it, and a sync that arrives late or out of order
  could move it back. One click on "Use on N more machines" gets the same
  result with the user present. Keeping it in `agent-accounts.json` rather
  than the global config avoids the renderer's whole-config write dropping a
  key no settings form edits (the reason the account registry lives there).
- **Pros.** No credential and not even the email leaves the machine; no
  surprise switches; works with leaves on older builds (only the command
  node needs the new command); a cell says at a glance which machines are
  off the preferred login and which cannot use it.
- **Cons.** A new leaf does not move onto the preferred login until someone
  presses the switch; the preference is not live across two open clients
  (it shows on the next full read); a login without an email cannot be
  preferred; a leaf's own window does not see the command node's
  preference.

### The overview in a leaf's own window

- **Options.** Keep hiding it in leaf mode; show the full fleet through the
  command node; show the leaf alone.
- **Choice.** Show the leaf alone (`selfOnly`).
- **Why.** The backend already answers `list_machine_agent_accounts` with
  only itself in leaf mode, and the leaf's own logins are its own to switch.
  The fleet belongs to the command node's window.
- **Pros.** The leaf's accounts are visible and switchable on the Machines
  page without opening its settings dialog; no new command.
- **Cons.** It repeats the row the leaf's settings dialog already shows.

### Verification method

- **Options** for the Codex question: a real login copied into a scratch
  home, or a synthetic login against a local server.
- **Choice.** Synthetic, reduced by the product's own
  `restrictCodexAuthSnapshot`, plus the 0.164.0 source.
- **Why.** It handles no real credential, needs no account, and the
  near-expiry case proves the harness sees a refresh when Codex makes one.
- **Cons.** It cannot reach a model turn (workspace routing needs the real
  backend), so a real coordinator turn stays a qualification item.

## Related

- [0003-agent-accounts-and-sign-in.md](0003-agent-accounts-and-sign-in.md)
- [agent-accounts.md](../../architecture/agent-accounts.md),
  [command-nodes.md](../../architecture/command-nodes.md),
  [coordinator.md](../../architecture/coordinator.md)
