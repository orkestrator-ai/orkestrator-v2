# Orkestrator-owned "always allow" rules that can be listed and removed

Worked on `feature-clarification-18cad6211bd8-r1` from `727f91c8` (2026-10-27)
and landed as `3d707ddd` (#1348). All five phases are built and tested. Left:
live card runs on real provider logins (Needs verification). The durable
description is [`permission-rules.md`](../../architecture/permission-rules.md).
A worker pass on `todo-0723-permission-rules-3c724e19dfa9` (2026-10-30)
settled everything that needs no login or billed turn: task 6 is done from the
pinned Claude binary, task 4's command shape is confirmed from the pinned
OpenCode binary, and task 5's panel and inactive path are covered by fixture
tests. The live runs moved to the manual-test checklist (7568) on
2026-11-10; their exact steps stay under Outstanding work.

Follows [0001](0001-agent-interactions-and-permissions.md) decision 1 (Claude
offers no "always allow" option) and
0160 (Codex's "Approve with
command/network policy" options were removed). Both would have saved rules in
the provider's own files, which Orkestrator cannot reliably list or remove.
The standing constraint was: no "always allow" option ships without a way to
list and remove what it saved, and no provider rules file is ever rewritten
without a documented format or an API for it.

## Task analysis

Analysed 2026-10-30 against `main` at `cd7bbe3e` (first analysed 2026-10-28
at `79f3bc97`).

Every code item is done on `main` (`3d707ddd`, #1348) and is not repeated as a
task; the proof is listed under Current state. Between `79f3bc97` and
`cd7bbe3e` nothing changed the rule store, the enforcer, the readers, the
protocol module, the card or the panel. Five commits touched nearby files
without changing rule eligibility:
- `3fa7d173` (#1436): the ACP workflow-result option and Pi's read-only gate
  for granted MCP tools;
- `3afb6f73` (#1435), `d2b7932c` (#1446) and `e62f056e` (#1431): the
  `AgentNativeTab` controller and its tests;
- `f2d21713` (#1447): the bridge package version only.

The pinned versions are unchanged (Claude Code `2.1.309`, Agent SDK
`0.3.309`, Codex `0.164.0`, Grok `1.0.67`, OpenCode `1.19.4`, Pi `1.4.0`).
What was left is qualification on real logins (tasks 1 to 5, moved to 7568 on 2026-11-10) and task 7.

### Tasks

6. **Claude Bash suggestion shape**: the `canUseTool` `suggestions` value for `Bash` on the pinned SDK. Status: done (read from the pinned Claude Code 2.1.309 binary, which writes `prefix *`; the bridge now parses it. Seeing the preselection live is part of the Claude card run in 7568).
7. **Codex managed-network card in the app**: on an administrator-managed host, the card reads "Approve network access", is enabled and offers no amendment. Moved from to-do 0160 (deleted 2026-11-06). Status: open (needs a disposable managed host).

### 6. Claude Bash suggestion shape

**Problem.** The card preselects the Claude-proposed prefix, read from
`canUseTool` `suggestions`. The bridge expects an `addRules` entry for `Bash`
whose `ruleContent` ends in `:*`.

**Context.** Only the preselection depends on it. A different shape means no
preselection, never a wrong answer.

**Investigation.** The SDK types on `0.3.309` match the parser:
`suggestions?: PermissionUpdate[]`
(`bridges/claude-bridge/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:239`),
`PermissionRuleValue = { toolName; ruleContent? }` (`:2584-2587`) and the
`addRules` member of `PermissionUpdate` (`:2589-2593`). `proposedBashPrefix`
(`session-manager-parked-interactions.ts:171-201`) strips a trailing `:*`.
The `:*` suffix itself is a runtime value the types do not fix; the test
fixture used `"npm run test:*"`.

On 2026-10-30 the pinned Claude Code `2.1.309` binary (the one the SDK runs,
from the managed toolchain) was searched. The Bash tool's permission check
returns `suggestions` from one function:
- `` ruleContent: `${prefix} *` `` (space, star) for a heredoc's or
  multi-line command's leading words, an extracted command prefix, or the
  model-detected `commandPrefix`;
- otherwise `ruleContent: command`, the exact command with no suffix.

Every suggestion is `{ type: "addRules", behavior: "allow", destination:
"localSettings" }`. A compound command's subcommands can share one `addRules`
entry. The legacy `prefix:*` form is only parsed, never suggested. The CLI
sends this list as `permission_suggestions`, and the SDK passes it to
`canUseTool` as `suggestions` (`sdk.mjs`). So the bridge's `:*`-only parser
gave the card no Claude preselection on 2.1.309: the trailing `*` stayed a
word, the proposal matched no offered pattern, and the card fell back to the
narrowest pattern. `proposedBashPrefix` now strips either suffix and drops a
suggestion with any other `*`.

**Decisions.**

- **If the live value differs?**
  - **Adapt `proposedBashPrefix` to the observed form during task 1
    (recommended).**
    - Pros: keeps the preselection; cheap.
    - Cons: one more format to parse.
  - **Drop the Claude preselection.**
    - Pros: less code.
    - Cons: the card loses a useful default for Claude only.

### 7. Codex managed-network card in the app

**Problem.** Codex raises a managed-network approval only when
`/etc/codex/requirements.toml` enables its network proxy. No one has looked at
that card in the app. It should offer "Approve network access" with no
"Approve with network policy" amendment, so Orkestrator saves no rule it
cannot list or revoke.

**Context.** Moved from to-do 0160 (deleted 2026-11-06), whose tasks 1 to 3
were done on Codex 0.166.0. The bridge never sends an amendment
(`bridges/codex-bridge/src/app-server/approvals.ts`). The backend labels a
host-only card "Approve network access" and drops amendments from an older
bridge (`apps/backend/src/core/http-bridge/interactions.ts`). The payload is
proved through the bridge's engine in a container
(`mise run verify:codex:network-approval`), the mapping by a unit test, and a
real command card by `e2e/agent-testing/codex-saved-rules-live.spec.ts`.

**Investigation.** Steps:

1. On a disposable Linux VM or container host, never a real workstation, start
   a `dev:test` profile with the pinned Codex and an isolated `CODEX_HOME`. A
   made-up key and a loopback model, as in `codex-saved-rules-live.spec.ts`,
   are enough.
2. Write `/etc/codex/requirements.toml` with `[network_proxy] enabled = true`.
3. In an Ask session, have Codex reach a host that is not allowed, for example
   `curl http://probe-host.example.test`.
4. Check that the card's "Approve network access" is enabled, that Deny,
   Cancel turn, Approve for session and "Approve and remember…" are offered,
   and that there is no "Approve with network policy".
5. Approve. Check that the request goes through and that the profile's
   `CODEX_HOME/rules/` stays empty.

**Decisions.**

- **Where to run it?**
  - **A disposable VM or container host (recommended).**
    - Pros: writing `/etc/codex/requirements.toml` cannot affect a real Codex
      install; a made-up key keeps it free.
    - Cons: one more host to prepare.
  - **Leave it to the first user on a managed host.**
    - Pros: no work now.
    - Cons: a broken card would be found by a user; both the bridge and the
      backend already refuse amendments, so the risk is the label only.

## Current state

- Protocol: `packages/protocol/src/permission-rules.ts` holds the rule model,
  validators, the shell parser, the matcher, offers and the external-rule
  types. `AgentInteractionPresentation.ruleOffer` is in the contract and its
  validators. `resource-events.ts` has the `permission-rule` kind, and the
  public actions `permission.rule.list` and `permission.rule.remove` are
  catalogued.
- Backend: `apps/backend/src/core/permission-rules/` holds the store (two
  database record stores, the application record doubling as the
  at-most-once claim), the payload readers per bridge, the enforcer and the
  external-rule reader.
  - The enforcer is wired into the activity sweep (`applyPermissionRules`, so
    rules apply with no tab mounted and before the waiting edge) and into
    both projection reads.
  - Commands live in `commands-registry-permission-rules.ts`.
  - Public actions live in `public-api/actions-permission-rules.ts`.
  - Environment deletion and project removal clean up.
- Bridges mark `ruleEligible` only on exact detail:
  - Codex (`approvals.ts`) also forwards `proposedCommandPrefix`.
  - Claude (`session-manager-parked-interactions.ts`) also forwards
    `proposedCommandPrefix` from `canUseTool` `addRules` and `networkHost` for
    `WebFetch`.
  - Pi (`interactions.ts`).
  - ACP/Grok (`acp-session.ts`).
  - OpenCode needs no bridge change: its reader uses `metadata.command` and
    `metadata.filepath`.
- Web:
  - The card's "Approve and remember…" uses `RememberRulePanel`.
  - Settings → Permissions (`PermissionsSettings.tsx`) holds Orkestrator rules
    by project, with removal, and the read-only "Rules outside Orkestrator".
  - Agent information has `AgentInfoPermissionRules`.
  - The transcript note is `PermissionRuleNote`, placed by
    `withPermissionRuleRows` and driven by `usePermissionRuleSession`.
- CLI: `orkestrator permissions rules list|remove`.
- Proof:
  - Protocol: `permission-rules.test.ts`, a hostile command and path corpus
    (105 tests; 92 was a miscount).
  - Backend `permission-rules/*.test.ts`:
    - the store;
    - the enforcer: automatic answer, removal taking effect at once,
      at-most-once under racing reads, provider failure not retried, store
      failure asks, every policy precedence case, non-actionable,
      approve-and-remember refusals;
    - the payload readers and the real adapters;
    - the activity sweep answering with no tab mounted, with no waiting edge;
    - the sweep with two environments (a rule scoped to the one not on
      screen) and with a matched plus an unmatched request (2026-10-30);
    - OpenCode 1.19.4's own `bash` and multi-file patch payloads
      (2026-10-30);
    - the external files.
  - `public-api-permission-rules.test.ts`.
  - Bridge tests: Codex `approvals.test.ts`, Pi `interactions.test.ts`, ACP
    `acp-permission-detail.test.ts`, Claude
    `session-manager-parked-interactions.test.ts` (with Claude Code
    2.1.309's `prefix *` suggestion and the legacy `prefix:*`, 2026-10-30).
  - Web: `NativeAgentInteractionCard.test.tsx`, `PermissionsSettings.test.tsx`,
    `permission-rule-rows.test.ts`, `usePermissionRuleSession.test.tsx`
    (2026-10-30).
  - Fixture browser run: `e2e/RememberRulePanel.spec.ts`, the panel on Codex
    cards at phone and desktop widths (2026-10-30, 8 passed).
  - Live, credit-free, against the pinned Codex 0.164.0 with a loopback model
    and a throwaway `CODEX_HOME` (2026-10-27), in
    `live-policy-amendment.test.ts`:
    - Codex sends `/bin/zsh -lc 'touch …'` and the matcher unwraps it to
      `["touch", …]`.
    - The approvals went person, then rule, then person once the rule was
      removed.
    - Codex asked all three times and `CODEX_HOME/rules/` stayed empty.
  - Browser: `e2e/agent-testing/permission-rules.spec.ts` passed on an
    isolated `dev:test --fixture --no-agent-credentials` profile
    (2026-10-27). A rule staged in the profile's database is listed in
    Settings → Permissions, removed from the page, and gone from the store.
  - Full suite (`mise run test`, 2026-10-27): every suite this change reaches
    passed. The remaining failures fail the same on the base commit or pass
    alone; they are recorded, with base reruns, in flake case
    [1171](../../tests/flaky-tests/aggregate-validation-runs/1171-orkestrator-permission-rules-0723-validation.md).

## Outstanding work

### Code

None.

### Qualification

- The Codex managed-network card on a disposable managed host (task 7).
- The live card runs on real logins (tasks 1 to 5: Claude, Pi, Grok,
  OpenCode, and Codex with its inactive-environment check) moved to 7568 on
  2026-11-10. The backend sweep, the returning tab's read and the panel are
  tested without a login; OpenCode's plain-command shape is confirmed from
  the pinned 1.19.4 binary.

### Live run steps

Moved with tasks 1 to 5 to the
[manual-test checklist](../manual-test/7568-manual-test-checklist.md)
("Permission-rule card runs (0723 tasks 1 to 5)") on 2026-11-10. Results are
recorded here, in a dated "Live card runs" section after Current state, one
line per provider.

## Constraints and rationale

### Brief

Orkestrator keeps its own rules and applies them itself, never in a
provider's files. When a provider asks for approval, the backend checks its
rule store first. On a match it answers with plain allow-once (Codex
`accept`, Claude `allow`, and so on) and adds a transcript note "Approved by
rule …". Every answer on the wire is allow-once, so removing a rule takes
effect at once. Rules behave the same for every provider, need no provider
API, and survive provider upgrades. The safety requirements (fail closed,
conservative matching, never widening the execution policy, no sensitive data
in logs, unchanged deny on timeout and disconnect) are the brief's and are
kept as written in the architecture doc.

### Decisions

1. **Scopes: project and environment only.** There is no host-wide scope. A
   new rule defaults to "this project". An environment rule is deleted with
   its environment.
2. **Expiry: until removed by default.** The card offers 1, 7 or 30 days.
   Settings shows the last use and use count, so stale rules are visible.
3. **Per machine.** The backend that owns a session owns its rules, like
   agent accounts (0722); nothing syncs to other nodes. Settings follows the
   machine chosen in its header.
4. **Provider: the asking agent by default.** "Also for other agents" saves a
   rule for `any`.
5. **Shell wrappers.** Exactly one `sh|bash|zsh|… -c|-lc '<script>'` layer is
   unwrapped, and only when the script is one plain command. Real Codex sends
   exactly this shape; without the unwrap, no Codex command rule would ever
   match.
6. **Prefix limits.**
   - A command rule needs at least two words.
   - It may never name a wrapper (`sudo`, `env`, shells, `xargs`, `find`,
     `sed`, `awk`, `ssh`, `rsync`, `timeout`, …).
   - An interpreter or runner (`python`, `node`, `bun`, `npx`, `git`,
     `docker`, …) may not be followed by an option.
   - Words must be plain tokens.
7. **Pattern choice.** The card offers only prefixes of the actual command
   (shortening at word boundaries), parent directories of the actual files,
   the exact host or the exact MCP tool. There is no free text and no
   wildcard. The provider's suggestion only preselects one offered pattern.
8. **Card.** A fourth action, "Approve and remember…", expands an inline
   panel. "Approve for session" stays. A rule-answered request shows no card,
   only the transcript note.
9. **Settings.** One page groups rules by project, filters by agent and kind,
   and removes one rule or all of a project's. There is no create or edit.
10. **CLI.** `list` and `remove` (a keyed mutation); removing only makes
    requests ask again. Nothing outside the card can create a rule.
11. **Bridge marker, fail closed.** A bridge must mark a request
    `ruleEligible`. Without it (an older bridge or container image) the
    backend asks. This changes the bridges, which the brief hoped to avoid:
    the backend cannot tell Codex `writeStdin` from a command, a lossy argv
    join from a shell string, or a truncated Claude value from a real one.
12. **Grok answers only through `allow_once`.** The bridge's own fallback for
    a bare approve may pick `allow_always`, which would save a rule in Grok's
    settings.
13. **Sensitive paths never match:** `.git`, `.github`, agent and editor
    configuration, `.husky`, `.mcp.json` and `.env*`. Writing to them could
    widen permissions or leak credentials.
14. **Shared projects / audit log.** Not applicable: the backend has no
    multi-user project concept. Each rule records the session and interaction
    it was created from.
15. **Rules outside Orkestrator** are read-only and cover:
    - Codex `rules/*.rules` in the host Codex home, each added account and
      each running container (one bounded `docker exec`);
    - Claude `permissions.allow` in the host and account settings and each
      local checkout's `.claude/settings*.json`.

## Assumptions and decisions

Made by the 2026-10-30 worker pass.

### Task 6: adapt the parser to the observed form

The analysis recommended adapting `proposedBashPrefix` to whatever form a
live request shows. The pinned 2.1.309 binary already shows it: a prefix is
`prefix *`, an exact rule is the bare command, and `prefix:*` is legacy. The
change was made from that static reading rather than waiting for task 1.
- It changes only the preselection hint.
- `permissionRuleOffer` still offers only prefixes of the actual command, so
  a wrong parse can at worst preselect nothing.
- It keeps `:*` for older CLIs.
- A suggestion with any other `*` (`git * --help`) is dropped rather than
  guessed at.
- The task is marked done. Task 1's Claude run still records the
  preselection it sees.

### Task 4: keep failing closed; no reader change

The binary reading and the tree-sitter run show a plain command's one
pattern equals `metadata.command`, so the recommended option (keep the exact
equality and document the eligible shapes) costs no rules for plain commands.
Matching on a single pattern would answer `cd app && npm test` from a rule
for `npm test`, which is exactly the widening the reader exists to prevent.
The eligible shapes are now in `permission-rules.md`. Multi-file patches keep
asking, as recommended: reading per-file paths from `metadata.files` is new
scope.

### Task 5: fixture render instead of a person's look at a billed card

The panel was rendered in Playwright from codex-bridge payloads, through the
real `codexRuleDetail` and `permissionRuleOffer`. The `HttpBridgeInteractionAdapter`
plus a staged rule store was not used: that needs a backend process. The
fixture copies the adapter's presentation fields (`title`, `body`,
`confirmLabel`, `approveForSessionLabel`), which the backend unit tests
already cover. The one-session, two-environment billed run stays the
recommended way to close the task, and its steps are above. The
"inactive-environment" tests treat "another environment on screen" as having
no backend state, which matches the code: the sweep in
`native-agent-launch-activity-reconciler.ts` runs for every adopted session,
whatever the UI shows.

### Tasks 1 to 4: one disposable profile per provider

The recommended option for each live run is an isolated `dev:test` profile
with `--credential-source <agent>`. The steps narrow it further with
`--agent-platforms <agent>`, so each run provisions and authorises one
provider, and they end with `dev:stop` plus `dev:reset`, so no rule or
application row outlives the run. No gated live spec was added, as the
analysis recommended.

### Out of scope: the card body's collapsed lines

The fixture screenshots show `BlockingPromptCard` running a Codex card's
`Reason:`, `Command:` and `Working directory:` lines together. It affects
every approval card, predates this todo and has nothing to do with rules, so
it was left alone and only reported.

## Needs verification

Both items (the billed Codex panel and no-badge check, and the Claude `Bash`
preselection seen live) moved to 7568 on 2026-11-10 with tasks 1 and 5. The
fixture-rendered panel, the backend path and the suggestion form (task 6) are
verified.

## Related

- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md),
  decision 1.
- `0160-codex-saved-rules-list-and-revoke.md` (deleted 2026-11-06).
- [agent-accounts.md](../../architecture/agent-accounts.md#machines) (to-do
  0722, retired 2026-11-10): the per-machine model followed here.
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (tasks 1 to 5, the billed live card runs) moved there on 2026-11-10.
