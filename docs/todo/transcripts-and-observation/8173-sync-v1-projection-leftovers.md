# Retire what joined paging left behind: the sync-v1 read and `historyPaging`

## Task analysis

Analysed 2026-11-16 against `main` at `c1fcc573b`, while removing joined
`sync-v1` history paging (0232 (retired) task 4;
`git show c1fcc573b:docs/todo/transcripts-and-observation/0232-direct-history-cursor-minting.md`).
Task 3 was done in the same change (see Assumptions and decisions).

### Tasks

1. **Retire `get_native_agent_projection_update`**: remove the sync-v1 projection command, its renderer wrapper and the backend's sync revision store, with a domain version bump. Status: open.
2. **Drop the `historyPaging` flag**: every `historyCursor` a transcript view names is direct, so the flag says nothing the cursor does not. Status: open.
3. **Let the coordinator action-history scan read more than one page**: `recoverActionHistory` refused every page that has a next cursor. Status: done (2026-11-16, with 0232 task 4: pages report `rowsTrimmed`).

### 1. Retire `get_native_agent_projection_update`

**Problem.** Since 0232 task 4 nothing in the product calls the sync-v1
projection read. The renderer's last two callers were the joined-cursor mint
in `loadEarlierMessages` and the coordinator's action-history scan
(`useCoordinatorActionHistory.ts`); the first is gone and the second reads the
transcript view. The command still keeps per-session revision state, and each
call reads the whole provider transcript.

**Context.** The read is `getProjectionUpdate` in
`apps/backend/src/core/native-agent-transcript-projection.ts`, registered in
`commands-registry-native.ts`, defined as `getNativeAgentProjectionUpdateCommand`
in `packages/protocol/src/contract/domains/native-sessions/commands-agent.ts`,
and wrapped by `getNativeAgentProjectionUpdate` in
`apps/web/src/lib/backend/workflows.ts`. Its state is `projectionSync`,
`projectionSyncBytes` and the `NATIVE_SYNC_*` revision bounds. The
`"sync-v1"` representation of `refreshProjection` has a second user that must
stay: tool-detail recovery (`getToolDetails` re-reads the projection with that
representation so a paged row's detail reference resolves again after cache
eviction). `capabilities.projectionSyncVersions` is still advertised. The
user's legacy-retirement decision (2026-11-14) means no older renderer needs
the command.

**Investigation.** Callers at `c1fcc573b` plus this change, from
`git grep get_native_agent_projection_update` and
`git grep getNativeAgentProjectionUpdate`: the registry handler, the unused
web wrapper, tests, the real-stack specs `cold-restart-live.spec.ts`,
`transcript-paging-live.spec.ts` and `session-history-live.spec.ts` (each uses
it to read the turn phase or the live tail, which `get_native_agent_session_state_update`
and `get_native_agent_transcript_update` also answer), the efficiency
workloads (`scripts/efficiency/workloads-projection.ts`, which measure older
baselines too) and `scripts/qualify-slash-mixed-versions.ts`, which 8108 task 4
retires.

**Decisions.**

- **How to remove the command?**
  - **Remove it with a `native-sessions` domain version bump and an adapter-free retirement row (recommended).**
    - Pros: follows the 2026-11-14 decision and the removed-command check in
      [version-compatibility.md](../../architecture/version-compatibility.md#domain-contracts);
      deletes the revision store and its bounds.
    - Cons: touches the contract, the real-stack specs and the efficiency
      workloads in one change.
  - **Keep the command and only delete the renderer wrapper.**
    - Pros: smallest change.
    - Cons: keeps a whole-transcript read and its state for no caller.
- **What happens to the `"sync-v1"` representation?**
  - **Keep it under a name for what it now is, the tool-detail recovery read (recommended).**
    - Pros: detail recovery keeps working unchanged.
    - Cons: a rename across `refreshProjection`'s callers.
  - **Recover details from the direct page cache only.**
    - Pros: no whole read at all.
    - Cons: a detail whose page was evicted could not be recovered; needs its
      own design.

### 2. Drop the `historyPaging` flag

**Problem.** `NativeAgentTranscriptView.historyPaging` is `"direct"` exactly
when `historyCursor` is set, so readers check two fields for one fact.

**Context.** Set in `native-agent-transcript-projection.ts`, carried by the
transcript delta (`packages/protocol/src/native-agent.ts`), read by
`useNativeAgentSession.ts` (`adoptDirectCursor`, the held-history re-read and
the stale-history check), the e2e fixtures, the efficiency workloads and many
tests. It is in the transcript view's TypeScript type and validator, not in
the contract schema (`ViewUpdateSchema` keeps `value` open).

**Investigation.** Not started beyond the reader list above.

**Decisions.**

- **Remove or keep?**
  - **Remove it everywhere in one change (recommended).**
    - Pros: one fact, one field.
    - Cons: a wide but mechanical test diff.
  - **Keep it.**
    - Pros: no churn.
    - Cons: a field that cannot be false misleads readers into thinking a
      non-direct cursor exists.

### 3. Let the coordinator action-history scan read more than one page

**Problem.** `recoverActionHistory`
(`apps/web/src/components/projects/coordinator-action-history.ts`) throws
"Action history changed or truncated" on any page whose `truncated` is true,
and a direct page sets `truncated` whenever it has a `nextCursor` (as joined
pages did). So a coordinator whose outstanding cards lie more than one page
before the window finds none: the hook's catch drops the whole index.

**Context.** The scan wants to refuse a page whose rows were trimmed, because
trimmed rows cannot prove an action is done. `NativeAgentMessagePage.truncated`
means "has more, or incomplete, or a row was trimmed", so the trimmed case
cannot be told apart from an ordinary next page. Covered today only by a
single complete page (`coordinator-action-history.test.ts`).

**Investigation.** Seen while moving the scan to the transcript view's direct
cursor in 0232 task 4. That move made it matter more: the sync-v1 snapshot
the scan read before carried a 512-row tail, so a session up to about 700
rows needed no second page, while the transcript view's tail is 100 rows.
A bridge page's own `truncated` (`bridgeTranscriptPage`) is true only when
it trimmed a row (omitted parts or an overflowing row), so the backend can
report trimming exactly.

**Decisions.**

- **How should the scan judge a page?**
  - **Add a page field that reports trimmed rows only, and refuse on that (recommended).**
    - Pros: exact; the page already knows when it trimmed a row
      (`trimmedRow` in `getMessagePage`).
    - Cons: a new optional field on the message page.
  - **Refuse only when `truncated` is true and there is no `nextCursor`.**
    - Pros: no protocol change.
    - Cons: still accepts a page with a trimmed row that also has a next page.

## Assumptions and decisions

### Task 3: report trimmed rows on the page (2026-11-16)

Chosen: the recommended option. `NativeAgentMessagePage` gains an optional
`rowsTrimmed: true`, set by `getMessagePage` when the provider page reports
`truncated` (a bridge trimmed a row) or the backend trimmed a row larger than
`DIRECT_PAGE_ROW_MAX_BYTES`; `recoverActionHistory` refuses on `rowsTrimmed`
instead of `truncated`. Why now rather than later: the scan's move to the
transcript view (0232 task 4) shortened its tail from 512 to 100 rows, which
would otherwise have left it finding no cards in sessions of 300 to 700 rows
that worked before. A new optional result field needs no domain version bump
([version-compatibility.md](../../architecture/version-compatibility.md#domain-contracts)).
Covered by `history walks every page, and refuses a page with a trimmed row`
(`coordinator-action-history.test.ts`) and the summary-transcripts test
named "a page says when a row was trimmed, which truncated alone cannot".

## Related

- 0232 (retired 2026-11-16): removed joined paging, which this follows up.
- [8108](../cross-cutting/8108-legacy-retirement-sweep.md): the legacy-retirement sweep; task 4 retires the mixed-version qualifiers.
- [native-transcripts.md](../../architecture/native-transcripts.md#history-pages-and-cursors).
