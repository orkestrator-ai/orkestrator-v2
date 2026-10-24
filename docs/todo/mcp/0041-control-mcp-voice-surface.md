# Control MCP: voice profile, progressive disclosure and CLI parity

Checked against `main` at `9906db30` (2026-10-16). Items 2 to 11 implemented on
branch `todo-0041-control-mcp-voice-4a2c0ccc548b` (2026-10-24, rebased onto
`main` at `71227437`).

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
  - Control MCP split: `control-mcp-server.ts` (listener, authentication,
    credentials; 515 lines) and `control-mcp-tools.ts` (the shared and
    coordinator tools; was one 2,373-line file), plus
    `control-mcp-credentials.ts`, `-confirm.ts`, `-caller.ts`, `-results.ts`,
    `-gateway.ts`, `-voice.ts`, `-resolve.ts`, `-direct-tools.ts`,
    `-operator-tools.ts` and `-lean-schema.ts`.
  - Registry commands `create_control_mcp_credential`,
    `rotate_control_mcp_credential`, `revoke_control_mcp_credential`
    (`commands-registry-control.ts`); `rotate_control_mcp_token` rotates
    `default`.
- **CLI** (`packages/cli/`): `CommandSpec.action` and `inputFields`,
  `SHARED_INPUT_FIELDS`; commands `attention`, `ticket …`, `mail …`;
  `waitForOperation` uses the shared classifier; reference scripts
  `examples/voice-attention-relay.ts` and `examples/voice-qualify.ts`.
- **Web**: Settings → MCP (`apps/web/src/components/settings/McpSettings.tsx`)
  lists credentials, creates one with a profile (custom: a capability list),
  and gives each Copy setup for Codex, Claude Code and "Other or voice
  client", Rotate and Revoke.

Measured on this branch (2026-10-24, `control-mcp-voice.test.ts` harness):

| Profile | Tools | `tools/list` bytes |
| --- | --- | --- |
| `voice` | 12 | 7,095 (budget 8,000) |
| `read-only` | 40 | 24,073 |
| `full` (the migrated `default`) | 82 | 76,374 |

## Work items

1. **Decisions.** Done. Questions 1 to 4 were settled on 2026-10-16;
   questions 5 to 7 are settled under Assumptions and decisions (D11 to D13).
2. **Input schemas.** Done before this branch.
3. **Authority plumbing.** Done.
   - Evidence: `public-api/public-api-authority.test.ts` (an `authority` field
     in request JSON is ignored; the same request ID under two authorities
     makes two operations; `run.get` by ID and by key, `run.retry/discard/cancel`
     and `session.stop` with `expectedOperationId` refuse another authority's
     operation as `not-found`); `control-mcp-voice.test.ts` "credentials and
     the CLI cannot read or collide with each other's operations".
4. **Scoped credentials and profiles.** Done.
   - Evidence: `control-mcp-credentials.test.ts` (version 1 token migrated to
     `default`/`full` and still accepted, mode 0600; independent rotate and
     revoke, persisted across restarts; ungrantable capabilities, unknown
     profiles, empty custom lists and bad `deniedActions` refused; invalid
     stored credentials dropped); `control-mcp-voice.test.ts` exact
     `tools/list` per profile; coordinator `tools/list` filtered by capability
     (`control-mcp-tools.ts` `filteredToolServer`, covered by the existing
     coordinator tests in `control-mcp-server.test.ts`); Settings →
     `McpSettings.test.tsx` (7 tests: list, copy each recipe, create, rotate,
     revoke, disabled, errors).
5. **Result mapper.** Done: `control-mcp-results.ts` (`envelopeToolResult`,
   `voiceText`, `nextHint`, `adapterError`). Evidence: voice text bounded to
   2 KB and `next` hints (`read_session`, `prompt_session` busy →
   `steer_session`, `run_status` → `answer_question`) in
   `control-mcp-voice.test.ts`.
6. **Gateway tools.** Done: `find_actions`, `describe_action`, `run_action`,
   `run_status` and confirm tokens (`control-mcp-gateway.ts`,
   `control-mcp-caller.ts`, `control-mcp-confirm.ts`). Evidence: every action
   an MCP credential can hold reaches its handler through `run_action` (the
   envelope carries the backend identity); the request-key rule; ranked
   search; `describe_action` schema and CLI line; `run_status` early stop on a
   pending interaction; confirm tokens bound to credential, action, input and
   expiry (`control-mcp-voice.test.ts`, `control-mcp-credentials.test.ts`
   "confirm tokens").
7. **Voice core tools.** Done: `overview`, `resolve_target`, `read_session`,
   `prompt_session`, `steer_session`, `stop_session`, `answer_question`,
   `start_work` (`control-mcp-voice.ts`, `control-mcp-resolve.ts`). Evidence:
   `control-mcp-voice.test.ts` (resolve never guesses, bounded excerpt, busy
   refusal, start and replay, approval confirmation and direct denial).
8. **Attention feed.** Done: `attention.list`, `orkestrator attention
   [--follow --jsonl]`, `overview` uses it, reference relay
   `packages/cli/examples/voice-attention-relay.ts`. Evidence:
   `public-api/public-api-attention.test.ts`,
   `packages/cli/tests/attention-ticket-mail-command.test.ts`,
   `packages/cli/tests/voice-attention-relay.test.ts`.
9. **Convergence.** Done, with the read tools narrowed (D7).
   - The original mutation tools for operator credentials are one public
     action each; `list_projects`, `list_tickets`, `get_ticket` and
     `list_mailboxes` read their public action. Behaviour differences are
     recorded in `control-mcp.md` ("Operator tools over public actions").
     Evidence: `control-mcp-operator-tools.test.ts`.
   - `ticket.*` and `mail.*` public actions and CLI commands. Evidence:
     `public-api/public-api-tickets-mail.test.ts`, the CLI test above.
   - `CommandSpec.action`. Evidence: `packages/cli/tests/command-actions.test.ts`.
10. **Parity and budget tests.** Done; see Tests and qualification.
11. **Docs.** Done: `control-mcp.md`, `public-cli.md`, `agent-messaging.md`,
    new `control-mcp-voice.md`, the catalog in `docs/README.md`, and a pointer
    from the gateway constraint in
    [`0017-cli-command-surface.md`](../cli-and-slash-commands/0017-cli-command-surface.md).
    The file is not fully ticked (see Remaining work), so it stays; its
    durable behaviour is already in `architecture/`.
12. **Optional.** Deferred, not built (D13, D14): `delegate`, and a stateful
    MCP session with `list_changed` and resource subscriptions.

## Tests and qualification

| Check | Status | Where |
| --- | --- | --- |
| Exact `tools/list` per profile | Done | `control-mcp-voice.test.ts` "each profile lists exactly its tools"; the original 18 stay first in `full` (`control-mcp-server.test.ts`) |
| Voice budget ≤ 8,000 bytes; full size reported | Done: 7,095 and 76,374 bytes | `control-mcp-voice.test.ts`; table above |
| Every action has a schema, capability and confirmation class | Done | `packages/protocol/src/public-api-inputs.test.ts`, backend `public-api/public-api-inputs.test.ts` (251 cases, including the new actions) |
| Every action reachable through `run_action` under `full` and mapped to a CLI command | Done | `control-mcp-voice.test.ts`; `packages/cli/tests/command-actions.test.ts` |
| Every direct and core tool names its actions | Done | `control-mcp-voice.test.ts` |
| Confirmation token bound to credential, action, fingerprint, expiry | Done | `control-mcp-credentials.test.ts`, `control-mcp-voice.test.ts` |
| Authority isolation | Done | `public-api-authority.test.ts`, `control-mcp-voice.test.ts` |
| Portability of every profile | Done | `mcp-tool-schema-portability.test.ts` (full, voice, read-only, custom, coordinator) |
| Coordinator regression | Done | `control-mcp-server.test.ts`: the coordinator tests pass as they were; nine former operator tests now run under a coordinator credential (the path that keeps those implementations) and two that covered removed operator-only branches moved to `control-mcp-operator-tools.test.ts` |
| Live: a realtime voice runtime runs the script | **Not done** | see Remaining work |

## Remaining work

1. **Live voice qualification.** Run the script (overview; start work; answer
   an approval; stop; read the result) through a real realtime voice runtime
   on this machine, directly or through a local relay, and record p50/p95
   tool latency (target p95 under 1 s for reads), misresolved targets,
   session-handle copy errors, and tool-definition and result token counts.
   `packages/cli/examples/voice-qualify.ts` runs the same script without a
   model and measures everything but the two model-dependent counts; see
   Live evidence for what it produced on node mbp3. Not done because no
   realtime voice runtime (audio in and out, a realtime model session) is
   installed or credentialed on mbp3, and misresolution and copy errors can
   only be measured with a speaking model and a person.
2. **Optional, deferred:** `delegate` into a coordinator turn (D13), and a
   stateful MCP session with `list_changed` and subscriptions (D14). Each
   needs its own todo file when it is wanted.

## Live evidence

LIVE_EVIDENCE_PLACEHOLDER

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

5. **Multi Review and build pipelines** stay coordinator-only (D11).
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
  Schemas (`control-mcp-lean-schema.ts`); (c) generate them from the action
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

**D17. Splitting `control-mcp-server.ts`.**
- It was 2,373 lines, over the repository's 2,000-line limit. The listener,
  authentication and credentials stay in `control-mcp-server.ts`; the shared
  and coordinator tools moved unchanged to `control-mcp-tools.ts`; each new
  part has its own module. The original test file stays as it was apart from
  the converted tests; new behaviour is tested in new files.

**Assumptions.**
- `capabilities` stays without a CLI command of its own; `connection check`
  reads it.
- Capability of `attention.list` is `sessions.read`: it reports pending
  interactions of sessions.
- Interaction kinds other than `question` count as approvals for voice
  confirmation, as the plan says, including MCP forms and plan approvals.
- A voice agent can copy a `ses_` handle exactly; aliases were not added
  (the plan asks to measure copy errors first, which needs Remaining work 1).
