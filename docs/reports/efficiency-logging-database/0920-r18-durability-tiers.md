# Tier `synchronous` and `secure_delete` by data

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Measure fsync and zero-write cost**: after the ledger work, on a real session. Status: open (depends on [0700](0700-r14-bound-measurement-file-rows.md) and [0710](0710-r15-prune-superseded-measurements.md)).
2. **Decide the tiers**: with the maintainer's sign-off. Status: open (depends on 1).

### 1. Measure fsync and zero-write cost

**Problem.** The report estimates 600 to 1,000 fsynced commits a minute in a busy session, dominated by change tracking. That was reasoned, not counted.

**Context.** A maintainer decision already governs this. [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 2 says of ST-12: "decided 2026-11-01: unchanged, revisited only if fsync cost still shows after this task", and its constraints add that durability changes need the maintainer's sign-off.

**Investigation.** Nothing counts commits or fsyncs today ([0810](0810-r19-database-observability.md) adds lease and transaction waits). The settings are at `storage-database.ts:291` and `:293`.

**Decisions.** None: the decision above sets the gate, and [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 1 owns baseline numbers.

### 2. Decide the tiers

**Problem.** `synchronous=FULL` and `secure_delete=ON` apply to all data, while the privacy and durability cases differ per store.

**Context.** The report says tiering is easiest once the ledger has its own connection or file. It already has its own connection (`change-tracking/backend-wiring.ts:29-31`), so `synchronous` and `secure_delete` can be set per connection without [0760](0760-r17-ledger-out-of-hourly-snapshots.md). Every connection comes from `openBackendDatabase` with one profile (`storage-database.ts:285-295`), so the ledger would set its own after opening.

**Investigation.** `docs/architecture/storage.md:368-375` documents the settings and the scrub guarantee. Ledger rows hold counts, object ids and encoded paths, while evidence bodies and file contents are files outside the database (`ledger-schema.ts:8`), so `secure_delete` on the ledger protects less than on mail or prompts. The report's macOS point (`fsync` without `fullfsync` not flushing the drive cache) was not checked against Bun's build.

**Decisions.**

- **What to change, if the measure justifies anything?**
  - **Ledger connection to `synchronous=NORMAL`; leave everything else (recommended).**
    - Pros: largest saving on the rows the report blames; loses only the last few transactions on power loss, with no corruption; `secure_delete` and the documented scrub stay whole.
    - Cons: one connection's commits differ; a turn's last measurement could vanish on power loss.
  - **Also `secure_delete=FAST` on the ledger and display tails.**
    - Pros: fewer zero-writes on the highest churn.
    - Cons: deleted content can stay in free pages until reused, which weakens the scrub guarantee for display tails, which hold transcript text.
  - **`synchronous=FULL` plus `fullfsync=ON` on macOS for app stores.**
    - Pros: makes the durability `storage.md` implies real.
    - Cons: slower commits, and it runs against the point of this work.
  - **Leave all as it is.**
    - Pros: the current decision; simple to state.
    - Cons: a real cost stays if the measure finds one.

## Constraints and rationale

- This file rates low because a maintainer deferred it pending a measurement. Re-rate it when task 1 has numbers.
- A durability change needs the maintainer's sign-off (1202, "Constraints and rationale").

## Needs verification

- macOS `fsync` and `fullfsync` under Bun 1.4.4's linked SQLite.

## Related

- [Logging and database report, R18](../2026-10-29-logging-and-database-efficiency.md#r18-tier-durability-and-maintenance-settings-d5-d6) and [D5](../2026-10-29-logging-and-database-efficiency.md#d5-durability-settings-are-uniform-not-tiered-medium)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) tasks 1 and 2 (ST-12)
- [0800](0800-r18-scrub-checkpoint-stall.md), [0910](0910-r18-sqlite-maintenance.md)
