# Agent interactions and permissions

Checked against `main` at `2459b05c` (2026-10-15); items 2, 4 and 6 and the
capability half of item 13 updated on `b83ae534` (2026-10-22). Every code
item, the open questions and the verification items worked through on
`00a0cb82` (2026-10-25); what is left needs a live provider or a person.

Every question, approval, elicitation and dialog a provider raises should either
reach the user through the shared interaction contract and its one generic card,
or be resolved by backend policy. The backend execution policy, not the bridges,
decides what a session may do without asking. The contract, the capability bit,
the unattended policy and the execution policy are in place, and the
per-bridge environment overrides that predated the execution policy are gone.
Since 2026-10-25 Codex questions reach the card, every countdown (Claude tmux
included) can be paused, the CLI can pause one, and Agent Info describes a
read-only turn truthfully. What is left is Grok loading a trusted
checkout's resources whatever the policy says (no switch exists on the
pinned Grok 1.0.67), and live qualification runs that need a provider login
or a person.

## Current state

- Contract (`packages/protocol/src/agent-interactions.ts`):
  - `AgentInteractionRequest.blocking` and `AgentInteractionOption.amendment`.
  - `INTERACTIVE_AGENT_INTERACTION_POLICY` and
    `UNATTENDED_AGENT_INTERACTION_POLICY`. The unattended policy declines the
    input bucket, denies the authorization bucket, and names the MCP
    elicitation kinds in its per-kind `kinds` overrides.
- Capability bit: `NativeAgentCapabilities.interactions.kinds`, set per platform
  in `nativeAgentCapabilities()` (`packages/protocol/src/native-agent.ts`).
  - Cursor reports `[]`.
  - Codex claims `question` again (item 13): interactive threads turn on
    `default_mode_request_user_input`; pipeline threads do not.
  - Pi reports its live gate through `publicInteractionKinds`
    (`bridges/pi-bridge/src/public.ts`). The backend prefers that answer over
    the table (`interactionKinds` in `http-bridge-provider.ts`).
- Unattended outcomes: every workflow owner resolves interactions through the
  shared journaled path with `agentInteractionPolicyAction`
  (`build-pipeline-service-interactions.ts`, `looped-review-service.ts`).
- Codex answers every server request (`app-server/server-request-router.ts`):
  - exec-policy and network-policy amendments are never offered or sent
    (`app-server/approvals.ts`; removed on 2026-10-27 by
    [0160](0160-codex-saved-rules-list-and-revoke.md), because the rule each
    saves cannot be listed or revoked);
  - `serverRequest/resolved` withdraws a parked request (`event-reducer.ts`);
  - dynamic `item/tool/call` is answered as a failure, with a transcript
    explanation.
- Claude (`bridges/claude-bridge/src/services/`):
  - MCP elicitations and tool approvals are parked in one store
    (`session-manager-parked-interactions.ts`), served by
    `GET /session/:id/interactions` and answered through
    `POST /session/:id/interactions/:interactionId` (`accept`, `decline`,
    `cancel`). The backend maps them in `mapClaudeInteraction`
    (`http-bridge-interactions.ts`).
    - `onElicitation` parks `mcp-form` and `mcp-url` requests. One the card
      cannot render (a `url` request without a URL, or a schema over the text
      limit) is still declined with a status row naming the server.
    - `onUserDialog` answers `cancelled`, and `supportedDialogKinds` is
      deliberately left undeclared: the only documented kind,
      `refusal_fallback_prompt`, has an opaque payload and the card has nothing
      to show for it. The capability table therefore no longer claims
      `elicitation` for Claude.
  - `ask` and `deny` policies both run in `default`. `claudePermissionMode`
    (`claude-query-config.ts`) caps the prompt's mode there: the backend still
    sends `bypassPermissions` with every build prompt, and the bridge lowers
    it. A prompt may narrow the mode to `plan` or `dontAsk`; read-only turns
    still arrive as `dontAsk`.
  - Under `ask`, `canUseTool` (`session-manager-prompt-can-use-tool.ts`) parks
    every tool that reaches it as `command-approval` (Bash), `file-approval`
    (Edit, MultiEdit, Write, NotebookEdit) or `permission`. Only reading tools
    are pre-approved.
  - Under `deny`, `canUseTool` refuses every tool that reaches it, after
    questions and plan approvals are handled. That is what `dontAsk` does,
    except that the pinned CLI (SDK 0.3.296) refuses AskUserQuestion outright
    in `dontAsk` without consulting `canUseTool`, so a coordinator could not
    ask the user anything. A real-CLI probe with a loopback model showed a
    coordinator in `default` running its whole allow list (Read, Glob, Grep,
    read-only Bash, Agent, ToolSearch, `mcp__orkestrator__*`) with only
    AskUserQuestion reaching the callback; Write, Edit, WebFetch and mutating
    Bash stayed refused, in subagents too.
  - Under `auto-approve` a tool that reaches `canUseTool` runs.
  - An approval never returns the SDK's permission `suggestions`, because no
    revoke surface exists and returning them "would silently widen permissions
    after an allow-once decision". `approve-for-session` is refused. Decided
    on 2026-10-25 (item 1): Claude offers no "always allow".
  - AskUserQuestion option previews: the query sets
    `toolConfig.askUserQuestion.previewFormat: "markdown"`, and the question
    card shows an option's `preview` verbatim in a monospace block (item 3).
  - Denials are recorded on the tool row or as a status row
    (`handlePermissionDenied`, `session-manager-prompt-handlers/system.ts`).
    `NativeAgentContextUsage` carries `permissionDenials` and
    `permissionDenialDetails`.
- Grok: `publicApprovals` (`bridges/acp-bridge/src/acp-public.ts`) reports each
  ACP permission request in ACP's own shape (title from `permissionTitle`,
  plus the agent's options), which the native branch of `mapAcpApproval`
  offers as a required choice. `permissionDetail` (`acp-session.ts`) adds the
  kind: `command` with the command for an `execute` call, `file-change` with
  its paths for `edit`, `delete` or `move`, `permission` otherwise or when
  that detail is missing. The backend maps them onto `command-approval`,
  `file-approval` and `permission`. While any request is held, `/activity` answers
  `waiting`. Plan approvals and questions use the separate
  `x.ai/exit_plan_mode` and `x.ai/ask_user_question` reverse requests.
- OpenCode: `OpenCodeProvider` never answers a permission or question
  itself; every OpenCode interaction goes through the same journaled path as
  everyone else (item 5 removed the auto-reject branch and its option).
- Execution policy:
  - Resolved once per session by `resolveNativeAgentExecutionPolicy`
    (`apps/backend/src/core/native-agent-execution-policy.ts`).
  - Defaults for host and pipeline sessions: `sandbox: "none"` and
    `approvals: "auto-approve"`. Containers get `sandbox: "container"`, project
    resources on, and the environment's network mode. The coordinator always
    gets `coordinator-read-only`, which cannot be overridden.
  - Overridable per environment (`executionPolicy` in
    `EnvironmentSettingsDialog.tsx`). An override cannot claim a container a
    host lacks, and a container session reports the network its firewall
    enforces, which follows the environment (`reconcileContainerBoundary`).
  - Shown in Agent Info through `describeNativeAgentExecutionPolicy`
    (`AgentInfoButton.tsx`), which renders the policy's effects
    (`nativeAgentPolicyEffects`, `packages/protocol/src/native-agent-policy-effects.ts`)
    from the policy each bridge reports. A bridge reports what it applies:
    Cursor, Pi, Grok and OpenCode rewrite an axis they cannot honour and
    say why in `note` (`withoutProviderSandbox`, `acpReportedPolicy`,
    `effectiveOpenCodePolicy`). Codex honours project resources off with a
    per-thread untrusted pin and disabled repo skills (item 6), so it reports
    the policy unchanged. While a read-only turn applies, Claude, Cursor and
    Grok report the read-only policy with `READ_ONLY_TURN_POLICY_NOTE`
    (item 7).
  - Held to the adapters by the execution-policy conformance suite
    (`tests/conformance/execution-policy/`). For each platform and ten policy
    shapes it captures the options the SDK or CLI receives, decodes them into
    the same effects and compares them with the summary. The only tolerated
    differences are the stricter ones listed in `narrowings.ts`.
- Pausing a countdown. Clicking the timer on a native question, plan, command,
  file or permission card pauses the deadline where it is enforced, and
  clicking again restarts a fresh window:
  - Every bridge timer is an `InteractionDeadline`
    (`packages/protocol/src/agent-interaction-deadline.ts`). A pause re-arms it
    at `AGENT_INTERACTION_HOLD_CEILING_MS` (24 h) or the provider's own sooner
    limit, so an unanswered request is still declined in the end and older
    backends, which require a deadline, keep the card.
  - Bridges publish `hold` (`AgentInteractionHold`) beside `expiresAt` and serve
    `POST /session/:id/{family}/:requestId/hold` with `{ held }`. The backend
    calls it through `holdInteraction` (`http-bridge-interactions.ts`) and the
    `hold_native_agent_interaction` command. A bridge that publishes no `hold`
    is mapped to `bridge-outdated`: the countdown shows but is not clickable.
  - Limits: Grok stops its turn clock while a request is held, so a pause
    runs to the hold ceiling (item 10), but a question still ends at a
    `ask_user_question` timeout the user configured for Grok, which the card
    shows as the provider limit; Pi until its turn
    budget; a Codex question with `autoResolutionMs` until then; MCP prompts
    pause but warn that their server may stop waiting first. OpenCode publishes
    no deadline, so there is nothing to pause.
  - Claude in tmux pauses through a hold sidecar its hook script honours
    (`claude_tmux_hold_hook`, item 9). A hook installed by an older backend,
    or a Claude CLI started before the upgrade, keeps an unpausable
    countdown (`hook-outdated`).
  - The public CLI and API list `hold` and pause or resume a countdown
    (`session interactions hold`, `session.interaction.hold`; item 11).
  - Qualified live on Claude (question and command approval), Codex (command
    approval), OpenCode (question and permission) and Pi (command approval):
    each was left pending for 11 minutes, then answered after a reload, and its
    turn finished with the answer (live pause record below). Grok is not
    qualified yet.
- No bridge reads the old execution-policy env overrides
  (`CURSOR_BRIDGE_SANDBOX`, `CURSOR_BRIDGE_PROJECT_SETTINGS`,
  `PI_BRIDGE_REQUIRE_APPROVAL`, `PI_BRIDGE_PROJECT_RESOURCES`,
  `ACP_APPROVE_PROJECT_MCPS`) and no launcher sets them (item 4).

## Outstanding work

### Code

1. **"Always allow" and saved rules.** Done 2026-10-25 (decision). Claude
   does not offer `permission-grant` amendments: an approval still never
   returns the SDK's `suggestions`, and `approve-for-session` stays refused,
   so nothing Claude approves outlives the call (decision 1 below). That
   leaves Codex's exec-policy and network amendments as the only path to a
   saved rule. Orkestrator cannot list or revoke those, so the read and
   revoke surface (`NativeAgentPermissionRule`, the `permission-rules`
   routes, `listPermissionRules?` / `removePermissionRule?`) moved to
   [0160-codex-saved-rules-list-and-revoke.md](0160-codex-saved-rules-list-and-revoke.md),
   which dropped the amendment options instead (2026-10-27): no Orkestrator
   approval saves a rule now.
2. **Grok approval kind.** Done 2026-10-22. The bridge derives the kind from
   the ACP `toolCall.kind` (or the kind it recorded for the same call, or a
   known tool name such as `bash`, reading through Grok's `use_tool`
   wrapper) and publishes `command` with the command or `file-change` with
   the paths; the backend maps them onto `command-approval` and
   `file-approval` and keeps the agent's own options as the choices. `delete`
   and `move` count as file changes as well as `edit`. A request without the
   command or paths stays a `permission`, and so does one from an older
   bridge. Tests: `acp-permission-detail.test.ts`, `acp-provider.test.ts`.
   Not done: ACP defines no blocking hint, so none is carried. Not checked
   against a live Grok request (the host Grok login was expired); the Grok
   live qualification below should confirm that real `execute` and `edit`
   requests arrive as command and file approvals.
3. **Claude question previews.** Done 2026-10-25. Every Claude turn sets
   `toolConfig: { askUserQuestion: { previewFormat: "markdown" } }`
   (`session-manager-prompt-query.ts`; `html` refused, decision 2). An
   option's `preview` is carried as `AgentInteractionOption.preview` (new,
   optional, bounded like a description), at most 4,096 characters each and
   32,768 per request; past that the request keeps its options and drops every
   preview, so a long preview can never push a question over the snapshot
   bound (`withinClaudePreviewBudget` in `http-bridge-interactions.ts`). Both
   cards show it verbatim in a monospace block, never as Markdown or HTML
   (`NativeAgentQuestionCard`, `NativeAgentInteractionCard`). Older clients
   ignore the field; only the backend validates options strictly. Tests:
   `session-manager-parked-interactions.test.ts` ("asks for question previews
   as Markdown"), `agent-provider-interactions.test.ts` ("Claude question
   previews are carried within their budget"), `NativeAgentQuestionCard.test.tsx`
   ("shows an option's preview verbatim"). Not checked against a live model:
   whether Claude actually emits previews for a plain question.
4. **Retire the deprecated policy env overrides.** Done 2026-10-22. Cursor
   and Pi read only the session's policy (`sandboxEnabled`,
   `resolveCursorSettingSources`, `approvalsEnabled` and
   `projectResourcesEnabled` are gone, and a session without a policy runs as
   the host default). `cursorMcpServers` opens `.cursor/mcp.json` only when
   the policy turns `projectResources` on. The launchers in
   `commands-servers.ts`, `host-model-catalog-refresh.ts` and
   `pi-model-catalog-seeding.ts` no longer set the variables; coordinators stay
   closed through `ORKESTRATOR_BRIDGE_EXECUTION_POLICY`. The comments, both
   `AGENTS.md` files and `platform-inconsistencies.md` are updated, and no
   source file outside tests names any of the five variables. Tests that set
   them now check they change nothing.
5. **Delete the unused OpenCode auto-answer branch.** Done 2026-10-25. The
   `autoAnswerRequests` option is gone from `ProviderCommonDependencies` and
   `OpenCodeProviderDependencies`, and with it the `permission.asked` /
   `question.asked` replies, the pending-request reconciliation in
   `registerSession` and on stream start, and the `blockedSessions`,
   `failedQuestionSessions` and `answeringRequestIds` state they fed. The
   provider-level `onInteractionObservation` hook fired only from that
   branch, so it went too, along with its wiring through the build pipeline,
   looped review and `index.ts` and the tracker's provider-reported
   observation path (`recordProviderInteractionObservation`,
   `providerReportedInteractions`, `PROVIDER_REPORTED_INTERACTION_GRACE_MS`).
   The interaction monitor now sees only what its sweep reads. Tests that
   drove the branch were deleted; "leaves OpenCode permissions and questions
   pending for the journaled path" (`opencode-provider-lifecycle.test.ts`)
   checks that even an unattended registration gets no provider-side reply.
   A future owner that wants provider-side answering should follow
   `agentInteractionPolicyAction` instead of always rejecting.
6. **Codex project resources.** Done 2026-10-22. With project resources off,
   every `thread/start`, `thread/resume` and `thread/fork` carries
   `config.projects[<cwd>].trust_level = "untrusted"` (and the cwd's canonical
   path) as a nested table, plus a thread-scoped `skills.config` that disables
   every repo-scope skill `skills/list` reports, because the pin does not reach
   skills. A `skills/list` failure other than method-not-found refuses the
   thread. `codexReportedPolicy` is deleted and the conformance suite reads the
   pin. Checked against the pinned 0.162.1 with a loopback Responses endpoint
   (`live-project-trust.test.ts`, gated by `RUN_LIVE_CODEX_APP_SERVER=1`, no
   credentials): with the project trusted, the `.codex` config layer, AGENTS.md,
   `.codex/skills` and `.agents/skills` all reach the model and the project MCP
   server is contacted (control); with the pin none of them do, on the first
   turn and after a reload, a pin on a linked worktree wins over a trusted main
   checkout, and the user's `config.toml` is left unchanged. A dotted
   `projects."<path>".trust_level` key in thread config is silently ignored.
   Left open, as residual risk:
   - A repo skill added while a thread is loaded is not disabled until the
     thread next starts or resumes.
   - The slash-command catalogue (`skill-inventory.ts`) still lists repo
     skills for a session with project resources off; Codex should refuse a
     disabled one, but that dispatch was not checked.
   - Hooks were not probed separately. They live in the same `.codex` layer
     the pin drops, which the config-layer and MCP canaries prove.
7. **Read-only turns.** Done 2026-10-25. Claude, Cursor and Grok now report
   the read-only policy while it applies, marked with
   `READ_ONLY_TURN_POLICY_NOTE` (`readOnlyTurnReportedPolicy` in
   `native-agent-policy-effects.ts`): Claude while a turn started with
   `readOnly` is running (`claudeReportedPolicy`, from
   `commandDiscoveryInputs.readOnly`), Cursor and Grok while the session's
   `readOnly` flag is set, which a later prompt clears (`cursorAppliedPolicy`
   in the new `cursor-bridge/src/execution-policy.ts`, shared with `attach`;
   `acpSessionReportedPolicy`). Tests: `claude-query-config.reported-policy.test.ts`,
   `public-policy.test.ts` (Cursor), `acp-reported-policy.test.ts`.
8. **Codex `on-request` in a container.** Done 2026-10-25 (decision 4).
   The composer describes the mode honestly rather than mapping it to
   `untrusted`: in a container under `auto-approve`, `on-request` reads
   "…so this never asks; choose Untrusted to approve commands" and
   `auto-review` says its reviewer is never consulted; under `ask` it says it
   asks like Untrusted, which is what `codexApprovalConfig` runs
   (`CODEX_CONTAINER_APPROVAL_DESCRIPTIONS` in `native-agent.ts`; the launcher
   passes the policy's `sandbox`, `AgentNativeTab.helpers.tsx`). Tests:
   `native-agent.test.ts`, `AgentNativeTab.test.tsx`.

9. **Pause in Claude tmux mode.** Code done 2026-10-25; live check open.
   - The three blocking hooks (PreToolUse, PermissionRequest, Elicitation)
     run as `bash hook.sh <Kind> hold-v1` with `timeout: 172800` (two hold
     ceilings), so Claude Code no longer kills them at 600 s.
   - With `hold-v1` the script writes a version-2 timing file (`startedAt`,
     `expiresAt`, `limitAt` = start + 172,740 s, `heldAt` while paused) and
     its wait loop consumes `<session>/hold/<Kind>-<id>.json`: a pause moves
     the deadline to the earlier of now + 24 h and `limitAt`, a resume to a
     fresh five-minute window. Without the argument it writes the old shape,
     which stays unpausable (`hook-outdated`): an installed script that
     predates the sidecar, or a CLI started before the upgrade.
   - `parseBlockingHookTiming` accepts a moved deadline only when it is
     consistent with `startedAt`/`heldAt` and `limitAt`.
   - Command `claude_tmux_hold_hook` writes the request, waits up to 5 s for
     the script to rewrite the timing, then re-emits the same `hook` frame
     with the new `expires_at` and `hold`. If the script does not answer, it
     withdraws the request and the prompt keeps its old deadline (fail
     closed). Answering, expiry and the drain remove the hold file.
   - Cards use `usePromptHold`; `TMUX_PROMPT_DEADLINE` is gone.
   - Tests: `apps/backend/tests/tmux-hook-hold.test.ts` runs the generated
     script (pause, resume, answer, expiry after resume, unpausable without
     the argument); web store, client, card and tab tests.
   - Still owed: a real Claude CLI honouring a 172,800 s hook `timeout`
     without clamping it, and a paused PermissionRequest surviving past 600 s
     (no documented maximum was found; a clamped hook is killed, which stops
     the tool call, so it still fails closed). See Qualification.
10. **Pause Grok past its own limits.** Done 2026-10-25 in code and against
    the pinned binary; the live pause through the app is owed (Qualification).
    - The `session/prompt` timeout is now a clock that stops while any parked
      request is held and restarts with the time it had left when the last
      hold ends or the held request settles (`acp-prompt-clock.ts`,
      `syncPromptTurnClock`; `AcpProcess.request` takes an `onTimeoutArmed`
      callback so the timeout can move). A resumed request always gets at
      least its fresh five-minute window. While stopped, a backstop sits at
      time left + 24 h, after any held request must have expired. A held
      approval or plan approval therefore runs to the 24 h ceiling instead of
      the turn deadline.
    - Grok's own question timeout is resolved at spawn in Grok's order
      (`/etc/grok/requirements.toml`, then the environment, then
      `$GROK_HOME/config.toml` `[toolset.ask_user_question]`;
      `acp-question-timeout.ts`). When nothing sets it, the child gets
      `GROK_ASK_USER_QUESTION_TIMEOUT_SECS=86400` and the bridge's deadline
      decides; a value or off switch the user set is left alone and
      published as the card's provider limit (decision 13).
      `managed_config.toml` is not read: Grok syncs it from the team and
      deleted a hand-written copy in the probe.
    - Tests: `acp-prompt-clock.test.ts`, `acp-question-timeout.test.ts`,
      `acp-request-rearm.test.ts` (a real `AcpProcess` timeout moved earlier
      and later against an agent that never answers), `acp-context.test.ts`
      (the spawned child's environment), `acp-prompt.test.ts`.
    - Evidence: Grok 1.0.67 (`2fe064390d07`, the pin) against a loopback
      model in a throwaway `GROK_HOME`, no credentials: the ask arrives as
      `_x.ai/ask_user_question` with no timeout in it; Grok abandoned it at
      8 s with the environment set to 8, at 5 s with the user config set to
      5, and at 9 s with environment 9 over config 5; with 86400 it was still
      pending at 1,950 s, past the 1,800 s default. Longer was not run.
11. **Pause from the public CLI and API.** Done 2026-10-25. Each item in
    `session.interactions` carries an optional `hold` (`available`,
    `heldAt` while paused, `reason`), and `session interactions list` prints
    whether each countdown is paused, pausable or not and why. The new
    `session.interaction.hold` action (`held: true|false`; CLI
    `orkestrator session interactions hold SESSION INTERACTION [--resume]`)
    calls `hold_native_agent_interaction`. It refuses before any provider call
    when the interaction is missing or expired (`interaction-stale`), has no
    countdown, or its pause is unavailable (`unsupported`, with
    `details.reason`, `bridge-outdated` when no `hold` is published); asking
    for the state it is already in returns applied. Request keys are scoped
    like resolve's, the intent is `{held}`, and no `expectedRevision` is
    required (decision 6). Control MCP reaches it through `run_action` (no
    voice confirmation: a pause approves nothing). Tests:
    `public-api-interaction-hold.test.ts`; docs in `public-cli.md` and
    `cli-testing.md`.
12. **Grok project resources off.** Open: blocked on xAI. When the policy
    turns project resources on, the ACP bridge launches Grok with
    `GROK_FOLDER_TRUST=0` (`acp-provider-config.ts`). When it is off, which is
    the host default, Grok still loads the AGENTS.md, skills, commands, hooks
    and MCP servers of a checkout whose main repository the user trusted in
    Grok, and `acpReportedPolicy` reports the axis as on with a note. No
    switch forces Grok's gate closed.
    - 2026-10-22, Grok 1.0.52: a search of the binary found only switches
      that open the gate (`GROK_FOLDER_TRUST=0`, `--trust`,
      `[folder_trust] enabled = false`).
    - 2026-10-25, Grok 1.0.67 (the pin), isolated `GROK_HOME`, loopback model:
      `_x.ai/hooks/list` reports `projectTrusted` without a model turn. A
      repo granted with `--trust` reports `true`, and so does a `git
      worktree` of it with no grant of its own (the leak); a never-granted
      repo reports `false`. On the trusted worktree it stayed `true` with
      `GROK_FOLDER_TRUST=1`, with `_meta {"x.ai/folderTrust": …}` (`false`,
      `true`, `"untrusted"`, `{trusted:false}`, `{enabled:true,
      trusted:false}`) on `session/new` and `false`/`true` on `initialize`,
      and with a `trusted = false` entry for the worktree in
      `trusted_folders.toml` (a store write the bridge must not make
      anyway). `strings` of `grok-native` shows `GROK_FOLDER_TRUST` as the
      only `GROK_*` trust variable; the `GROK_CONFIG` overlay is documented as
      unable to "elevate trust" and covers only models, features, toolset and
      part of the shell policy; untrusting (`/hooks-untrust`,
      `x.ai/hooks/action`) rewrites the user's `~/.grok/trusted_folders.toml`.
    - The only mechanism that works is a throwaway `GROK_HOME`, which drops
      the user's config, skills, MCP servers and the session store
      `session/load` reads. Not shipped (decision 14).
    - To close: xAI adds a per-process "never trust" switch (an environment
      variable or a `session/new` meta key), or a live qualification of a
      throwaway `GROK_HOME` with `GROK_AUTH_PATH` pointed at the real login,
      with resume checked. Then honour `false` and drop the note, as item 6
      did for Codex.
13. **Codex questions never reach the card.** Done 2026-10-25 in code and
    against the pinned binary; a real-model run is owed (Qualification).
    Every `thread/start`, `thread/resume` and `thread/fork` of a session with
    a policy other than `pipeline` sets
    `features.default_mode_request_user_input = true`
    (`codexRequestUserInputConfig` in `codex-config.ts`), so Default mode no
    longer refuses `request_user_input` and the call parks as a question card.
    Pipeline threads keep the refusal (decision 3). `question` is back in the
    Codex row of `nativeAgentCapabilities()`, and
    `paused-interactions-live.spec.ts` has a `codex-question` case. Evidence:
    `live-request-user-input.test.ts` (`RUN_LIVE_CODEX_APP_SERVER=1`, the
    managed Codex 0.164.0 against a loopback Responses endpoint, no
    credentials) passes twice over: an interactive-host thread's call parks
    as `item/tool/requestUserInput`, can be paused, and the answer reaches the
    model as the tool output with no resample in between; the `pipeline`
    control still gets "unavailable in Default mode". With the config
    removed the first case fails, so the test is not passing by accident.
    Codex sends these questions with `isBlocking: false` but still waits for
    the answer; since
    [0161-codex-default-mode-question-activity.md](0161-codex-default-mode-question-activity.md)
    (2026-10-27) the bridge publishes them as blocking, so the session shows
    as waiting.
    `upgrade-agents.md` now runs the live test on every Codex bump, because
    the feature is marked under development and could be renamed.

### Qualification

- Live pause on Grok: a Grok permission and a Grok `ask_user_question`, paused
  past ten minutes and then answered, with
  `ORKESTRATOR_AGENT_TEST_PAUSE_PROVIDERS=grok` (see the live pause record).
  The 2026-10-21 run skipped Grok because the host Grok login had expired, and
  a profile may never refresh it. Claude, Codex, OpenCode and Pi passed. The
  same run should confirm that a Grok command and edit now reach the card as a
  command and a file approval (item 2), and, since item 10, that a paused
  Grok request outlives the 30-minute turn deadline (pause it, wait past
  30 minutes, answer, and check the turn finishes). Needs a valid Grok login
  on the host.

- Browser: raise an MCP elicitation (Codex or Claude), answer it, reload
  mid-question, and confirm it rehydrates from `/session/:id/interactions`. On
  a Claude environment overridden to `approvals: "ask"`, confirm a Bash or Edit
  call raises an approval card and that approve, deny and cancel turn reach the
  CLI. On one set to `deny`, confirm a tool outside the allow list is refused
  without a card while a question still appears. Run a real coordinator turn
  that delegates and asks a question.
- `mise run test:agent:docker` for the container cells on Cursor and Pi
  (needs a `dev:test` profile started with `--fixture-environments
  container`, and Cursor and Pi logins). Not run on 2026-10-25.
- Live Codex question (item 13): in a disposable profile with Codex signed in,
  `ORKESTRATOR_AGENT_TEST_PROFILE=<profile>
  ORKESTRATOR_AGENT_TEST_LIVE_PAUSED_INTERACTIONS=1
  ORKESTRATOR_AGENT_TEST_PAUSE_PROVIDERS=codex mise run test:logged -- --name
  paused-codex-question -- mise run test:agent:paused-interactions`. The
  `codex-question` case must raise a card, stay pending past ten minutes
  while paused, and finish with the chosen codeword after a reload. Codex
  0.164.0 has no timeout of its own on a held question (0161, from source and
  an 11-minute run against the real app-server).
- Live Claude tmux pause (item 9): in a Claude tmux tab of a disposable
  profile, raise a PermissionRequest (a Bash `touch`), pause it from the card,
  wait past ten minutes (Claude Code's default 600 s hook limit), then
  approve. Pass: the hook is still alive, the marker file appears only after
  approval. A Claude CLI that clamps the 172,800 s hook `timeout` would show
  as the tool call failing at the clamp instead.
- Live Claude question preview (item 3): ask a Claude session to "use
  AskUserQuestion with a preview for each option" and confirm the previews
  appear verbatim in monospace on the card.
- On a real Claude CLI, confirm that a provider-sandboxed auto-approve session
  can neither leave the sandbox (`allowUnsandboxedCommands: false`) nor reach a
  domain off its allowlist when the network is restricted (`strictAllowlist`).
  The conformance suite proves the options; only the CLI proves the behaviour.

### Live pause record (2026-10-21)

`e2e/agent-testing/paused-interactions-live.spec.ts` (procedure in
[agent-testing.md](../../development/agent-testing.md#live-paused-interactions))
ran on `9b3f53a2` plus this change, in the disposable profile `qa-pause-0640`
(macOS arm64, load average about 20). The profile authorized Claude, Codex,
Grok, OpenCode and Pi, with pinned CLIs claude 2.1.296, codex 0.162.1,
opencode 1.19.0 and pi 1.2.0. Each case had its own local environment under
`approvals: "ask"` and its own real turn. All six were raised within seven
seconds of each other and held together.

| Case | Request | Pause from the card | After 11 min | Answer (after reload) | Turn |
| --- | --- | --- | --- | --- | --- |
| Claude question | `question` (AskUserQuestion) | Paused, deadline moved to +24 h | Pending, turn waiting | Picked `PAUSE_BETA` | Finished with `CODEWORD_CHOSEN=PAUSE_BETA` |
| Claude approval | `command-approval` (Bash `touch`) | Paused, +24 h | Pending, no marker file | **Approve** | Marker created, finished with the done token |
| Codex approval | `command-approval` (`untrusted`) | Paused, +24 h | Pending, no marker file | **Approve** | Marker created, finished |
| OpenCode question | `question` | No countdown shown (no deadline published) | Pending, turn waiting | Picked `PAUSE_BETA` | Finished with the codeword |
| OpenCode approval | `permission` (bash) | No countdown shown | Pending, no marker file | **Approve once** (not "Always allow") | Marker created, finished |
| Pi approval | `command-approval` | Paused to its 6 h turn budget (`provider-limit`) | Pending, no marker file | **Approve** | Marker created, finished |

The spec checked every 60 s that each request kept its id and stayed
`pending`, that no turn went `idle` or `error`, and that no marker file
appeared. The answers were given only after a fresh sign-in and a reload, so
each card was rehydrated from the backend. The Playwright run passed in
675 s (`mise run test:logged -- --name paused-interactions-live`, results in
`output/agent-testing/qa-pause-0640/browser/results.json`). No silent
timeout, auto-deny or auto-approve was seen on any provider. Earlier one-minute
shakedowns showed the same behaviour.

Not qualified:

- **Grok.** The host Grok login had expired, and a profile may not refresh it
  (refresh tokens are single-use), so the launcher seeded nothing. It is
  tracked as its own qualification item above.
- **Codex question.** No real Codex turn can raise one (Code item 13).
- **Cursor.** It raises no interactions (`interactions.kinds` is `[]`).

Found on the way, none of them in the pause path:

1. Codex refuses `request_user_input` in every Orkestrator turn (item 13).
2. Two OpenCode servers starting in the same second can lose one to `database
   is locked`. Fixed 2026-10-23 in
   [0002-session-lifecycle-consistency.md](0002-session-lifecycle-consistency.md):
   host OpenCode starts are serialised and a locked start is retried. The
   "silent wait" was this spec ignoring a refused dispatch, which it now
   fails on at once. The spec still starts a provider's cases one after the
   other.
3. A harness bug selected the Codex card's optional "Approve with command
   policy", which wrote a durable rule into the host's
   `~/.codex/rules/default.rules`, because a profile shares the host Codex
   home. The product behaved as designed: only that explicit choice sends
   `acceptWithExecpolicyAmendment`, and **Approve** alone sends `accept`. The
   spec now never picks an optional or amendment option. The file, created by
   the run, was removed. The isolation gap is recorded under
   [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
   item 4.
4. An early approval prompt passed an absolute path containing a space
   (`Application Support`), and one agent created an empty `~/Library/Application`.
   That file was removed, and the prompts now use a bare file name in the
   worktree.
5. In a profile, Pi falls back to `gpt-4`, because only Pi's `auth.json` is
   shared, not the host's default model. A ChatGPT-backed OpenAI login refuses
   that model, so the spec defaults Pi to `openai/gpt-6-sol`.

Decisions:

- **How to drive it.** Options: drive the browser by hand, write a
  backend-only script, or add an opt-in Playwright spec. We added the spec.
  The pause and answer go through the real card, the run can be repeated for
  Grok later, and the wait is checked continuously rather than once. The
  dispatches go through the backend command the compose bar uses, because
  typing six prompts would not change what is under test.
- **Parallelism.** One environment per case, all held together, so the run
  takes about 12 minutes for six cases rather than 66.
- **Wait.** 10.5 minutes after the last request was raised, which is past the
  old five-minute default and Claude's 600 s hook limit. Every case had in
  fact waited 11 minutes when it was answered.

### Review rerun (2026-10-21)

The review fixes were validated on base `5f290e5c` plus the review changes in
profile `qa-pause-review-2a03`, using the same pinned provider CLIs as the
record above. The new `test:agent:paused-interactions` mise task keeps the
live qualification separate from credential-free default tests.

- The full 10.5-minute live qualification passed in 678.6 seconds, using:

  ```bash
  ORKESTRATOR_AGENT_TEST_PROFILE=qa-pause-review-2a03 \
    ORKESTRATOR_AGENT_TEST_LIVE_PAUSED_INTERACTIONS=1 \
    ORKESTRATOR_AGENT_TEST_PAUSE_PROVIDERS=claude,codex,opencode,pi \
    ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=90000 \
    mise run test:logged -- --name paused-interactions-review-live -- \
    mise run test:agent:paused-interactions
  ```

  All six cases in the table above stayed pending for about 11 minutes and
  finished with their expected answer after reload: Claude question/approval,
  Codex approval, OpenCode question/permission, and Pi approval. Every timed
  request was held immediately on arrival, then resumed and paused through
  its enabled card controls. Both OpenCode cards were visibly mounted before
  asserting no countdown. The 10.5-minute wait began after all card checks,
  so every UI hold itself received the full qualification interval. No marker
  appeared before approval; no pending interaction remained after completion.
  Results: `output/agent-testing/qa-pause-review-2a03/browser/results.json`.
- Cleanup was tested against real fixture environments by injecting failures
  immediately after creation and after startup, before layout persistence:
  `ORKESTRATOR_AGENT_TEST_PROFILE=qa-pause-review-2a03
  ORKESTRATOR_AGENT_TEST_RUN_ID=qa-pause-review-2a03-cleanup
  ORKESTRATOR_AGENT_TEST_LIVE_PAUSED_INTERACTIONS=1 mise run test:logged --
  --name paused-cleanup-live -- mise run test:agent:paused-interactions --grep
  'setup failure'`. Both cases passed. Both stop/delete commands were attempted,
  the environment records disappeared, and the started worktree was removed.
- The 13 credential-free helper regressions cover optional choices, amendments,
  allow-once preference, unsafe choices, setup/cleanup failures, immediate holds
  despite delayed providers, and draining providers before cleanup. They now
  run in the default `mise run test`, alongside the existing heartbeat tests.
- The separate Grok attempt used `ORKESTRATOR_AGENT_TEST_PAUSE_PROVIDERS=grok`
  and run ID `qa-pause-review-2a03-grok`. It **failed qualification** after
  303 seconds: no question became pending. The launcher had reported that the
  host Grok login was expired and could not be refreshed by an isolated profile.
  The question and permission cases remain unqualified; neither is counted as
  passed. Five one-minute heartbeats kept the 300-second raise poll alive under
  `ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=90000`; the failure was the assertion
  timeout, not the watchdog. Its environments were cleaned up. Failure logs:
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.p0WoNb`.
- `mise run test:logged -- --name full-non-ios -- mise run test` passed
  in 554.6 seconds. Format, lint and all typechecks passed through `mise run
  check`; the changed TypeScript files also linted with zero warnings.
  Focused task, heartbeat, helper and Playwright-loading checks passed, and
  `mise tasks validate` accepted all 79 tasks. Other platform scenario suites
  were omitted because only the qualification harness, task wiring and docs
  changed; the real browser paths are exercised by the live qualification.
- Codex question qualification remains blocked by the Default-mode limitation
  in item 13 above. The approval qualification does not imply question coverage.
  Enabling a different Codex collaboration mode is a product change outside
  these harness fixes. No passing Codex question result is claimed.

The disposable profile was stopped and reset after validation. The initial
rerun exposed a harness race between optimistic countdown labels and a still
pending resume action; waiting for the authoritative resumed state and an
enabled pause button fixed it before the successful qualification above.

## Constraints and rationale

- Approvals fail closed. A timeout, disconnect or unparseable answer denies.
- Unattended `command-approval` and `file-approval` are `deny-and-fail`; MCP
  elicitations are `decline-and-continue`, because MCP defines `decline` as an
  outcome the server handles.
- `permission` stays `deny-and-fail` when unattended. Codex uses that kind for a
  genuine capability escalation, but OpenCode puts per-tool approvals on it: an
  unattended OpenCode session refused file edits would carry on producing
  nothing. Telling the two apart belongs in the execution policy, not in a
  per-kind default. The reasoning is in the `UNATTENDED_AGENT_INTERACTION_POLICY`
  comment.
- An allow-once decision must never widen durable permissions. No "always
  allow" option ships without a way to list and revoke what it saved.
- Bridges translate the policy; they never decide trust. They cannot reliably
  tell a host from a container.
- A prompt's permission mode may narrow an `ask` or `deny` policy (plan mode,
  a read-only turn's `dontAsk`) but never widen it.
- `deny` is enforced by `canUseTool` in `default`, not by `dontAsk`, so a
  denying session can still ask the user questions.
- The coordinator policy is not user-overridable.
- Hosts default to no sandbox and auto-approve because every vendor sandbox
  holds `.git` read-only, which stalls ordinary Git work in a worktree (#613).
  `ask` stays available as an override.
- Key entry and other secrets go through an interaction, never a renderer form.
- Agent Info's policy summary is checked against what each adapter actually
  sends, not by a one-off look. The decisions behind that check:
  - One semantic model (`NativeAgentPolicyEffects`: isolation, approvals,
    project resources, network and what holds a network restriction) is both
    what the summary renders and what each runner decodes the received options
    into. No test compares summary strings.
  - The summary describes the policy the bridge reports, and the bridge reports
    what it applies. An axis an agent cannot honour is rewritten to the truth
    with a `note`, at report time only, so no gate or persisted policy changes.
    The alternative, a per-platform caveat table in the renderer, would have
    put provider knowledge back in the web app.
  - Runners capture the real hand-off (Claude's mocked `query()` options,
    Codex's `thread/start` and `turn/start` requests plus its `-c` overrides,
    Cursor's `Agent.create` options, Pi's loader options and approval gate,
    Grok's command line and permission answers, OpenCode's `session.create`
    rules). Approvals are observed behaviourally: each runner hands its gate an
    action nothing pre-approved and records whether it asks, refuses or runs.
  - An adapter may be stricter than its summary only where `narrowings.ts`
    says so with a reason. The suite fails if a narrowing is looser, or if it
    stops being observed, so an entry cannot outlive its cause.
  - "Restricted network" means the agent's own commands. Hosted tools that
    reach the internet without running a command here (web fetch, web search)
    are described by the effects model's network denial and hosted-search
    exception; the provider network-policy tests verify their tool restrictions.
  - A provider sandbox that the model can leave unseen holds nothing, so
    Claude only offers the way out (`allowUnsandboxedCommands`) when a person
    approves it, and a restricted sandbox uses a strict allowlist.

## Open questions

All answered on 2026-10-25; the reasoning is in the decisions below.

- ~~Pi, Grok and OpenCode have no sandbox of their own, so a `provider`
  sandbox or a restricted network on a host runs unsandboxed with full
  network access, reported as such with a note. Should the backend refuse such
  a session, as Cursor refuses `deny`, rather than run it?~~ No (decision 5).
- ~~Should Orkestrator expose "always allow" at all, given there is no revoke
  UI yet?~~ Not for Claude (decision 1). Codex's amendment options were
  removed by [0160](0160-codex-saved-rules-list-and-revoke.md) on
  2026-10-27.
- ~~`previewFormat`: plain or html?~~ `markdown`, shown verbatim (decision 2).
- ~~Claude MCP OAuth: is the parked `mcp-url` card the intended route for
  that sign-in, or should MCP management own a separate flow?~~ The parked
  card, while a Claude CLI is live; with none, the sign-in action is refused
  with a message rather than reconnecting on a probe whose link reaches no
  one (decision 7, `performSessionMcpAction`; `mcp-management.md` "Claude MCP
  sign-in").

## Needs verification

- ~~Whether every bridge has per-kind tests for park, render, resolve and
  fail-closed timeout.~~ Checked 2026-10-25. Every provider has park,
  render, resolve and timeout tests for its main kinds; the cells without one
  (kinds that share another kind's timer, `mcp-url` expiry, some backend
  mapping fixtures and bridge-route listings, OpenCode abort) are in
  [0162-interaction-test-matrix-gaps.md](0162-interaction-test-matrix-gaps.md).
  The audit also found OpenCode's capability row claiming `command-approval`
  and `file-approval`, which it never emits; the row now says `question` and
  `permission`.
- ~~Whether the Cursor SDK also loads `.cursor/mcp.json` itself when
  `settingSources` includes `project`.~~ Yes. In the pinned `@cursor/sdk`
  1.0.40 the MCP adapter is built with `includeProjectMcp:
  settingSources.includes("project")` and then loads
  `<project>/.cursor/mcp.json` beside the inline set. The bridge already
  avoids a duplicate: with project settings loaded, `cursorInlineMcpServers`
  passes only the backend-owned `orkestrator` and artifact servers inline.
  New tests in `mcp.test.ts` ("cursorInlineMcpServers") pin that.

## Assumptions and decisions

Decisions made on 2026-10-25 while working through the file.

1. **"Always allow" for Claude (item 1).** Options: (a) offer
   `permission-grant` amendments built from `canUseTool` `suggestions`, with
   a new list and revoke surface; (b) offer none. Chose (b). Claude's
   suggestions write rules into the user's Claude settings, which outlive the
   session and Orkestrator, and the constraint here forbids that without a
   revoke surface. Pros: no allow-once decision can widen permissions; no new
   surface to maintain. Cons: a user who wants a tool always allowed must
   use an `auto-approve` policy or edit Claude's settings. The Codex
   amendments that already ship are split into 0160.
2. **Question preview format (item 3).** Options: leave it unset (the SDK
   default, `markdown`, but the card dropped previews), set `markdown` and
   show it as plain monospace text, or set `html` and render it. Chose
   `markdown`, shown verbatim. Pros: matches the CLI's own monospace box;
   model-written text is never parsed as Markdown or HTML, so there is no new
   injection surface; explicit, so an SDK default change cannot surprise the
   card. Cons: Markdown emphasis in a preview shows as literal characters.
   Previews are bounded (4,096 characters each, 32,768 per request) and
   dropped rather than letting a question exceed the snapshot bound.
3. **Codex questions (item 13).** Options: run Orkestrator Plan turns in
   Codex's Plan collaboration mode, or turn on
   `default_mode_request_user_input` for watched sessions. Chose the feature
   flag, on every non-`pipeline` thread (the coordinator included, because it
   is a conversation with the user). Pros: every interactive turn can ask,
   not only Plan; one thread-scoped setting; proven on the pinned binary.
   Cons: Codex marks the feature as under development, so it may be renamed;
   the live test runs on every bump to catch that. Plan mode would have
   needed an experimental API and changes the model's instructions.
4. **Codex `on-request` in a container (item 8).** Options: run it as
   `untrusted` under `auto-approve` too, or describe it honestly. Chose the
   description. Under `auto-approve` the pick is the user's own narrowing,
   and the picker already offers Untrusted, so remapping would make two
   options identical. Pros: no behaviour change; the UI no longer misleads.
   Cons: the text describes Build turns; a Plan turn's read-only sandbox can
   still ask.
5. **Provider sandbox on agents without one (open question).** Options:
   refuse the session, as Cursor refuses `deny`, or run it and report the
   truth with a note. Chose to keep running and reporting. The policy comes
   from an environment override that applies to every agent in the
   environment; refusing would break Pi, Grok and OpenCode tabs in an
   environment whose override was meant for Claude or Codex. Cursor refuses
   `deny` because it cannot express that axis at all, which is different
   from an agent without a sandbox. Pros: mixed-agent environments keep
   working; Agent Info states exactly what runs. Cons: a user who never
   opens Agent Info may assume the sandbox applies.
6. **Pausing from the public API (item 11).** No `expectedRevision`: a pause
   answers nothing and keeps the request ID, and requiring the revision would
   make each pause refuse the next. No voice confirmation: a pause cannot
   approve anything and still ends at the bridge's limit. One action with
   `held`, not two, mirroring the backend command. The API refuses up front
   when the bridge reports the pause unavailable, so the error carries the
   reason and no provider call is made.
7. **Claude MCP sign-in without a live CLI (open question).** Options: keep
   reconnecting on a probe (the link reaches no one), refuse with a message,
   or build a separate MCP-management sign-in flow. Chose to refuse with a
   message pointing at the parked card. Pros: honest and small; the card
   route already works with a live CLI. Cons: one extra step (send a message
   first). A separate flow stays possible under
   [0039-mcp-management.md](../mcp/0039-mcp-management.md).
8. **Claude tmux pause (item 9).**
   - Who enforces it: a request file the hook script consumes, with the
     script writing the new timing back. The script stays the only owner of
     its deadline and nothing runs per tick; the backend polls up to 5 s for
     the change.
   - Old installs: detected by a `hold-v1` argument in the hook command
     rather than a script version, because Claude Code snapshots hook
     settings at start; the argument proves the running CLI also took the
     matching `timeout`. A CLI started before the upgrade stays unpausable
     until it restarts, and the card says so.
   - Hook timeout: two hold ceilings (48 h) with the script stopping 60 s
     before, so the first pause always gets its full day.
   - Command: `claude_tmux_hold_hook`, not `hold_native_agent_interaction`,
     because tmux prompts are not native interactions and every other tmux
     action is a `claude_tmux_*` command. The same `hook` frame is re-emitted
     with the new deadline, so older clients just deduplicate it.
9. **OpenCode auto-answer removal (item 5).** The provider-level
   `onInteractionObservation` hook and the tracker's provider-reported
   observation path were removed with the branch, because nothing else fed
   them. Leaving them would have kept a public method and a grace-period
   sweep that production can never reach.
10. **Read-only reporting (item 7).** Claude reports per turn (while a
    read-only turn runs); Cursor and Grok report while the session's
    `readOnly` flag is set, because that is when their agent is built under
    the read-only policy, until a later prompt clears it. A shared note
    explains the difference in Agent Info.
11. **Lifting Grok's turn cap (item 10).** Options: pause the turn clock,
    extend the turn deadline to the latest hold, or drop the turn timeout
    while anything is parked. Chose pausing, keeping the time the turn had
    left. Pros: the turn's budget is unchanged and a forgotten request is
    still cancelled within 24 h. Cons: a turn whose requests keep being
    re-held can run past 30 minutes of wall time.
12. **A resumed Grok countdown against the turn (item 10).** The turn runs at
    least as long as a resumed countdown, rather than capping the countdown
    at the turn deadline. Pro: the card never shows more time than Grok will
    give. Con: up to five extra minutes on the turn.
13. **Grok's question timeout (item 10).** Options: always force it to the
    ceiling, raise it only when nothing sets it, or leave it and publish what
    is configured. Chose raising only the default and honouring a value the
    user set, which the card then shows. Con: a user's short value still ends
    a pause early, as the card says.
14. **Grok project resources (item 12).** Options: ship a throwaway
    `GROK_HOME` (with `GROK_AUTH_PATH` for the login), write untrust entries
    into the user's trust store, or keep reporting the truth and wait for an
    upstream switch. Chose to wait: the first drops the user's own Grok
    configuration and session store and is unqualified, the second
    permanently changes the user's Grok settings. Pro: nothing breaks. Con:
    the host default still loads a trusted checkout's resources, which Agent
    Info states.

## Related

- [0160-codex-saved-rules-list-and-revoke.md](0160-codex-saved-rules-list-and-revoke.md),
  [0161-codex-default-mode-question-activity.md](0161-codex-default-mode-question-activity.md),
  [0162-interaction-test-matrix-gaps.md](0162-interaction-test-matrix-gaps.md)
  (split out on 2026-10-25).
- [0723-orkestrator-permission-rules.md](0723-orkestrator-permission-rules.md)
  (Orkestrator-owned "always allow" rules, applied as allow-once; meets decision 1's
  list-and-revoke constraint without a provider rule).
- [0039-mcp-management.md](../mcp/0039-mcp-management.md) (MCP OAuth and `mcp-url` sign-in).
- [0026-coordinator-read-only-adapters.md](../coordinator-and-multi-review/0026-coordinator-read-only-adapters.md)
  (coordinator safety tiers, `coordinator-providers.ts`).
- [0003-agent-accounts-and-sign-in.md](0003-agent-accounts-and-sign-in.md) (provider
  sign-in and readiness).
- [0007-provider-sdk-adoption-backlog.md](0007-provider-sdk-adoption-backlog.md)
  (deferred Claude pending-permission re-arm and MCP permission provenance).
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
  for the Docker and provider runs.
- [agent-engines.md](../../architecture/agent-engines.md) "Execution policy".

## Replaces

- `docs/plans/sdk-coverage/04-interactions-elicitation-and-permissions.md`
- `docs/plans/sdk-coverage/12-execution-policy-and-host-container-parity.md`
  (deprecated overrides, Docker and host QA, the documentation drift)
- `docs/plans/sdk-coverage/01-quick-correctness-fixes.md` (done; its Cursor
  host-policy decision is now the execution policy)
- `docs/plans/sdk-coverage-2026-09-06.md` (Claude §3.5, §3.8; Codex §4.4, §4.9;
  OpenCode §5.7; Cursor §6.1; the "Approvals capability bit" and "Host versus
  container parity" cross-cutting notes)
