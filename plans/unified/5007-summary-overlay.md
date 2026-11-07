---
id: 5007
title: "Warm and live scopes overlay their summary rows"
phase: 5
plan: "§5.1, §9 (Sidebar) and §12 Phase 5"
status: done
depends_on: [4002]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 5007 · Warm and live scopes overlay their summary rows

- **Report:** [§5.1 Scopes](../../docs/reports/unified-federation.md#51-scopes), [§9 Cross-node features](../../docs/reports/unified-federation.md#9-cross-node-features) (the Sidebar row)
- **Depends on:** [4002](4002-hydration-tiers-and-budgets.md) (tiers)
- **Size:** S–M
- **Track:** S (scopes)

## Goal

The sidebar, ⌘K search and title-bar readings show a warm or live node from its scope's full stores, and every other node from summaries, as §9's Sidebar row describes ("Summaries for every node; full scope stores overlay warm/live nodes; parity tests kept and extended to 'same row from summary vs scope'").

## Current state (verified 2026-11-07)

Found while doing [6004](6004-documentation.md): the sidebar, ⌘K search and title-bar readings use summaries only, whatever the node's tier. `docs/architecture/federation.md` lists this under known limitations.

## Work

- [x] In the presentation path (`docs/architecture/federation.md#one-presentation-for-both-paths`: `lib/federation/aggregate.ts`, `node-summaries.ts`, `MachineView`), take a node's rows from its scope's project and environment stores while the scope is `warm` or `live`, and from its summary otherwise. Switching tiers must not flicker or reorder rows.
- [x] Apply the same rule to ⌘K search and the title-bar readings that read per-node data.
- [x] Remove the known-limitation line from `federation.md` and describe the overlay.

## Tests

- [x] Parity: the same row rendered from a summary and from a scope is identical (extend the existing parity tests).
- [x] A tier change from summary to warm and back keeps the row stable; a scope's fresher data (an environment renamed in the scope) shows without waiting for the next summary.

## Done when

- [x] Warm and live nodes' rows come from their scopes, with the parity tests passing.

## Notes

- 2026-11-07 (orchestrator): created from 6004's finding that the §9 overlay was never assigned to an item.
- **API (2026-11-07).**
  - `lib/federation/scope-overlay.ts` (new): `ScopeRows { projects, environments }`; `scopeRowsReady(scope): boolean`; `readScopeRows(scope): ScopeRows | null`; `machineViewWithScopeRows(view, summary, rows): MachineView` (the node's summary view with its projects and environments from the scope's records); `scopeRowsSource(windowScope): { subscribe, getSnapshot }` (one per window, a `useSyncExternalStore` source over every leaf scope's tier, connection, first authoritative reads and project/environment stores; its snapshot keeps its identity while no node's rows changed); `SUMMARY_ONLY_ENVIRONMENT_FIELDS` (module constant).
  - `components/federation/useMachineViews.ts`: `useRemoteMachineViews()` now overlays (`viewFromNodeSummary` stays the pure summary mapping); new `useRemoteMachineView(nodeId)`.
  - `lib/node-scope/snapshot-sync.ts` (additive): `scopeAuthoritativeReads(scope): ReadableSignal<ReadonlySet<SnapshotGatedKind>>`, changed when a kind is first read.
  - `lib/node-scope/providers.tsx` (additive): `useWindowScopeWithFallback()` (the nearest window scope or the app's, without requiring a command scope); `useScopesWithCommandFallback` uses it.
  - `components/layout/AppShell.tsx`: the title bar's names and merge-ready shimmer of the node on screen read `useRemoteMachineView` instead of `portalState.nodes`.
- **Decision: where the overlay applies (2026-11-07).** Options: (a) in each reader (sidebar sections, ⌘K, title bar); (b) once, in `useRemoteMachineViews`, which every one of them already reads (sidebar through `useMachineViews`, ⌘K through `machineSearchSource` over `useMachineViews`, the title bar's CPU readings through `useMachineViews`, and now its names through `useRemoteMachineView`). Chosen (b): one rule, and the shared components and adapters ("One presentation for both paths") stay unchanged, since the overlay produces the same `NodeProjectSummary`/`NodeEnvironmentSummary` shapes.
- **Decision: how a scope row is made (2026-11-07).** Options: (a) a third adapter from `Environment` to row facts (like `localEnvironmentRowFacts`); (b) the scope's records through the command node's own projection (`toNodeProjectSummary`/`toNodeEnvironmentSummary`), with the same caps and order. Chosen (b): parity with the summary row is by construction (the same function on the same record shape), so "same row from summary vs scope" holds for every field the record carries, and a new summary field needs no second implementation. The fields only a summary read adds (`EnvironmentSnapshotRowSchema`'s extras: PR monitor health, `buildPipeline`, `buildActive`, agent mail, `dockerAvailable`; a project's `defaultBranch`) are kept from the summary row of the same id, and a row created since the summary takes the machine's Docker fact from the other rows. They are as fresh as the summary, as before. Considered and not done: reading `buildActive` from the scope's build-pipeline store (it is a workflow store whose loading on a leaf is 3011/3012's, and the summary already carries it).
- **Decision: when the scope is used (2026-11-07).** A leaf scope at tier `warm` or `live` (the scope's own `tier` signal, which `WindowScope.lifecycle` sets), whose client is `live` or `resyncing`, and whose stores hold authoritative data: `projectStore.hasLoaded` (false after a snapshot hydration, 4003) and an authoritative environment read (`noteAuthoritativeRead(scope, "environment")`, from 3004's every-scope environment resync). The environment condition needed the new `scopeAuthoritativeReads` signal: the resync calls `setEnvironments` before `noteAuthoritativeRead`, and an unchanged set notifies no store subscriber, so a store subscription alone would miss the moment. `suspended` goes back to the summary because its streams are closed, so the summary is the fresher source. A client that cannot hear its node (`connecting`, `lapsed`, `failed`) also yields to the summary, which the command node keeps current on its own link. The machine-level fields (transport, freshness, `loadedAt`, release) stay the command node's, so `isMachineWritable` and the "Not available yet" state are unchanged.
- **Decision: project icons (2026-11-07).** The scope's icon is used (`normalizeProjectIcon` through the projection). The summary drops icons past a shared 256 KiB budget per node (`boundSummaryIcons`); a warm node's projects past that budget therefore show their icon, as on the node's own sidebar. That is the only visible difference and needs more than five 48 KiB icons on one node; no screenshot was taken for it (rows within the budget are identical, which the tests pin).
- **No flicker (2026-11-07).** Rows are keyed by node-qualified key on both sources, and the order is the node's own `order` on both, so a tier change re-renders rows in place: `sidebar-parity.test.tsx` checks the drawn sidebar is byte-identical across summary → warm → live → suspended → warm and that the row element is the same DOM node. Optimistic reorders (`remote-order-writes.ts`) still settle on the summary; while a warm scope already shows the new order the overlay draws the same order, so nothing jumps.
- **Visible change: none expected, none found.** With equal data the rows are identical (tests). The intended change is fresher data. No screenshots rendered.
- **Effect.** Not used. The overlay is a synchronous projection read during render, and the source is a `useSyncExternalStore` adapter over the scopes' signals and zustand stores; an Effect program would add a runtime boundary with nothing to compose. Its listeners are released by React's unsubscribe; the scopes' own lifetimes (Effect `Scope`) are untouched.
- **Outside the file set (minimal, additive).** `lib/node-scope/snapshot-sync.ts` (the signal) and `lib/node-scope/providers.tsx` (the fallback hook).
- **Title-bar test.** `AppShell.test.tsx` was being edited by 3018 at the time (uncommitted), so the title bar's reader is tested at the hook it uses (`useMachineViews.overlay.test.tsx`: names from the live scope, the summary before its authoritative read and once suspended). An `AppShell`-level case could be added there once 3018 lands.
- **For the orchestrator (report).** §9's Sidebar row could say the overlay is per node and condition (warm/live, heard, authoritative), and that summary-only fields stay the summary's.
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): added the scope overlay (`lib/federation/scope-overlay.ts`): a warm or live leaf scope's authoritative project and environment records, through the summary projection with the summary's caps and order and the summary-only fields kept, replace that node's summary rows in `useRemoteMachineViews`, so the sidebar, the ⌘K search and the title bar's names and merge-ready shimmer of the shown node read them; `scopeAuthoritativeReads` in `snapshot-sync.ts`; `useWindowScopeWithFallback`; `AppShell` on `useRemoteMachineView`; `federation.md` (machine views, "Summaries and scopes together", the adapters, ⌘K sources, the summary-field recipe; the known-limitation line removed). Tests: `scope-overlay.test.ts` (7: whole-view parity, fresher scope data with summary-only fields kept, bounds, readiness across tiers/connection/authoritative reads, snapshot-painted scope, command and summary scopes, unsubscribe), `environment-row-model.parity.test.ts` (+19: every row case from summary vs scope), `sidebar-parity.test.tsx` (+2: identical drawn sidebar and same row element across summary/warm/live/suspended; a rename in the scope shown before the summary, summary again when suspended), `ProjectSearchBar.federation.test.tsx` (+1: ⌘K finds a warm node's renamed environment), `useMachineViews.overlay.test.tsx` (1, new: the title bar's reader). Focused web run `src/components/federation src/lib/federation src/lib/node-scope src/components/sidebar src/components/layout src/components/environments src/lib/node-snapshots.test.ts src/lib/project-search.test.ts`: 1,969 pass, 0 fail; root `HierarchicalSidebar`/`SortableSidebarItems` pass; `source-guards.test.ts` fails only on other files' baseline findings. Web typecheck clean; fmt and oxlint clean on touched files.
