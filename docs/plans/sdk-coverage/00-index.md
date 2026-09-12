# SDK coverage plans — index

Source review: [`docs/todo/sdk-coverage-2026-09-06.md`](../../todo/sdk-coverage-2026-09-06.md).
These plans turn that review into work that can be picked up one milestone at
a time. Each plan is self-contained: goal, the normalized model it introduces
or extends, tasks with checkboxes grouped by layer, verification, and what it
deliberately leaves out.

## Status legend

| Mark | Meaning |
| --- | --- |
| ⬜ | Not started |
| 🟨 | In progress |
| ✅ | Done |
| ⏸ | Deferred or blocked (reason in the plan) |

Update the status line at the top of a plan and the table below together.
A plan is ✅ only when every task box is checked or explicitly struck through
with a reason.

## Milestones

| # | Plan | Status | Depends on | Summary |
| --- | --- | --- | --- | --- |
| 01 | [Quick correctness fixes](01-quick-correctness-fixes.md) | ✅ | — | Eight small, independent fixes: wrong success reporting, dropped elicitation mode, drift-counter noise, wrong typed fields. |
| 02 | [Typed engine boundaries and drift detection](02-typed-engine-boundaries-and-drift.md) | ✅ | — | Every bridge imports its SDK union, dispatches exhaustively, and turns an unknown variant into a normalized notice instead of silence. Generic runtime-health route on every bridge. |
| 03 | [Transcript part coverage](03-transcript-part-coverage.md) | ✅ | 02 | New generic part kinds (compaction, retry, image, progress, status) and adapters so no provider drops a renderable event. |
| 04 | [Interactions: elicitation, dialogs and permissions](04-interactions-elicitation-and-permissions.md) | 🟨 | 02 | Route every provider's questions, MCP elicitations, dialogs and permission escalations through the existing interaction contract, with a capability bit and an unattended policy. |
| 05 | [Mid-turn control: steer and graceful interrupt](05-mid-turn-control-steer-and-interrupt.md) | ⬜ | 02 | Long-lived Claude query with `streamInput`/`interrupt`, Cursor `Run.steer`, Pi follow-up queue, and a shared interrupt-then-kill abort ladder. |
| 06 | [Commands, skills and prompt templates](06-commands-skills-and-templates.md) | ⬜ | 02 | One normalized slash-command catalogue with a source tag, populated from each SDK instead of filesystem scans and counts. |
| 07 | [MCP inventory and management](07-mcp-inventory-and-management.md) | 🟨 | 02, 04 | Cursor/Grok receive the Orkestrator MCP server at launch; Pi now reports a live session inventory. Remaining: status/lifecycle actions in one panel. |
| 08 | [Auth and account status](08-auth-and-account-status.md) | ⬜ | 02 | Normalized sign-in state for every platform, an in-app sign-in action where the SDK offers one, and auth-in-progress surfaced in the tab. |
| 09 | [Session history: fork, rewind, revert and titles](09-session-history-fork-rewind-titles.md) | ⬜ | 02, 03 | Message-level rewind for Codex and Cursor, SDK-native fork for Pi, session-tree resume entries, and backend-owned titles for every platform. |
| 10 | [Composer: model axes and settings](10-composer-model-axes-and-settings.md) | ⬜ | 02 | Generic per-model parameter descriptors so Cursor's extra axes, Claude's thinking budget and betas, and Pi's persisted defaults all render through the same controls. |
| 11 | [Usage, cost and limits](11-usage-cost-and-limits.md) | 🟨 | 02 | Fill the existing `NativeAgentContextUsage` from every SDK: per-turn cost, rate limits, context percent after compaction, account-level usage. |
| 12 | [Execution policy and host/container parity](12-execution-policy-and-host-container-parity.md) | 🟨 | 04 | A backend-owned execution policy (sandbox, approvals, tool allow/deny, project resources) that every adapter honours, so the same repo behaves the same on host and in a container, or the difference is stated. |
| 13 | [OpenCode on v1: streaming and cleanup](13-opencode-v1-streaming-and-cleanup.md) | 🟨 | 03 | Adopt the v1 SSE events that replace polling, type the prompt payload, and delete the dead renderer paths. No v2 protocol. |
| 14 | [ACP bridge generalization](14-acp-bridge-generalization.md) | 🟨 | 02, 06, 08 | Vendored ACP schema, client-side `fs` and `terminal`, `authenticate`, open mode mapping, and removal of Cursor-era code, so the bridge can host any ACP agent. |
| 15 | [Adapter simplification](15-adapter-simplification.md) | 🟨 | 05, 06, 09 | Replace hand-rolled reimplementations with the SDK primitive that now exists: Claude hooks and plan-mode instructions, Pi typed session parsing, Claude MCP config parsing, Codex goals decision. |

Suggested order: 01 first (independent, quick wins), then 02 (everything
else builds on typed boundaries), then 03 and 04 in parallel, then the rest in
numeric order. 13, 14 and 15 can run whenever their dependencies land.

## Architecture rules every plan follows

These come from the request that produced the plans and from `AGENTS.md`.
A task that violates one is a task to rewrite, not a task to do.

1. **Backend owns the behaviour.** New state, decisions, policies and
   long-running work live in the bridge, the backend provider layer
   (`apps/backend/src/core/http-bridge-provider.ts`, `opencode-provider.ts`),
   the backend service (`native-agent-service-*.ts`) or the persistent store.
   The renderer reads projections and capability flags and renders them. If
   a task needs an `if (platform === …)` in `apps/web`, it belongs one layer
   lower.
2. **Adapters sit as low as possible.** Vendor shapes stop at the bridge's
   translate layer (`translate.ts`, `session-manager-*.ts`, `event-reducer.ts`,
   `item-adapter.ts`, `acp-session.ts`, `opencode-messages.ts`). Above that,
   everything speaks the shared protocol in `packages/protocol/src/`.
3. **Normalize, then generalize.** A feature is added to the shared model
   first (a part kind, an interaction kind, a capability bit, a composer
   control), and adapters populate it. A provider that cannot populate it
   leaves the field absent or the bit `false`; the renderer hides the control.
   Provider-only features are fine; provider-only UI is not.
4. **Missing is not an error.** A bridge answers a capability it lacks with an
   empty list, an absent field or a `false` bit, never a 404 the backend would
   read as "older bridge". See `AGENTS.md` on `/activity` and `/dispatch`.
5. **Invariants from `AGENTS.md` hold.** Approvals fail closed. Stdout loops
   never await consumers. Snapshots are authoritative, events are hints.
   Unmount is not cancel. Nothing sensitive in logs or metrics.
6. **Tests follow the split.** A new adapter mapping gets a bridge-level test
   against a recorded or fake vendor payload; a new protocol type gets a
   protocol test; a new renderer component gets a rendering test with
   synthetic projections. Browser QA per `docs/development/agent-testing.md`
   for anything a user can see.

## Deliberately not planned

- **OpenCode v2 session protocol.** Not stable enough yet. Plan 13 works
  strictly within the v1 surface the repo already uses. Revisit with
  `docs/todo/opencode-v2.md` when upstream settles.
- **Provider-native code review.** Code review stays an Orkestrator-owned
  pipeline. Codex `review/start` remains as it is today and is not extended;
  `enteredReviewMode`/`exitedReviewMode` items are not rendered; Cursor cloud
  agents with auto-PR are not exposed.
- **Cursor cloud agents, Codex plugins/marketplace, Codex thread sections,
  Windows sandbox, Codex realtime/voice.** Product surfaces with no generic
  counterpart in Orkestrator.
- **Pi provider login.** Stays out by the reasoning in
  `docs/technical-architecture/agent-engines.md`; plan 08 improves the
  read-only status only.
- **Codex `thread/delete`.** Never, per `AGENTS.md`.

## Conventions for editing these plans

- Check a box when the task is merged to `main`, not when a branch exists.
- If a task is dropped, strike it through and add a one-line reason.
- Keep file references current; a moved file is a plan edit.
- When a plan changes the shared protocol, list the type or route under
  "Normalized model" so the next plan can depend on it by name.
