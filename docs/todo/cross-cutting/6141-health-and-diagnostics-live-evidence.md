# Health and diagnostics: live evidence

## Task analysis

Analysed 2026-11-05 against `main` at `ecff91f74`. From E15 parts `0820`, `0810` and `0780`.

### Tasks

1. **macOS: `dbstat` and `process.memoryUsage`**: confirm both on a real Mac. Status: open.
3. **A packaged app**: the clean exit marker and the essential log's file writer in a locally packaged build. Status: open (the bundle's export through the native save dialog of a release candidate is in 7568: 6141 task 3).
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

### 3. A packaged app

**Problem.** The download path and the marker have run under `dev:test` only, and so has the essential log's file writer in its packaged paths (part `0750`).

**Context.** The renderer uses a plain `<a download>` through `downloadBlob`. Electron's default handling shows a save dialog for one, and only the artifact session registers a `will-download` handler. `shutdown()` writes the marker from the same path under every runtime flavor.

**Investigation.** Playwright saved a bundle through the browser client on a headless profile. No packaged build was run, and a native window's save dialog was not seen.

**Decisions.**

- **How to check?**
  - **Export once from a packaged build, and read `previous-run` after a normal quit (recommended).**
    - Pros: covers the real save dialog and packaged paths.
    - Cons: needs a release candidate.
    - Agent part: the `previous-run` marker and the essential log's packaged paths in a locally packaged build, through the packaged-app spec ([agent-testing.md](../../development/agent-testing.md#packaged-app-electron-spec)); the export through a release candidate's native save dialog is in the manual-test checklist (7568: 6141 task 3).
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
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 2, the user part of task 3: exporting the bundle through a release candidate's native save dialog) moved there on 2026-11-10.
