# Storage facade size

Checked against the 0009 branch (`todo-0009-storage-repositories-4696a61ea39f`,
on `main` at `00a0cb82`, 2026-10-25). Follow-up from
[0009-storage-service-repositories.md](0009-storage-service-repositories.md).

0009 replaced the `StorageService` inheritance chain with a facade over
per-store repositories. To keep every public method name and signature (a
constraint of 0009), the facade forwards each of its 327 repository methods
explicitly, so `storage.ts` is 2,464 lines of one-line forwarders, over the
2,000-line limit in `AGENTS.md` ("General guidance"). A class cannot be split
across files without the `extends` layers 0009 removed, so the size only goes
down as callers stop needing the forwarders. `storage-agent-mail.ts`
(`AgentMailRepository`, 3,271 lines; 3,226 before 0009) was already over the
limit and is the one repository file that still is.

## Current state

- `StorageService` (`apps/backend/src/core/storage.ts`) holds a private
  `StorageContext` and a private `StorageRepositories` registry. Its public
  methods are the entry points `storage-writer-guards.test.ts` follows writes
  back to; nothing outside the `storage*.ts` files names a repository.
- Most callers reach storage through `CommandContext.storage`; 68 non-test
  backend files name `StorageService`.
- `AgentMailRepository` mixes the mail store, mailbox synchronization, inject
  scheduling and budgets in one class.

## Outstanding work

### Code

- Narrow callers by area to an interface the owning repository satisfies
  (for example a `KanbanStorage` type for the Kanban commands), one area per
  PR, and drop the forwarders no caller uses any more. Keep the facade's
  public methods the only entry points the writer guard follows: an area
  interface must be implemented by the facade, or the guard must learn the new
  entry points first.
- Split `AgentMailRepository` by responsibility into collaborators (the mail
  store, mailbox directory synchronization, inject scheduling and budgets),
  following "Splitting large classes" in `AGENTS.md`.

### Qualification

- Run every `apps/backend/src/core/storage*.test.ts`, including
  `storage-writer-guards.test.ts`, after each step, plus `mise run test`.

## Constraints and rationale

- Leaving this undone changes no behaviour: the forwarders are mechanical and
  typed, and the writer guard checks every path through them.
- Do not generate forwarders at run time (prototype assignment with interface
  merging): the guard would lose the explicit entry points it reads, and the
  surface would no longer be greppable.

## Related

- [0009-storage-service-repositories.md](0009-storage-service-repositories.md),
  decision 3 (explicit forwarders).
- [0012-backend-core-domain-folders.md](0012-backend-core-domain-folders.md):
  the storage folder move.
- [`storage.md`](../../architecture/storage.md) ("Code layout").
