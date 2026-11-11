# Control MCP: voice profile, progressive disclosure and CLI parity

Checked against `main` at `9906db30` (2026-10-16). Items 2 to 11 implemented on
branch `todo-0041-control-mcp-voice-4a2c0ccc548b` (2026-10-24, rebased onto
`main` at `a5d78cfc`). Remaining work 1(b) (a live command approval) and the
tooling for 1(a) done on branch `todo-0041-control-mcp-voice-699c0075ce9c`
(2026-10-25, from `main` at `00a0cb82`). Tasks 4 and 5 done on branch
`split-mcp-tools-d9dc0536f49e-r1` (2026-11-06, from `main` at `c1724ab7`).

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab7`.

### Tasks

2. **`delegate` into a coordinator turn (D13)**: an action that starts a coordinator turn from outside. Status: deferred; the recommended removal from this file, with a pointer in `control-mcp.md`, can be done now.
3. **Stateful MCP session with `list_changed` and subscriptions (D14)**. Status: deferred; the same removal can be done now.
4. **Over-limit Control MCP files**: `control-mcp/server.test.ts` (left over the limit by D17) and, newly, `control-mcp/tools.ts` exceed the 2,000-line rule. Status: done (test file split 2026-11-03, D23; `control-mcp/tools.ts` split 2026-11-06 after #1664 merged, D25).
5. **Stale statements in this file**: D11, the profile size table and the OpenCode conformance note no longer match `main`. Status: done (2026-11-06, D26).

### 2. `delegate` into a coordinator turn (D13)

**Problem.** A voice agent cannot hand a multi-step goal to a coordinator; it must compose every tool call itself.

**Context.** D13 deferred it because external messages are inbox-only by design, and starting a coordinator turn from outside needs its own authenticated path, capability and loop budget. Remaining work 2 says it needs its own todo file when wanted.

**Investigation.** No `delegate` action exists in `PUBLIC_ACTIONS` (`packages/protocol/src/public-api.ts`). Since this file was written, #1268 (`32317ae6`) added operator `review.*` and `pr.*` actions, which reduces the gap somewhat: a voice or operator credential can now start a Multi Review directly.

**Decisions.**

- **What to do with the deferred item?**
  - **Remove it from this file and leave a one-line pointer in `control-mcp.md`; open a new todo only when someone asks for it (recommended).**
    - Pros: lets this file finish (the live voice qualification moved to the manual-test checklist on 2026-11-10); follows the file's own instruction that each needs its own todo.
    - Cons: the idea is less visible than as an open item.
  - **Open a new todo file for it now.**
    - Pros: tracked and rateable.
    - Cons: a Low file with no requester; the design questions (capability, loop budget) would be guesses without a use case.

### 3. Stateful MCP session with `list_changed` and subscriptions (D14)

**Problem.** The server is stateless and rebuilt per request, so clients get no push of new tools or resource subscriptions.

**Context.** D14 deferred it: the gateway reaches every action from a fixed list, and realtime voice clients fix their tool list at session start.

**Investigation.** `control-mcp/server.ts` still builds a server per request (the design D5 relies on, compiling schemas once per process). Nothing on `main` depends on `list_changed`.

**Decisions.**

- **What to do with the deferred item?**
  - **Remove it from this file with the same pointer approach as task 2 (recommended).**
    - Pros: no current consumer; the gateway already covers discovery.
    - Cons: a future client that relies on `list_changed` would need to rediscover the reasoning in D14.
  - **Keep it listed as deferred here.**
    - Pros: no edit.
    - Cons: blocks retiring the file even after task 1 is done.

### 4. Over-limit Control MCP files

**Problem.** The repository rule caps files at 2,000 lines. D17 split `control-mcp/server.ts` but left `control-mcp/server.test.ts` over the limit "for its own change", and nothing tracks that change.

**Context.** D17 recorded the test file at 2,872 lines on `main` before the split; it avoided splitting a file `main` kept changing.

**Investigation.** At HEAD `apps/backend/src/core/control-mcp/server.test.ts` is 3,078 lines and still growing. New since this file: `apps/backend/src/core/control-mcp/tools.ts` is 2,002 lines, just over the limit, after #1268 added the operator workflow tools (`control-mcp/operator-workflow-tools.ts`, `control-mcp/review-actions.ts`). `control-mcp/server.ts` itself is 650 lines.

Rechecked 2026-11-03 against `main` at `b8862313`: the test file had reached 4,322 lines (62 tests, 565 assertions) and `control-mcp/tools.ts` 2,272. The test file is now split by the source module each block exercises (D23); the 62 tests keep their names and assertions. `control-mcp/tools.ts` is left alone because #1664 (cross-machine ticket coordination) edits it; it should be split once #1664 merges, along the boundaries in D24, so each tools module lines up with one test file.

**Decisions.**

- **Where should the split be tracked and done?** Resolved 2026-11-03: in this file's task 4, by a ticket against it, rather than in a new todo file.
  - **Open a new todo file for splitting both, aligned with each other (tools module and its tests), as the README requires for new work (recommended).**
    - Pros: follows the "never add new todos to an existing file" rule; the split of the tools module and the test file can follow the same boundaries.
    - Cons: one more Low file.
  - **Split them opportunistically in the next change that touches them.**
    - Pros: no tracking overhead.
    - Cons: that is what D17 assumed, and the test file has grown by 200 lines since.

**Outcome (2026-11-06).** Done. #1664 has merged, and `control-mcp/tools.ts` (2,593 lines on `main` at `c1724ab7`) is split by tool group into six files of 115 to 781 lines (D25). Every tool's name, order, description and input schema and the server instructions are byte-identical before and after, for coordinator and operator credentials alike.

### 5. Stale statements in this file

**Problem.** Three statements no longer match `main`, which misleads anyone using this file as the record of decisions.

**Context.** The README allows correcting existing items and recording decisions against them.

**Investigation.**
- D11 and decision 5 say Multi Review and Build Pipelines stay coordinator-only. Since `32317ae6` (#1268), Multi Review and PR actions are public actions (`review.launch/list/get/open/address/cancel`, `pr.create/resolve`, `packages/protocol/src/public-api.ts`) with operator tools, and `docs/architecture/control-mcp.md` lists the Multi Review tools in the `full` profile. Build Pipelines also have operator public actions: `build.launch` requires `environments.lifecycle`, `build.list/get` require `sessions.read`, and `build.cancel` requires `sessions.control` (`packages/protocol/src/public-api-inputs-build.ts`).
- The profile table (`full` = 82 tools, 76,374 bytes) predates #1268, so the `full` count and size are now higher; they were not re-measured here. The voice profile's budget still holds (task 1).
- The `mise run test` row says 14 OpenCode conformance cases fail because `conformance-execution-policy.test.ts` expects 1.19.0. The test now asserts `PINNED_TOOLCHAIN_VERSIONS.opencode` from the shared toolchain manifest instead of maintaining a separate hardcoded version; `policyQualificationCli` also resolves its default binary from that manifest-pinned directory, so the stale expectation is fixed.

**Decisions.**

- **How to correct them?**
  - **Annotate in place: mark D11 as superseded for Multi Review and PR actions by #1268 and for Build Pipeline public actions, add a dated note under the size table that `full` grew, and mark the OpenCode note fixed (recommended).**
    - Pros: keeps the history while making the current state clear; cheap.
    - Cons: the size table still shows old figures until someone re-measures.
  - **Re-measure `full` and replace the table.**
    - Pros: accurate numbers.
    - Cons: the figure moves with every new public action and is not a gate (only voice is budgeted), so it would go stale again.

**Outcome (2026-11-06).** Done as recommended, with one addition: the same harness gave current figures cheaply, so the dated note under the size table records them rather than only saying that `full` grew (D26). The operator Build Pipeline actions and their required capabilities are documented. The OpenCode test enforces the shared toolchain version pin instead of maintaining a separate hardcoded version.

The goal is to let an external agent, in particular a realtime voice agent,
do everything the public CLI can do through Control MCP, without loading
60 or more tool definitions into its context up front. Four parts:

- A small, always-loaded core of tools, chosen for spoken requests.
- Gateway meta-tools that reveal the rest of the public action catalogue on
  demand.
- Scoped credentials that choose a tool profile.
- One contract shared with the CLI: the versioned public actions, their
  request keys, receipts and error codes.

## Current state

All of that is built. The durable description lives in the architecture
docs; this file keeps the evidence, the decisions and the work that is left.

- [`control-mcp.md`](../../architecture/control-mcp.md): credentials and
  profiles, tool tiers, results, confirmation, authority, and the original
  operator tools over public actions (with their recorded behaviour
  differences).
- [`control-mcp-voice.md`](../../architecture/control-mcp-voice.md): setting up
  a voice client, the voice tools, spoken confirmation, the attention relay,
  the local relay for hosted voice platforms, and the qualification harness.
- [`public-cli.md`](../../architecture/public-cli.md): the new `attention`,
  `ticket` and `mail` commands and the CLI/MCP parity test.

What exists, by part:

- **Protocol** (`packages/protocol/src/`):
  - `public-api.ts`: new actions `attention.list`, `ticket.list/get/create/update/comment`,
    `mail.mailboxes/send`; limits `attentionDefaultItems`/`attentionMaxItems`.
  - `public-api-inputs.ts`: schemas, capabilities (`sessions.read` for
    attention, `tickets`, `mail`) and confirmation classes for the new actions.
  - `control-mcp.ts`: profiles, capability presets, `controlMcpActionAllowed`,
    `controlMcpConfirmationRule`, `isApprovalResolution`, the voice budgets.
  - `public-api-wait.ts`: `classifyReceiptForWait`, shared by the CLI and
    `run_status`.
  - `public-api-cli.ts`: `PUBLIC_ACTION_CLI_COMMANDS` for `describe_action`.
  - `public-api-resources.ts`: attention and ticket result types.
- **Backend** (`apps/backend/src/core/`):
  - Authority: `PublicAuthority = "operator" | "control-mcp:<id>"`
    (`public-api/operation-ledger.ts`), passed in-process through a symbol
    key (`PUBLIC_ACTION_AUTHORITY` in `public-api/dispatch.ts`); `loadOperation`
    and `findPublicOperationsByRequest` are scoped to it; the reconciler runs
    as the operator.
  - New handlers: `public-api/actions-attention.ts`, `actions-tickets.ts`,
    `actions-mail.ts`.
  - Control MCP split: `control-mcp/server.ts` (listener, authentication,
    credentials), `control-mcp/tools.ts` (composition; since 2026-11-06 the
    shared tools are in `control-mcp/environment-tools.ts`,
    `launch-tools.ts`, `ticket-tools.ts` and `mail-tools.ts`, D25),
    `control-mcp/coordinator-tools.ts` and `control-mcp/tool-support.ts`
    (was one file, 2,824 lines on `main`), plus
    `control-mcp/credentials.ts`, `confirm.ts`, `caller.ts`, `results.ts`,
    `gateway.ts`, `voice.ts`, `resolve.ts`, `direct-tools.ts`,
    `operator-tools.ts` and `lean-schema.ts`.
  - Registry commands `create_control_mcp_credential`,
    `rotate_control_mcp_credential`, `revoke_control_mcp_credential`
    (`commands-registry-control.ts`); `rotate_control_mcp_token` rotates
    `default`.
- **CLI** (`packages/cli/`): `CommandSpec.action` and `inputFields`,
  `SHARED_INPUT_FIELDS`; commands `attention`, `ticket …`, `mail …`;
  `waitForOperation` uses the shared classifier; reference scripts
  `examples/voice-attention-relay.ts`, `examples/voice-qualify.ts` (the
  scripted run, `--expect-approval`, `--record`, `--score`),
  `examples/voice-mcp-relay.ts` (a recording relay for a real voice runtime)
  and `examples/voice-recording.ts` (the recording format and scoring).
- **Web**: Settings → MCP (`apps/web/src/components/settings/McpSettings.tsx`)
  lists credentials, creates one with a profile (custom: a capability list),
  and gives each Copy setup for Codex, Claude Code and "Other or voice
  client", Rotate and Revoke.

Measured on this branch (2026-10-24, `control-mcp/voice.test.ts` harness):

| Profile | Tools | `tools/list` bytes |
| --- | --- | --- |
| `voice` | 12 | 7,095 (budget 8,000) |
| `read-only` | 40 | 24,073 |
| `full` (the migrated `default`) | 82 | 76,374 |

Note (2026-11-06, D26): these figures predate #1268 and later public
actions. Measured again on `main` at `c1724ab7` with the same harness:
`voice` 12 tools, 7,757 bytes (still within its 8,000-byte budget);
`read-only` 62 tools, 47,827 bytes; `full` 153 tools, 209,198 bytes. Only
`voice` is budgeted, so the other two will keep moving.

## Work items

1. **Decisions.** Done. Questions 1 to 4 were settled on 2026-10-16;
   questions 5 to 7 are settled under Assumptions and decisions (D11 to D13).
2. **Input schemas.** Done before this branch.
3. **Authority plumbing.** Done.
   - Evidence: `public-api/public-api-authority.test.ts` (an `authority` field
     in request JSON is ignored; the same request ID under two authorities
     makes two operations; `run.get` by ID and by key, `run.retry/discard/cancel`
     and `session.stop` with `expectedOperationId` refuse another authority's
     operation as `not-found`); `control-mcp/voice.test.ts` "credentials and
     the CLI cannot read or collide with each other's operations".
4. **Scoped credentials and profiles.** Done.
   - Evidence: `control-mcp/credentials.test.ts` (version 1 token migrated to
     `default`/`full` and still accepted, mode 0600; independent rotate and
     revoke, persisted across restarts; ungrantable capabilities, unknown
     profiles, empty custom lists and bad `deniedActions` refused; invalid
     stored credentials dropped); `control-mcp/voice.test.ts` exact
     `tools/list` per profile; coordinator `tools/list` filtered by capability
     (`control-mcp/tools.ts` `filteredToolServer`; a side agent with
     `discovery` and `mail` lists no launch, ticket or pipeline tool:
     `control-mcp/credentials.test.ts`); Settings →
     `McpSettings.test.tsx` (7 tests: list, copy each recipe, create, rotate,
     revoke, disabled, errors).
5. **Result mapper.** Done: `control-mcp/results.ts` (`envelopeToolResult`,
   `voiceText`, `nextHint`, `adapterError`). Evidence: voice text bounded to
   2 KB and `next` hints (`read_session`, `prompt_session` busy →
   `steer_session`, `run_status` → `answer_question`) in
   `control-mcp/voice.test.ts`.
6. **Gateway tools.** Done: `find_actions`, `describe_action`, `run_action`,
   `run_status` and confirm tokens (`control-mcp/gateway.ts`,
   `control-mcp/caller.ts`, `control-mcp/confirm.ts`). Evidence: every action
   an MCP credential can hold reaches its handler through `run_action` (the
   envelope carries the backend identity); the request-key rule; ranked
   search; `describe_action` schema and CLI line; `run_status` early stop on a
   pending interaction; confirm tokens bound to credential, action, input and
   expiry (`control-mcp/voice.test.ts`, `control-mcp/credentials.test.ts`
   "confirm tokens").
7. **Voice core tools.** Done: `overview`, `resolve_target`, `read_session`,
   `prompt_session`, `steer_session`, `stop_session`, `answer_question`,
   `start_work` (`control-mcp/voice.ts`, `control-mcp/resolve.ts`). Evidence:
   `control-mcp/voice.test.ts` (resolve never guesses, bounded excerpt, busy
   refusal, start and replay, approval confirmation and direct denial).
8. **Attention feed.** Done: `attention.list`, `orkestrator attention
   [--follow --jsonl]`, `overview` uses it, reference relay
   `packages/cli/examples/voice-attention-relay.ts`. Evidence:
   `public-api/public-api-attention.test.ts`,
   `packages/cli/tests/attention-ticket-mail-command.test.ts`,
   `packages/cli/tests/voice-attention-relay.test.ts`; the qualification
   harness: `packages/cli/tests/voice-qualify.test.ts`.
9. **Convergence.** Done, with the read tools narrowed (D7).
   - The original mutation tools for operator credentials are one public
     action each; `list_projects`, `list_tickets`, `get_ticket` and
     `list_mailboxes` read their public action. Behaviour differences are
     recorded in `control-mcp.md` ("Operator tools over public actions").
     Evidence: `control-mcp/operator-tools.test.ts`.
   - `ticket.*` and `mail.*` public actions and CLI commands. Evidence:
     `public-api/public-api-tickets-mail.test.ts`, the CLI test above.
   - `CommandSpec.action`. Evidence: `packages/cli/tests/command-actions.test.ts`.
10. **Parity and budget tests.** Done; see Tests and qualification.
11. **Docs.** Done: `control-mcp.md`, `public-cli.md`, `agent-messaging.md`,
    new `control-mcp-voice.md`, the catalog in `docs/README.md`, and a pointer
    from the gateway constraint, now in
    [`public-cli.md`](../../architecture/public-cli.md#rules-for-new-client-features)
    (to-do 0017 was retired on 2026-11-11).
    The file is not fully ticked (see Remaining work), so it stays; its
    durable behaviour is already in `architecture/`.
12. **Optional.** Deferred, not built (D13, D14): `delegate`, and a stateful
    MCP session with `list_changed` and resource subscriptions.

## Tests and qualification

| Check | Status | Where |
| --- | --- | --- |
| Exact `tools/list` per profile | Done | `control-mcp/voice.test.ts` "each profile lists exactly its tools"; the original 18 stay first in `full` (`control-mcp/server.test.ts`) |
| Voice budget ≤ 8,000 bytes; full size reported | Done: 7,095 and 76,374 bytes (7,757 and 209,198 on 2026-11-06, D26) | `control-mcp/voice.test.ts`; table above |
| Every action has a schema, capability and confirmation class | Done | `packages/protocol/src/public-api-inputs.test.ts`, backend `public-api/public-api-inputs.test.ts` (251 cases, including the new actions) |
| Every action reachable through `run_action` under `full` and mapped to a CLI command | Done | `control-mcp/voice.test.ts`; `packages/cli/tests/command-actions.test.ts` |
| Every direct and core tool names its actions | Done | `control-mcp/voice.test.ts` |
| Confirmation token bound to credential, action, fingerprint, expiry | Done | `control-mcp/credentials.test.ts`, `control-mcp/voice.test.ts` |
| Authority isolation | Done | `public-api-authority.test.ts`, `control-mcp/voice.test.ts` |
| Portability of every profile | Done | `mcp-tool-schema-portability.test.ts` (full, voice, read-only, custom, coordinator) |
| Coordinator regression | Done | `control-mcp/server.test.ts`: the coordinator tests pass as they were; nine former operator tests now run under a coordinator credential (the path that keeps those implementations) and two that covered removed operator-only branches moved to `control-mcp/operator-tools.test.ts` |
| `mise run test` (non-iOS) on the rebased branch | Fails only on unrelated cases | every failure passed alone and is a registered flake (0192, 0632, 0244, 0258, new 0775), except the 14 OpenCode execution-policy conformance cases, which fail on `main` too: #1198 moved the OpenCode pin to 1.19.4 and `conformance-execution-policy.test.ts` still expects 1.19.0. Fixed since (2026-11-06 note, D26): the test asserts the shared `PINNED_TOOLCHAIN_VERSIONS.opencode` pin; `policyQualificationCli` resolves its default CLI from that manifest-pinned directory (`tests/conformance/execution-policy/vendor-cli.ts`) |
| `mise run test` (non-iOS), 2026-10-25 branch | Fails only on unrelated cases | three failures, each passed alone: registered flakes 0785 (OpenCode research server) and 0791 (Codex command catalogue), and new flake 0935 (environment-move Cursor read failure, five-second deadline; owner 37/37 alone) |
| Live: the script over MCP with a real agent; real MCP clients on `full` | Done (no speaking model) | Live evidence |
| Live: the approval step with a real command approval | Done 2026-10-25 | Live evidence, "Real command approval" |
| Recording relay and scoring of misresolved targets and handle copy errors | Done 2026-10-25 | `packages/cli/tests/voice-recording.test.ts` (11 tests: targets and result IDs, no prompt or token in a recording, zero score for exact handles, misresolution versus copy error, repeats following the latest session, report, relay forwarding and bounds, `--score`, `--expect-approval` pass and fail); a live relay recording scored 0 / 0 |
| Live: a realtime voice runtime runs the script | Moved to the manual-test checklist (2026-11-10) | Remaining work 1 |

## Remaining work

1. **Live voice qualification.** Run the script (overview; start work; answer
   an approval; stop; read the result) through a real realtime voice runtime
   on this machine, directly or through a local relay, and record p50/p95
   tool latency (target p95 under 1 s for reads), misresolved targets,
   session-handle copy errors, and tool-definition and result token counts.
   `packages/cli/examples/voice-qualify.ts` runs the same script without a
   speaking model and measures everything but the two model-dependent
   counts; Live evidence records its runs with a real Claude session.
   - (b) **Done 2026-10-25:** the approval step with a real command approval.
     An environment set to Settings → Execution policy → Approvals: Ask
     raised a real Claude `command-approval`; the harness confirmed it
     (`confirmation-required`, then the call with `confirmToken`), approved
     it, and the command ran (Live evidence, "Real command approval"). The
     earlier note that "no public setting enables approvals" was right about
     public actions but missed the environment's own policy override, which
     is enough (D19).
   - (a) Moved to the manual-test checklist on 2026-11-10: the same script
     driven by a realtime voice runtime, for misresolved targets and
     session-handle copy errors. It needs realtime-model credentials and a
     person speaking. The tooling is ready and tested: `voice-mcp-relay.ts`
     records a runtime's calls (IDs and sizes only) and
     `voice-qualify.ts --score` counts both errors (D20, D21); a live relay
     recording of the scripted run scored 0 / 0. The procedure is in
     [`control-mcp-voice.md`](../../architecture/control-mcp-voice.md#qualifying-a-voice-runtime).
2. **Optional, deferred:** `delegate` into a coordinator turn (D13), and a
   stateful MCP session with `list_changed` and subscriptions (D14). Each
   needs its own todo file when it is wanted.

## Live evidence

Node mbp3 (macOS, Darwin 25.6), 2026-10-24, isolated profile
`dev:test --profile mcp-voice-0041 --fixture --credential-source claude
--agent-platforms claude` on this branch; profile stopped and reset afterwards.

- **Migration on a real backend.** The profile's `control-mcp.json` was
  written as version 2, mode 0600, with one credential `default` / `full`.
- **Settings → MCP in a real browser** (Playwright on the profile's
  `browserUrl`): the panel listed `Default`, created a `Voice assistant`
  credential with the Voice profile and switched the setup to it; after a
  page reload both credentials came back from the backend; the narrow
  (420 px) layout showed the credential cards, Rotate and Revoke. Screenshots
  are under `output/agent-testing/mcp-voice-0041/` (not committed).
- **CLI against the real backend:** `orkestrator attention` listed the CLI's
  own settled `environment.create`/`environment.start` runs and the finished
  setup; `ticket create`, `comment`, `update --status done` and
  `ticket list --status done` round-tripped; `mail mailboxes` answered.
- **Voice script over MCP with a real Claude session**
  (`packages/cli/examples/voice-qualify.ts`, voice credential, 20 repeats per
  read): overview → `start_work` (Claude, a prompt that makes it ask a
  question) → a real pending question detected through `run_status`
  (`waiting-for-input`), read with `run_action session.interactions` and
  answered with `answer_question` (no confirmation: a question) →
  `stop_session` → `read_session`. Every step succeeded.

  | Measure | Result |
  | --- | --- |
  | Voice `tools/list` | 12 tools, 7,118 bytes (about 1,780 tokens) |
  | Reads (`overview`, `read_session`, `run_status`), p50 / p95 | 2.7 ms / 4.1 ms (target p95 < 1 s: met) |
  | `start_work` (provider dispatch) | 517 ms |
  | `answer_question`, `stop_session` | 15 ms, 123 ms |
  | Largest result text | 427 bytes (about 107 tokens), `overview` |

  An earlier run, whose prompt only said "ask before running anything",
  produced a real question too; the harness then answered `answer` with no
  answers and the public action refused it as `invalid-input` (a required
  question must be answered), which is why the harness now reads the
  interaction first (D18). No command approval was raised: the profile ran
  Claude with the default (auto-approve) host policy, and no public setting
  turns approvals on, so the approval-confirmation path is covered by the
  scripted-provider tests only.
- **Real MCP clients on the `full` profile** (the migrated `default`
  credential, 82 tools):
  - Claude Code 2.1.310 (`claude -p --strict-mcp-config`) called
    `find_actions` (returned the five `ticket.*` actions), the original
    `list_projects`, the generated `ticket_list` direct tool and `overview`,
    and reported each correctly.
  - Codex CLI 0.162.1 (`codex exec`, bearer token from an environment
    variable) called `find_actions`, `attention_list` and `describe_action`
    (`cli: orkestrator session prompt`); 13,566 tokens for the whole run.
- Not measured: misresolved spoken targets and session-handle copy errors
  (no speaking model or person; see Remaining work 1).

Node arktech-mini (macOS, Darwin 27.0), 2026-10-25, isolated profile
`dev:test --profile mcp-voice-0041b --fixture --credential-source claude
--agent-platforms claude` on branch `todo-0041-control-mcp-voice-699c0075ce9c`;
profile stopped and reset afterwards.

- **Real command approval.** A local environment of the fixture project was
  created with `executionPolicy.approvals: "ask"` (the Settings → Execution
  policy → Approvals: Ask override, set through
  `update_environment_agent_settings`, as the renderer does), and a Voice
  credential was created (`create_control_mcp_credential`, 12 tools,
  7,118 bytes). `voice-qualify.ts --expect-approval` then ran the script with
  a real Claude session:
  1. A first attempt with a read-only prompt (`ls`) raised nothing: Claude
     runs read-only commands without asking even under Ask. The approval
     script's default prompt now writes a canary file instead.
  2. With `printf voice > voice-qualify-canary.txt`, Claude raised a real
     `command-approval`; `run_status` reported `waiting-for-input`; the
     harness read it with `session.interactions`; the first `answer_question`
     returned `confirmation-required` with a token; the repeat with
     `confirmToken` approved it. Two runs stopped the turn straight after the
     answer (a real mid-turn stop, 123 ms and 129 ms) before the command
     ran, so the harness now waits for the run to settle first.
  3. The final run: approval confirmed and answered, run then `completed`,
     `stop_session` refused as `session-idle` (the turn had finished), and
     `voice-qualify-canary.txt` in the environment's worktree contained
     `voice`: the approved command ran.

  | Measure (final run, through the recording relay) | Result |
  | --- | --- |
  | Voice `tools/list` | 12 tools, 7,118 bytes (about 1,780 tokens) |
  | Reads (`overview`, `read_session`, `run_status`), p50 / p95 | 4.2 ms / 78 ms (target p95 < 1 s: met) |
  | `start_work` | 485 ms |
  | `answer_question` (refusal, then confirmed) | 11.8 ms / 17.6 ms |
  | Largest result text | 400 bytes (about 100 tokens) |
  | `selfCheck` and relay score | 34 targeted calls; 0 misresolved, 0 copy errors |

- **Recording relay against the real backend.** The same runs went through
  `voice-mcp-relay.ts` (loopback, the client's own Authorization header): 54
  calls recorded, `voice-qualify.ts --score` gave the same counts as the
  harness's own `selfCheck`, and the recording contained no prompt text
  (`printf` appears 0 times) and no token.

## Constraints and rationale

- **No raw registry dispatch.** `run_action` accepts only `PUBLIC_ACTIONS`
  names and enters through `dispatchPublicAction`. It is not a wrapper
  around `invoke`.
- **Request keys.** Every mutation keeps request-key and fingerprint rules
  and persists before any side effect. MCP mutations require a caller
  `requestId`, as the existing tools do. The server instructions say to
  reuse it only when retrying after an ambiguous response.
- **Authority source.** Authority comes from the credential only, never
  from input.
- **Network.** The listener stays loopback-only; this plan adds no public
  listener.
- **Caller intent.** Never change it automatically. For example, a busy
  prompt is never turned into a steer.
- **The CLI transport does not change.** This plan does not make the CLI an
  MCP client.
- **Withdrawing an action** still means removing its handler. Capabilities,
  gateway listings and direct tools follow from the handler table.

## Decisions

Settled on 2026-10-16.

1. **Authority:** each MCP credential dispatches under its own authority,
   `control-mcp:<credentialId>`. It cannot read the CLI's or another
   credential's operations.
2. **Storage:** credentials stay in plaintext with mode 0600, so Copy setup
   works at any time. Each one can be rotated and revoked on its own.
3. **Voice approvals:** only approvals of a command or file change need a
   confirm token. The spoken description reads the command (truncated) or a
   summary of the file change. Denials and question answers run directly.
4. **Exec in voice:** excluded from the voice preset. A credential may be
   granted `exec` explicitly; every voice call then needs a confirm token.

Settled on 2026-10-24 (details under Assumptions and decisions):

5. **Multi Review and Build Pipelines** were kept coordinator-only (D11).
   Superseded for Multi Review and pull requests by #1268, and for Build
   Pipelines by `build.launch/list/get/cancel` (2026-11-06 note, D26).
   Operator Build Pipeline launch requires `environments.lifecycle`, list/get
   require `sessions.read`, and cancel requires `sessions.control`.
6. **Hosted voice platforms** use a local relay only; the remote (Tailscale)
   gateway is not opened to MCP (D12).
7. **`delegate`** into a coordinator turn is deferred (D13).

## Assumptions and decisions

Made while implementing items 3 to 12 on 2026-10-24. Each lists the options,
the choice, why, and its pros and cons.

**D1. How Control MCP dispatches public actions under a credential's authority.**
- Options: (a) an `authority` argument on the `public_action` registry
  command; (b) a second registry command for Control MCP; (c) an in-process
  symbol key on the `public_action` arguments; (d) a dispatcher object
  injected into `ControlMcpServer`.
- Chosen: (c), `PUBLIC_ACTION_AUTHORITY` / `withPublicAuthority`.
- Why: the gateway passes JSON, which cannot carry a symbol, so no external
  caller (renderer, CLI, remote node) can set it, while Control MCP keeps
  using the same `invoke` it already had.
- Pros: authority never comes from input; one entrypoint; no new command.
- Cons: a symbol property is invisible in logs and easy to drop if someone
  copies the arguments object; a malformed authority throws rather than
  falling back. The reconciler is started with a separate operator context so
  it never inherits a credential's authority.

**D2. How strictly operation reads are scoped.**
- Options: (a) scope only `run.get`; (b) scope every lookup by operation ID
  and by request key; (c) let the operator read everything.
- Chosen: (b). `loadOperation` treats another authority's record as
  `not-found`, and `findPublicOperationsByRequest` takes an authority.
- Why: decision 1 says a credential cannot read the CLI's or another
  credential's operations; `run.retry/discard/cancel/output` and
  `expectedOperationId` all go through `loadOperation`.
- Pros: one rule, no existence oracle (foreign IDs look missing).
- Cons: the CLI cannot `run get` a run a voice agent started; it sees the
  session itself. A user who wants both views uses the UI.

**D3. Credential storage and migration.**
- Options: (a) a new file beside `control-mcp.json`; (b) descriptor version 2
  in the same file; (c) SQLite storage.
- Chosen: (b). A version 1 token becomes `default` with the `full` profile.
  Only a missing or unreadable file starts fresh; a readable file whose
  credentials were all revoked stays empty after a restart. `lastUsedAt` is
  written at most once a minute.
- Why: decision 2 keeps plaintext 0600 for Copy setup, and keeping the
  descriptor means one atomic write for URL, PID and credentials.
- Pros: no migration step outside the file; existing setups keep working.
- Cons: `lastUsedAt` can lag by up to a minute and is lost on a crash before
  the flush; tokens are as readable as before (same file, same mode).

**D4. Tool shape of each profile.**
- Options: (a) `full` = direct tools only; (b) `full` = the 18 original tools,
  the voice core, the gateway and one direct tool per allowed action;
  (c) `full` without the duplicates of the original tools.
- Chosen: (b); `read-only` and `custom` use the same shape filtered by the
  rule; `voice` is the core plus the gateway.
- Why: the plan keeps the 18 documented names and asks for one direct tool
  per action; dropping either breaks a documented surface.
- Pros: every client finds every action, under the old names and the action
  names; one rule filters all of it.
- Cons: the migrated `default` credential now lists 82 tools (76,374 bytes)
  instead of 18. Clients that defer or search tools (Claude Code) cope; a
  client that loads everything up front pays the context. Mitigation: create a
  `voice` or `custom` credential; documented in `control-mcp.md`.

**D5. Direct-tool input schemas.**
- Options: (a) a JSON Schema to Zod converter; (b) the SDK's
  `fromJsonSchema`.
- Chosen: (b). `@modelcontextprotocol/server` 2.3.1 exports
  `fromJsonSchema(schema, validator?)`; schemas are compiled once per process
  because the server is rebuilt for every request.
- Pros: the published schema is exactly the protocol schema; no converter to
  maintain.
- Cons: the SDK validates with its own JSON Schema validator before the
  handler runs, so a schema mistake shows as an SDK validation error rather
  than a public envelope (the handler still validates authoritatively).

**D6. Voice and gateway schemas.**
- Options: (a) Zod, like the original tools; (b) hand-written lean JSON
  Schemas (`control-mcp/lean-schema.ts`); (c) generate them from the action
  schemas.
- Chosen: (b), plus dropping `title` and sending only non-default annotation
  hints on those twelve tools.
- Why: with Zod (which publishes `$schema` and every bound) and titles the
  voice list measured 9,849 bytes against the 8,000-byte budget; lean schemas
  bring it to 7,095.
- Pros: inside the budget with about 900 bytes of headroom; handlers still
  validate every value.
- Cons: no length limits in those twelve published schemas, and the tool
  types are declared by hand.

**D7. How far the original operator tools converge.**
- Options: (a) rebase all 18 on public actions and change their outputs to
  public shapes; (b) rebase every mutation and the reads with an exact mapping,
  keep the documented output shapes, and leave the other reads on their
  registry projections; (c) leave them all as they were.
- Chosen: (b). Mutations: `launch_environment`, `launch_job`,
  `send_prompt_to_tab`, `create_ticket`, `update_ticket`,
  `add_ticket_comment`, `send_message`. Reads: `list_projects`,
  `list_tickets`, `get_ticket`, `list_mailboxes`. Coordinator credentials
  keep their own implementations; the operator-only branches that became
  unreachable (`create_environment` plus background start in
  `launch_environment`, external mail in `send_message`) were removed.
- Why: convergence matters where behaviour can diverge, which is in side
  effects (request keys, fingerprints, the busy rule). The remaining reads
  (`get_launch_options`, `list_environments`, `get_environment`, `list_tabs`,
  `list_agents`, `get_tab_state`, `get_tab_transcript`) return pane state,
  terminal tabs, raw startup state and launch defaults the public reads do
  not carry; mapping them would silently change documented outputs.
- Pros: one implementation of every operator side effect; documented shapes
  unchanged (plus `receipt`).
- Cons: seven reads still have two implementations (the tool and the public
  read). Recorded behaviour changes: keys used before this change are not
  matched afterwards; a busy session refuses `send_prompt_to_tab`; `launch_job`
  no longer focuses its tab; `send_message` returns a smaller result; errors
  are envelopes.

**D8. `update_ticket`'s request key.**
- Options: (a) require a new `requestId` field; (b) derive the key from the
  update.
- Chosen: (b), `update-ticket-<sha256 of the canonical update>`.
- Why: the tool never took a `requestId`, and replacing fields is
  idempotent, so the derived key replays retries without breaking clients.
- Pros: no client change. Cons: an identical update repeated later replays
  instead of running again (harmless: it would set the same values).

**D9. Pending interactions in `attention.list`.**
- Options: (a) only the in-memory projection cache; (b) read every native
  session's pending interactions; (c) read only sessions the backend observes
  as `waiting`, or whose cached projection already shows something pending.
- Chosen: (c), with the same cached (10 s) pending-interactions read
  `session.interactions` makes.
- Why: (a) missed every background environment in testing, because a
  projection is built only when something reads the session; (b) would call
  every bridge on every poll.
- Pros: background approvals are heard; idle sessions cost nothing.
- Cons: a session the activity sweep has not yet marked `waiting` is missed
  until it is. Interaction bodies are left out of the feed (titles only).

**D10. Confirm tokens.**
- Options: (a) server-side pending confirmations; (b) a stateless HMAC token.
- Chosen: (b), per the plan: HMAC(per-process secret, credential, action,
  canonical input fingerprint, expiry), 120 s. The fingerprint covers the
  input but not `requestId`. A refused token returns a fresh
  `confirmation-required` (with `refused: mismatch | expired | malformed`)
  rather than a bare error. An approval whose interaction cannot be read is
  confirmed.
- Pros: no state on a stateless server; changed input, expiry and
  cross-credential replay are refused. Cons: a restart voids outstanding
  tokens (one repeated question); a client could chain the refusal's new
  token without asking the person, which the server instructions forbid but
  cannot prevent.

**D11. Open question 5: Multi Review and build pipelines as operator actions.**
- Options: (a) add public actions now; (b) keep them coordinator-only.
- Chosen: (b).
- Why: both depend on coordinator associations (delegation bases, workflow
  wakes, conversation adoption) that an operator credential does not have,
  and the operator already has the app's Build and Multi Review buttons.
- Pros: no half-qualified operator path. Cons: a voice or coding agent cannot
  start them through MCP; a new todo file can add them when someone needs it.
- Superseded for Multi Review, pull requests and Build Pipelines (2026-11-06
  note, D26):
  since `32317ae6` (#1268) `review.launch/list/get/open/address/cancel` and
  `pr.create/resolve` are public actions (`packages/protocol/src/public-api.ts`)
  with operator tools, and the `full` profile lists the Multi Review tools
  (`docs/architecture/control-mcp.md`, the profile table). Operators can also
  launch, list, inspect and cancel Build Pipelines through the public actions
  `build.launch/list/get/cancel`, exposed as `build_launch/list/get/cancel`
  direct tools when the credential allows them. Launch requires
  `environments.lifecycle`, list/get require `sessions.read`, and cancel
  requires `sessions.control` (`packages/protocol/src/public-api-inputs-build.ts`).

**D12. Open question 6: hosted voice platforms.**
- Options: (a) local relay only; (b) expose Control MCP through the remote
  (Tailscale) gateway.
- Chosen: (a). Documented in `control-mcp-voice.md`.
- Why: the plan's constraint is no public listener, and the remote gateway
  authenticates operators of the whole app, not scoped MCP credentials.
- Pros: the credential and the loopback boundary stay local. Cons: a hosted
  platform needs a relay process on the machine.

**D13. Open question 7 and item 12: `delegate`.**
- Options: (a) build a `delegate` public action that starts a coordinator
  turn; (b) defer.
- Chosen: (b).
- Why: external messages are inbox-only by design; starting a coordinator
  turn from outside needs a deliberate authenticated path, its own
  capability and its own loop budget, and nothing else in this plan needs it.
- Pros: no new injection path. Cons: voice agents keep composing tool calls
  themselves.

**D14. Item 12: stateful session with `list_changed`.**
- Options: (a) build it; (b) defer.
- Chosen: (b). The gateway already reaches everything from a fixed list, and
  realtime voice clients fix their tool list at session start anyway.
- Pros: no session state to bound or expire. Cons: no push of new tools or
  resource subscriptions.

**D15. The CLI equivalent in `describe_action`.**
- Options: (a) the backend imports the CLI's command table; (b) a protocol
  table checked against it.
- Chosen: (b), `PUBLIC_ACTION_CLI_COMMANDS`, which
  `command-actions.test.ts` requires to equal the first command naming each
  action.
- Why: the backend must not depend on the CLI package.
- Pros: no cross-package import. Cons: a second table, kept honest by a test.

**D16. Flag names that differ from input properties.**
- Options: (a) per-command maps only; (b) a shared map for conventions plus
  per-command maps.
- Chosen: (b), `SHARED_INPUT_FIELDS` (`project` → `projectId`, `prompt-file`
  → `prompt`, …) and `inputFields` where a command differs; observer flags
  (`request-id`, `wait`, `timeout`, …) are listed in the test.
- Pros: short per-command maps. Cons: a convention change touches every
  command at once (by design).

**D17. Splitting `control-mcp/server.ts`.**
- It was 2,373 lines, over the repository's 2,000-line limit, and `main`
  grew it to 2,824 (remote workflows, #1211) while this branch was open. The
  listener, authentication and credentials stay in `control-mcp/server.ts`;
  the shared tools are in `control-mcp/tools.ts`; the coordinator-only
  workflow tools moved unchanged to `control-mcp/coordinator-tools.ts`, with
  the helpers both use in `control-mcp/tool-support.ts`; each new part has its
  own module. Operator credentials are refused a `nodeId`, which `main` made
  coordinator-only, with `main`'s own message.
- Pros: no source file over the limit; the rebase replayed this branch's
  edits onto `main`'s file mechanically. Cons: `control-mcp/server.test.ts`
  (2,872 lines on `main` before this change) is still over the limit;
  splitting it would rewrite a file `main` keeps changing, so it is left for
  its own change.

**D18. How the qualification harness answers.**
- Options: (a) send `answer` with no answers; (b) read the interaction with
  `session.interactions` and choose the option a "yes" means (an option
  labelled yes, allow, approve, proceed, continue or ok, else the first; free
  text "yes" where a required question has no options).
- Chosen: (b), after (a) was refused live.
- Pros: behaves like a voice agent that heard the question. Cons: it is a
  heuristic for a harness, not product behaviour; `answer_question` itself
  never guesses an answer.

**D19. How the qualification gets a real command approval.**
- Options: (a) add a public setting (for example `agent.approvals`) so the CLI
  and MCP can turn approvals on; (b) use the environment's existing execution
  policy override (Settings → Execution policy → Approvals: Ask, stored by
  `update_environment_agent_settings`); (c) a dev-only flag on `dev:test`.
- Chosen: (b), with `--expect-approval` in the harness, which fails the run
  unless a command or file approval is confirmed and answered, and defaults to
  a prompt that writes a file.
- Why: host and container sessions auto-approve by design and `ask` is the
  documented override; a public approvals setting would let any credential
  holding `settings` loosen a human-in-the-loop guard, which the qualification
  does not need.
- Pros: no new security-relevant surface; the run uses the policy a user
  would set. Cons: the setup step is in the UI (or the renderer's command),
  not scriptable through the public CLI.

**D20. How misresolved targets and copy errors are captured from a real runtime.**
- Options: (a) ask the person to log errors by hand; (b) a recording relay
  between the runtime and Control MCP; (c) record inside the backend.
- Chosen: (b), `voice-mcp-relay.ts`: loopback only, forwards each request
  with the runtime's own Authorization header (it holds no token), buffers
  each response, and records per call only the tool, latency, outcome, the
  IDs it targeted and the IDs its result returned.
- Why: it works with any runtime that takes an MCP URL, keeps the backend
  unchanged, and the recording carries no prompts, answers, result text or
  token.
- Pros: repeatable, scored by a program. Cons: it buffers responses (fine for
  Control MCP's single stateless replies, not a general streaming proxy); a
  hosted platform still needs its own relay (D12).

**D21. How a recording is scored.**
- Options: (a) per-step expected targets written by the person; (b) infer
  from the script's single environment and the latest session `start_work`
  started in it.
- Chosen: (b), so one recording can hold several repeats. A targeted ID that no earlier result returned (and the run
  was not given), or a malformed `ses_` handle, is a copy error; a returned
  ID that is not the script's environment, project or session is a
  misresolution; operation and interaction IDs are checked for copy errors
  only. Rates are per targeted call.
- Why: no annotation step, and the script addresses exactly one environment
  and one session.
- Pros: automatic and exact for the script. Cons: only valid for that
  script (addressing an earlier repeat's session counts as a misresolution); a session reached by `environmentId` plus a wrong `tabId` counts as
  a copy error, since the handle was never returned.

**D22. When the harness stops after answering.**
- Options: (a) stop straight after the answer; (b) wait, up to 30 s, until
  the run finishes or asks again, and treat `session-idle` at the stop step
  as "already finished".
- Chosen: (b), after (a) interrupted the approved command before it ran in
  two live runs.
- Pros: the run proves the answer took effect. Cons: the stop step usually
  meets an idle session in the approval script; a real mid-turn stop is
  covered by the runs without `--expect-approval` and by the earlier evidence.

**D23. Task 4: how `control-mcp/server.test.ts` is split (2026-11-03).**
- Options: (a) the five areas the ticket named (server, tools, voice,
  operator workflow, review actions); (b) the source module each test block
  actually exercises; (c) equal-sized chunks in file order.
- Chosen: (b). The file had no voice, operator-workflow or review-action
  tests of its own; those already live in `control-mcp/voice.test.ts`,
  `control-mcp/operator-tools.test.ts` and `control-mcp/pr-tools.test.ts`.
  Its 62 tests divide into:
  - `control-mcp/server.test.ts`: credentials, the descriptor, transport,
    transfers and the coordinator invoker guard (`control-mcp/server.ts`).
  - `control-mcp/server-coordinator-workflows.test.ts`: worker, workflow,
    review and schedule tools (`control-mcp/coordinator-tools.ts`,
    `control-mcp/coordinator-worker-tools.ts`, `control-mcp/review-actions.ts`,
    `control-mcp/account-tools.ts`).
  - `control-mcp/server-reads.test.ts`: tool listing and instructions, and
    the project, environment, tab, prompt, ticket and node tools.
  - `control-mcp/server-launch.test.ts`: `get_launch_options`,
    `launch_environment`, `launch_job` and the coordinator launch base.
  - `control-mcp/server-messaging.test.ts`: the agent mail tools and the
    delegation wake contract.
  The scripted invoker, `rpc`, `rpcPayload`, `BASE` and
  `coordinatorCredential` moved unchanged into
  `control-mcp/server-test-support.ts` (`useControlMcpServerHarness`).
  Test bodies moved byte for byte. Each file keeps the `describe` name, so
  every test's full name is unchanged. The `for (const mode …)` loop stays
  whole in the server file, although its third test (the workflow wake
  promise) is a workflow test, because splitting a loop would change the
  file's structure, not just move it.
- Why: the test files then match how `control-mcp/tools.ts` will be split
  (D24), which is what this task asked for.
- Pros: each tools module will have one test file; every file is under
  1,000 lines. Cons: the reads file spans several small tool groups, and the
  credentials test ("binds coordinator credentials…", 505 lines) still calls
  tools from most groups.
- Evidence (rechecked 2026-11-03, from `apps/backend` with `NODE_ENV=test`
  and `--reporter=junit`):
  - Before: the parent commit's `control-mcp/server.test.ts`, run alone,
    gave 62 pass, 0 fail, 565 `expect()` calls.
  - After, all five files with `--parallel=5`: 62 pass, 0 fail, 565
    `expect()` calls.
  - After, each file alone: server 13 tests / 177 expects,
    coordinator-workflows 10 / 125, reads 11 / 100, launch 16 / 82,
    messaging 12 / 81 (62 tests, 565 expects in total), all passing.
  - Names: the sorted `describe > test` list from each junit report has 62
    entries. Two names appear twice because the `for (const mode …)` loop
    runs them once per mode, both before and after. The list is identical
    across all three runs (`diff` empty; SHA-256 `ebc3673f…89938` for
    each).

**D24. Task 4: when and how `control-mcp/tools.ts` is split.**
- Options: (a) split it now, alongside the tests; (b) wait for #1664, which
  edits it, then split along the D23 boundaries.
- Chosen: (b). Done 2026-11-06 after #1664 merged (D25).
- Boundaries: keep `createControlMcp`'s composition, instructions, the
  listing filter and the shared helpers in `control-mcp/tools.ts`; move the
  launch tools and their launch-base helpers (tested by
  `control-mcp/server-launch.test.ts`), the project, environment, tab, prompt
  and ticket tools (`control-mcp/server-reads.test.ts`) and the mail tools
  (`control-mcp/server-messaging.test.ts`) into one module each, registered
  the way `registerCoordinatorWorkflowTools` already is.
- Pros: no rebase conflict with #1664; one split per boundary. Cons: the
  file stays at 2,272 lines until then.

**D25. Task 4: how `control-mcp/tools.ts` was split (2026-11-06).**
- Starting point: 2,593 lines on `main` at `c1724ab7`, almost all of it one
  function, `createControlMcp`, with every shared tool registered inline.
- Options for the module boundaries: (a) D24 exactly, with the project,
  environment, tab, prompt and ticket tools in one module; (b) D24 with the
  ticket tools in a module of their own.
- Chosen: (b). The modules:
  - `control-mcp/tools.ts` (461 lines): the capability map and role
    helpers, the listing filter, `withoutWakePromise`, and
    `createControlMcp`: instructions, the node routing closures
    (`onNode`, `nodeTickets`, `environmentInvoker`) and the calls that
    register each group. Every existing export stays here, so no importer
    changed.
  - `control-mcp/environment-tools.ts` (650): `list_projects`, the
    environment, tab, agent and transcript reads, and `send_prompt_to_tab`.
  - `control-mcp/launch-tools.ts` (781): `get_launch_options`,
    `launch_environment`, `launch_job`, the launch-base and launch-default
    helpers, and the two former closures `launchOptionsWithDefaults` and
    `selectionReport`, now built per invoker by `launchSettingsHelpers`.
  - `control-mcp/ticket-tools.ts` (335): the five ticket tools and their
    summary helpers.
  - `control-mcp/mail-tools.ts` (485): the six agent mail tools and the
    own-mailbox check, still inside their `if (messagingEnabled)`.
  - `control-mcp/tools-shared.ts` (115): the `ControlMcpToolContext` the
    modules receive, and the helpers more than one module uses
    (`MAX_PROMPT_LENGTH`, `COORDINATOR_WORKER_PROMPT_NOTE`,
    `asyncDelegationResult`, the two delegation openers,
    `coordinatorNodeRefused`). They cannot stay in `control-mcp/tools.ts`:
    the modules would then import values from the file that imports them,
    a runtime cycle the lint rejects.
- How: each tool's registration moved byte for byte (a script cut the
  original by line ranges); each module's function destructures the context
  names its tools use, so the bodies did not change. Registration order is
  `tools/list` order, which `control-mcp/server-reads.test.ts` pins, so
  `createControlMcp` calls the register functions in the original order,
  which is why launch and environment tools each have two entry points.
  One orphaned doc comment (about a mailbox fingerprint that lives in
  `control-mcp/poll-guard.ts`) was dropped.
- Why (b): tickets are their own tool group with their own helpers, and
  the combined module would have been the largest (about 950 lines).
- Pros: every file is under 800 lines; each group can change without
  touching the composition. Cons: `control-mcp/server-reads.test.ts` now
  covers two modules, not one.
- Evidence (2026-11-06):
  - The ten `initialize` and `tools/list` answers (main and side
    coordinators with messaging and scheduling on, messaging off, and
    scheduling off; operator `default`, `full`, `read-only` and `voice`)
    were captured to JSON before and after: identical, SHA-256
    `eca3097c…e10371` for both. That covers names, order, titles,
    descriptions, input schemas and the server instructions.
  - A line-multiset comparison of the original against the six new files
    leaves only import lines, the five helpers that gained `export`, the
    new context and register-function scaffolding, and the dropped comment.
  - `control-mcp/coordinator-schema-size.test.ts` and the other Control MCP
    and coordinator tests pass unchanged (see the stage's test record).

**D26. Task 5: how the stale statements were corrected (2026-11-06).**
- Chosen: the recommended option, annotate in place, with the figures
  re-measured because the harness made it cheap.
  - D11 and decision 5: marked superseded for Multi Review and pull
    requests by #1268, and for Build Pipelines by `build.launch/list/get/cancel`.
    Their operator capabilities are `environments.lifecycle` for launch,
    `sessions.read` for list/get, and `sessions.control` for cancel.
  - The profile table: a dated note under it with the current figures
    (`voice` 7,757 bytes, `read-only` 47,827, `full` 153 tools and 209,198
    bytes), measured with `controlMcpHarness` from
    `control-mcp/test-support.ts` on `main` at `c1724ab7`.
  - The `mise run test` row: marked fixed. The investigation above said the
    test pinned `opencode: "1.19.4"`; it now asserts the shared
    `PINNED_TOOLCHAIN_VERSIONS.opencode` pin rather than a separate hardcoded
    version. `policyQualificationCli` resolves its default CLI from that
    manifest-pinned directory.
- Pros: history kept, current state visible. Cons: the `read-only` and
  `full` figures will go stale again; only `voice` is a gate.

**Assumptions.**
- `capabilities` stays without a CLI command of its own; `connection check`
  reads it.
- Capability of `attention.list` is `sessions.read`: it reports pending
  interactions of sessions.
- Interaction kinds other than `question` count as approvals for voice
  confirmation, as the plan says, including MCP forms and plan approvals.
- A voice agent can copy a `ses_` handle exactly; aliases were not added
  (the plan asks to measure copy errors first, which needs Remaining work 1).

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, the live voice qualification) moved there on 2026-11-10.
