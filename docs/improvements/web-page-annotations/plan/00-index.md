# Web page annotations — implementation plan

Status: Implemented; review gaps closed (2026-09-25); gate verification partial. Source review: 2026-09-21.
Living guide: [web-page-annotations.md](../../../architecture/web-page-annotations.md).

This plan implements the recommendations in
[the findings](../../web-page-annotations.md). It describes proposed work;
type, command, tool, and file names described as new do not exist yet. Existing
integration points were checked against the repository. No implementation or
runtime validation is claimed by this document.

## Outcome

A user can select part of a preview, save feedback without an agent open,
discuss it with one chosen session, request an implementation, and return to
the same thread to review and accept the result. Feedback, execution state,
and evidence survive tab changes, missed events, and backend restarts.

The first release must complete this entire cycle with element capture and
manual review. It must not require advanced anchoring, result tools, automatic
screenshots, or non-desktop capture to deliver useful work.

## Reading and execution order

Read this index and step 01 before implementation. Follow the dependency table;
the numbering supplies a default order. Each step names its inputs, code
boundaries, tasks, failure handling, verification, and completion criteria.
Step 14 is a continuing verification checklist: use its applicable gate during
every step, not only after all feature work is complete.

| Step | Plan | Dependencies | Milestone | Status |
| --- | --- | --- | --- | --- |
| 01 | [Domain model, contracts, and state transitions](01-domain-model-and-contracts.md) | None | A | Implemented; gaps closed 2026-09-25; gate partial |
| 02 | [Durable storage, assets, and retention](02-storage-assets-and-retention.md) | 01 | A | Implemented; gaps closed 2026-09-25; gate partial |
| 03 | [Commands, synchronization, and capability discovery](03-commands-synchronization-and-capabilities.md) | 01, 02 | A | Implemented; gaps closed 2026-09-25; gate partial |
| 04 | [Trusted capture and acknowledged delivery](04-trusted-capture-and-delivery.md) | 01–03 | A | Implemented; gaps closed 2026-09-25; gate partial |
| 05 | [Annotation panel and authoring](05-annotation-panel-and-authoring.md) | 03, 04 | A | Implemented; gaps closed 2026-09-25; gate partial |
| 06 | [Agent targeting and change briefs](06-agent-targeting-and-change-briefs.md) | 01–03, 05 | A | Implemented; gaps closed 2026-09-25; gate partial |
| 07 | [Dispatch, queues, and recovery](07-dispatch-queues-and-recovery.md) | 02, 03, 06 | A | Implemented; gaps closed 2026-09-25; gate partial |
| 08 | [Discussion, progress, and manual review](08-discussion-progress-and-review.md) | 05–07 | A | Implemented; gaps closed 2026-09-25; gate partial |
| 09 | [Legacy migration and first release](09-migration-and-first-release.md) | 01–08; step 14 gate A | A | Implemented; gaps closed 2026-09-25; gate partial |
| 10 | [Anchors, navigation, and stale targets](10-anchors-navigation-and-stale-targets.md) | 04, 05, 09 | B | Implemented; gaps closed 2026-09-25; gate partial |
| 11 | [Batch review and efficient evidence](11-batch-review-and-evidence.md) | 06–10 | B | Implemented; gaps closed 2026-09-25; gate partial |
| 12 | [Structured results and visual verification](12-results-and-visual-verification.md) | 08, 10, 11 | C | Implemented; gaps closed 2026-09-25; gate partial |
| 13 | [Additional capture modes and client support](13-capture-modes-and-client-support.md) | 10–12 | C | Implemented; gaps closed 2026-09-25; gate partial |
| 14 | [Validation, observability, and release gates](14-validation-observability-and-release.md) | Starts after 01; gates each milestone | A–C | Fixture, real-stack specs and bounds landed; live-agent, Docker, remote and iOS gates outstanding |

### Milestones

- **A — Complete the core loop:** steps 01–09, plus gate A in step 14. Native
  desktop element capture; persistent app-owned discussion; one annotation per
  request; explicit destination; durable dispatch; manual review and resolution.
- **B — Review a page efficiently:** steps 10–11, plus gate B. Reliable anchor
  recovery, stale-target handling, grouped requests, bounded evidence selection.
- **C — Improve evidence and reach:** steps 12–13, plus gate C. Optional
  structured result tools, comparable before/after captures, more selection
  modes, and accurately advertised client capabilities.

Within each milestone, merge small PRs through the repository's normal review
process. Keep incomplete entry points disabled by backend/client capability
negotiation. Final merges to `main` belong to a human maintainer.

## Implementation record (2026-09-24)

All steps landed in one working tree on branch `20260924-090518-b9c71b2501fe`
(not yet committed or reviewed). Automated evidence: protocol, backend,
desktop and web unit/contract suites, repository `mise run check`, and
`mise run test`. Not yet exercised: the isolated Electron native-window checks,
Docker materialization, remote backend upload, live-agent smoke runs per
provider, and the synthetic fixture application from step 14. Checkboxes in
the step files remain unchecked until that gate evidence is recorded.

Deviations and known gaps are listed under **Known limitations** in the living
guide.

## Gap-closure record (2026-09-25)

A plan-versus-code audit found partial or missing work in every step. The
follow-up changes on this branch close those gaps:

- **Contracts and storage (01–03, 09, 14):** plan page size, justified
  transition table, archive and continuation at capacity, typed errors with
  usage, a manifest without prompt or draft bodies, startup record validation,
  symlink-safe container materialization with owned cleanup, a rollout switch
  (`enabled`/`read-only`/`disabled`), content-free metrics, and migration
  receipts with screenshot and ownership metadata.
- **Dispatch and results (06–08, 11–12):** removing an annotation from the chat
  queue cancels the request; annotation queue items are frozen; missing
  destinations and rejected dispatches are explicit holds; the native queue is
  no longer un-parked automatically; recorded turn outcomes, linked
  interactions, transcript message ids, the session's own mode for implement
  requests, capability-derived tool support, per-model image support,
  deterministic cross-session thread excerpts, batch follow-ups, per-annotation
  result captures and agent-reported and app-observed evidence kept apart.
- **Desktop capture (04, 05, 10, 12, 13):** typed expiry notices, receipts and
  recapture, keyboard-only selection, editor focus handoff, corroborated
  anchors, `too-complex` and `historical` outcomes, bounded mutation-driven pin
  re-resolution, `showOnPage`, stable result captures with reapplied masks,
  advertised capture modes and responsive capture sets.
- **Web (03–13):** automatic upload resume and re-acknowledgement, local draft
  persistence, archive and history paging, narrow-layout switching, dirty
  compose-draft reconciliation, rollout banners and settings, request execution
  states, in-panel interaction answers, follow-up and retarget flows, and
  conversation navigation to the request's message.
- **Validation (14):** the synthetic fixture application
  (`test-fixtures/agent-project/annotation-app/`), Electron and gateway
  real-stack specs under `e2e/agent-testing/`, and worst-case payload bounds
  (`web-annotation-payloads.bench.test.ts`).

Gate evidence recorded so far is in step 14. Live-agent implementation runs,
Docker materialization, remote upload, iOS review and multi-zoom native-window
checks remain outstanding, so the step checkboxes stay unchecked.

## Architectural decisions

1. **The backend owns annotations.** Use a dedicated annotation service with
   persisted records, immutable request snapshots, and bounded asset storage.
   Renderer stores are projections; pane layout contains identifiers and UI
   preferences only.
2. **The desktop owns native capture.** The Electron main process tracks capture
   lifecycle and a bounded pending spool. Page inspection produces untrusted
   evidence. Human comments and send actions live in Orkestrator's renderer.
3. **The existing agent service owns execution.** Extend `NativeAgentService`
   queue/dispatch correlation. Do not add a second queue drainer, agent process,
   renderer-owned worker, or provider-specific annotation execution path.
4. **Requests and threads have different lifetimes.** An implementation request
   freezes selected revisions. Later comments remain editable. Only a human
   acceptance action resolves the relevant annotation revision.
5. **Discuss is a distinct request operation.** It asks for analysis and does
   not authorize implementation. Use enforceable read-only execution when the
   provider supports it without disturbing another turn; otherwise label the
   limitation and do not promise a sandbox guarantee. Never silently change a
   running session's execution policy.
6. **Snapshots repair events.** Revision hints invalidate cached views. Client
   activation and cursor reconciliation recover even a lost final hint.
7. **Dispatch uncertainty stays visible.** Native dispatch journals remain the
   authority on whether a turn was sent. A timeout does not authorize a new-ID
   retry. Discarding uncertainty does not prove that work never ran.
8. **All providers use the shared flow.** Images, read-only execution, transcript
   linking, and result tools depend on advertised capabilities, not frontend
   checks for provider names.

## Repository integration map

Paths in this table exist today; new modules are identified within each step.

| Concern | Existing owner |
| --- | --- |
| Preview capture contract | `packages/protocol/src/browser-preview.ts` |
| Native preview/runtime | `apps/desktop/electron/browser-preview-manager.ts`, `browser-preview-annotation-script.ts` |
| Desktop IPC and preload | `apps/desktop/electron/ipc.ts`, `preload-api.ts` |
| Browser UI and adapter | `apps/web/src/components/browser/BrowserTab.tsx`, `apps/web/src/lib/native/browser-preview.ts` |
| Legacy annotation formatting/distribution | `apps/web/src/lib/chat/browser-annotations.ts`, `transcript-annotations.ts` |
| Compose persistence | `apps/web/src/stores/nativeComposeStore.ts`, `apps/web/src/hooks/useNativeComposeDraftPersistence.ts` |
| Service lifecycle and context | `apps/backend/src/core/index.ts`, `commands-context.ts` |
| Command composition | `apps/backend/src/core/commands.ts` exports `createCommandRegistry` from `commands-registry.ts`; registrars live alongside it |
| Native dispatch/recovery | `apps/backend/src/core/native-agent-service-dispatch.ts`, `native-agent-service-reconciliation.ts` |
| Durable queue operations | `apps/backend/src/core/storage-prompts.ts`, `storage-native.ts` |
| Native prompt construction/projection | `apps/backend/src/core/native-agent-service-prompt.ts`, `native-agent-service-projection.ts` |
| Agent credentials/tools | `apps/backend/src/core/agent-tools.ts`, `workflow-result-service.ts`, `workflow-result-tools.ts` |
| Existing storage/sync precedent | `apps/backend/src/core/design-service.ts`, `commands-registry-design.ts`; `docs/architecture/design-canvas.md` |
| Native chat and interactions | `apps/web/src/components/native-agent/AgentNativeTab.controller.tsx`, `apps/web/src/hooks/useNativeAgentSession.ts` |

`prompt-queue-drainer.ts` is the **tmux** drainer. Native queues are drained in
`native-agent-service-reconciliation.ts`; annotation requests target that path.
The design canvas offers persistence and synchronization patterns, but its
self-contained HTML renderer does not reproduce arbitrary authenticated apps.

## Working conventions

- Update the status here and in the owning step together. A checked task means
  implemented and verified; record the PR and validation evidence before marking
  the whole step complete. A drafted plan is not completed implementation.
- Keep protocol definitions and limits in step 01 authoritative. If a measured
  need changes a limit, update that step, code, tests, and dependent steps.
- New files listed in a step are suggested ownership boundaries, not permission
  to create large catch-all modules. Keep files below repository size guidance.
- Test each step's failure cases as it lands. Follow the
  [testing guide](../../../development/testing-guide.md) and
  [isolated agent testing guide](../../../development/agent-testing.md).
- Use repository `mise` tasks and logged test wrappers. Regenerate lockfiles
  using the pinned runtime if implementation changes package metadata.
- No commit, push, release, or implementation is performed by writing this plan.

## Scope boundaries

Initial delivery does not include collaborative human accounts, arbitrary
third-party website inspection, issue-tracker export, automatic commits or PRs,
automatic approval of agent actions, or code generation from private framework
internals. Implementation changes repository source through existing agents;
temporary page DOM edits are not a completed change.

Optional component/source hints and controlled pixel diffs are described in
step 12. External issue export and multi-user collaboration require separate
product and authorization designs after this plan.
