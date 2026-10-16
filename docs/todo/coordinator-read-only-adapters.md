# Coordinator read-only adapters

Checked against `main` at `2459b05c` (2026-10-15).

Coordinator runs against the user's real checkout, so every platform it offers
must hold the same read-only outcome: creating a file, editing a file, running
a writing shell command and fetching a URL all fail, and Control MCP discovery
still works. The deny list is already one shared policy. What differs is how
strongly each adapter holds it, and the remaining work is a set of
per-platform decisions about that strength and the tier each platform
advertises.

## Current state

- The contract every qualified platform is held to (from the coordinator
  design). A finished coordinator conversation must:
  - **Inspect** the checkout under `coordinator-read-only`, with mutations
    denied by the adapter rather than by asking the model to behave. The
    per-platform strength differs; see the table below.
  - **Choose** platform and model on the first send, then stay on that
    binding. Done on every platform.
  - **Delegate** through Control MCP (`launch_environment`, `launch_job`,
    `send_message`, build and review) and finish the turn. Done on every
    platform; `delegation` is true for all six in
    `coordinator-conformance.test.ts`.
  - **Wake** exactly once per delegation when the worker's turn ends, with
    held progress mail delivered as one carrier, and a system notice for a
    silent worker. Done on every platform at the layer-test level; live
    evidence is in [coordinator-live-conformance.md](coordinator-live-conformance.md).
  - **Queue** a prompt typed during a turn and run it before worker mail. Done
    on every platform.
  - **Steer** a running inspection turn where the platform has a steer
    adapter. Claude, Codex, Pi and Cursor do; OpenCode and Grok do not (see
    [coordinator-consistency-gaps.md](coordinator-consistency-gaps.md)).
- The policy names operations, not vendor tools.
  `resolveNativeAgentExecutionPolicy(..., "coordinator")`
  (`apps/backend/src/core/native-agent-execution-policy.ts`) returns
  `capabilityPolicy.deny: ["file.write", "file.patch", "shell.mutate",
  "network"]`, `approvals: "deny"`, `projectResources: false` and
  `networkAccess: "restricted"`. `toolPolicy` stays Codex-shaped and is the
  user-override surface, so it cannot carry the translation.
- Process authority. `commands-servers.ts` sets
  `ORKESTRATOR_BRIDGE_EXECUTION_POLICY=coordinator-read-only` on every
  coordinator bridge launch. Each bridge replaces whatever policy a request
  body or persisted record carries:
  - Claude: `bridges/claude-bridge/src/services/read-only-policy.ts`;
  - Codex: `isCoordinatorReadOnlyEnvironment` in
    `bridges/codex-bridge/src/codex-config.ts` (also honours the older
    `CODEX_BRIDGE_EXECUTION_POLICY`);
  - Cursor: `bridges/cursor-bridge/src/agent-session.ts`;
  - Pi: `BRIDGE_EXECUTION_POLICY_ENV` in `bridges/pi-bridge/src/agent-session.ts`;
  - Grok: `effectiveExecutionPolicy` in `bridges/acp-bridge/src/acp-policy.ts`,
    with `restorePersistedPolicy` (`acp-persistence.ts`) refusing a permissive
    persisted policy;
  - OpenCode has no bridge. The backend applies `effectiveOpenCodePolicy`,
    `openCodePermissionRules` and `openCodeCoordinatorAgent` (the `plan`
    agent) from `apps/backend/src/core/opencode-provider-helpers.ts`.
- Qualification is one table: `judge` and `coordinatorProviderQualification`
  in `apps/backend/src/core/coordinator-providers.ts`. Claude's tier depends on
  the host probe `defaultCoordinatorHostCapabilities` (command sandbox on
  macOS and Linux only). **Settings → Agent platforms → Coordinator safety
  level** defaults to `provider-configured`. A platform whose tier is weaker
  than the setting is unavailable, and the tier's `reason` is shown in the
  picker.
- Per-platform strength today:

  | Platform | Tier | How read-only is held | Gap |
  | --- | --- | --- | --- |
  | Claude (macOS, Linux) | `enforced` | SDK command sandbox, `allowUnsandboxedCommands` off, `dontAsk`, an allowlist without writing tools, and a bridge `PreToolUse` hook that allows a fixed list of reading commands; WebFetch and WebSearch are off the allowlist, in `disallowedTools` and refused by the hook | None known |
  | Claude (Windows) | `provider-configured` | Same, without the OS sandbox; the hook allowlist is the boundary | No OS containment |
  | Codex | `enforced` | Permission profile that denies filesystem writes and network in the child; the bridge refuses a turn unless app-server echoes the profile back. Hosted web search (`web__run`) is switched off with `web_search = "disabled"`, and the bridge refuses a thread unless `config/read` reads it back | `sleep` is not denied (it is a read-only command) |
  | Pi | `enforced` | In-process `tool_call` gate in the bridge; a name allowlist, so an extension's web tool is refused too | None known |
  | OpenCode | `provider-configured` | SDK `plan` agent plus permission rules (`*: deny`, a read-only list, the coordinator's own Orkestrator tools by name, then named denies for `webfetch`, `websearch` and `codesearch`) | Always loads the checkout's project configuration, including command-backed MCP servers in `opencode.json` |
  | Cursor | `provider-configured` | SDK sandbox plus a built-in tool allowlist (`CURSOR_READ_ONLY_TOOLS`, with denied capabilities mapped by `CURSOR_CAPABILITY_TOOLS`), which leaves out `webFetch` and `webSearch`; a read-only session without a sandbox boundary is refused before attach | No approval callback, so a denial cannot be verified |
  | Grok | `advisory` | Web search and web fetch removed with `--disable-web-search` (plus `--no-leader`, so a shared leader cannot ignore it); every other permission request is cancelled | A tool that does not ask is not stopped; not offered at the default safety level |

- Waiting tools. Claude refuses `Monitor`, `ScheduleWakeup`, the `Cron*`
  tools and `sleep`/`watch`/`timeout` (asserted in
  `coordinator-conformance.test.ts`). OpenCode and Pi have no sleep primitive.
  Codex can run `sleep`; Cursor and Grok depend on the provider. The Control
  MCP poll guard (`coordinatorPollGuard` in `control-mcp-server.ts`) is the
  backstop.
- `coordinator-conformance.test.ts` pins the `enforced` set to exactly
  `claude`, `codex` and `pi`, so a platform cannot be promoted without a
  matching test change.

## Outstanding work

### Code

1. **Claude on Windows.** Decide whether the hook allowlist is enough to keep
   offering Claude at the default `provider-configured` setting on Windows.
   An `enforced`-only installation already refuses it, because the tier is
   compared with the setting. Whatever is decided, never report `enforced`
   where the sandbox cannot start.
2. **Codex `sleep`.** Optionally add an argv0 deny for `sleep` (and similar
   waiting commands) on the coordinator permission profile in
   `codex-config.ts`. Only do this if a live run in
   [coordinator-live-conformance.md](coordinator-live-conformance.md) shows
   Codex reaching for it; the poll guard covers mailbox polling either way.
3. **OpenCode at `enforced`.** Only if unification requires it: the adapter
   would have to ignore or disable project MCP servers that can execute
   commands. Until then OpenCode stays `provider-configured`, and the note
   from `effectiveOpenCodePolicy` stays on its qualification `reason`.
4. **Cursor.** Stays `provider-configured` until a probe can prove that a
   denied tool did not run. Without an approval callback there is nothing to
   check today.
5. **Grok.** Stays `advisory`. Do not raise the tier without a real gate in
   the ACP bridge.
6. **Pi.** No change.
7. **Hosted network tools.** Done. A live run of the read-only suite found a
   Codex coordinator reaching `https://example.com` through Codex's hosted web
   search while its permission profile had the network off: the profile stops
   commands, and hosted search runs on OpenAI's servers. Every policy whose
   `capabilityPolicy` denies `network` (`nativeAgentPolicyDeniesNetwork`) now
   loses the provider's hosted and network tools:
   - Codex: `web_search = "disabled"` and `features.standalone_web_search =
     false` as process configuration for a coordinator and as thread
     configuration for any network-denied thread (`CODEX_NETWORK_DENIED_CONFIG`).
     The engine reads the coordinator's setting back through `config/read` once
     per app-server generation and refuses the thread without it
     (`assertHostedNetworkLock`), so a Codex that renames the switch fails
     closed. Verified against 0.162.1 by `live-network-lock.test.ts`, which
     reads the tools out of the real model request on a loopback endpoint,
     and live on 2026-10-16 in a `dev:test` profile with real Codex
     credentials. Before the change, a coordinator asked to search the web
     called `web_search` and returned the title of `https://example.com`.
     After it, the same conversation (resumed) answered "Web search is not
     available to me". A fresh conversation found no search or fetch tool, and
     its `curl` failed with "Could not resolve host".
   - Claude: WebFetch and WebSearch were already off the coordinator's
     allowlist, denied and refused by the hook; any other network-denied
     policy now gets them in `disallowedTools` too (`claudeDisallowedTools`).
   - OpenCode: named denies for `webfetch`, `websearch` and `codesearch`,
     which a `task` subagent inherits.
   - Grok: `--disable-web-search` and `--no-leader`, keyed by provider id so the
     backend's serialized launcher record cannot drop them, and applied to
     policy-less children in a coordinator process.
   - Cursor and Pi: no change; their read-only allowlists already exclude every
     network tool, now pinned by tests.
8. **Grok flag, live.** The `--disable-web-search` flag and its effect on the
   ACP toolset are read from the 1.0.52 binary, not from a live turn. Confirm
   on the pinned build that a coordinator turn has no web search or web fetch.
9. **Readiness for a failed Codex lock.** A Codex coordinator whose
   `config/read` does not confirm search is off is refused at thread start,
   which the user sees as a failed turn. `NativeAgentReadiness` has no state for
   "this provider cannot hold the boundary", so the conversation still looks
   ready until the first send. Add one if a Codex bump ever trips the check.

### Qualification

- The live read-only scenario (tree hash unchanged, every mutation denied,
  discovery still returns) runs per platform in
  [coordinator-live-conformance.md](coordinator-live-conformance.md). The
  decisions above for Codex, Cursor and OpenCode depend on its results.

## Constraints and rationale

- Do not cover a missing adapter half with prompt text. A platform joins the
  unified set only when its adapter holds the same contract as the others.
- Moving a platform to `enforced` claims that the provider or the OS blocks
  the mutation whatever the agent attempts. It needs all of:
  - a translation of `capabilityPolicy` into the provider's own vocabulary, in
    the bridge, applied on create, resume, config and every turn;
  - `ORKESTRATOR_BRIDGE_EXECUTION_POLICY` honoured as process authority;
  - an entry in the `enforced` list in `coordinator-conformance.test.ts`;
  - a place in the live suite's platform list (see
    [coordinator-live-conformance.md](coordinator-live-conformance.md)).
- New adapter work must honour the policy on create, resume, config and every
  turn, and fail closed if a persisted session carries another policy id.
- Where a platform cannot honour an axis, report it in the policy's `note` and
  leave the tier at `provider-configured`. Do not silently drop the axis.
- Do not reintroduce a platform literal at any qualification gate (workspace
  service, runtime resolver, bridge launcher, trusted session input). That is
  what once let a platform hold a conversation but be refused a bridge.
- `delegation` is derived (`mcpClient && canInject`), not declared. The tier is
  about sandbox strength, not mail.

## Open questions

- Should Windows Claude be offered at the default safety level at all, given
  that its boundary is a command allowlist inside the bridge?
- Is `provider-configured` an acceptable final tier for OpenCode and Cursor, or
  does "same product" require `enforced` on every default-offered platform?

## Related

- [coordinator-live-conformance.md](coordinator-live-conformance.md): the live
  suite that produces the evidence these decisions need.
- [coordinator-consistency-gaps.md](coordinator-consistency-gaps.md): steer and
  the smaller parity gaps.
- [`coordinator.md`](../architecture/coordinator.md): "Provider qualification"
  and "Changing qualification"; `AGENTS.md` "Coordinator qualification".
- [`control-mcp.md`](../architecture/control-mcp.md) ("Project coordinator
  credentials").
- Living-doc drift to fix: `coordinator.md` links
  `docs/todo/coordinator-to-implement.md` twice, in its introduction ("What is
  still missing") and at the end of "Tests that exist today". That file is
  split into this file,
  [coordinator-live-conformance.md](coordinator-live-conformance.md) and
  [coordinator-consistency-gaps.md](coordinator-consistency-gaps.md). The
  introduction should point at all three; the "Tests that exist today" link
  should point at the live conformance file.

## Replaces

- `docs/todo/coordinator-to-implement.md` (introduction, "The unified
  interface", the read-only and waiting-tool rows of "Current matrix", and §1
  "Read-only adapters")
