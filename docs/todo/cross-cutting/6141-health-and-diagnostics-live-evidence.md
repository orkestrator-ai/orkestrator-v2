# Health and diagnostics: live evidence

## Task analysis

Analysed 2026-11-05 against `main` at `ecff91f74`. From E15 parts `0820`, `0810` and `0780`.

### Tasks

1. **macOS: `dbstat` and `process.memoryUsage`**: confirm both on a real Mac. Status: open.
2. **A long-running real install**: the health rows, the top tables and the cost of a sample, over days. Status: open.
3. **A packaged app**: the bundle's download and the clean exit marker in packaged paths. Status: open.
4. **Export across machines**: Settings and `--node` against a leaf node. Status: open.

### 1. macOS: `dbstat` and `process.memoryUsage`

**Problem.** Both findings E15 records were measured on Linux only.

**Context.** `rowBytesExpression` in `storage-database.ts` notes that Bun on macOS loads the system SQLite library, which varies with the macOS version. A SQLite without `dbstat` reports no top tables and the copy still counts, so a miss is a missing figure rather than a failure. `docs/architecture/logging.md` holds the memory table.

**Investigation.** On Linux under Bun 1.4.4, `PRAGMA compile_options` lists `ENABLE_DBSTAT_VTAB`, and a `dbstat` query answered on a real copy. No Mac was available to this build, and neither claim was tested there.

**Decisions.**

- **How to check?**
  - **Run the two probes on a Mac and record the results in the logging guide (recommended).**
    - Pros: minutes of work; settles whether the panel can show tables there.
    - Cons: needs a Mac at the supported macOS versions.
  - **Assume they match Linux.**
    - Pros: nothing to do.
    - Cons: the report's own note says this library varies.

### 2. A long-running real install

**Problem.** Row size and write cost were only reasoned about, and a real database's top tables have not been seen.

**Context.** The store is bounded at 2,016 rows, and a sample is one small transaction every five minutes. `health-summary` also counts towards the hourly copy's size. Part `0750` left the same kind of gap for the essential log: its "tens of KB a day" is an estimate, and only the worst case (4 MiB in total, about 36 KB a day from any one event) is bounded.

**Investigation.** An isolated `dev:test` profile showed the rows, a `previous-run` line for both a clean stop and a killed backend, and `/metrics` carrying the database figures. It ran for minutes, on a fixture. This build was told not to read real logs or databases, so no real install was sampled.

**Decisions.**

- **What decides that it is fine?**
  - **Sampling one real install after a week: the row's bytes, the store's share of the file and the commit's time (recommended).**
    - Pros: replaces the report's "trivial" and "tens of KB" with numbers; also shows whether `store_rows` swamps the top tables (6144).
    - Cons: needs the user's installation and a week.
  - **Rely on the bound.**
    - Pros: the worst case is already known to be small.
    - Cons: says nothing about what the figures look like in use.

### 3. A packaged app

**Problem.** The download path and the marker have run under `dev:test` only, and so has the essential log's file writer in its packaged paths (part `0750`).

**Context.** The renderer uses a plain `<a download>` through `downloadBlob`. Electron's default handling shows a save dialog for one, and only the artifact session registers a `will-download` handler. `shutdown()` writes the marker from the same path under every runtime flavor.

**Investigation.** Playwright saved a bundle through the browser client on a headless profile. No packaged build was run, and a native window's save dialog was not seen.

**Decisions.**

- **How to check?**
  - **Export once from a packaged build, and read `previous-run` after a normal quit (recommended).**
    - Pros: covers the real save dialog and packaged paths.
    - Cons: needs a release candidate.
  - **Add a native save dialog now.**
    - Pros: the report mentions they exist.
    - Cons: a new IPC surface for a case nothing shows is broken, and a remote machine's bytes still have to reach the renderer first.

### 4. Export across machines

**Problem.** A window can select another machine in Settings, and the CLI has `--node`.

**Context.** The renderer calls through `machineInvoke`, and `diagnostics.plan` and `diagnostics.read` are ordinary node-routed reads. A plan is held by the backend that built it, so pieces must reach the same node. Neither command is in the node-excluded list.

**Investigation.** `DiagnosticsCards.test.tsx` shows the machine is passed through. No two-node setup was run.

**Decisions.**

- **How to check?**
  - **Export from a leaf through Settings and through `--node` on a real two-node setup (recommended).**
    - Pros: covers the link's response limits with real pieces.
    - Cons: needs two machines.
  - **Rely on the piece size.**
    - Pros: 256 KiB is well under every limit in the code.
    - Cons: not observed.

## Related

- [Application logging](../../architecture/logging.md#health-summary-and-the-clean-exit-marker)
- [The diagnostics bundle](../../architecture/logging.md#the-diagnostics-bundle)
