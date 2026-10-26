# Storage files over the size limit

Checked against `main` at `93018933` and the 0163 branch
(`todo-0163-storage-facade-size-a8e92b2563c1`), 2026-10-26. Found while
validating [0163-storage-facade-size.md](0163-storage-facade-size.md), whose
scope named only `storage.ts` and `storage-agent-mail.ts`.

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
