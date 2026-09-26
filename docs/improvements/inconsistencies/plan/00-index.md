# Inconsistency remediation — implementation plan

Status: Planned; implementation has not started.  
Prepared: 2026-09-21  
Source revision: `88c2f9ccfaa68045573b658dd4f172bc5ff7c51b`

Source: [codebase inconsistency review](../../incocnsistencies.md).
The misspelling in the review filename is retained so existing references remain
valid. This directory uses the correctly spelled `inconsistencies` name.

## Intended outcome

Close all nine reviewed inconsistencies with observable, tested contracts:
dispatch cannot precede required journal publication; resource limits cannot
silently disable persistence; acknowledged sessions survive a bridge restart;
closing a session prevents late execution; early cancellation remains effective;
supported draft attachments survive reload; steer history stays bounded without
enabling duplicates; conversation retention is explicit; and equivalent message
routes parse cursors consistently.

These documents specify future work. The passing tests recorded in the source
review are a baseline, not evidence that any proposed fix is implemented. Only
planning documents and the documentation catalog are changed by this planning
task.

## Numbered steps

| Step | Plan | Findings | Required predecessors | Status |
| --- | --- | --- | --- | --- |
| 01 | [Contract baseline and deterministic regression fixtures](01-contract-baseline-and-regression-fixtures.md) | All | None | Planned |
| 02 | [Mandatory persistence and dispatch barriers](02-mandatory-persistence-and-dispatch-barriers.md) | INC-01; failure part of INC-03 | 01 | Planned |
| 03 | [Aggregate persistence budgeting and recovery](03-aggregate-persistence-budgeting-and-recovery.md) | INC-03 | 02 | Planned |
| 04 | [Durable session lifecycle acknowledgements](04-durable-session-lifecycle-acknowledgements.md) | INC-04 | 02, 03 | Planned |
| 05 | [Cursor permanent close and late-work ownership](05-cursor-permanent-close-and-late-work-ownership.md) | INC-02 | 02, 03 | Planned |
| 06 | [Pi cancellation during startup and preflight](06-pi-cancellation-during-startup-and-preflight.md) | INC-05 | 01 | Planned |
| 07 | [Capability-driven attachment draft restoration](07-capability-driven-attachment-draft-restoration.md) | INC-06 | 01 | Planned |
| 08 | [Bounded steer history with safe replay behavior](08-bounded-steer-history-with-safe-replay.md) | INC-07 | 02, 03 | Planned |
| 09 | [Conversation retention and close semantics](09-conversation-retention-and-close-semantics.md) | INC-08 | 04, 05; recorded retention decision | Planned; decision open |
| 10 | [Shared transcript cursor validation](10-shared-transcript-cursor-validation.md) | INC-09 | 01 | Planned |
| 11 | [Conformance, real-stack verification, and release handoff](11-conformance-verification-and-release-handoff.md) | All | 02–10 | Planned |

Numeric order is the default execution order. Steps 06, 07, and 10 do not depend
on the persistence work and may be implemented independently after their fixtures
exist. Step 09's product decision does not block the other correctness fixes.
Step 01 is preparation attached to the first implementation PR, not a requirement
to merge failing tests or build a large test framework first.

## Proposed change boundaries

| Review unit | Content | Reason for boundary |
| --- | --- | --- |
| A | 01 fixtures needed by 02–03, then 02 and 03 | Make publication truthful and keep ordinary multi-session workloads usable together |
| B | 04 | Apply the new durability primitive to create/resume/attach acknowledgements |
| C | 05 | Isolate permanent-close ownership and cancellation races |
| D | 06 | Pi-specific startup cancellation with backend integration coverage |
| E | 07 | Renderer draft recovery, with focused browser verification |
| F | 08 | Bounded steering requires its own replay and compatibility review |
| G | 09 | Product retention decision, adapter changes, and lifecycle migration |
| H | 10 | Small shared parsing contract and its route consumers |
| I | 11 | Final cross-provider evidence, documentation, and release readiness |

These are review boundaries, not a requirement for nine separate pull requests.
Combine adjacent units when that makes validation clearer. Do not postpone a
P1 lifecycle fix merely to bundle a lower-priority parser change.

## Contracts shared by every step

1. Backend/bridge state owns execution. Unmount, navigation, an SSE disconnect,
   and a lost HTTP response do not mean cancellation.
2. A successful mandatory persistence operation means the requested snapshot
   was published to the configured state file. This plan targets bridge-process
   restart recovery; it does not claim power-loss durability without fsync work.
3. Distinguish failure before provider invocation from uncertainty after it.
   Never retry a possibly accepted prompt or steer under a new ID automatically.
4. A missing, trimmed, unreadable, or old-generation journal entry is not proof
   of non-delivery. `dispatched` needs positive evidence; `absent` needs positive
   evidence that the steer was not delivered or was removed.
5. After permanent close succeeds, a late attachment, SDK send result, timer,
   or callback cannot revive ownership or continue an unobserved turn.
6. Transcripts are reconstructible display state; session identities, uncertain
   dispatch records, and recovery fences are not interchangeable with them.
7. Limits cover both bytes and counts. An aggregate limit needs an explicit
   recovery or admission policy, not a silent skipped write.
8. Approval timeout, disconnect, closure, malformed answers, and dead generations
   retain the repository's fail-closed behavior.
9. Diagnostics contain bounded metadata only: no prompts, attachments, terminal
   output, credentials, file contents, or serialized vendor errors.
10. Keep provider-specific engines separate. Share a contract or a proven pure
    helper, not a new generic runtime that obscures provider ownership.

The governing instructions remain [AGENTS.md](../../../../AGENTS.md). In
particular, never call Codex `thread/delete`, never block its stdout loop on
consumer work, and never merge an implementation PR into `main` as an agent.

## Decisions and implementation defaults

| Topic | Planning default | Decision/evidence needed |
| --- | --- | --- |
| Conversation retention | Ordinary tab close preserves resumable history | Record the product choice in step 09 before changing destructive behavior |
| Mandatory persistence | Serialize writes, propagate failure, publish before side effects | Prove all interleavings with a controlled writer and process-restart tests |
| Oversized state | Shed persisted transcript copies; retain essential records | Establish bounded serialization and explicit admission failure for metadata-only overflow |
| Steer retention | Protect all records that could target the current run; reject admission when necessary | Validate recovered-run identity and the negative-acknowledgement path; FIFO alone is insufficient |
| Cursor syntax | Canonical nonnegative decimal safe integers, invalid means full-window fallback | Audit actual emitters before rejecting previously accepted alternate encodings |
| Missing state directory | Preserve explicit stateless fixture/development mode | Verify managed production launchers always configure persistent state |

No vendor API behavior is assumed solely from names or comments. When an
implementation needs SDK/CLI semantics beyond this repository, consult the
pinned types/source and current documentation using Context7 as required by
AGENTS.md. OpenCode integrations must keep the existing v2 import paths. This
plan requires no dependency or agent-version upgrade by default.

## Validation strategy

Each step has a concrete test matrix and acceptance checklist. Apply the
[testing guide](../../../development/testing-guide.md) and
[isolated-stack guide](../../../development/agent-testing.md).

- Use real temporary files for publication/restart behavior and narrow fake
  provider boundaries for timing. Never manufacture success by calling graceful
  shutdown before reading a snapshot meant to prove crash recovery.
- Use deferred promises and event barriers for races; do not use long sleeps or
  timing luck. Restore globals, environment variables, spies, and servers.
- Run focused checks through `mise run test:logged`; direct Bun tests must name
  explicit paths and bounded parallelism. No root-level bare `bun test`.
- Run relevant typechecks, `mise run test:changed` while iterating, then
  `mise run check` through the logged wrapper and `mise run test` for handoff.
- UI, gateway, and user-visible lifecycle changes require the real browser
  cycle, reload, and inactive-environment recovery. Record unavailable optional
  layers honestly; a unit suite does not replace them.
- Do not put tests into existing files already beyond the repository's 2,000-line
  guidance. Prefer focused sibling files with matching ownership.

If a new protocol export or package metadata changes, use the pinned Bun version
to regenerate every tracked lockfile and perform the frozen-install/drift checks
from AGENTS.md. Merely adding a helper to an existing exported module does not
require inventing a new package or bumping the application version.

## Completion tracking

Use `Planned`, `In progress`, `Verified`, and `Merged` consistently in this index
and the affected step. Mark `Verified` only when that step's acceptance criteria
and required QA have evidence. Record the human-merged PR for `Merged`; agents
must not merge. A pending product decision or unavailable required QA remains
visible and does not count as complete.

For each implementation PR record: changed owners, finding IDs, new regression
cases, commands/results, isolated profile/run identifiers, failure artifact
paths when relevant, compatibility behavior, and remaining limitations. Preserve
the original review as a dated snapshot; link resolution evidence from this
index rather than rewriting the original observations as if they never existed.

## Overall acceptance

- [ ] Every finding maps to a verified change or a documented product resolution.
- [ ] Mandatory publications fail truthfully and protect all relevant side effects.
- [ ] Restart and size-bound tests retain essential recovery state.
- [ ] No closed-session race leaves executing work outside authoritative ownership.
- [ ] Pi startup cancellation and Cursor/Grok draft reloads work in real-stack QA.
- [ ] Steer bounds preserve uncertainty and cannot enable an exact-key duplicate.
- [ ] Close semantics are documented and compatibility-tested across all platforms.
- [ ] Cursor parsing has one tested contract for equivalent bridge routes.
- [ ] Full validation evidence and cleanup are recorded in step 11.

