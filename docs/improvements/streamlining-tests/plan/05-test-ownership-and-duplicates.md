# 05 — Consolidate duplicated and shallow test coverage

Status: Implemented for demonstrated duplication; compiler and barrel contracts
retained. Depends on: [01](01-baseline-and-coverage-inventory.md).

## Implementation result

The renderer pane-layout suite no longer repeats 35 protocol merge matrix rows.
It keeps two renderer-specific contracts: shared merge metadata reaches the
renderer and validator narrowing accepts a representative merged layout. The
protocol package remains the exhaustive owner of its 44-case matrix. Four
container-truthiness repetitions were removed from `StatusIndicator`; label,
spinner, hidden-state and class behavior remain covered. Cheap type-only and
barrel-import tests were retained because they exercise compiler/import
initialization contracts rather than duplicating behavioral assertions.

## Goal

Give shared behavior one exhaustive test owner and keep a small, meaningful
contract at each consumer. Remove demonstrated redundancy without treating
similar filenames or test titles as proof that behavior is covered elsewhere.
This is primarily a maintenance and setup-cost improvement; it is not expected
to recover the largest part of the aggregate runtime.

## Case mapping required before deletion

For each candidate, record:

| Field | Example or requirement |
| --- | --- |
| Original owner | File and full test/describe name |
| Behavior | Input classes, state transition, side effect or failure prevented |
| Actual implementation | Production function/module invoked, including wrappers |
| Retained owner | Exact test preserving that behavior |
| Unique assertion | Renderer metadata, error branch or import behavior to migrate |
| Decision | Retain, move, replace with consumer contract, or remove as redundant |

Do not accept a mapping consisting only of equal titles. Compare setup,
fixtures, assertions, exceptional paths and the real implementation called.
Keep this bounded mapping in the implementation PR or an evidence appendix,
rather than duplicating all test source in documentation.

## Tasks

### 1. Shared pane-layout merge

- [ ] Compare all 35 renderer cases in
  [pane-layout-merge.test.ts](../../../../apps/web/src/lib/pane-layout-merge.test.ts)
  with the 44 named protocol cases in
  [the owning suite](../../../../packages/protocol/src/pane-layout-merge.test.ts).
- [ ] Verify [the renderer wrapper](../../../../apps/web/src/lib/pane-layout-merge.ts)
  still re-exports the shared merge and delegates the node validator.
- [ ] Move any renderer fixture carrying a unique metadata/conflict behavior
  into the owning protocol matrix before deleting its old case. Protocol
  fixtures should use the public generic tab shape rather than import the app.
- [ ] Preserve concurrent additions/deletions, topology changes, moves and
  reorderings, field conflicts, focus/selection intent, malformed inputs and
  recursion bounds in the protocol package.
- [ ] Replace the repeated renderer matrix with a small consumer contract:
  merge accepts renderer-shaped metadata and returns a usable renderer layout;
  the validator accepts/rejects representative renderer values correctly.
- [ ] Verify that changes to the shared implementation select protocol tests
  through the affected package graph. Moving tests must not make an app-only
  command the sole owner of a shared behavior.

The proposed reduction is approximately 35 renderer cases to two, subject to
the fixture comparison. Do not force that number if unique cases remain.

### 2. Redundant render smoke cases

- [ ] Remove the four container-truthiness cases from
  [StatusIndicator.test.tsx](../../../../tests/unit/components/StatusIndicator.test.tsx)
  only after confirming the same file still renders running, stopped, error
  and creating states and checks their actual labels.
- [ ] Retain spinner behavior, hidden-label behavior and custom class support.
- [ ] Do not expand this into a blanket removal of tests named “renders”. A
  render test can protect a real public contract even with a short assertion.

### 3. Barrel and type-only contracts

- [ ] Review `tests/unit/components/projects-index.test.ts`,
  `apps/web/src/hooks/index.test.ts`, `apps/web/src/stores/index.test.ts` and
  `apps/web/src/components/github/index.test.ts` individually.
- [ ] Where an existing behavior test can import its subject through the
  public barrel without disturbing file-scoped mocks, use that consumer to
  exercise the export and remove the redundant function-type smoke test.
- [ ] If the contract is purely a static export/assignability guarantee, move
  it to a compiler-checked contract file. Do not call a runtime function-type
  assertion equivalent to a compiler assertion when initialization matters.
- [ ] Move purely type-level cases from `apps/web/src/types/index.test.ts` out
  of runtime discovery only while keeping them in an explicitly checked tsconfig.
- [ ] For `tests/unit/types/web-client-types.test.ts`, preserve the Window API
  and barrel/direct-type assignability checks. Remove assertions against
  self-created fake functions only after those contracts have a compiler owner.
- [ ] Verify root type contracts are actually compiled by an invoked task.
  The root `tsconfig.json` existing on disk is not proof it is part of
  `mise run typecheck`.
- [ ] Update the inventory from step 01 to distinguish compiler-only files
  from missing runtime tests. Keep compile failure fatal in authoritative checks.

Use a deliberately invalid assignment/export in a temporary local probe to
demonstrate compiler coverage, then restore it. No new permanent test is needed
merely to mirror each deleted trivial assertion.

### 4. Preserve complementary suites

- [ ] Keep root/web Git URL tests: validation/normalization and GitHub page URL
  conversion are different functions.
- [ ] Keep root/web utility tests: class merging and session-key parsing are
  different contracts.
- [ ] Keep unique root/web CreateEnvironmentDialog and NativeMessage cases.
  Co-location is optional organizational work, not a performance claim.
- [ ] Keep independent ACP/Cursor attachment trust-boundary suites, including
  traversal, symlinks, payload limits and changed-file detection.
- [ ] Keep reader/writer-specific path-safety race coverage even where a small
  payload-limit assertion overlaps.

## Validation

```bash
mise run test:logged -- --name streamlining-protocol-merge -- \
  bun test --cwd packages/protocol --preload ../../tests/setup-node.ts \
  ./src/pane-layout-merge.test.ts --parallel=1 --only-failures

mise run test:logged -- --name streamlining-renderer-merge -- \
  bun test --cwd apps/web ./src/lib/pane-layout-merge.test.ts \
  --parallel=1 --only-failures

mise run test:logged -- --name streamlining-status-indicator -- \
  bun test ./tests/unit/components/StatusIndicator.test.tsx \
  --parallel=1 --only-failures
```

Run the new compiler owner through its repository task, relevant behavioral
consumers, changed-code selection and normal handoff checks. Check the inventory
and report both runtime case reductions and any new compiler contracts.

## Completion and rollback

- [ ] Every removed case has a reviewed retained owner or a demonstrated
  redundancy explanation.
- [ ] Shared merge coverage is at least as strong in the protocol package.
- [ ] Public consumer exports and type contracts remain checked.
- [ ] Package/file execution deltas are measured without implying that fewer
  assertion calls alone prove a useful speedup.

Keep merge consolidation, smoke removal and compiler migration in separate
commits. If a consumer loses assurance, restore its old case until the owning
coverage or compiler wiring is corrected.
