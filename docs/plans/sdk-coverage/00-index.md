# SDK coverage plans — index

Status: Active — living index for SDK coverage work.

Source review: [`docs/plans/sdk-coverage-2026-09-06.md`](../sdk-coverage-2026-09-06.md).
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

Status lines refreshed 2026-09-11 against the current tree. Several plans
marked ⬜ below were already substantially implemented; read the plan's own
status paragraph before picking it up.

| # | Plan | Status | Depends on | Summary |
| --- | --- | --- | --- | --- |
| 01 | [Quick correctness fixes](01-quick-correctness-fixes.md) | ✅ | — | Eight small, independent fixes: wrong success reporting, dropped elicitation mode, drift-counter noise, wrong typed fields. |
| 02 | [Typed engine boundaries and drift detection](02-typed-engine-boundaries-and-drift.md) | ✅ | — | Every bridge imports its SDK union, dispatches exhaustively, and turns an unknown variant into a normalized notice instead of silence. Generic runtime-health route on every bridge. |
| 03 | [Transcript part coverage](03-transcript-part-coverage.md) | ✅ | 02 | New generic part kinds (compaction, retry, image, progress, status) and adapters so no provider drops a renderable event. |
| 04 | [Interactions: elicitation, dialogs and permissions](04-interactions-elicitation-and-permissions.md) | 🟨 ~65% | 02 | Shared interaction contract and unattended policy are live. Remaining: permission-rules API, full elicitation parking, Grok titles, QA. |
| 05 | [Mid-turn control: steer and graceful interrupt](05-mid-turn-control-steer-and-interrupt.md) | 🟨 ~50% | 02 | Codex/Claude/Pi/Cursor steer and the abort ladder are live. Remaining: Claude long-lived query, Grok/OpenCode steer, crash recovery, QA. |
| 06 | [Commands, skills and prompt templates](06-commands-skills-and-templates.md) | 🟨 ~80% | 02 | Normalized catalogue and picker grouping are live. Remaining: retire legacy `/plugins/commands` and Claude filesystem scan. |
| 07 | [MCP inventory and management](07-mcp-inventory-and-management.md) | 🟨 ~75% | 02, 04 | Routes, actions, and `McpServersPanel` are live. Cursor/Grok get the Orkestrator MCP server at launch; Pi reports a live session inventory. Remaining: Claude config-parse leftover, lifecycle polish, QA. |
| 08 | [Auth and account status](08-auth-and-account-status.md) | 🟨 ~65% | 02 | Auth routes exist on the major bridges. Remaining: OpenCode OAuth, turn-time notices, settings-pane card. |
| 09 | [Session history: fork, rewind, revert and titles](09-session-history-fork-rewind-titles.md) | 🟨 ~45% | 02, 03 | Codex/Cursor rewind and Pi fork exist. Remaining: backend-owned titles, Pi switch-branch, Claude resume-at. |
| 10 | [Composer: model axes and settings](10-composer-model-axes-and-settings.md) | 🟨 ~60% | 02 | Generic parameters drive Claude/Cursor/Pi/ACP controls. Remaining: Codex axes, reasoning/speed alias cleanup. |
| 11 | [Usage, cost and limits](11-usage-cost-and-limits.md) | 🟨 code done | 02 | All six providers map usage. Remaining: browser/reload QA. |
| 12 | [Execution policy and host/container parity](12-execution-policy-and-host-container-parity.md) | 🟨 code done | 04 | Backend-owned policy is applied on create. Remaining: Docker/browser QA. |
| 13 | [OpenCode on v1: streaming and cleanup](13-opencode-v1-streaming-and-cleanup.md) | 🟨 code done | 03 | v1 SSE adoption and dead-card removal are in tree. Remaining: inactive-path browser QA. |
| 14 | [ACP bridge generalization](14-acp-bridge-generalization.md) | 🟨 ~85% | 02, 06, 08 | Typed ACP client and Cursor-era cleanup are in tree. Remaining: fence Grok interjection, real-Grok QA. |
| 15 | [Adapter simplification](15-adapter-simplification.md) | 🟨 ~50% | 05, 06, 09 | Partial: Claude hooks/plan capture and Pi/Cursor SDK helpers. Remaining items are blocked on 05/09. |

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
  `docs/architecture/agent-engines.md`; plan 08 improves the
  read-only status only.
- **Codex `thread/delete`.** Never, per `AGENTS.md`.

## Conventions for editing these plans

- Check a box when the task is merged to `main`, not when a branch exists.
- If a task is dropped, strike it through and add a one-line reason.
- Keep file references current; a moved file is a plan edit.
- When a plan changes the shared protocol, list the type or route under
  "Normalized model" so the next plan can depend on it by name.
