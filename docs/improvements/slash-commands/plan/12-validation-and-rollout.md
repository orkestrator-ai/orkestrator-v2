# 12 — Validate, stage, and release slash-command support

Status: proposed. Dependencies: all earlier steps. [Index](00-index.md).

## Validation ownership

Use [testing-guide.md](../../../development/testing-guide.md) as the command and
scope authority, and [agent-testing.md](../../../development/agent-testing.md)
for isolated real-stack profiles. Use the Bun-testing skill when implementing
or modifying Bun suites. The commands below are future implementation checks;
they were not run as part of this documentation-only investigation.

## Contract and adapter test map

Extend the existing owners rather than introducing a second fake provider stack:

| Area | Existing test starting points | Required proof |
| --- | --- | --- |
| Protocol | `packages/protocol/src/agent-slash-commands.test.ts`, `native-agent.test.ts` | Identity, parsing, policy, bounds, projection schema compatibility |
| Backend catalogue | `native-agent-service-projection.test.ts`, `native-agent-service-progressive.test.ts`, `http-bridge-provider.test.ts` | Cold/empty/stale/error states, races, bounded discovery, bridge compatibility |
| Backend dispatch | `native-agent-service-prompt.test.ts`, `native-agent-service-dispatch.test.ts`, `native-agent-service-reconciliation.test.ts` | Queue identity, ambiguous acceptance, restart, workflow opt-out |
| Claude | `services/session-manager-catalog-transport.test.ts`, `session-manager-prompt.test.ts`, `routes/session.test.ts` | SDK names, replacement events, query draining, result/session lifecycle |
| Codex | `prompts/slash-commands.test.ts`, `app-server-runtime-prompt.test.ts`, `engine/app-server-engine.test.ts`, route/reducer suites | Structured skills, exact wire inputs, invalidation, template policy, read-loop independence |
| OpenCode | `opencode-provider-dispatch.test.ts`, provider runtime/stream suites | Real command list, exact v2 requests, file parts, message-ID recovery |
| Pi | `agent-session.test.ts`, `http.test.ts`, `prompt.test.ts`, persistence tests | One inventory, precedence, headless completion, deferred reload |
| Grok | ACP session/HTTP/persistence/drift tests | `input.hint`, replacement lists, attach/update/restart |
| Cursor | `http.test.ts`, protocol capability tests | Unsupported provider catalogue, separate application actions |
| Web | `useSlashCommandMenu.test.tsx`, `SlashCommandMenu.test.tsx`, `AgentNativeTab.test.tsx`, projection-store tests | Stable selection, draft intent, feedback, accessibility, rehydration |

Backend file names in the table are under `apps/backend/src/core/`; bridge and
web names are under their existing `src/` directories. Verify each owning path
when implementing rather than copying stale locations from old plans.

## Cross-provider behavioral matrix

For every integration and each supported execution category, exercise:

1. Cold inventory before any turn; first successful inventory; known empty;
   failed read; stale refresh; explicit refresh; command removal.
2. Typed canonical invocation, selected descriptor, alias, namespace, ambiguous
   collision, mixed case, no arguments, multiline arguments, and literal path.
3. Supported and unsupported attachments; annotations; pending handoff;
   workflow prompt starting with a slash; structured-output opt-out.
4. Idle, running, queued, cancelling, recovering, and parked-dispatch states.
5. Completion with model text, without model text, with local action output,
   with error, and with a pending approval/question.
6. Lost acknowledgement, bridge restart, backend restart, expired binding,
   provider generation death, and retry/discard under the original request ID.

Only run cases relevant to a provider's declared support. For unsupported
categories assert clear refusal rather than manufacturing a mock implementation.

## Mandatory inactive-environment scenario

1. Create sessions A and B in an isolated test project.
2. In A discover a fixture command and start it. Switch to B before acceptance
   or completion, so A's React tree can unmount.
3. While A is inactive, change its inventory, let the command finish or request
   interaction, and interrupt the event connection long enough to require
   reconciliation.
4. Return to A. Verify authoritative result/status, new inventory, stale draft
   handling, pending prompt, and correctly enabled controls.
5. Reload the browser and repeat with a bridge/backend restart at a controlled
   dispatch boundary. Ensure no command runs twice.
6. Let A become idle/detachable and verify catalogue refresh does not keep it
   alive or load its transcript in the background.

Run local-worktree coverage and container coverage where available. In containers
verify that skill/template paths resolve inside the provider environment, not
on the renderer or host. Use fixture content, never user projects.

## Performance and bounds

Use synthetic large inventories and delayed discovery. Assert bounded rows,
UTF-8 bytes, cache memory, concurrent probes, traversal, and expansion. Opening
the picker must not introduce one provider process or filesystem scan per
keystroke. Warm command reads must not wait for model/MCP/account refreshes.

Measure cold discovery latency, warm read latency, refresh coalescing, retained
catalogue bytes, and provider probe count against the pre-change baseline.
Record explicit budgets from steps 02/04/07. Do not make unsupported numeric
latency claims; report measured p50/p95 for the fixture environment and any
provider-specific unavoidable cold-start cost.

Diagnostics may contain operation class, provider enum, bounded counts,
latency, state transitions, and allowlisted error codes. Do not log command
names, arguments, skill/template paths, prompts, terminal output, credentials,
file contents, or attachment data.

## Example execution order

Run exact-owner focused tests during each change, through the logged runner:

```bash
mise run test:logged -- --name slash-protocol -- \
  bun test ./packages/protocol/src/agent-slash-commands.test.ts \
  --parallel=1 --only-failures

mise run test:logged -- --name slash-opencode -- \
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
  ./src/core/opencode-provider-dispatch.test.ts --parallel=1 --only-failures

mise run test:logged -- --name slash-codex -- \
  bun test ./bridges/codex-bridge/src/prompts/slash-commands.test.ts \
  --parallel=1 --only-failures
```

Then run the repository-required validation, each as a separate invocation:

```bash
mise run test:changed
mise run test:logged -- --name slash-check -- mise run check
mise run test
mise run test:logged -- --name slash-browser -- mise run test:browser
mise run test:logged -- --name slash-agent-browser -- mise run test:agent:browser
```

Use the guide's isolated profile setup for agent-browser runs. Add Electron
coverage if IPC changes, Docker coverage for environment-specific behavior,
and release-sensitive iOS validation on a supported Mac when applicable.
Changed-only tests are not final proof. A missing credential/runtime must be
reported as a skipped qualification with the affected capability disabled.

## Mixed-version rollout

1. Ship additive readers and negotiated contracts before enabling enhanced
   execution. Test new backend/old bridge, old backend/new bridge, and old/new
   renderer projections in the supported compatibility window.
2. New bridge descriptors must retain safe legacy display fields. Enhanced
   selected execution is available only when both sides negotiate support.
3. Never downgrade an explicit structured skill/action to raw text when the
   server is old. Return an update-required explanation and preserve the draft.
4. Gate provider categories independently until their qualification passes.
   Removing guessed rows can ship as a correctness fix; restoring them to hide
   a rollout problem is not an acceptable fallback.
5. Keep legacy routes as shared-source aliases for at least one documented
   release window, and check any remote backend support policy before removal.
   Count legacy route use without logging user command details.
6. Retire duplicate scanners/routes only after support-window and call-site
   evidence. Update architecture/operator docs and the old SDK command plan.

## Rollback and release record

A rollback disables the affected enhanced execution category and keeps safe
ordinary prompting plus already qualified actions available. Persisted selected
drafts/queued requests must become explicitly unavailable if an older adapter
cannot execute them; they must not become plain prompts. Keep compatibility
readers for stored invocation metadata during rollback.

Record tested commit, dependency pins, exact commands/results, provider support
table, isolated-profile/browser evidence, missed/skipped cases, and any changed
legacy template behavior. Announce removal of misleading menu entries and the
default shell-template restriction. Do not say “full slash-command parity”:
describe the precise provider surfaces qualified in this release.

Release only when every enabled descriptor has an executor, foreground and
inactive recovery tests pass, and no unresolved ambiguity can double-dispatch a
command or turn it into a different kind of request.
