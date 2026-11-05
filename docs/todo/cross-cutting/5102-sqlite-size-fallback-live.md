# Row sizing on an older SQLite and with a cold page cache

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`. Carried from part `0870` (R20's remainder, "Needs verification") of the E6 efficiency batch, whose report was deleted when E6 landed; it stays in git history at `e198fd4a7`, under `docs/reports/efficiency-logging-database/`.

### Tasks

1. **Run the fallback on a real older macOS**: a sizes-only listing on the oldest supported macOS, and its timing. Status: open (needs live evidence).
2. **Time a cold-cache listing**: the display tail listing with nothing in the page cache. Status: open (needs live evidence).

### 1. Run the fallback on a real older macOS

**Problem.** Sizes-only listings choose `octet_length(value)` or `length(CAST(value AS BLOB))` per connection. The fallback has only run against a simulated failure, on a library that has the function.

**Context.** The app supports macOS 13.0 (`minimumSystemVersion` in `package.json`), and `setCustomSQLite` is not used. Bun 1.4.4 on macOS names `libsqlite3.dylib`, the system library, so the SQLite version follows the macOS release. The report left this as "was not checked".

**Investigation.** Checked on 2026-11-04: SQLite 3.54.0 on macOS 27 arm64, and 3.53.4 in `oven/bun:1.4.4-debian` on Linux arm64. Both have `octet_length`. Not checked: macOS 13 to 26, Linux amd64 and Windows. `rowBytesExpression` is tested against a query that throws, and both expressions are tested to agree on multi-byte values. Only the size expression depends on the version: the primary-key scan that gave most of the gain does not.

**Decisions.**

- **How much proof is needed?**
  - **Run the benchmark's listing once on a macOS 13 machine or virtual machine (recommended).**
    - Pros: proves the fallback path and how much slower it is, on the case that matters.
    - Cons: needs an old macOS, which no host here has.
  - **Rely on the test with a simulated failure.**
    - Pros: no work; the fallback's answer is already proven equal.
    - Cons: its cost on a real old library stays unknown.

### 2. Time a cold-cache listing

**Problem.** The report inferred the overflow read cost from SQLite's behaviour. E6 timed it on a warm page cache only (46–60 ms to 9.4–11.7 ms at 64 rows of 1 MiB), and a first listing after start reads from disk, where the difference should be larger.

**Context.** Display tails list their rows on every `put`, and the store's limit is 64 MiB. Pipeline manifests read `bytes` too.

**Investigation.** Timing a cold cache needs dropping the operating system's page cache (`purge` on macOS, `drop_caches` on Linux), which is a host-wide action outside what a build may do on a shared machine, so it was not run.

**Decisions.**

- **Is a cold number needed?**
  - **Take one when a maintainer runs 5101 on a host they can purge (recommended).**
    - Pros: cheap once someone is at the host; completes the measurement.
    - Cons: not urgent, since the warm numbers already justify the change.
  - **Skip it.**
    - Pros: no work.
    - Cons: the report's inference stays unconfirmed for the case it singled out.

## Related

- [1202](1202-efficiency-review-follow-ups.md) task 2, "Blob length"
- [5101](5101-store-size-and-write-rate-live.md)
- [Storage: Engines on the database](../../architecture/storage.md#engines-on-the-database)
