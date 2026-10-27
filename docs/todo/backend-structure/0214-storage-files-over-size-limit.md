# Storage files over the size limit

Checked against `main` at `93018933` and the 0163 branch
(`todo-0163-storage-facade-size-a8e92b2563c1`), 2026-10-26. Found while
validating [0163-storage-facade-size.md](0163-storage-facade-size.md), whose
scope named only `storage.ts` and `storage-agent-mail.ts`.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Split `storage-shared-core.ts` by topic**: 2,187 lines of record types, validators and helpers behind `storage-shared.ts`. Status: open.
2. **Split `NativeAgentSessionsRepository` into collaborators**: `storage-native.ts` is 2,015 lines. Status: open.
3. **Qualification run**: storage tests with the before/after writer-guard comparison, then `mise run test`. Status: open.

### 1. Split `storage-shared-core.ts` by topic

**Problem.** `apps/backend/src/core/storage-shared-core.ts` is over the 2,000-line guideline in `AGENTS.md`. Anyone touching one record type (a model catalogue, a native session validator) reads a grab-bag file. No behaviour is affected.

**Context.** Found while validating [0163](0163-storage-facade-size.md). The file proposes topic modules behind `storage-shared.ts` so callers do not change.

**Investigation.** The file is 2,187 lines (2,185 when written; #1293 added two) with 94 exports. The "core"/"extra" split is older than the storage work: both files came from `7aee8366` (#417, "split large modules"), and `storage-shared-extra.ts` (220 lines) already holds the OpenCode model helpers. `storage-shared.ts` is a two-line `export *` over both. The content falls into clear blocks: limits, pane-layout bounds and setup-handoff helpers (lines 165 to 410); Kanban, feature-plan and Linear/GitHub comment types (411 to 522); general predicates and agent-activity helpers (523 to 732); persisted-record validators for reviews, the prompt queue, native agent sessions, drafts and build pipelines (733 to 1189, with the native session validator and migration at 852 to 1090); model catalogue normalisation (1190 to 1537); config validation and `normalizePersistedConfig` (1538 to 1870); factories and naming helpers (1871 to 2093); and a re-export block at the end (from 2093) that re-exports `fs`, `path` and `node:crypto` functions alongside protocol symbols. Callers do not all go through the barrel: seven files import `storage-shared-core.js` directly (`public-api/actions-tickets.ts`, `workflow-tab-actions.ts`, `storage-opencode-models.ts`, `storage-shared-extra.ts` and four tests), against 23 that import `storage-shared.js`.

**Decisions.**

- **How far to split?**
  - **Two or three topic modules that bring the core under the limit (recommended).** Move model catalogue normalisation (about 350 lines) and config validation (about 330) to their own modules, re-exported from `storage-shared.ts`.
    - Pros: small, mechanical diff; the two blocks have few internal dependencies; the core drops to about 1,500 lines.
    - Cons: the core stays a mixed file, and the "core"/"extra" naming remains.
  - **One module per topic, retiring "core" and "extra".** Seven or eight modules (pane layout, Kanban types, activity, record validators, catalogues, config, factories), with `storage-shared.ts` as the only barrel.
    - Pros: each module has one subject; the naming the `AGENTS.md` split guidance discourages goes away.
    - Cons: a larger diff, more risk of import cycles (`import/no-cycle` is a lint error) between validators and factories, and the direct importers all change.
- **What happens to the direct `storage-shared-core.js` importers and the `fs`/`path`/crypto re-exports?**
  - **Point the seven direct importers at `storage-shared.js` and leave the Node re-exports in place (recommended).**
    - Pros: one public surface; nothing outside storage depends on which module a helper lives in after the split.
    - Cons: the odd re-export of `fs` and `path` survives.
  - **Also drop the Node re-exports and make each repository import `node:fs`/`node:path` itself.**
    - Pros: removes a surprising dependency path.
    - Cons: touches every repository file for no size gain; out of this file's size-only scope.

### 2. Split `NativeAgentSessionsRepository` into collaborators

**Problem.** `apps/backend/src/core/storage-native.ts` is 2,015 lines, 15 over the guideline. The class mixes session records, the interaction journal, display tails, at-most-once prompt and steer dispatch, turn outcomes, prompt-queue persistence and claim recovery.

**Context.** The file asks for collaborators through the `StorageRepositories` registry, as 0163 did for agent mail with a shared `AgentMailStore`. The writer guard rejects `extends` between scanned classes and any class holding a `StorageContext` the facade does not reach.

**Investigation.** Unchanged in size since the file was written. The class is at `storage-native.ts:172` and is registered as `nativeAgentSessions` (`storage-repositories.ts:44`). Responsibilities by line: lease wrappers and backup scrubbing (232 to 306), interaction journal (322 to 360), session records and adoption (361 to 906), display tails (907 to 959, already delegating to `NativeAgentDisplayTailStore` in `native-agent-display-tail-store.ts:101`), dispatch (1000 to 1266), steer (1267 to 1616), notices and publication state (1617 to 1709), prompt-queue persistence (1710 to 1813), turn outcomes (1814 to 1900), claim recovery and queue loading (1901 to 2015). The private `enqueueNativeAgentSessionMutation` is used 25 times; any collaborator that writes a session record must take that same lease, so it has to move to a shared store object (the `AgentMailStore` pattern) rather than be duplicated. The prompt-queue store is also written by `PromptsRepository`, so a prompt-queue collaborator must keep the lease the guard already sees.

**Decisions.**

- **Which responsibility moves out first?**
  - **Dispatch and steer journalling, about 620 lines, into a collaborator sharing a native-session store object (recommended).**
    - Pros: the largest coherent block; it is the code reviewers most need to read in isolation (at-most-once dispatch); the remaining class falls to about 1,400 lines.
    - Cons: it shares the per-session lease and record load/save with every other method, so the shared store object has to be extracted first, as for agent mail.
  - **Prompt-queue persistence and claim recovery, about 250 lines, as the file suggests.**
    - Pros: self-contained, and its timer state moves with it; enough to get under the limit.
    - Cons: it leaves the file at about 1,770 lines, so the next feature pushes it back over; the claim-recovery start in the facade's `init` has to be rewired.
  - **Move only the display-tail methods (about 50 lines).**
    - Pros: trivial, and already a thin wrapper over its own store.
    - Cons: meets the letter of the limit with no readability gain, and is undone by the next change.
- **Should the over-limit storage test files be handled too?** `AGENTS.md` asks for tests split to match their sources. `storage.test.ts` is 4,322 lines, `storage-writer-guards.test.ts` 2,478 and `storage-agent-mail.test.ts` 2,292; `storage-native-agent-sessions.test.ts` is 1,943.
  - **Split `storage-native-agent-sessions.test.ts` alongside its source here, and open a new todo for the other three (recommended).**
    - Pros: keeps this file's scope; the README forbids adding new items to an existing file, so the test sizes need their own file anyway.
    - Cons: one more low-priority todo.
  - **Leave tests out entirely.**
    - Pros: smallest change.
    - Cons: the three test files stay well over the limit with nothing tracking them.

### 3. Qualification run

**Problem.** A split must not change which lease guards which store write.

**Context.** 0163 dumped the writer guard's full analysis (per store and per write site) before and after and compared them; this file asks to repeat that.

**Investigation.** The guard is `apps/backend/src/core/storage-writer-guards.test.ts` (the main analysis at `:1701`; the scan-coverage test at `:1705` lists every scanned class, so a new collaborator must be added there). There is no committed script for the dump; 0163 did it ad hoc.

**Decisions.**

- **How should the before/after comparison be produced?**
  - **Ad hoc dump on both heads, as 0163 did, recorded in this file (recommended).**
    - Pros: no new test code to maintain; proven twice.
    - Cons: the method lives only in prose; the next splitter repeats the work.
  - **Commit a small dump helper beside the guard test.**
    - Pros: repeatable, and makes future storage refactors cheaper.
    - Cons: test-only code that runs only during refactors; the guard file is already over the size limit.
- **Order relative to tasks 1 and 2?**
  - **One run after both splits, plus the focused storage tests after each (recommended).**
    - Pros: one `mise run test` instead of two.
    - Cons: a guard difference found late has two candidate causes.
  - **A full run after each split.**
    - Pros: isolates a failure to one split.
    - Cons: doubles the cost of a long suite for size-only changes.

Two storage source files are still over the 2,000-line limit in `AGENTS.md`
("General guidance"), unchanged by 0009 and 0163.

## Current state

- `apps/backend/src/core/storage-shared-core.ts` is 2,185 lines: the record
  types and the pure helpers every repository shares (90 exports: model
  catalogue, agent activity, interaction journal, prompt-queue claim,
  feature-planning and connection parsing, pane-layout helpers, …),
  re-exported through `storage-shared.ts`.
- `apps/backend/src/core/storage-native.ts` (`NativeAgentSessionsRepository`)
  is 2,015 lines: native agent sessions, the interaction journal,
  display tails, prompt-queue persistence and claim recovery.

## Outstanding work

### Code

- Split `storage-shared-core.ts` by topic into modules (for example agent
  activity, interaction journal, prompt queue records, model catalogues),
  keeping `storage-shared.ts` as the re-export surface so callers do not
  change.
- Split `NativeAgentSessionsRepository` by responsibility into collaborators
  sharing the context through the `StorageRepositories` registry, as 0163 did
  for agent mail (for example prompt-queue persistence and claim recovery
  apart from the session records), following "Splitting large classes" in
  `AGENTS.md`.

### Qualification

- Run every `apps/backend/src/core/storage*.test.ts`, including
  `storage-writer-guards.test.ts` (its analysis should match before and
  after, store for store, as in 0163), plus `mise run test`.

## Constraints and rationale

- Size and readability only: leaving it changes no behaviour.
- No `extends` layers; the writer guard rejects a scanned class that extends
  another.

## Related

- [0163-storage-facade-size.md](0163-storage-facade-size.md): the facade and
  agent mail split, and the before/after guard comparison to repeat.
- [`storage.md`](../../architecture/storage.md) ("Code layout").
