# Bring Cursor and Grok mail to native parity

Status: Implemented — 2026-09-12. Inventory:
[`docs/architecture/agent-messaging.md`](../architecture/agent-messaging.md).
Related ticket: `872eb45b-0982-4a83-8a43-b53d1a1c7029`.

What landed: per-tab `agentMcp` on Cursor and Grok (override wins over
process env; token never persisted; Grok never writes it into
`process.env`), then `{canPull,canSend,canInject}=true` for both native
platforms so idle inject and coordinator delegation follow. Terminal
cursor/grok/pi stay off. OpenCode identity was left alone.

## Goal

Native Cursor and native Grok get the same mailbox as native Claude, Codex,
OpenCode, and Pi: pull, send, ack, idle inject, and therefore coordinator
delegation. Do that by finishing the existing mail path, not by writing a
second one.

A second, separate question: can OpenCode’s environment-scoped MCP token be
replaced with a per-tab credential the way Claude/Codex/Pi already mint one?
**Not with OpenCode’s current MCP API.** See the last section.

Non-goals: terminal Cursor/Grok/Pi mailboxes; OpenCode workflow-result tool
mode (a different MCP attach); inventing attachments, search, or multicast.

## Why this is small

The store, drain, carrier, Agent Tools, UI, and `dispatchMailInject` already
treat every native platform the same. Cursor and Grok already load
`orkestrator` from `ORKESTRATOR_AGENT_MCP_*` at launch. What is left is
identity + the three flags.

| Missing piece | Effect today |
| --- | --- |
| `agentMailCapabilities("agent-native", "cursor"\|"grok")` all-false | Mail tools `capability-denied`; inject never scheduled; compose UI hides the tab; `delegationDeliverable` is false |
| `resolveAgentMcp` only runs for `claude` / `codex` / `pi` | Cursor/Grok keep the **environment** token from bridge launch, even after flags flip |
| Cursor HTTP ignores `body.agentMcp` | Per-tab token never reaches `AgentOptions.mcpServers` |
| Grok `configuredAcpMcpServers()` reads only process env | Every ACP session in the environment shares one token |

Flipping the flags **without** per-tab credentials would make mail “work”
in a single-tab environment and mis-attribute it in a multi-tab one: two
Cursor tabs would share one environment credential, and `assertCallerMailbox`
would either pick the unique pull-capable tab or demand a manual `tabId`
claim. That is OpenCode’s current identity, not Claude’s. Do not ship the
flag flip until Cursor and Grok consume `agentMcp`.

Delegation then follows for free:
`coordinator-providers.ts` already computes
`delegation = mcpClient && NATIVE_AGENT_MAIL_CAPABILITIES[platform].canInject`.
Cursor stays `provider-configured`; Grok stays `advisory`. Those tiers are
sandbox strength, not mail.

## Phase 0 — Per-tab MCP on Cursor and Grok

Mirror Pi: the backend already posts `{ url, token }` on create/prompt
(`http-bridge-provider.ts`). The bridges must store it in memory, never
persist it, and rebuild the MCP client when the token changes.

### Backend

In `native-agent-service-prompt.ts` `resolveAgentMcp`, add `"cursor"` and
`"grok"` to the platform allowlist next to Claude/Codex/Pi. Same
`logicalSessionKey` → tabId slice, same
`resolveAgentToolConnection(..., tabId, host|container)`.

No new credential type. `AgentToolsServer.connection(..., tabId)` already
mints `environmentId\0tabId`.

### Cursor bridge

`bridges/cursor-bridge/` is one `SDKAgent` per session. `attach()` already
builds `AgentOptions.mcpServers` from `cursorMcpServers()`. Change that
function to accept an optional override and prefer it over process env:

1. Parse `body.agentMcp` on `/session/create`, `/session/resume`,
   `/session/prompt` (and any other route that already forwards `policy`).
   Same validation as Pi: HTTP(S) URL, token length cap; ignore malformed
   rather than fail the session.
2. Hold it on `SessionState` as `agentMcp`. Strip it in persistence
   (Pi/Codex already do this).
3. `cursorMcpServers(agentMcp?)`: if override present, `orkestrator` uses
   that URL/token; else env. Project `.cursor/mcp.json` stays
   container-only. Name collision still prefers Orkestrator.
4. If `ensureAgent` already has an agent and the stored credential
   fingerprint changed, detach and re-attach so resume/create do not keep
   the environment token. Pi’s comment in `mcp.ts` is the pattern: a
   rotated token must not stay attached to the old client.
5. Tests: create/prompt persist the override in memory; persistence file
   has no token; override wins over env; malformed body is ignored;
   fingerprint change rebuilds the agent.

### Grok (ACP) bridge

Grok is closer than it looks. `session/new` and `session/load` already
pass `configuredAcpMcpServers()` **per session**. The function is process
env only.

1. Parse and store `agentMcp` on the session the same way, on create /
   prompt / load. Do not persist.
2. Change `configuredAcpMcpServers` to take the session (or its override)
   and emit that bearer. Env remains the fallback for a session that has
   not received a body yet.
3. A token change on a live child: pass the new list on the next
   `session/load` / reconnect, or respawn that session’s CLI child. Do not
   mutate a sibling session’s env.
4. Tests: two sessions in one process get two tokens; env fallback still
   works; persistence redacts the token.

### Probe before the flag flip

The architecture notes ask for a live tool-call probe. Do not wait for a
manual chat. Add a focused test that, with a tab-scoped token:

1. `initialize` + `tools/list` against Agent Tools (or call
   `list_mailboxes` over Streamable HTTP) and asserts the seven mail tools
   are present.
2. `list_mailboxes` succeeds and `identity.resolved === "credential"` with
   the claimed tab — not `"unique"` via an environment token.

That proves the credential the SDK/ACP child will hold can actually pull.
Vendor “the model chose not to call the tool” is out of scope.

Optional follow-up, not a gate: an `e2e/agent-testing` turn that asks
Cursor or Grok to `list_mailboxes` once, if the existing browser-gateway
harness can attach those providers cheaply.

## Phase 1 — Flip the three flags together

In `packages/protocol/src/agent-mail.ts` `agentMailCapabilities`, add
`cursor` and `grok` to the native allowlist next to Claude/Codex/OpenCode/Pi.

```ts
if (agent === "claude" || agent === "codex" || agent === "opencode"
    || agent === "pi" || agent === "cursor" || agent === "grok") {
  return { canPull: true, canSend: true, canInject: true };
}
```

`NATIVE_AGENT_MAIL_CAPABILITIES` is derived from that function, so
delegation updates in the same commit.

Expand `agent-mail.test.ts` so every `AGENT_PLATFORMS` native row is
explicit (the current test only checks Claude and Pi). Add Cursor/Grok
terminal rows: still not addressable (`TERMINAL_TYPES` stays
`claude|codex|opencode`; Cursor has no terminal product).

Do **not** add terminal `cursor`/`grok`/`pi` to `TERMINAL_TYPES`. That is a
different product (PTY, no inject) and is not required for native parity.

## Phase 2 — Docs and coordinator copy

One commit after the flags, or the same PR if the diff stays small:

- `docs/architecture/agent-messaging.md` — Cursor/Grok native rows become
  complete; drop the “flag flip pending” language; keep the OpenCode
  identity caveat.
- `docs/architecture/agent-engines.md`, `coordinator.md`,
  `platform-inconsistencies.md`, `AGENTS.md` — same.
- `docs/plans/async-coordinator.md` provider matrix footnote.
- Ticket `872eb45b`: retitle to Cursor/Grok only, or close it when this
  lands.

## Verification

| Layer | What to run |
| --- | --- |
| Protocol | `agent-mail.test.ts` full native matrix; coordinator qualification tests assert `delegation: true` for Cursor (when the host tier allows `provider-configured`) and for Grok only when the safety setting admits `advisory` |
| Cursor bridge | `mcp.test.ts`, `agent-session` attach with override, persistence redaction |
| ACP bridge | session A vs session B tokens; `session/new` payload |
| Backend | `resolveAgentMcp` allowlist test; mail send/inject against a cursor/grok mailbox fixture (the native inject path is already generic) |
| Manual | Two Cursor tabs in one env: each `list_mailboxes` reports `self` as itself; idle inject of a user message with policy `idle` starts a turn; coordinator on Cursor/Grok can `launch_environment` and is woken by the worker reply |

Failure mode to watch: Cursor resume with a new `agentMcp` must not create a
second SDK agent that orphans the conversation. Grok must not write the
tab token into the process env (that would leak it to every session).

## Order

```text
Phase 0 (Cursor + Grok agentMcp)  →  probe test green  →  Phase 1 flags
                                                          →  Phase 2 docs
```

Ship Cursor and Grok in one PR if the bridge diffs stay local. Split only
if ACP child respawn for token rotation gets messy — then Cursor can land
first; do not flip Grok’s flags until its override works.

## OpenCode: can we close the per-tab gap?

**Short answer: not to Claude/Pi’s level, given today’s vendor API. Do not
block Cursor/Grok on it.**

OpenCode is already mail-complete: `canPull/canSend/canInject` are true,
inject uses the shared native drain, coordinator delegation is on. The
only shortfall is **identity**.

`configureOpenCodeAgentTools` `POST`s one remote server named
`orkestrator` onto `opencode serve` for the environment directory
(`commands-servers.ts`). OpenCode’s MCP HTTP API (`GET/POST /mcp`,
connect/disconnect/auth) is **instance/workspace scoped**. There is no
session id on that catalog. One `opencode serve` serves every OpenCode
tab in the environment.

| Approach | Verdict |
| --- | --- |
| Register `orkestrator-<tabId>` per tab | Every session would see every sibling’s tools and could act as the wrong mailbox. Worse than today’s claim. |
| Re-`POST /mcp` with a new token before each prompt | Two concurrent OpenCode turns in one env race the single catalog. Not at-most-once. |
| One `opencode serve` per tab | Breaks the “one process set per environment” rule and the existing provider. Out of scope. |
| Wait for session-scoped MCP in OpenCode | The only honest path to Claude-level identity. Not available in the current `/mcp` API. |

What we already have is the designed fallback: an environment credential
plus `assertCallerMailbox`. One OpenCode tab → `resolved: "unique"`.
Several pull-capable tabs → the model must pass `tabId` / `fromTabId`.
Tool descriptions already say so.

If a later OpenCode release adds per-session MCP headers or a session id
on the MCP client, then `resolveAgentMcp` can grow an `"opencode"` branch
and `configureOpenCodeAgentTools` can move from launch-once to
per-session. Until then, treat environment-scoped OpenCode MCP as
**complete for a single-server vendor**, not as a defect in the mail
store.

Do not add a shim that pretends otherwise.
