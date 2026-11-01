# Agent accounts across machines

Checked against `main` at `71227437` (2026-10-24), with both rounds of this
work applied on top; the third round (2026-10-25) was built on `ba7cc8d4`.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Claude coordinator credential handoff on a leaf**: a coordinator on a leaf with a stale credential file answers, and one idle past its token's expiry comes back refreshed. Status: open.
2. **Cross-machine switching and preferred login**: switch the leaf's Claude account from the overview, Settings and the information panel, and exercise the preferred-login star. Status: open.
3. **Remote sign-ins from the command node**: add a Claude or Codex account, Cursor sign-in, Grok "Sign in on <leaf>", and a locked-keychain failure, all driven from the command node. Status: open.
4. **Codex coordinator on an added account**: a real turn on an access-only `auth.json`, without breaking the account's own sessions. Status: open.
5. **Change propagation**: a switch on the leaf reaches the command node's open overview and the leaf tab's panel within a second. Status: open.
6. **MBP3 credential diagnosis**: on MBP3, compare `~/.claude/.credentials.json` with the Keychain login and find why `claude auth login` exited 1. Status: open.

All six are live runs; no code item remains, and every symbol the file names still exists at `863b5782`. The only code change since the file was written is `fb1700b5` (#1295, todo 0003's qualification), which touched `apps/backend/src/core/agent-accounts-active.ts` but none of the behaviour below.

### 1. Claude coordinator credential handoff on a leaf

**Problem.** The original failure ("OAuth session expired and could not be refreshed") was on a leaf. The fix has been unit-tested but never shown on a real leaf with a real Keychain login.

**Context.** First-round fix: coordinators get the access token only, and a keeper refreshes the login. Constraint: never copy a refresh token.

**Investigation.** `applyCoordinatorClaudeAccount` is at `apps/backend/src/core/agent-accounts-active.ts:373`, called from `apps/backend/src/core/commands-servers.ts:136`. The keeper is `ContainerClaudeLoginKeeper` (`apps/backend/src/core/container-claude-login-keeper.ts:109`), with `refreshHostIfDue` at `:216` and `refreshLocalLoginIfDue` at `:226`, wired through `setLocalClaudeLoginRefresher` (`apps/backend/src/core/agent-accounts-active.ts:280-290`). The file says these runs are batched in [0031](../cross-cutting/0031-live-provider-and-platform-qualification.md), but 0031's "Two machines or a remote backend" row (`docs/todo/cross-cutting/0031-live-provider-and-platform-qualification.md:199`) does not list this file, so the batching link is one-way and a person working from 0031 would miss these runs. Todo 0003's qualification already ran on MBP3 as a node (see `0003-agent-accounts-and-sign-in.md` header), so a two-machine set-up has been available.

**Decisions.**

- **Where are these runs tracked?**
  - **Add this file to 0031's two-machine row (recommended).** One edit to 0031 (outside this task's scope here; for whoever owns 0031).
    - Pros: matches what this file claims; the two-machine batch is planned from 0031.
    - Cons: touches another file.
  - **Leave tracking here only.**
    - Pros: no cross-file edit.
    - Cons: the runs stay invisible to anyone batching from 0031.
- **How to make the credential file stale?**
  - **Use a disposable account directory on the leaf, not the default login (recommended).** Sign a throwaway login in, back-date or replace its `.credentials.json`, and leave the Keychain entry live.
    - Pros: never risks signing the user's real login out; mirrors how 0003 used throwaway Keychain entries.
    - Cons: an added account's hashed Keychain service differs from the default login's, so it is a close, not exact, reproduction.
  - **Use the leaf's real default login.**
    - Pros: exact reproduction of the original failure.
    - Cons: a mistake can sign the user out on that machine.

### 2. Cross-machine switching and preferred login

**Problem.** Switching another machine's account and the preferred-login controls have never run across two real machines.

**Context.** Second- and third-round work; decision "Preferred login across machines" chose option (c), an explicit switch with nothing automatic.

**Investigation.** Commands are registered in `apps/backend/src/core/commands-registry-accounts.ts` (`list_machine_agent_accounts` at `:70`, `set_preferred_agent_identity` at `:75`, `get_native_agent_session_account` at `:104`). "No preferred login" is rendered at `apps/web/src/components/settings/machines/MachineAgentAccountsSection.tsx:189`. The composer chip `SessionAccountChip` is gone from the tree, as the file says.

**Decisions.**

- **What counts as a pass for "the next idle prompt runs on the new account"?**
  - **The information panel's account card and the provider's own account read agree after the prompt (recommended).**
    - Pros: checks the product's claim and the provider's view; no prompt content needed.
    - Cons: needs two accounts with distinguishable emails.
  - **The panel alone.**
    - Pros: quicker.
    - Cons: the panel reads the registry, so it can show the new account while the bridge still runs the old one.

### 3. Remote sign-ins from the command node

**Problem.** Adding an account, signing in to Cursor and Grok, and the locked-keychain message have not been shown on a leaf driven from another machine.

**Context.** The browser must open on the client, not on the leaf's desktop. Login URLs and codes must never be logged.

**Investigation.** The CLI browser shim is `ensureBrowserShim` (`apps/backend/src/core/agent-accounts-login.ts:132`). Cursor's sign-in sets `NO_OPEN_BROWSER` when `openBrowser` is false (`apps/backend/src/core/cursor-sdk-bridge.ts:187`), and the SDK side is proved offline by `bridges/cursor-bridge/src/login-no-open-browser.test.ts` against the still-pinned `@cursor/sdk` 1.0.40 (`bridges/cursor-bridge/package.json:15`). The locked-keychain hint is in `loginFailureMessage` (`apps/backend/src/core/agent-accounts-login.ts:107-115`): it matches any failure reason containing "keychain". Grok's sign-in terminal is `open_agent_sign_in_terminal` (`apps/backend/src/core/commands-registry-accounts.ts:89`).

**Decisions.**

- **How to reproduce a locked keychain?**
  - **Start the leaf's backend from an SSH session without unlocking the login keychain (recommended).**
    - Pros: matches the suspected MBP3 cause (task 6).
    - Cons: needs physical or screen access afterwards to unlock it again.
  - **Lock the keychain explicitly on a running leaf.**
    - Pros: simple and reversible.
    - Cons: may produce a different CLI error text from the LaunchAgent case, so the hint's match is tested on the wrong string.

### 4. Codex coordinator on an added account

**Problem.** The access-only `auth.json` was proved offline only; the run stopped at workspace routing discovery, so no model turn ran.

**Context.** Decision "Verification method" left the real turn here. Codex is pinned at 0.164.0 (`packages/toolchain/src/manifest.ts:8`), the version the offline probe used, so the probe's evidence still applies.

**Investigation.** `coordinatorCodexLogin` is at `apps/backend/src/core/agent-accounts-active.ts:450`, built on `restrictCodexAuthSnapshot`. The probe is `scripts/codex-access-only-auth-probe.ts`. This run needs only one machine with an added Codex account, not two.

**Decisions.**

- **Run it on one machine now, or wait for the two-machine batch?**
  - **One machine, now (recommended).** An isolated `dev:test` profile with an added Codex account.
    - Pros: not blocked on a second machine; closes the last gap in the offline evidence.
    - Cons: one more live session spent on a real account.
  - **With the two-machine batch.**
    - Pros: one scheduling effort for everything.
    - Cons: delays a check that has nothing to do with two machines.

### 5. Change propagation

**Problem.** The "within a second" claim for the command node's overview is unmeasured.

**Context.** Each account change emits `agent-accounts-changed`; the overview re-reads only the machine that announced it.

**Investigation.** The event constant is at `packages/protocol/src/agent-accounts.ts:190`, emitted at `apps/backend/src/core/agent-accounts.ts:90-92`, and subscribed at `apps/web/src/components/settings/machines/MachineAgentAccountsSection.tsx:719`.

**Decisions.**

- **What counts as a pass?**
  - **The overview updates without a reload, timed roughly by eye; under a few seconds passes (recommended).**
    - Pros: tests what a user notices; no instrumentation.
    - Cons: not a precise measurement.
  - **Measure the relay latency with timestamps.**
    - Pros: a real number.
    - Cons: needs instrumentation that is not there and must not log account data.

### 6. MBP3 credential diagnosis

**Problem.** The root cause on MBP3 (a stale file, and why `claude auth login` exited 1) is still a guess.

**Context.** Only MBP3 can answer it; the likely cause is a locked login keychain under a LaunchAgent started from SSH.

**Investigation.** Nothing in the code can answer this. MBP3 has since served as a node for todo 0003's qualification (`fb1700b5`), so it is reachable. The failure message now names the CLI's reason (`apps/backend/src/core/agent-accounts-login.ts:107`), so a fresh sign-in attempt there would say why it fails.

**Decisions.**

- **Investigate or retire?**
  - **Run a read-only check on MBP3 (recommended).** Compare the credential file's modification time with the Keychain item's metadata (no secret read), and retry a sign-in to read the new failure message.
    - Pros: cheap now that MBP3 is reachable; confirms or refutes the keychain hypothesis that task 3 tests.
    - Cons: the original state may already have changed since 2026-10-24, so it may prove nothing.
  - **Retire it as superseded by tasks 1 and 3.**
    - Pros: no further work.
    - Cons: the original cause stays unknown.

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
  login**. The preferred login switches nothing by itself. See
  [Assumptions and decisions](#assumptions-and-decisions). Updated 2026-11-01:
  [automatic switching](../../architecture/agent-accounts.md#automatic-switching)
  is an explicit opt-in exception to "nothing switches by itself" for the machine
  as a whole. It follows reset times, not this preference, which still moves
  nothing. See [1250](1250-automatic-account-switching-live-checks.md).
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
- **Choice.** (c). Still so for the preferred login. On 2026-11-01 the user chose
  [automatic switching](1250-automatic-account-switching-live-checks.md) as an
  explicit opt-in exception to "nothing switches by itself": off by default, ticked
  per provider, following weekly reset times rather than this preference, and
  turned off by any manual switch. The reasons below still apply to the preference.
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
