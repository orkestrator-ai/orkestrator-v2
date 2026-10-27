# Orkestrator-owned "always allow" rules that can be listed and removed

Worked on `feature-clarification-18cad6211bd8-r1` from `727f91c8` (2026-10-27).
All five phases are built and tested. Left: live card runs on real provider
logins (Needs verification). The durable description is
[`permission-rules.md`](../../architecture/permission-rules.md).

Follows [0001](0001-agent-interactions-and-permissions.md) decision 1 (Claude
offers no "always allow" option) and
[0160](0160-codex-saved-rules-list-and-revoke.md) (Codex's "Approve with
command/network policy" options were removed). Both would have saved rules in
the provider's own files, which Orkestrator cannot reliably list or remove.
The standing constraint was: no "always allow" option ships without a way to
list and remove what it saved, and no provider rules file is ever rewritten
without a documented format or an API for it.

## Brief

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
    (92 tests).
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

## Decisions

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

## Outstanding work

### Code

None.

### Qualification

- Live card runs on real logins, through the app (billed):
  - Claude Bash, file and `WebFetch` approvals;
  - Pi `bash`;
  - Grok (ACP) command;
  - OpenCode `bash`, `edit` and `webfetch`.

  Each run should save a rule from the card, see the next identical request
  answered with the transcript note, remove the rule from the note, and see
  the request ask again. OpenCode's `metadata.command`/`metadata.filepath`
  are unverified upstream behaviour; until confirmed, its requests may simply
  keep asking.
- An inactive-environment run through the app: a rule answering a Codex
  approval while another environment is shown. The backend path is
  unit-tested (`service.test.ts`).

## Needs verification

- A look at the rendered "Approve and remember…" panel on a real Codex card.
- The Claude `canUseTool` `suggestions` shape for `Bash` (`ruleContent` with
  `:*`) on the pinned SDK. Only the preselection depends on it.

## Related

- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md),
  decision 1.
- [0160-codex-saved-rules-list-and-revoke.md](0160-codex-saved-rules-list-and-revoke.md).
- [0722-per-machine-agent-accounts.md](0722-per-machine-agent-accounts.md):
  the per-machine model followed here.
