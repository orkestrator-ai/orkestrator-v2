# How large the row-written stores get, and how often they are written

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`. Carried from part `0470` (ST-10's rest, "Needs verification") of the E6 efficiency batch, whose report was deleted when E6 landed; it stays in git history at `e198fd4a7`, under `docs/reports/efficiency-logging-database/`. Also covers part `0230`'s premise that mutation cost matters on a busy backend, and part `0870`'s two fsynced commits per read-only lease.

### Tasks

1. **Measure real store sizes and write rates**: rows and bytes of `environments`, `sessions`, `projects` and `native-agent-sessions`, and writes per hour on a working host. Status: open (needs live evidence).

### 1. Measure real store sizes and write rates

**Problem.** E6's impact is reasoned from the code and measured on a generated workload. Nothing shows how large these stores are on a real install or how often they are written, so the real saving is unknown. The ticket forbade touching a real data directory, so this could not be done there.

**Context.** The report's words were "How large the environment store gets, and how often it is written; the report's impact is reasoned, not measured." Its numbers would also show whether the slower project gesture matters. On `store-writes-v1`, moving one project across 500 went from 3.4–4.8 ms to 5.8–8.7 ms; a real install probably has far fewer projects, but nobody has counted.

**Investigation.** The instruments exist: `get_recurring_work_diagnostics` and the `recurringWork` metrics block charge storage reads, writes and bytes per job kind, and `readStorageDatabaseStore` opens a database read-only. The benchmark ran on a temporary directory on an internal SSD with macOS's fsync, where a commit is cheap, so it understates what a lease write costs on a Linux host. None of this was run against real data.

**Decisions.**

- **Where to get the numbers?**
  - **Ask the maintainer to run a read-only count and the recurring-work diagnostics on their own hosts, macOS and Linux (recommended).**
    - Pros: real sizes and rates; a read-only open writes nothing; the output is counts, with no content.
    - Cons: needs a person with the host; one host's load is not everyone's.
  - **A long-running isolated `dev:test` profile under a scripted load.**
    - Pros: repeatable, and no real data involved.
    - Cons: the load is invented, which is what this item exists to replace.

## Needs verification

- Whether any install has enough projects for the reorder cost to be noticeable.
- The commit cost on a Linux host's filesystem.

## Related

- [1202](1202-efficiency-review-follow-ups.md) tasks 1 and 2
