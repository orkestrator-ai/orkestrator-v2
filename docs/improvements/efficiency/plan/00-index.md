# Efficiency implementation plan

Date: 2026-09-21. Source baseline: `88c2f9cc`.

Status: **Every finding has shipped changes (2026-09-27)**. Steps 01 and 13
remain partial (measurement coverage; frontend page structure), and several
steps list unrun real-stack checks; see the status column and
[step 19](19-integration-and-rollout.md) for the consolidated evidence and the
surfaces that were not validated. This directory is the implementation
specification for the [efficiency review](../README.md); the original findings
remain the dated evidence record.

## Intended result

An unchanged transcript read should perform metadata work only. A changed read
should do work proportional to the changed messages/parts and requested window.
Historical pages and large artifacts should be fetched independently. Display
cache updates should affect one record, while durable workflow and dispatch
state remain recoverable independently of display retention. None of these
changes may make background work depend on a mounted UI.

The work is divided into independently reviewable changes. Step numbers give
the preferred reading and implementation order; the dependency column gives
the actual prerequisites. Several steps can proceed independently after the
baseline, but shared protocol/storage changes should land before their callers.

## Numbered steps

Status is summarized here; each step's execution record is authoritative.

| Step | Plan | Findings | Hard prerequisites | Status |
| --- | --- | --- | --- | --- |
| 01 | [Baseline instrumentation and fixtures](01-baselines-and-instrumentation.md) | All | None | Partial (E11–E14, heap/RSS, browser, remote not measured) |
| 02 | [Linear transcript size accounting and trimming](02-linear-transcript-budgets.md) | E09; supports E01/E05 | 01 | Complete |
| 03 | [Cursor bounds during background streaming](03-cursor-background-bounds.md) | E01 | 02 | Complete (live trim thresholds not reached) |
| 04 | [Cursor persistence and dispatch barriers](04-cursor-durable-persistence.md) | E02 | 01; use 02 for sizing | Complete |
| 05 | [Claude transcript revisions](05-claude-transcript-revisions.md) | E03 | 01 | Complete (inactive-tab QA unrun) |
| 06 | [Keyed storage and migration primitives](06-keyed-storage-primitives.md) | E04/E14 | 01 | Complete |
| 07 | [Independent display-tail records](07-display-tail-storage.md) | E04 | 06 | Complete |
| 08 | [Transcript summary, detail, and history contracts](08-transcript-contracts.md) | E05/E06/E07/E13 | 01 | Complete |
| 09 | [Provider summary/detail adapters](09-provider-transcript-adapters.md) | E06; supports E05/E07/E13 | 02, 05, 08 | Complete (shared contract; Grok not run live) |
| 10 | [Bounded Codex rollout reading and indexing](10-codex-rollout-reader.md) | E08 | 01; coordinate with 08 | Complete |
| 11 | [Direct history paging](11-direct-history-paging.md) | E07 | 08, 09; 10 for Codex indexed pages | Complete (v2 providers, page cache; joined fallback kept) |
| 12 | [Incremental backend projection work](12-incremental-backend-projection.md) | E05 | 05, 09 | Complete (row reuse; one comparison walk remains) |
| 13 | [Frontend history and cache accounting](13-frontend-history-accounting.md) | E10 | 12 | Partial (items 1, 4, 7; no browser profiling) |
| 14 | [Measured part-level streaming deltas](14-part-level-deltas.md) | E05 | 08, 09, 12, 13; benchmark gate | Adopted, negotiated |
| 15 | [Conditional review/workflow transcript reads](15-reviewer-and-progress-reads.md) | E13 | 09, 11 | Complete (no live multi-review run) |
| 16 | [Separate pipeline transcripts from control state](16-pipeline-transcript-storage.md) | E14 | 06, 09, 11 | Complete (control partitioning deferred) |
| 17 | [Visibility-aware reads and batched activity](17-read-scheduling-and-activity.md) | E11 | 08, 09; coordinate with 15 | Complete |
| 18 | [Cached file trees with reconciliation](18-file-tree-caching.md) | E12 | 01 | Complete (no container watcher) |
| 19 | [Integration, measurement, migration, and rollout](19-integration-and-rollout.md) | All | All mandatory steps; explicit 14 decision | Complete (unrun surfaces listed) |

Steps 02–05 form the first urgent release: bounded streaming, trustworthy
durability barriers, and cheap unchanged reads. Do not delay those fixes for
the new storage or protocol work. Step 01 should establish the targeted
fixtures/counters quickly; a complete cross-provider benchmark campaign is not
a prerequisite for fixing a reproduced bound violation.

Steps 06–13 provide the main storage and processing improvements. Steps 15–18
extend them to other consumers and background work. Step 14 is deliberately
conditional: implement it only if the post-step-13 benchmark still demonstrates
material whole-message amplification. “Deferred with evidence” is an acceptable
step-14 outcome, not an excuse to leave the other findings unresolved.

## Architectural decisions

1. **Keep existing provider histories authoritative.** Derived summary indexes,
   display tails, and detail caches may be regenerated. Durable pipeline inputs,
   reports, and dispatch journals are separate and cannot be evicted as caches.
2. **Use bounded keyed files first for backend-owned records.** Reuse the
   repository's atomic writes, ownership validation, and mutation locks. Do not
   add a database dependency for the first implementation. Step 06 specifies
   the transaction/manifest boundary and its limits; revisit storage choice only
   if measured metadata-scale costs require it.
3. **Preserve existing wire versions.** Introduce negotiated capabilities for
   lightweight bridge summaries and direct pages. Existing v1 callers must keep
   their old behavior. Proposed interfaces/file names in these plans are design
   targets, not claims that those APIs already exist.
4. **Treat size accounting as part of correctness.** Encoded JSON bytes,
   source-file bytes, and estimated retained heap are different measurements.
   Keep count and byte limits at each boundary, including temporary work.
5. **Optimize before adding transport complexity.** Keep Electron IPC and the
   gateway. Leave compression defaults unchanged. Add part-level deltas only
   after summary payloads and repeated serialization have been reduced.
6. **Keep display and action authority separate.** A cached tail may paint, but
   approvals, dispatch controls, cancellation, and workflow advancement must
   still use authoritative state and generation checks.

## Budget policy

Existing limits are the starting ceilings, not targets to raise:

| Domain | Baseline |
| --- | --- |
| Progressive live window | 100 messages; 512 KiB soft target |
| Backend projected history | 4,096 messages; 16 MiB projected response bound |
| Native sync envelope | Existing 20 MiB hard snapshot limit |
| Display tails | 512 KiB per record; 128 records; 64 MiB aggregate compact data |
| Cursor bridge persisted state | 32 MiB current whole-file limit |
| Cursor/Pi display history | 500 messages; 512 parts/message; configured byte cap |
| Codex rollout cache | 64 MiB soft/256 MiB hard source-byte accounting today |
| Frontend history | 4,096 messages/8 MiB per session; 32 MiB global history budget |

Read the owning constants at implementation time; these values describe the
review baseline. A soft target may be exceeded only where the current contract
explicitly permits it, and always below a documented hard cap. Chunk readers
and new indexes need their own count/byte/concurrency limits. Do not advertise
source-byte accounting as a heap limit.

## Compatibility and migration rules

- Support current readers before switching writers. New schemas have explicit
  versions; old tokens/cursors never enter a new namespace by accident.
- Discover capabilities once per bridge connection generation with bounded
  caching. A timeout or corrupt response is not proof that a capability is
  absent. Use existing identity/missing semantics; do not repurpose 404 in a
  way that deletes a live mapping against an older bridge.
- Prefer additive read fallbacks over indefinite dual writes. A migration
  publishes a verifiable manifest only after referenced files exist; it is
  idempotent across interruption. Deletion must not resurrect records from a
  legacy file or backup.
- Preserve source snapshots until a migration is verified. Durable-format
  downgrade requires a tested export/migration or an explicitly compatible
  reader, not simply switching binaries back. Export only the affected data;
  never copy credentials into benchmark artifacts.
- Reader disagreement, stale epochs, expired details, and partial results are
  explicit outcomes. Never substitute “empty/complete” for “unavailable”.

## Shared correctness requirements

Use the repository's [AGENTS.md](../../../../AGENTS.md) as the source of truth.
Every step must preserve no-touch background activity, revision-gap recovery,
subscribe-before-replay, connected-cursor echoing, bounded backpressure, and
fail-closed approvals. Codex stdout and SDK event listeners must not await
storage, rendering, or clients. Synchronous CPU inside those callbacks is still
work: “does not await” is not a performance guarantee.

Cancellation of a shared read cancels only the caller's wait unless no consumer
still owns the operation. Catch every rejected abort/cancel promise. Detaching a
tab does not stop an agent, destroy a terminal, or delete provider history.

## Definition of done for each step

1. Land the behavior and its owning regression tests together, with before/after
   structural measurements where applicable.
2. Record schema/capability changes, exact limits, compatibility, and downgrade
   behavior. Update living documentation and this step's status.
3. Run the smallest owning test workflow, then required repository checks from
   [the testing guide](../../../development/testing-guide.md). Use mise and Bun;
   never a bare root-level `bun test`.
4. Complete applicable isolated browser/Electron/Docker QA for user-visible
   behavior. Include the inactive-environment path for background changes.
5. Record commands, results, commit, profile, and sanitized artifact paths in
   the step's execution record. Mark unrun checks as unrun, not passed.

PRs remain the route to `main`, with merging left to a human maintainer.

## Execution record template

Append this to each step when work begins:

```text
Status: Not started | In progress | Implemented, validation pending | Complete
Implementation commit / PR:
Protocol or storage decisions:
Tests and isolated profiles:
Before/after measurements:
Compatibility/migration result:
Remaining limitations:
```

The final consolidated evidence belongs in step 19. Timing targets must be
reported on a named test machine/profile; deterministic operation-count and
byte-bound tests belong in the normal suite.
