# Coordinator — remaining work

Status: Active — provider parity for Coordinator.

Current product and architecture:
[`docs/architecture/coordinator.md`](../architecture/coordinator.md).

The product already runs on every enabled platform. What it can *do* is not
the same on every platform. The remaining work is to make Coordinator one
interface at the top — inspect, delegate, wake, queue — with platform-specific
adapters underneath, so a conversation on Claude, Codex, OpenCode, Pi, Cursor,
or Grok is the same product.

A platform joins that unified set only when its adapter holds the same
contracts the others do. Do not paper over a missing half with prompt text.

## The unified interface

A finished coordinator conversation, on any qualified platform, must:

1. **Inspect** the real checkout under `coordinator-read-only`. Mutations are
   denied by the adapter, not by asking the model to behave.
2. **Choose** platform and model on the first send, then stay on that binding.
3. **Delegate** through Control MCP (`launch_environment`, `launch_job`,
   `send_message`, build and review) and finish the turn.
4. **Wake** exactly once per delegation when the worker turn ends, with held
   progress mail delivered as one carrier. A silent worker still produces a
   system notice.
5. **Queue** a user prompt typed during a turn and run it before worker mail.
6. **Steer** a running inspection turn where the platform already has a steer
   adapter, without a coordinator-specific opt-out.

The top of the stack already aims at this: `coordinator-providers.ts` is the
qualification table, `capabilityPolicy` names operations rather than vendor
tools, `nativeAgentCapabilities()` is the shared composer/action table, and
`NativeAgentRuntimeProvider` is the runtime contract. What is still
platform-shaped is mail, wake, and how strongly the read-only boundary is
held.

## Current matrix

| Surface | Claude | Codex | OpenCode | Pi | Cursor | Grok |
| --- | --- | --- | --- | --- | --- | --- |
| Offered at default safety level | yes (enforced on Linux/macOS; provider-configured on Windows) | yes (enforced) | yes (provider-configured) | yes (enforced) | yes (provider-configured) | no (advisory; opt-in) |
| MCP client (outbound launch) | yes | yes | yes | yes (bridge-owned) | yes (HTTP inject) | yes (HTTP inject) |
| Native mail pull / send / inject | yes | yes | yes | yes | **no** | **no** |
| Delegation + wake | yes | yes | yes | yes | **no** | **no** |
| Queue during a turn | yes | yes | yes | yes | yes | yes |
| Steer a running turn | yes | yes | **no** | yes | yes | **no** |
| Idle is an observed edge | yes | yes | yes | yes | yes (session), unused for wake | same |
| Read-only strength | OS sandbox + hook; hook-only on Windows | OS profile, fail-closed | SDK `plan` + permission rules; project `opencode.json` still loads | in-process tool gate | SDK sandbox + tool ban; no approval callback | ask-then-cancel; a tool that does not ask is not stopped |
| Waiting tools (`sleep`, schedulers) | refused | sandbox allows `sleep` | no sleep primitive | no sleep primitive | n/a until mail lands | n/a until mail lands |

Cursor and Grok are the functional split: they can inspect, they cannot
complete a delegation. Everything else is a strength or control-surface gap
on an otherwise working path.

## 1. Mail and delegation adapters — Cursor and Grok

Delegation is a round trip. Outbound MCP without an injectable mailbox
produces a conversation that launches work and never hears back. That is why
`delegation` is derived from `mcpClient && canInject`, and why Cursor and Grok
are told worker controls are unavailable.

Do not flip `NATIVE_AGENT_MAIL_CAPABILITIES` from a table. Add a mailbox
adapter per platform, prove it with a live tool-call probe (pull, send, ack,
inject), then flip pull, send, and inject together. A carrier the recipient
cannot acknowledge wedges the mailbox backlog.

Required of each adapter:

- The bridge already injects the reserved `orkestrator` HTTP MCP server from
  `ORKESTRATOR_AGENT_MCP_URL` / `ORKESTRATOR_AGENT_MCP_TOKEN`. Keep that
  backend-authoritative.
- Native pull, send, and inject must work against a coordinator mailbox, not
  only an environment tab.
- Injected worker mail must go through the existing idle fence, queue-first
  ordering, and delegation hold (`delegation-running` until `working → idle`).
- The coordinator prompt offers launch tools only after `delegation` becomes
  true. Until then the caveat stays on the qualification `reason`.

Pi already has this adapter (bridge-owned MCP client plus mail flags). Treat
it as the template, not as remaining work. Ticket
`Enable agent mail for Cursor, Grok, and Pi` is the historical tracker; Pi
is done.

## 2. Read-only adapters — same operations, same outcome

The top-level deny list is already unified:

```ts
capabilityPolicy: { deny: ["file.write", "file.patch", "shell.mutate", "network"] }
```

Each bridge translates it. The remaining work is to make the *outcome* the
same: create a file, edit a file, run a writing shell command, and fetch a
URL all fail, and Control MCP discovery still succeeds.

| Platform | Gap | Adapter work |
| --- | --- | --- |
| Claude on Windows | No OS command sandbox; tier drops to `provider-configured`. The hook's command allowlist is the boundary. | Keep the automatic drop. Decide whether Windows stays at that tier or is refused at `enforced`-only installs. Do not advertise `enforced` where the sandbox cannot start. |
| Codex | Read-only sandbox still allows `sleep`. | Optional argv0 deny on the coordinator permission profile if a conformance run shows Codex reaching for it. The mailbox poll guard is the backstop either way. |
| OpenCode | Always loads the checkout's `opencode.json`, including command-backed MCP servers. | The picker already shows the caveat. If unification requires `enforced`, the adapter must disable or ignore project MCP that can execute. Until then the tier stays `provider-configured` and the note stays visible. |
| Cursor | Sandbox and `disallowedTools` apply; no approval callback to verify them. Refused if the sandbox cannot be enabled. | Leave at `provider-configured` until a probe can prove a denied tool did not run. |
| Grok | Advisory only. Every permission request is cancelled; a tool that does not ask is not stopped. | Do not raise the tier without a real gate. Unification for Grok is "honest advisory" plus mail (section 1), not a fake `enforced`. |
| Pi | Already enforced at the `tool_call` gate. | No change. |

Process authority is already shared:
`ORKESTRATOR_BRIDGE_EXECUTION_POLICY=coordinator-read-only` on every
coordinator launch. New adapter work must honour it on create, resume,
config, and every turn, and fail closed if a persisted session carries
another policy id.

## 3. One conformance suite, one claim of "same"

`coordinator-conformance.test.ts` and the per-bridge policy tests are the
cheap half. They do not drive a real provider against a fixture tree.

Add `tests/agent/coordinator-read-only.test.ts`, opt-in, driven like
`test:agent:docker`, with `--credential-source <name>`. For each platform in
the qualification table the suite:

1. Creates a coordinator conversation on the fixture project and assigns the
   platform.
2. Hashes the fixture tree.
3. Sends one prompt that asks the agent, in order, to create a file, edit an
   existing file, run a writing shell command, fetch a URL, and then call the
   Control MCP discovery tool.
4. Asserts the tree hash is unchanged, the transcript shows each mutation
   denied, and discovery returned — or, for `delegation: false`, was never
   offered.

A second scenario defines "async" for a delegating platform:

1. Dispatch a coordinator prompt; the provider reports running, then idle.
2. `launch_environment` returns `delivery: "async"` before any worker
   activity.
3. A user prompt queued while running is dispatched before pending mail.
4. Two mid-turn worker messages stay held; `working → idle` injects one
   carrier and no system notice.
5. A silent worker produces exactly one system notice.
6. Four identical `read_messages` calls return the page with `repeatedRead`.

The async scenario is worth running against real providers when the read-only
suite next runs. It is not a substitute for the layer tests that already own
presence, one-wake, batching, and the poll guard — those mechanisms are
provider-neutral.

`coordinator-providers.test.ts` / `coordinator-conformance.test.ts` already
require every `enforced` platform to have a translation. Extend that so
every `enforced` platform is also in the live suite's list. A platform may
not move to `enforced` without both.

## 4. Turn-control adapters

Steer is already on the shared session-action surface. Coordinator does not
opt out. What is missing is the adapter on two platforms:

- **OpenCode** — no production steer. Native `/steer` is tied to the unused
  Session v2 protocol; see [`docs/todo/opencode-v2.md`](opencode-v2.md). Do
  not invent a coordinator-only workaround.
- **Grok** — no production steer. ACP has no equivalent until one is
  adapted.

Claude, Codex, Pi, and Cursor already steer. For Coordinator that means a
user can redirect a long-running inspection turn without cancelling. Queue
during a turn is already true for all six.

Do not block mail/delegation work on steer. A platform without steer is
still a complete dispatcher if queue and wake work.

## 5. Smaller consistency gaps

These are not what split the product, but they keep platforms from feeling
the same.

**Polling.** The mailbox guard covers `read_messages` and
`get_message_status`. A model can still poll worker status through
`list_environments`. Same revision-based counter, same budget, if the live
suite shows coordinators doing it.

**Delegation age.** A still-running worker produces no "still running after
N hours" notice. The toolbar chip already shows the wait. A timer is the
kind of unsolicited update the async contract removes. Default remains: no
timer.

**Waiting workers.** The chip lists environments; it does not mark a worker
whose session is `waiting` (approval or question) as needing a human. The
architecture currently refuses to infer tab-level attention from an
environment-wide status. If this returns, it must be the worker tab's own
session phase, not the environment aggregate.

**Mail carriers.** Injected worker mail has no `data-mail-kind` for styling
`system` notices vs `tab` replies. Light-touch; no new message type.

**Unassigned conversations.** They count toward the 16-open limit. Consider
auto-closing an unassigned conversation with an empty draft when a new one
is created, so the limit cannot be filled with unused composers.

**Model favourites.** With `platformFilter`, hide rather than dim favourites
for platforms the current conversation cannot use.

## 6. Product surfaces that are not provider work

These are missing coordinator capabilities, not platform adapters. Keep them
out of the parity path.

- Copying uncommitted root changes into a worker. Today workers start from
  the recorded commit. A user-selected patch is a separate feature.
- Coordinator MCP for terminal/tmux launch (`launch_terminal_job` already
  exists on the backend), browser launch/navigation, arbitrary pane editing,
  custom-fix model switches, reviewer subtabs, looped review, and
  feature-plan launch. Each needs its own authority and idempotency design.
- Repository checkout mutation as an agent tool. Remains UI-only.

## Acceptance for "same product"

A platform is at the unified level when:

- Its qualification `delegation` is true, or it is honestly labelled and
  hidden from launch tools.
- The live read-only suite leaves the fixture tree unchanged and still
  reaches Control MCP discovery.
- The live async scenario (if `delegation` is true) produces one wake per
  delegation and never a wait-inside-the-turn.
- Its caveats, if any, are on the qualification `reason` and visible in the
  picker before the first send.

Until then, the architecture doc's matrix is the truth, and this file is the
backlog.
