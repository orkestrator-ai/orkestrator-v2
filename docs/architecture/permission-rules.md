# Orkestrator permission rules

"Always allow" rules that Orkestrator keeps and applies itself. When an agent
asks for approval, the backend checks its own rule store first. On a match it
answers with the provider's plain **allow-once** and records the application;
the provider never learns a rule exists. Every answer on the wire is
allow-once, so removing a rule takes effect at once: the next matching request
simply asks again. Work item and decisions:
[0723-orkestrator-permission-rules.md](../todo/agent-engines/0723-orkestrator-permission-rules.md).

Orkestrator never writes a rule into a provider's own files
(`~/.codex/rules/*.rules`, Claude's `settings.json`, Grok's settings): app-server
has no rules API, and Codex's docs mark its rules format experimental
([0160](../todo/agent-engines/0160-codex-saved-rules-list-and-revoke.md)).
Those files are only listed, read-only, in Settings → Permissions. Codex 0.166.0
keeps a saved command as `prefix_rule(...)` and a saved host as
`network_rule(...)`, both in `rules/default.rules`. It reads them when a thread
starts, so removing one stops it for new threads only, unlike an Orkestrator
rule.

## Model

`packages/protocol/src/permission-rules.ts` (browser-safe, shared by the
renderer and backend):

- `NativeAgentPermissionRule`: `id`, `provider` (one agent or `any`), `scope`
  (`project`, or `environment` with `environmentId`), `projectId`, `kind`,
  `pattern`, `createdAt`, `createdFrom` (environment, agent, session and
  interaction ids), `lastUsedAt`, `useCount`, optional `expiresAt`. There is
  no host scope.
- Kinds and canonical patterns:
  - `command-prefix`: argv words joined by single spaces (`npm run test`).
    Every word is a plain token, so the join is unambiguous. At least two
    words.
  - `file-path`: relative to the environment's workspace. `src/` covers a
    directory, `src/a.ts` one file, `./` the whole workspace.
  - `network-host`: a lower-case host name or IPv4 address, no port, exact.
  - `mcp-tool`: `server/tool`, exact.
- `PermissionRuleApplication`: one request a rule answered, with the rule's
  pattern and kind at the time (the rule may since be gone).
- `AgentInteractionPresentation.ruleOffer`: the card's "Approve and remember"
  offer: the patterns the user may choose, narrowest first, the preselected
  one, or why this request cannot be remembered.

## Matching fails closed

Everything the matcher cannot know for sure asks.

- **Commands** are split into argv by `parseShellWords`, a strict subset of
  POSIX shell. Single and double quotes are honoured. Anything that could run
  something other than the words shown is refused: `;`, `&`, `|`, redirects,
  `(`, `)`, `$`, backticks, backslash escapes, globs, braces, `~`, `!`, `#`,
  newlines, control characters and bidi controls.
- Exactly one shell wrapper layer is unwrapped (`/bin/zsh -lc 'npm test'`,
  which is what real Codex 0.164.0 sends), and only when the inner script is
  itself one plain command. Any other shell use never matches. Neither does
  a wrapper (`sudo`, `env`, `xargs`, `find`, `sed`, `ssh`, …) or a leading
  `NAME=value`.
- A rule may not name a wrapper, nor an interpreter or runner (`python`,
  `node`, `bun`, `npx`, `git`, `docker`, …) followed by an option. A prefix
  matches at word boundaries only, and argv[0] matches exactly
  (`/usr/bin/npm` is not `npm`).
- **Paths** are normalised lexically and must sit inside the workspace root:
  `worktreePath` for a local environment, `/workspace` in a container. They
  never match under `.git`, `.github`, agent configuration (`.claude`,
  `.codex`, `.cursor`, `.opencode`, `.grok`, `.pi`, `.agents`,
  `.orkestrator`), editor configuration, `.husky`, `.mcp.json` or any
  `.env*`. Every path of a multi-file change must match.
- **Hosts** match exactly, never by suffix.

## Where rules are applied

`apps/backend/src/core/permission-rules/`:

- `store.ts`: `PermissionRuleStore`, two record stores in the backend
  database. `permission-rules` holds one row per rule, owned by its project.
  `permission-rule-applications` holds one row per answered request (a digest
  key), owned by its environment, bounded at 1,024. Writes are single
  transactions. `claimApplication` is the at-most-once journal: the first
  claim of a request wins, and only while its rule exists and is unexpired.
  An unparseable row answers nothing.
- `request-detail.ts`: reads each bridge's own payload (never the card's
  display text) into a `PermissionRuleSubject`, the provider's suggested
  prefix, and the answer that selects allow-once.
- `enforcer.ts`: `PermissionRuleEnforcer` decides, answers and offers.
- `external-rules.ts`: the read-only view of the providers' own rule files.

The enforcer runs in two places, so a rule applies with no tab mounted and
before any card is shown:

1. **The activity sweep.** When a session is observed `waiting`, the hook
   (`applyPermissionRules`) first checks that its project has a rule that
   could apply (one indexed read, no provider read). Only then does it read
   the pending requests and answer what rules cover. If that leaves nothing
   waiting, the observation is recorded as `working`, so no waiting edge or
   attention badge is raised for a card nobody needed to see.
2. **Projection reads.** Pending requests are run through the enforcer before
   the card list is built. Answered ones are dropped, and the rest get their
   `ruleOffer`.

### Fail-closed conditions

A rule never widens the session's policy. It only answers a question that
policy would otherwise put to the user. Nothing is auto-answered when:

- the origin is not `interactive-native` (coordinator, pipeline, review);
- the interaction policy is not interactive, or routes the kind anywhere but
  `await-user`;
- the execution policy is coordinator read-only, a pipeline, or has
  `approvals` other than `ask`;
- the session is in plan mode;
- the capability is denied (`shell`, `file.write`, `network`), or the network
  is `restricted` (for host rules);
- the environment is missing or being deleted;
- the request is not pending, has expired, has `confirmDisabled`, or the
  bridge did not mark it `ruleEligible`;
- the store cannot be read, or the claim already exists;
- the provider did not apply the answer. The card then stays and the claim is
  not retried.

Approval timeouts, disconnects and process restarts still deny, as before.
Only the operation's structured detail is held in memory, and logs and
metrics carry none of it.

## Bridges

Each bridge marks a request `ruleEligible` only when its detail is exact.
A bridge that predates the marker keeps asking.

| Agent | Eligible | Never |
| --- | --- | --- |
| Codex | v2 `item/commandExecution/requestApproval` with app-server's own `command` and `kind` `command`; a managed-network host, which arrives with no `command` on 0.166.0; a file change without `grantRoot` | `writeStdin`, a command rebuilt from `commandActions`, a legacy argv join, `permissions` grants |
| Claude | `Bash` with an untruncated command; file tools with an absolute path; `mcp__<server>__<tool>` with its `mcpServer`; `WebFetch` (by URL host) | truncated values, relative paths, other tools |
| Pi | `bash` with a command; `edit`/`write` with a path (resolved against its working directory) | `powershell`, custom tools |
| Grok (ACP) | a command sent as one string, a file change with every path, and only with an explicit `allow_once` option | an argv array, truncated detail, no `allow_once` |
| OpenCode | `bash` only from the full `metadata.command` when it is the single pattern; `edit`/`write` by `metadata.filepath` or a single pattern; `webfetch` by URL | compound commands, a multi-file patch, anything else |
| Cursor | none (the SDK bridge raises no approvals) | |

OpenCode 1.19.4 (`ShellTool.ask`, read from the pinned binary) sends one
`bash` pattern per tree-sitter `command` node: the node's trimmed text, with
its redirect, skipping `cd`/`pushd`/`popd`. So a plain single command
(`git status --short`, `npm run test -- --watch`) arrives with its one
pattern equal to `metadata.command` and is eligible. A command behind
`cd … &&`, a list, a pipe, a command substitution, a repeated command or one
with surrounding whitespace has a different or second pattern and asks. A
multi-file patch sends `metadata.filepath` as the relative paths joined by
`", "` and several patterns, so it always asks; a single-file patch resolves
its one pattern against the session directory.

The Codex and Claude bridges also forward the provider's own suggestion
(Codex `proposedExecpolicyAmendment`, Claude's `canUseTool` `addRules` for
`Bash`) as `proposedCommandPrefix`. It only preselects one of the offered
patterns. It is never sent back, and no answer carries an amendment. Claude
Code 2.1.309 suggests a prefix as `Bash(npm test *)` and an exact command
without a suffix; the bridge also accepts the legacy `npm test:*` and drops
any other wildcard.

## Creating, listing and removing

- **Create** only from an approval card: "Approve and remember…" opens a
  panel showing the exact patterns (narrowest first), the scope (this project
  or this environment), an optional expiry (1, 7 or 30 days) and "also for
  other agents".
  `approve_native_agent_interaction_and_remember` re-derives the offer from
  the provider's payload and refuses a pattern that is not in it. It then
  answers allow-once and saves the rule only if the provider applied the
  answer. No public action, MCP tool or coordinator tool reaches it, so an
  agent can never create a rule.
- **List and remove**:
  - Settings → Permissions (`PermissionsSettings.tsx`, per machine) groups
    rules by project, filters by agent and kind, shows last use and use
    count, and removes one rule or a project's rules.
  - The transcript note "Approved once by your rule …" (`PermissionRuleNote`)
    has a Remove rule action.
  - Agent information lists the session's applications.
  - `orkestrator permissions rules list|remove` (`permission.rule.*`) does the
    same from the CLI.
- **Cleanup**: deleting an environment removes its environment rules and
  application rows; removing a project removes its rules.
- **Scope**: rules are per machine and are not synced to other nodes. A
  card's command reaches the machine its session runs on, and Settings
  follows the machine chosen in its header.

## Tests

- `packages/protocol/src/permission-rules.test.ts`: the parser and matcher
  against a hostile corpus, offers and validation.
- `apps/backend/src/core/permission-rules/*.test.ts`:
  - the store;
  - the enforcer (automatic answers, removal taking effect at once,
    at-most-once, store failure, policy precedence, approve-and-remember);
  - the payload readers and adapters;
  - the activity sweep with no tab mounted, a rule scoped to another
    environment, and a session left waiting on an unmatched request;
  - the external files.
- `public-api-permission-rules.test.ts`.
- Bridge tests: `approvals.test.ts` (Codex), `interactions.test.ts` (Pi),
  `acp-permission-detail.test.ts`, `session-manager-parked-interactions.test.ts`
  (Claude).
- Web: `NativeAgentInteractionCard.test.tsx`, `PermissionsSettings.test.tsx`,
  `permission-rule-rows.test.ts`, `usePermissionRuleSession.test.tsx` (the
  notes read by a tab mounted on return).
- Live, no credits: `bridges/codex-bridge/src/app-server/live-policy-amendment.test.ts`
  ("an Orkestrator rule answers the identical command…"), and its managed-network
  half in a container (`mise run verify:codex:network-approval`).
- Browser:
  - `e2e/agent-testing/permission-rules.spec.ts` (Settings → Permissions on a
    `dev:test` profile);
  - `e2e/RememberRulePanel.spec.ts` (the "Approve and remember…" panel on
    Codex cards built by the real Codex reader, at phone and desktop widths);
  - `e2e/agent-testing/codex-saved-rules-live.spec.ts` (opt-in, no credits: a
    real Codex card and "Rules outside Orkestrator", against a loopback model).
