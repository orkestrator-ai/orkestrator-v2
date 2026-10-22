# Control MCP: voice profile, progressive disclosure and CLI parity

Checked against `main` at `9906db30` (2026-10-16).

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

### Control MCP

Code is in `apps/backend/src/core/control-mcp-server.ts`. The operator guide
is [`control-mcp.md`](../../architecture/control-mcp.md).

- **Transport:** Streamable HTTP on `127.0.0.1:34122/mcp`. The server is
  stateless: it is rebuilt for every request through
  `createMcpHandler(..., { legacy: "stateless" })`, and only POST is
  accepted. The SDK (`@modelcontextprotocol/server` 2.3.1) supports
  `sendToolListChanged()`, but a stateless server cannot deliver it, and the
  code never uses it.
- **Operator surface:** 18 tools. 16 are always present, plus
  `list_mailboxes` and `send_message` when `agentMessaging.enabled`. The
  exact ordered list is asserted in `control-mcp-server.test.ts`.
- **Coordinator-only tools:** `start_environment`/`stop_environment`, the
  build pipeline tools, the Multi Review tools, `get_repository_context`,
  `list_workflows`/`adopt_workflow`, and
  `read_messages`/`get_message`/`get_message_status`/`ack_message`.
- **Coordinator credentials:** one per conversation, held in memory with a
  12 h sliding TTL. `COORDINATOR_TOOL_CAPABILITY` is enforced on
  `tools/call`, but `tools/list` is not filtered.
- **Operator token:** one shared token, stored in plaintext in
  `<dataDir>/control-mcp.json` (mode 0600). Rotating it cuts off every
  client. There are no per-client or scoped operator credentials.
- **Not reachable through operator MCP:**
  - session stop, steer, config, history, resume and fork
  - interaction list and resolve
  - run get, retry, discard, cancel and output
  - environment start, stop, recreate, delete, fork, rename and config
  - exec
  - project add, create, update, remove and config

### Public API

- **Catalogue:** about 45 actions in `PUBLIC_ACTIONS`
  (`packages/protocol/src/public-api.ts`). Each descriptor has `version`,
  `mutation`, `effects`, `observation`, `waitConditions` and `summary`, but
  **no input schema**.
- **Validation:** handlers in `apps/backend/src/core/public-api/` check
  values by hand with the helpers in `input.ts` (`requiredString`, `oneOf`
  and so on). Their accepted keys come from `PUBLIC_ACTION_INPUTS`
  (`packages/protocol/src/public-api-inputs.ts`) through `onlyActionKeys`;
  see Input schemas.
- **Dispatch:** `dispatchPublicAction` (`dispatch.ts`) hard-codes
  `authority: "operator"` in `createPublicActionContext`.
- **Request keys:** a key is `sha256(authority, action, scope, requestId)`
  (`operation-ledger.ts`), bound to an intent fingerprint. Neither `run.get`
  nor the operation lookups are scoped by authority.
- **Waiting:** waiting happens only on the client. The CLI's `observe()`
  (`packages/cli/src/client/wait.ts`) backs off from 250 ms to 2 s, and
  `waitForOperation` (`commands/common.ts`) polls `run.get` and classifies
  the receipt.

### CLI

- `CLIENT_COMMANDS` (`packages/cli/src/client/main.ts`) is a table of
  `CommandSpec` entries (`spec.ts`). Path, summary and options are
  declarative.
- The action name and the input are built by hand inside each `run()`. The
  table never records which action a command calls.

### Sharing and gaps

- `control-shared-actions.ts` is shared in practice only through
  `validateSelection`, `launchEnvironmentCreateInput` and
  `cachedLaunchModels`.
- These features exist only in MCP and have no public action: tickets,
  agent mail, Multi Review, build pipelines, and terminal-tab state.

### Earlier decision

[`0017-cli-command-surface.md`](../cli-and-slash-commands/0017-cli-command-surface.md) records that the CLI uses
the gateway rather than an MCP client, and says "never expose raw registry
dispatch". This plan keeps that decision:

- The CLI does not change.
- The MCP gateway dispatches only public actions, in-process, never
  arbitrary registry commands.

## Target design

```
voice or agent client
  |  tools/list filtered by the credential's profile
  v
Control MCP adapter
  |-- core tools (voice-shaped; each mutation is exactly one public action)
  |-- gateway: find_actions / describe_action / run_action / run_status
  v
in-process public action dispatch   (authority = control-mcp:<credentialId>)
  v
PUBLIC_ACTIONS handlers             (the same handlers the CLI reaches through the gateway)
```

### Disclosure tiers

**Tier 0: core.** Always loaded, about 12 tools. Budget: the serialized
`tools/list` for the voice profile stays at or below 8,000 bytes, roughly
2,000 tokens.

**Tier 1: gateway.** Every other public action, revealed on demand:

- `find_actions(query?, group?)` returns, for each matching action: name,
  one-line summary, `mutation`, `effects`, its confirmation class, and
  whether this credential may call it. The output is capped at 15 rows.
- `describe_action(action)` returns the action's input JSON Schema, one or
  two examples, its `waitConditions`, and the equivalent CLI command.
- `run_action(action, input, requestId, confirmToken?)` dispatches exactly
  one public action. `requestId` is required for mutations and refused for
  reads, the same rule `dispatchPublicAction` applies.
- `run_status(operationId | requestId, action?, waitSeconds?)` reads
  `run.get`, with an optional bounded wait (see Waiting).

**Tier 2: profiles.** The credential decides which tools are registered:

- `voice`: core plus gateway, with capabilities limited (see Credentials).
- `full`: core plus gateway, plus one direct tool per allowed public action.
  This suits coding agents whose clients defer or search tool definitions.
- `read-only`: the read tools only.
- `custom`: an explicit capability list.

**Why a gateway rather than `tools/list_changed`:**

- The server is stateless.
- Client support for `tools/list_changed` is uneven. Realtime voice clients
  usually fix their tool list when the session starts.
- A gateway works on every client.

A stateful session with `list_changed` remains possible later work.

### Core tools (voice profile)

| Tool | Backed by | Notes |
| --- | --- | --- |
| `overview` | `project.list`, `environment.list`, `session.list`, `attention.list` (all reads, composed) | One call answers "what's going on?". Returns counts plus the top 5 items needing attention: questions and approvals pending, runs failed or finished, setups finished or failed. |
| `resolve_target` | reads, composed | Turns spoken names ("the auth environment", "the Codex tab") into IDs. Never guesses. On ambiguity it returns `ambiguous-target` with up to 5 candidates. |
| `read_session` | `session.transcript` | Defaults to the last 3 messages, about 600 characters each. `detail: "brief" \| "full"`. |
| `prompt_session` | `session.prompt` | A busy session is refused with the hint "use steer_session". It never turns into a steer by itself. |
| `steer_session` | `session.steer` | |
| `stop_session` | `session.stop` | Passes `expectedOperationId` when the caller has one. |
| `answer_question` | `session.interaction.resolve` | Requires the interaction `revision`. Confirmation rules apply (see below). |
| `start_work` | `environment.launch` or `session.start` | Creates and starts a new environment with a first prompt, or starts a new session in an existing ready environment. |
| `find_actions`, `describe_action`, `run_action`, `run_status` | gateway | |

Composition rules:

- A core tool may compose several **reads**.
- Every **mutation** goes through exactly one public action, with the
  caller's `requestId`, so request-key and fingerprint semantics are the
  same as the CLI's.
- Tool names match `^[a-z0-9_]{1,64}$` so that every client accepts them.
  Public action names, which contain dots, appear only as values of the
  `action` argument.

### Result shape

- `structuredContent` carries the public envelope unchanged
  (`PublicSuccessEnvelope` / `PublicErrorEnvelope`): `ok`, `error.code`,
  `exitCode`, `receipt`, `warnings`. An MCP client therefore sees the same
  codes and classes as `orkestrator ... --json`.
- `isError` is true when `ok` is false.
- In the voice profile the text content is short and speakable:
  - a `say` sentence, built from structured fields;
  - the IDs needed for the next call;
  - a `next` hint on errors. Examples: `busy` gives `steer_session`;
    `waiting-for-input` gives `answer_question`; `not-ready` gives
    `run_status`.
- In the voice profile, text is at most 2 KB per result. Lists default to 5
  items, with a `more` count and a cursor.
- In the full profile, text is compact JSON, as today.
- `say` never quotes transcript content beyond the bounded excerpt
  `read_session` returns.

### Identity and names

- **Session handles** are `ses_` plus base64url(`environmentId\ntabId`),
  roughly 70 to 110 characters. Accept either `sessionId` or
  `{environmentId, tabId}`. Measure copy errors during qualification before
  adding aliases. A stateless server cannot keep a per-connection alias
  table.
- **Name resolution:** `project.get` already accepts a unique name.
  `resolve_target` extends the same rule:
  - environments by name or branch;
  - sessions by title, agent, or position within an environment;
  - a single exact match wins;
  - anything else is `ambiguous-target` with candidates.

### Confirmation for risky actions

Each action gets a confirmation class, `never`, `voice` or `always`, held in
the capability table in `packages/protocol` beside the input schema (see
Input schemas).

- **`always`:**
  - `environment.delete`
  - `environment.recreate` with `discard`
  - `project.create`, which creates a GitHub repository
  - `project.remove`
  - `run.discard`
- **`voice` (confirm in the voice profile):**
  - `environment.stop`
  - `environment.exec`
  - `session.interaction.resolve` when it approves a command or a file
    change: `answer` or `approve-for-session` on any interaction other than
    a question. Denials, cancels and question answers need no confirmation.
    The spoken description reads the command (truncated) or a summary of
    the file change, not the full diff.

The table records the conditional cases as `confirmWhen: "discard"` and
`confirmWhen: "approval"`.

How it works, with no server state:

1. The first call without `confirmToken` returns `confirmation-required`
   (exit class 6). The response includes a spoken description, for example
   "This deletes environment auth-fix and its worktree", and a
   `confirmToken`.
2. The token is HMAC(server secret, credentialId, action, intent
   fingerprint, expiry), with an expiry of 120 s.
3. The second call, with identical input plus the token, runs the action.
4. A changed input, an expired token or a different credential is refused.

The server instructions tell voice agents to read the description aloud and
get explicit verbal confirmation. `confirmation-required` is an MCP adapter
code, not a new public error: the CLI expresses the same intent with
explicit flags.

### Credentials and profiles

**Credentials.** Replace the single operator token with a list of named
credentials:

- Shape: `{id, label, profile, capabilities[], deniedActions[], createdAt,
  lastUsedAt}`.
- Migration: the existing token becomes credential `default` with profile
  `full`, so existing Codex and Claude Code setups keep working.

**Capabilities** group the public actions:

- `discovery`
- `sessions.read`, `sessions.control`
- `interactions`
- `environments.lifecycle`, `environments.destructive`
- `exec`
- `projects`
- `settings`
- `tickets`
- `mail`

A profile is a preset. `voice` excludes `projects`, `settings`,
`environments.destructive` and `exec` by default. A credential may opt in to
`exec` explicitly; `environment.exec` keeps its `voice` confirmation class,
so a voice credential that is granted it confirms every call.

Each action's capability is in `PUBLIC_ACTION_INPUTS`. Reads that every
profile needs to follow its own work (`run.get`, `run.output`) are in
`discovery`. `run.retry` and `run.discard` are in `sessions.control`, and
`run.cancel` is in `exec`.

**Enforcement** happens in one function, `actionAllowed(credential,
action)`:

- It is called by `run_action`, by every direct tool, and when filtering
  `tools/list`.
- Filter coordinator `tools/list` by capability as well; today it is not
  filtered.

**Authority:**

- Dispatch with `authority = "control-mcp:<credentialId>"`, passed
  in-process and never read from request input.
- Widen `PublicAuthority` in `operation-ledger.ts` to allow this.
- Scope `run.get`, `loadOperation` and `findPublicOperationsByRequest` to
  the caller's authority, so one credential cannot read another's receipts.
- The CLI keeps `operator`.

**Storage and setup:**

- Each credential can be rotated and revoked on its own.
- Storage is plaintext 0600 like today, so Copy setup keeps working
  (decided; see Decisions).
- **Settings → MCP** (`apps/web/src/components/settings/McpSettings.tsx`)
  lists credentials and creates one with a profile. Each credential gets
  Copy setup for each client, including a generic "other or voice client"
  recipe (URL plus `Authorization` header), Rotate and Revoke.

**Network:** the listener stays loopback-only. Hosted voice platforms that
call MCP from their own cloud cannot reach it. Document a local relay
instead of adding a public listener.

### Input schemas: one contract for CLI and MCP

**Schemas in protocol:**

Done. `PUBLIC_ACTION_INPUTS` in `packages/protocol/src/public-api-inputs.ts`
holds, per action, `input` (the schema), `capability`, `confirmation`,
optional `confirmWhen` and `examples`.

- Each entry is a plain JSON Schema object literal. Protocol has no runtime
  dependencies; keep it that way.
- The portable subset is `type`, `properties`, `required`, `enum`, `items`,
  `minLength`/`maxLength`, `minItems`/`maxItems`, `minimum`/`maximum`,
  `description` and `additionalProperties`. Every top-level schema is closed
  (`additionalProperties: false`). Field descriptions are written for agents.
- Rules the subset cannot express (exactly one of two fields, fields given
  together) are stated in descriptions; the handler enforces them.
- Fields that accept a string or `null` (`project.update` `set.folder` and
  `set.path`) carry no `type`, since the subset has no unions.
- The settings `set` and `unset` schemas are generated from
  `PUBLIC_PROJECT_SETTINGS` and `PUBLIC_ENVIRONMENT_SETTINGS`.

**Backend:**

Done.

- Handlers take their allowed keys from the schema through
  `onlyActionKeys(input, action)`, and nested objects (`project.update`
  `set`, interaction `answers`) through `publicActionNestedKeys`.
- `public-api-inputs.test.ts` in the backend checks, per action, that the
  schema properties equal the accepted keys, a missing required field is
  rejected, `enum` matches the handler's lists, and every example parses.
- `public-api-inputs.test.ts` in protocol checks catalogue coverage, the
  portable subset, examples against their schemas, capability grouping and
  the confirmation table.

**MCP:**

- `describe_action` returns the schema.
- Full-profile direct tools are generated from it.
- Check whether the SDK v2 `registerTool` accepts JSON Schema directly. If
  it does not, add a small builder that converts JSON Schema to Zod.
- Run every profile through `mcp-tool-schema-portability.test.ts`.

**CLI:**

- Add a declarative `action?: PublicActionName` field to `CommandSpec`.
  Do not rewrite the `run()` closures.
- A test asserts that:
  - every public action except `capabilities` maps to at least one
    command;
  - each command's options name schema properties, through an explicit map
    where the flag name differs.
- `describe_action` derives its "CLI equivalent" line from that field.

### Waiting

There is no server-side wait. `run_status`:

- takes `waitSeconds` from 0 to 20, default 0;
- polls `run.get` in-process with the CLI's backoff (250 ms rising to 2 s);
- returns early on a terminal state, `waiting-for-input`, unknown dispatch,
  or `unsupported`.

Move the receipt classification in `waitForOperation`
(`packages/cli/src/client/commands/common.ts`) into protocol as a pure
`classifyReceiptForWait(receipt, options)`, used by both the CLI and MCP.

Voice agents should report "started" and check back later rather than wait.

### Attention feed (proactive voice)

A voice agent should be able to say "Claude is asking to run `rm -rf dist`"
without being asked first. MCP tools cannot push. Plan:

- **New action.** Add a read action, `attention.list({cursor?, limit?})`,
  with immediate observation. It returns:
  - pending interactions;
  - runs that settled since the cursor (succeeded, failed, unknown);
  - environments whose setup became ready or failed;
  - a monotonic cursor.
- **CLI.** `orkestrator attention [--follow --jsonl]`.
- **MCP.** `overview` uses `attention.list`.
- **Voice runtime.** It polls `attention.list` from its own code, every few
  seconds, without going through the model. It injects new items into the
  conversation as context. Ship a small reference relay script in
  `docs/development/` or `packages/cli` examples.
- **Later.** A stateful MCP session with resource subscriptions.

### Converging the existing operator tools

**Existing tools.** Keep the 18 existing tool names, since they are
documented and tested. Re-implement each as an adapter over the matching
public action:

| Existing tool | Public action |
| --- | --- |
| `list_projects` | `project.list` |
| `list_environments`, `get_environment` | `environment.list` / `environment.get` |
| `list_tabs`, `get_tab_state` | `session.list` / `session.get`, plus the terminal-tab path |
| `get_tab_transcript` | `session.transcript` |
| `launch_environment` | `environment.launch` |
| `launch_job` | `session.start` |
| `send_prompt_to_tab` | `session.prompt` |
| `get_launch_options` | `agent.options` |

Reconcile behaviour differences first and record them, including:

- `launch_environment` fingerprint semantics;
- the busy-session prompt rule;
- the terminal-tab transcript.

Coordinator scope keeps its own tools and checks.

**New public actions for MCP-only features**, so the CLI gains them too:

- `ticket.list`, `ticket.get`, `ticket.create`, `ticket.update`,
  `ticket.comment`;
- `mail.mailboxes`, `mail.send`.

Multi Review and build pipelines stay coordinator-only until a decision is
made.

When this is done, MCP and the CLI cover the same operator set, and the
parity test keeps them aligned.

### Delegation to a coordinator (optional)

A `delegate(request)` tool would hand a plain-language task to the project
coordinator. Voice models are weak at long tool chains, and coordinators
are strong at them.

Today, external messages go to the inbox only and are never injected into a
turn. This needs a deliberate, authenticated path, such as a public action
that starts a coordinator turn, with its own capability. It is a decision
item and is not needed for full functionality.

## Work items

In order. Each item lists its main files and when it is done.

1. **Decisions.** Questions 1 to 4 are settled; see Decisions. Questions
   5 to 7 stay open and block nothing before item 9.
2. **Input schemas.** Done.
   - Files: `packages/protocol/src/public-api-inputs.ts`, handlers in
     `apps/backend/src/core/public-api/actions-*.ts`.
   - Done when: every action has a schema, capability and confirmation
     class; handlers take allowed keys from it; the conformance tests pass.
3. **Authority plumbing.**
   - Files: `operation-ledger.ts`, `dispatch.ts`, `actions-runs.ts`,
     storage lookups.
   - Done when: Control MCP can dispatch in-process under
     `control-mcp:<id>`; operation reads are authority-scoped; the same
     `requestId` from the CLI and from MCP does not conflict.
4. **Scoped credentials and profiles.**
   - Files: `control-mcp-server.ts`, `commands-registry-control.ts`,
     `McpSettings.tsx`, `config-integrations.ts`.
   - Done when: named credentials exist with profiles and capabilities;
     `tools/list` is filtered for operators and coordinators; the legacy
     token is migrated to `default`; Settings shows create, copy, rotate
     and revoke.
5. **Result mapper.** From envelope to tool result, with `say` and `next`,
   size caps, and a profile-specific text form.
6. **Gateway tools.** `find_actions`, `describe_action`, `run_action`,
   `run_status`, and confirmation tokens.
7. **Voice core tools.** The core tools plus `resolve_target`.
8. **Attention feed.** The `attention.list` public action and CLI command,
   used by `overview`, plus a reference voice relay.
9. **Convergence.**
   - Rebase the existing operator tools on public actions.
   - Add the `ticket.*` and `mail.*` public actions and CLI commands.
   - Add `action` to `CommandSpec`.
10. **Parity and budget tests.** See below.
11. **Docs.**
    - Update `control-mcp.md` and `public-cli.md`.
    - Add a pointer from the constraint in `cli-command-surface.md`.
    - Add a voice client setup guide covering the local relay.
    - When this file is fully ticked, move durable behaviour into
      `architecture/`.
12. **Optional.** `delegate`; a stateful MCP session with `list_changed`
    and subscriptions.

## Tests and qualification

- **Exact `tools/list` per profile:** extend the existing ordered-list
  assertion in `control-mcp-server.test.ts`.
- **Budget:** the serialized voice-profile `tools/list` is at most 8,000
  bytes. The full profile's size is reported, not capped.
- **Parity:**
  - every `PUBLIC_ACTIONS` entry has a schema, a capability and a
    confirmation class;
  - every entry is reachable through `run_action` under the `full`
    profile, and maps to a CLI command;
  - every direct MCP tool names the action or actions it uses.
- **Confirmation:** the token is bound to credential, action, fingerprint
  and expiry. Changed input, expired tokens and cross-credential replay are
  refused.
- **Authority isolation:** a voice credential cannot `run.get` another
  credential's or the CLI's operations, and requests from different
  authorities cannot conflict on keys.
- **Portability:** run every profile through
  `mcp-tool-schema-portability.test.ts`.
- **Coordinator regression:** the existing coordinator suites pass
  unchanged.
- **Live (qualification):** one local realtime voice runtime, connected
  directly or through a local relay, runs this script:
  1. overview;
  2. start work;
  3. answer an approval;
  4. stop;
  5. read the result.

  Record:
  - p50/p95 tool latency, with a target p95 under 1 s for reads;
  - misresolved targets and session-handle copy errors;
  - tool-definition and result token counts.

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

## Open questions

5. Should Multi Review and build pipelines become operator public actions?
6. For hosted voice platforms: local relay only, or allow the remote
   (Tailscale) gateway for MCP?
7. Should there be a `delegate` path into a coordinator turn?
