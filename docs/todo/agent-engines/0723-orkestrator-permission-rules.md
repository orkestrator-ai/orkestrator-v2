# Orkestrator-owned "always allow" rules that can be listed and removed

Worked on `feature-clarification-18cad6211bd8-r1` from `727f91c8` (2026-10-27)
and landed as `3d707ddd` (#1348). All five phases are built and tested. Left:
live card runs on real provider logins (Needs verification). The durable
description is [`permission-rules.md`](../../architecture/permission-rules.md).

Follows [0001](0001-agent-interactions-and-permissions.md) decision 1 (Claude
offers no "always allow" option) and
[0160](0160-codex-saved-rules-list-and-revoke.md) (Codex's "Approve with
command/network policy" options were removed). Both would have saved rules in
the provider's own files, which Orkestrator cannot reliably list or remove.
The standing constraint was: no "always allow" option ships without a way to
list and remove what it saved, and no provider rules file is ever rewritten
without a documented format or an API for it.

## Task analysis

Analysed 2026-10-28 against `main` at `79f3bc97`.

Every code item is done on `main` (`3d707ddd`, #1348) and is not repeated as a
task; the proof is listed under Current state. No later commit changed the
rule store, the enforcer, the protocol module or the card. What is left is
qualification on real logins and two checks that need a person or a live
provider.

### Tasks

1. **Claude live card run**: Bash, file and `WebFetch` approvals through the app. Status: open (needs a Claude login; billed).
2. **Pi live card run**: `bash` through the app. Status: open (billed).
3. **Grok live card run**: a command through the app. Status: open (needs a valid Grok login).
4. **OpenCode live card run**: `bash`, `edit` and `webfetch` through the app. Status: open (billed; payload fields now confirmed statically).
5. **Codex card in the app**: the rendered "Approve and remember…" panel, and a rule answering while another environment is shown. Status: open (billed).
6. **Claude Bash suggestion shape**: the `canUseTool` `suggestions` value for `Bash` on the pinned SDK. Status: open (depends on 1; types confirmed).

### 1. Claude live card run

**Problem.** The Claude path is proved by bridge and backend unit tests only.
No real Claude request has been answered by a rule.

**Context.** The Claude bridge marks `ruleEligible` only for an untruncated
`Bash` command with known keys, an absolute file path, an MCP tool with its
server, or `WebFetch` by host
(`bridges/claude-bridge/src/services/session-manager-parked-interactions.ts:264-284`).
The enforcer only answers an `interactive-native` session whose execution
policy has `approvals` `ask` and is not in plan mode
([`permission-rules.md`](../../architecture/permission-rules.md), "Fail-closed
conditions").

**Investigation.** Pinned versions: Claude Code `2.1.309`
(`packages/toolchain/src/manifest.ts:7`), Agent SDK `0.3.309`
(`bridges/claude-bridge/package.json:16`). `dev:test` accepts
`--credential-source <agent>` for every agent platform
(`apps/desktop/scripts/dev/arguments.ts:28`, `:98-103`). The existing browser
spec (`e2e/agent-testing/permission-rules.spec.ts`) stages rules straight
into the database because "a card needs a real, billed provider turn", so it
does not cover this.

**Decisions.**

- **How to run it?**
  - **An isolated `mise run dev:test --credential-source claude` profile,
    driven by hand or with `playwright-cli`, with the outcome recorded in this
    file (recommended).**
    - Pros: no billed spec added to the repository; a few short turns cover
      all three kinds.
    - Cons: not repeated automatically on a provider bump.
  - **A gated `*-live.spec.ts` beside `permission-rules.spec.ts`.**
    - Pros: repeatable on every bump.
    - Cons: billed on every run; more code to keep for a feature that only
      acts once a person saves a rule.
- **What counts as a pass?** (The same bar applies to tasks 2 to 5.)
  - **The full cycle per approval kind (recommended):** save a rule from the
    card; the identical next request shows no card and an "Approved by rule"
    note; Settings → Permissions shows the use; removing the rule from the
    note makes the next identical request ask again. Also check that the
    account's Claude `settings.json` `permissions.allow` is unchanged.
    - Pros: proves creation, application, removal and that nothing reached
      the provider's own files.
    - Cons: three turns per kind.
  - **Only the rule-answered request.**
    - Pros: one turn fewer per kind.
    - Cons: removal taking effect at once is the point of the design and
      would stay unproved.

### 2. Pi live card run

**Problem.** Pi's `bash` path is proved by `bridges/pi-bridge/src/interactions.test.ts`
only.

**Context.** The Pi bridge marks `bash` with a command and `edit`/`write`
with a path; the qualification item names only `bash`.

**Investigation.** Pi is pinned at `1.4.0` (`packages/toolchain/src/manifest.ts:11`).
Nothing has changed in `bridges/pi-bridge/src/interactions.ts` since
`3d707ddd`.

**Decisions.**

- **Which login?**
  - **Copy the host Pi login into a disposable `dev:test` profile with
    `--credential-source pi` (recommended).**
    - Pros: the profile is thrown away afterwards; no change to the host
      login.
    - Cons: billed against the host's Pi provider.
  - **Run on the production instance.**
    - Pros: no profile set-up.
    - Cons: leaves a rule and its applications in the production database.
- **Pass:** the task 1 cycle for one `bash` command.

### 3. Grok live card run

**Problem.** Grok's path is proved by `bridges/acp-bridge/src/acp-permission-detail.test.ts`
only, and decision 12 (answer only through `allow_once`) has not been seen
on a real Grok.

**Context.** The bridge's own fallback for a bare approve picks
`allow_once`, then `allow_always` (`bridges/acp-bridge/src/acp-session.ts:818-823`).
The backend's reader only answers a Grok request that offers `allow_once`
(`apps/backend/src/core/permission-rules/request-detail.ts:100-125`).

**Investigation.** Grok is pinned at `1.0.67`
(`packages/toolchain/src/manifest.ts:9`).
[0001](0001-agent-interactions-and-permissions.md) task 3 is blocked on the
same thing: a valid Grok login on the test host.

**Decisions.**

- **How to prove nothing reached Grok's own settings?**
  - **Snapshot Grok's settings under `$GROK_HOME` before and after the run
    and compare (recommended).**
    - Pros: shows directly that no `allow_always` rule was saved.
    - Cons: needs the profile's Grok home located first.
  - **Rely on the unit tests for the answer chosen.**
    - Pros: no extra step.
    - Cons: does not cover a Grok release that changes its option kinds.
- **Pass:** the task 1 cycle for one command, plus the unchanged settings.

### 4. OpenCode live card run

**Problem.** OpenCode needs no bridge change because the backend reads
`metadata.command` and `metadata.filepath` from its permission requests. The
file called these fields unverified upstream behaviour; if they were missing,
OpenCode requests would simply keep asking.

**Context.** `openCodeRuleDetail` (`apps/backend/src/core/permission-rules/request-detail.ts:174-201`)
matches a command only when `metadata.command` equals the one pattern asked
about; an edit by an absolute `metadata.filepath`, or else a single pattern
resolved against the session directory; a fetch by its one URL pattern. The
SDK types leave `metadata` untyped
(`apps/backend/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:2045-2058`).

**Investigation.** The pinned OpenCode `1.19.4` binary
(`packages/toolchain/src/manifest.ts:10`) was searched, not run. It sends:
- `bash`: `metadata: { command }`, with `patterns` from its own shell parse
  (`ShellTool.ask`);
- `edit` (the edit and write tools): `patterns: [relative path]`,
  `metadata: { filepath, diff }`, where `filepath` is the absolute path;
- a multi-file patch: `permission: "edit"`, `patterns` relative to the
  worktree, and `metadata.filepath` set to those relative paths joined by
  `", "`. `absolutePath` rejects that (it is not absolute and no base is
  given), and more than one pattern returns `null`, so a multi-file patch
  asks. A single-file patch resolves its pattern against the session
  directory;
- `webfetch`: `patterns: [url]`, `metadata: { url, format, timeout }`.

So the fields exist. What only a live run shows is whether `patterns[0]`
equals `metadata.command` for a plain command.

**Decisions.**

- **If a plain `bash` command's pattern differs from `metadata.command`?**
  - **Keep failing closed and record in `permission-rules.md` which command
    shapes OpenCode makes eligible (recommended).**
    - Pros: the reader's caution exists because OpenCode's parse can leave
      out redirects and operators.
    - Cons: OpenCode command rules may never apply.
  - **Match on `patterns` when there is exactly one.**
    - Pros: rules would apply.
    - Cons: a pattern can omit what the command really runs; this widens
      what a rule answers.
- **Multi-file patches always ask.** Accept this and say so in the OpenCode
  row of `permission-rules.md` (recommended), rather than reading per-file
  paths from `metadata.files`, which is new scope.
- **Pass:** the task 1 cycle for `bash`, `edit` and `webfetch`.

### 5. Codex card in the app

**Problem.** Two Codex checks need the app: a person looking at the rendered
"Approve and remember…" panel, and a rule answering a Codex approval in an
environment that is not on screen.

**Context.** The Codex match is proved live and credit-free against the pinned
`0.164.0` binary with a loopback model
(`bridges/codex-bridge/src/app-server/live-policy-amendment.test.ts`). That
harness has no app and no renderer. The backend path for an unmounted
session is unit-tested: "a rule answers a waiting session with no tab mounted
and no waiting edge" (`apps/backend/src/core/permission-rules/service.test.ts:66-70`).

**Investigation.** The card's fourth action is at
`apps/web/src/components/native-agent/NativeAgentInteractionCard.tsx:255`,
and the panel is `RememberRulePanel.tsx`. Neither has been seen with a real
Codex payload.

**Decisions.**

- **One run or two?**
  - **One billed Codex session on an isolated profile with two environments
    (recommended):** remember a rule from the card in environment A and look
    at the panel; then show environment B while A's agent repeats the
    command. Pass when A shows the transcript note and no card on return, and
    no attention badge was raised.
    - Pros: one login, one session, both checks.
    - Cons: billed.
  - **Point the profile's Codex at a loopback model.**
    - Pros: no credits.
    - Cons: no such option exists for `dev:test` today; building it is new
      scope.

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
fixture uses `"npm run test:*"` (`session-manager-parked-interactions.test.ts:398`).

**Decisions.**

- **If the live value differs?**
  - **Adapt `proposedBashPrefix` to the observed form during task 1
    (recommended).**
    - Pros: keeps the preselection; cheap.
    - Cons: one more format to parse.
  - **Drop the Claude preselection.**
    - Pros: less code.
    - Cons: the card loses a useful default for Claude only.

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
    - the external files.
  - `public-api-permission-rules.test.ts`.
  - Bridge tests: Codex `approvals.test.ts`, Pi `interactions.test.ts`, ACP
    `acp-permission-detail.test.ts`, Claude
    `session-manager-parked-interactions.test.ts`.
  - Web: `NativeAgentInteractionCard.test.tsx`, `PermissionsSettings.test.tsx`,
    `permission-rule-rows.test.ts`.
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

- Live card runs on real logins, through the app (billed):
  - Claude Bash, file and `WebFetch` approvals (task 1);
  - Pi `bash` (task 2);
  - Grok (ACP) command (task 3);
  - OpenCode `bash`, `edit` and `webfetch` (task 4).

  Each run should save a rule from the card, see the next identical request
  answered with the transcript note, remove the rule from the note, and see
  the request ask again. OpenCode's `metadata.command`/`metadata.filepath`
  are present in the pinned 1.19.4 binary (task 4); whether a plain command's
  pattern equals `metadata.command` is still unproved, and until it is,
  OpenCode command requests may simply keep asking.
- An inactive-environment run through the app: a rule answering a Codex
  approval while another environment is shown (task 5). The backend path is
  unit-tested (`service.test.ts`).

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

## Needs verification

- A look at the rendered "Approve and remember…" panel on a real Codex card
  (task 5).
- The Claude `canUseTool` `suggestions` shape for `Bash` (`ruleContent` with
  `:*`) on the pinned SDK. Only the preselection depends on it. The SDK
  `0.3.309` types match the bridge's parser; the `:*` value needs a live
  request (task 6).

## Related

- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md),
  decision 1.
- [0160-codex-saved-rules-list-and-revoke.md](0160-codex-saved-rules-list-and-revoke.md).
- [0722-per-machine-agent-accounts.md](0722-per-machine-agent-accounts.md):
  the per-machine model followed here.
