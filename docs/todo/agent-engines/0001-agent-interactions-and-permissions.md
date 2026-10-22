# Agent interactions and permissions

Checked against `main` at `2459b05c` (2026-10-15).

Every question, approval, elicitation and dialog a provider raises should either
reach the user through the shared interaction contract and its one generic card,
or be resolved by backend policy. The backend execution policy, not the bridges,
decides what a session may do without asking. The contract, the capability bit,
the unattended policy and the execution policy are in place. What is left is
durable "always allow" rules, honest Grok approval kinds, and retiring the
per-bridge environment overrides that predate the execution policy.

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
  - Pi reports its live gate through `publicInteractionKinds`
    (`bridges/pi-bridge/src/public.ts`). The backend prefers that answer over
    the table (`interactionKinds` in `http-bridge-provider.ts`).
- Unattended outcomes: every workflow owner resolves interactions through the
  shared journaled path with `agentInteractionPolicyAction`
  (`build-pipeline-service-interactions.ts`, `looped-review-service.ts`).
- Codex answers every server request (`app-server/server-request-router.ts`):
  - exec-policy and network-policy amendments as options
    (`acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment` in
    `app-server/approvals.ts`);
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
    after an allow-once decision". `approve-for-session` is refused.
  - Denials are recorded on the tool row or as a status row
    (`handlePermissionDenied`, `session-manager-prompt-handlers/system.ts`).
    `NativeAgentContextUsage` carries `permissionDenials` and
    `permissionDenialDetails`.
- Grok: `publicApprovals` (`bridges/acp-bridge/src/acp-public.ts`) reports each
  ACP permission request in ACP's own shape (title from `permissionTitle`,
  plus the agent's options), which the native branch of `mapAcpApproval`
  offers as a required choice. While any request is held, `/activity` answers
  `waiting`. Plan approvals and questions use the separate
  `x.ai/exit_plan_mode` and `x.ai/ask_user_question` reverse requests.
- OpenCode: every production owner creates the provider with
  `autoAnswerRequests: false`, so OpenCode interactions go through the same
  journaled path as everyone else. The `OpenCodeProvider` auto-reject branch
  (`autoAnswerRequests: true`) is reached only from
  `agent-provider-test-support.ts`.
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
    Cursor, Pi, Grok, Codex and OpenCode rewrite an axis they cannot honour and
    say why in `note` (`withoutProviderSandbox`, `codexReportedPolicy`,
    `acpReportedPolicy`, `effectiveOpenCodePolicy`).
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
  - Limits: Grok pauses only until its turn deadline (`ACP_PROMPT_TIMEOUT_MS`)
    and, for questions, its own `ask_user_question` timeout; Pi until its turn
    budget; a Codex question with `autoResolutionMs` until then; MCP prompts
    pause but warn that their server may stop waiting first. OpenCode publishes
    no deadline, so there is nothing to pause.
  - Claude in tmux shows the countdown as not pausable yet (item 9).
  - Qualified live on Claude (question and command approval), Codex (command
    approval), OpenCode (question and permission) and Pi (command approval):
    each was left pending for 11 minutes, then answered after a reload, and its
    turn finished with the answer (live pause record below). Grok is not
    qualified yet.
- Deprecated overrides still read by the bridges, with a one-time deprecation
  warning:
  - Cursor: `CURSOR_BRIDGE_SANDBOX` and `CURSOR_BRIDGE_PROJECT_SETTINGS`
    (`bridges/cursor-bridge/src/agent-session.ts`, `config.ts`
    `sandboxEnabled` / `resolveCursorSettingSources`).
  - Pi: `PI_BRIDGE_REQUIRE_APPROVAL` and `PI_BRIDGE_PROJECT_RESOURCES`
    (`bridges/pi-bridge/src/agent-session.ts`, `config.ts`
    `approvalsEnabled` / `projectResourcesEnabled`).
  - ACP: `ACP_APPROVE_PROJECT_MCPS` is no longer read by `bridges/acp-bridge`
    at all. Only a launcher sets it, and comments still cite it.

## Outstanding work

### Code

1. **"Always allow" and saved rules.** Codex execpolicy and network amendments
   are the only path to a persistent rule today. Decide whether Claude offers
   `permission-grant` amendments built from `canUseTool` `suggestions`. If it
   does, add a read and revoke surface first. None of these exist yet:
   - `NativeAgentPermissionRule` (`id`, `label`, `scope`, `source`);
   - `GET /session/:id/permission-rules` and `DELETE /session/:id/permission-rules/:ruleId`;
   - `listPermissionRules?` / `removePermissionRule?` on `NativeAgentRuntimeProvider`.

   Bridges with no saved rules answer an empty list, not 404.
2. **Grok approval kind.** Every Grok approval reaches the card as a
   `permission` titled by the tool call, with the agent's own options. The
   native ACP branch of `mapAcpApproval`
   (`apps/backend/src/core/http-bridge-interactions.ts`) hard-codes
   `kind: "permission"`. Derive the kind from the ACP `toolCall.kind` in the
   bridge: report `execute` as a command approval and `edit` as a file change,
   with the fields those kinds carry, and keep `permission` for everything
   else. The backend then maps them onto `command-approval` and
   `file-approval`. Carry the request's blocking hint if ACP supplies one.
3. **Claude question previews.** Set `toolConfig.askUserQuestion.previewFormat`
   once the question card's rendering mode (plain or html) is decided. Nothing
   sets it today.
4. **Retire the deprecated policy env overrides.**
   - Remove the reads and the deprecation warnings in the Cursor and Pi bridges,
     along with `sandboxEnabled`, `resolveCursorSettingSources`,
     `approvalsEnabled` and `projectResourcesEnabled`. Today
     `publicInteractionKinds` and `bridges/pi-bridge/src/interactions.ts` still
     fall back to them when a session has no policy.
   - `cursorMcpServers` (`bridges/cursor-bridge/src/mcp.ts`) needs more than a
     deletion. It reads project MCP servers only when
     `resolveCursorSettingSources()` includes `project`, which means only when
     `CURSOR_BRIDGE_PROJECT_SETTINGS=1`. No launcher sets that, so the check
     ignores a policy with `projectResources: true`. Make it follow the
     session's policy instead.
   - Then remove the launchers that still set them to `"0"`:
     - `commands-servers.ts`: `CURSOR_BRIDGE_PROJECT_SETTINGS` and
       `PI_BRIDGE_PROJECT_RESOURCES` for coordinator conversations;
     - `host-model-catalog-refresh.ts`: `CURSOR_BRIDGE_PROJECT_SETTINGS` and
       `ACP_APPROVE_PROJECT_MCPS`;
     - `pi-model-catalog-seeding.ts`: `PI_BRIDGE_PROJECT_RESOURCES`.

     The bridges treat any defined value as an override, so these `"0"` values
     also trigger the deprecation warning on every such launch. They exist only
     to close an override inherited from the backend's environment, so they go
     once the bridges stop reading the variables. Coordinator conversations stay
     closed through `ORKESTRATOR_BRIDGE_EXECUTION_POLICY`.
   - Update the stale comments: the Pi row in `nativeAgentCapabilities`, the
     `publicInteractionKinds` doc comment, `bridges/pi-bridge/src/interactions.ts`
     and the `config.ts` comments in both bridges that cite
     `ACP_APPROVE_PROJECT_MCPS`. Root `AGENTS.md` and `bridges/pi-bridge/AGENTS.md`
     still say Pi approvals and project resources are env-gated; update them in
     the same change.
   - Done when no source file outside tests names any of the five variables.
5. **Delete the unused OpenCode auto-answer branch.** No production caller sets
   `autoAnswerRequests: true`. Remove the branch in `OpenCodeProvider`
   (`registerSession`, the reconcile hook and the `permission.asked` /
   `question.asked` replies) and move the tests that use it onto the journaled
   path. If a future owner wants provider-side answering, it should follow
   `agentInteractionPolicyAction` instead of always rejecting.
6. **Codex project resources.** A Codex worker loads a trusted project's own
   `.codex` configuration whatever `projectResources` says, so the bridge now
   reports the axis as on with a note (`codexReportedPolicy`). Make it honour
   `false` instead, by pinning the checkout untrusted for that thread as the
   coordinator does process-wide, after checking live that a per-thread
   `projects.<root>.trust_level` override takes effect. Then delete
   `codexReportedPolicy` and let the suite prove it.
7. **Read-only turns.** Claude, Cursor and Grok run a `readOnly` turn under the
   coordinator policy but keep reporting the session's. Agent Info then
   understates the turn's restrictions (never overstates them).
8. **Codex `on-request` in a container.** Under an `auto-approve` policy a user
   who picks `on-request` in a container gets a mode that never asks, because
   Codex asks only at the edge of a sandbox the container keeps off. Under
   `ask` the bridge now runs it as `untrusted`; decide whether the composer
   should do the same, or describe the mode honestly there.

9. **Pause in Claude tmux mode.** The deadline there is the `sleep` in the hook
   script (`tmux-hooks.ts` `hookScript`), and Claude Code kills a command hook
   after its own 600 s default. Pausing needs: a hold sidecar the script's wait
   loop honours (re-arming on resume), a `timeout` on the PreToolUse,
   PermissionRequest and Elicitation hooks above the hold ceiling,
   `parseBlockingHookTiming` accepting a moved deadline, a backend command, and
   re-emitting the hook event (blocking ids are emitted once today). Cards then
   drop `TMUX_PROMPT_DEADLINE`. Detect an installed script that predates the
   sidecar and keep its countdown unpausable.
10. **Pause Grok past its own limits.** A Grok pause ends at the 30-minute turn
    deadline, and a question also at Grok's `ask_user_question` timeout. Lifting
    that means pausing the bridge's `session/prompt` timeout while a request is
    held and raising Grok's question timeout to match; the bridge also does not
    read Grok's `config.toml` `[toolset.ask_user_question]`, so a shorter value
    set there is not reflected in the published limit.
11. **Pause from the public CLI and API.** `session interactions list` shows the
    moved `expiresAt` but not `hold`, and there is no hold action. Add `hold` to
    the listing and a `session.interaction.hold` action that calls
    `hold_native_agent_interaction`.
12. **Grok project resources off.** When the policy turns project resources on,
    the ACP bridge launches Grok with `GROK_FOLDER_TRUST=0`
    (`acp-provider-config.ts`). When it is off, which is the host default, Grok
    still loads the AGENTS.md, skills, commands, hooks and MCP servers of a
    checkout whose main repository the user trusted in Grok, and
    `acpReportedPolicy` reports the axis as on. No switch forces Grok's gate
    closed: an empty `GROK_HOME` would also drop the login. Find one on the
    pinned build (or ask xAI), then honour `false` and drop the note, as item 6
    plans for Codex.
13. **Codex questions never reach the card.** The capability table and the
    bridge's `item/tool/requestUserInput` path claim Codex questions, but no
    real Codex turn can raise one. The bridge never sets a collaboration mode
    on `turn/start`, so every turn, Orkestrator Plan included (a prompt
    reminder, not Codex's Plan mode), runs in Codex's Default mode. Codex
    0.162.1 there answers `request_user_input` with "request_user_input is
    unavailable in Default mode", and the model falls back to asking in plain
    text (seen live on 2026-10-21, see the live pause record). Either run
    Orkestrator Plan turns in Codex's Plan collaboration mode, or turn on
    Codex's `default_mode_request_user_input` feature for interactive
    sessions only (unattended owners would then decline the question by
    policy). Until then, take `question` out of the Codex row in
    `nativeAgentCapabilities()`, or say why it stays. Then add the Codex
    question case to `paused-interactions-live.spec.ts`.

### Qualification

- Live pause on Grok: a Grok permission and a Grok `ask_user_question`, paused
  past ten minutes and then answered, with
  `ORKESTRATOR_AGENT_TEST_PAUSE_PROVIDERS=grok` (see the live pause record).
  The 2026-10-21 run skipped Grok because the host Grok login had expired, and
  a profile may never refresh it. Claude, Codex, OpenCode and Pi passed.

- Browser: raise an MCP elicitation (Codex or Claude), answer it, reload
  mid-question, and confirm it rehydrates from `/session/:id/interactions`. On
  a Claude environment overridden to `approvals: "ask"`, confirm a Bash or Edit
  call raises an approval card and that approve, deny and cancel turn reach the
  CLI. On one set to `deny`, confirm a tool outside the allow list is refused
  without a card while a question still appears. Run a real coordinator turn
  that delegates and asks a question.
- `mise run test:agent:docker` for the container cells on Cursor and Pi.
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
   is locked`, and that turn then waits silently
   ([0002-session-lifecycle-consistency.md](0002-session-lifecycle-consistency.md) item
   5). The spec starts a provider's cases one after the other.
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

- Pi, Grok and OpenCode have no sandbox of their own, so a `provider` sandbox
  or a restricted network on a host runs unsandboxed with full network access,
  reported as such with a note. Should the backend refuse such a session, as
  Cursor refuses `deny`, rather than run it?

- Should Orkestrator expose "always allow" at all, given there is no revoke UI
  yet?
- `previewFormat`: plain or html?
- Claude MCP OAuth: the bridge's `authenticate` MCP action reconnects the server
  and expects the sign-in URL through `onElicitation`
  (`session-manager-catalog.ts`). With a live CLI that URL now arrives as a
  parked `mcp-url` card. With no live CLI the action runs on a `createProbe()`
  query that has no `onElicitation`, so the link never reaches anyone. Is the
  parked `mcp-url` card the intended route for that sign-in, or should MCP
  management own a separate flow? Decide with
  [0039-mcp-management.md](../mcp/0039-mcp-management.md).

## Needs verification

- Whether every bridge has per-kind tests for park, render, resolve and
  fail-closed timeout. Codex and Pi have `interactions.test.ts` and Claude has
  `session-manager-parked-interactions.test.ts`; the full matrix was not
  confirmed.
- Whether a container Cursor session loads the repository's `.cursor/mcp.json`
  today. The SDK gets `settingSources` with `project` from the policy, which may
  load it on its own, independently of `cursorMcpServers`.

## Related

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
- Living-doc drift to fix:
  - [platform-inconsistencies.md](../../architecture/platform-inconsistencies.md)
    still describes `ACP_APPROVE_PROJECT_MCPS` as a live switch.

## Replaces

- `docs/plans/sdk-coverage/04-interactions-elicitation-and-permissions.md`
- `docs/plans/sdk-coverage/12-execution-policy-and-host-container-parity.md`
  (deprecated overrides, Docker and host QA, the documentation drift)
- `docs/plans/sdk-coverage/01-quick-correctness-fixes.md` (done; its Cursor
  host-policy decision is now the execution policy)
- `docs/plans/sdk-coverage-2026-09-06.md` (Claude §3.5, §3.8; Codex §4.4, §4.9;
  OpenCode §5.7; Cursor §6.1; the "Approvals capability bit" and "Host versus
  container parity" cross-cutting notes)
