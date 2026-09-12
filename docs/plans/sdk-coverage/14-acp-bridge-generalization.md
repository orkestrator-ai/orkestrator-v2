# 14 — ACP bridge generalization

**Status:** 🟨 In progress · ~85% · Depends on: 02, 06, 08

Refreshed 2026-09-11. Typed ACP client, fs/terminal, authenticate, and
Cursor-era module removal are in tree. Still open: fence or delete
`grok-interjection.ts`, and real-Grok / browser QA.

## Goal

`bridges/acp-bridge` is a well-built Grok-specific ACP client with residual
Cursor code, not a generic ACP host. It declines the client-side filesystem
and terminal methods, never authenticates, maps modes to a closed pair,
hand-writes every wire shape without a schema, and pins the provider in three
places. Make it a generic ACP host so Grok gets the missing protocol
features and a future ACP agent (Gemini CLI, Claude-over-ACP) is a config
entry rather than a bridge.

## Normalized model

No new Orkestrator protocol types beyond what plans 02, 06 and 08 add. The
bridge-internal change is to vendor the ACP schema and type every method
against it.

- Add `@agentclientprotocol/sdk` (1.4.0 at time of writing) or vendor its
  `schema/v1/schema.json` under `bridges/acp-bridge/src/generated/` as a
  lockfile with a `verify:acp:protocol` script, mirroring the Codex
  generated tree and its manifest check.
- `ACP_PROVIDER` becomes a config record `{ id, executable, argv, env,
  requiresAuthenticate, modeMap }` loaded by the backend launcher; `grok` is
  the first entry.

## Tasks

### Schema and typing

- [ ] Vendor the ACP schema and generate types; replace `JsonObject` guards
  in `acp-context.ts`, `acp-session.ts`, `acp-tools.ts`, `acp-transcript.ts`
  with the generated types at the boundary. Add the verify script and a
  version-drift test entry.
- [ ] Read the negotiated `protocolVersion` from the `initialize` response
  (`acp-context.ts:699-718` never reads it) and refuse or adapt on a
  mismatch with a clear notice.

### Client-side capabilities

- [ ] Implement `fs/read_text_file` and `fs/write_text_file`
  (`clientCapabilities.fs` is `false` today, `acp-context.ts:705`) against
  the workspace with the same path-trust checks `prompt-attachments.ts`
  applies (symlink refusal, workspace confinement).
- [ ] Implement `terminal/create`, `terminal/output`,
  `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`
  (`terminal: false` today) backed by a bounded PTY per call; terminal
  content blocks then render as live tool output instead of the
  `[Terminal <id>]` placeholder (`acp-transcript.ts:190-193`). Respect the
  output bounds from the transport invariants.
- [ ] Advertise `promptCapabilities` honestly from the agent's own
  `initialize` answer and send `embeddedContext`/`resource` blocks where the
  agent supports them (files attachments for Grok if it reports support).

### Session surface

- [ ] `authenticate` (plan 08 adds the status route; this task performs the
  handshake when `authMethods` requires it).
- [ ] Open the mode mapping (`session-config.ts:628-643` recognises six ids)
  into the config record's `modeMap`, with unmapped ids passed through as
  extra `modes` entries labelled by the agent's own name so nothing is
  silently dropped.
- [ ] Carry `availableCommands` names (plan 06) and non-text content blocks
  (plan 03). Inspect `stopReason` on the prompt result.
- [ ] `session/set_config_option` already works; expose remaining boolean
  config options as composer parameters (plan 10) generically.

### Provider unpinning

- [ ] Replace `parseProvider` (`acp-context.ts:966-969`) and
  `configureGrokRuntime` (`grok-runtime.ts`) with the config record; the
  argv ternary at `acp-context.ts:655-669` becomes `record.argv`. The
  default executable fallback to `grok` goes.
- [ ] Vendor-method predicates (`isVendorModelUpdate`,
  `isCursorAcknowledgedExtensionMethod`, `acp-context.ts:1027-1048`) become
  a prefix registry on the config record.
- [ ] Delete the Cursor-era modules (`acp-cursor-background.ts`,
  `acp-cursor-child-discovery.ts`, `acp-cursor-transcript-parts.ts`) and
  their gates, or move the genuinely generic sub-agent continuation into a
  provider-neutral module if Grok's `subagent_*` extension needs it.
- [ ] Backend: `packages/protocol/src/agent-platforms.ts` stays as is;
  adding a second ACP agent is a launcher config change plus a platform id,
  and `tests/unit/bridge-packaging.test.ts` covers the packaging.

### Verification

- [ ] Bridge tests with the fake agent extended to exercise `fs/*`,
  `terminal/*`, `authenticate`, an unmapped mode, and a v2 `protocolVersion`.
- [ ] Manual: the argv contract check from `docs/development/upgrade-agents.md` against
  the pinned Grok binary, since nothing in CI runs the real agent.
- [ ] Browser: Grok fixture shows terminal output inline for a shell tool
  call; reload preserves it.

## Out of scope

Steering (ACP v1 has none). Hosting a second agent in this milestone; the
plan makes it possible, a separate plan adds one.

## Implementation notes

- The bridge pins `@agentclientprotocol/sdk` 1.4.0 and uses its public request
  and response types at the client-method boundary. Protocol negotiation fails
  clearly when the agent returns an unsupported version.
- Provider launch, authentication, modes and extension prefixes are driven by
  a config record. The production Cursor-era ACP replay/discovery modules and
  Grok-only wrapper were removed; Cursor's supported path is its SDK bridge.
- Workspace-confined filesystem methods and bounded Bun-terminal methods are
  implemented, including inline captured output. Fake-agent tests cover auth,
  capabilities, protocol refusal, filesystem and the terminal lifecycle.
- The pinned real-Grok argv check and browser fixture remain manual before
  merge. Plans 06 and 08 still own the fully normalized command and account
  surfaces used above this adapter.
