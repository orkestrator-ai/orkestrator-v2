# Explicit refresh behind a running container scan

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`, from the client-side
latency run of [0048](0048-recurring-work-qualification.md) task 2 (see its
[macOS evidence](0048-recurring-work-qualification.md#macos-watcher-change-to-visible-and-remote-freshness-2026-11-06-macos)).
Task 1 done 2026-11-10 against `main` at `04639b12b`.

### Tasks

1. **Decide the explicit-refresh tail on containers**: about one Changes-tab Refresh in fifteen on a container exceeds the ≤ 1 s budget, because it follows a scan already running. Accept it in the budget table or change how a refresh joins a running scan. Status: done (2026-11-10: accepted as "≤ 1 s, or one scan longer when a scan is already running", recorded in the budget table and enforced by the qualification check).

### 1. Decide the explicit-refresh tail on containers

**Problem.** The latency budget for the Files panel says "≤ 1 s after an explicit action" ([recurring-work.md](../../architecture/recurring-work.md#latency-budgets)). On macOS with Docker Desktop, a container's Changes tab showed a file written just before Refresh in p50 425 to 543 ms, but at least 2 of 30 refreshes went over (1.30 s and 2.23 s; the first run kept only its summary, whose p95 was 2.23 s), so p95 is over budget. The All files tab's refresh stayed within it (max 881 ms over 30).

**Context.** The Changes tab's Refresh goes through the change projection: `ChangeTrackingService.refresh` asks the scan owner for a refresh and settles only on a pass that started after the request, polling every 100 ms. `DiffStatsService.request(entry, "refresh")` coalesces into a scan already in flight and reruns after it (`entry.inFlight` → `coalesced`). So a refresh that lands while a scan runs waits for that scan and then a whole second one. A container scan takes about 0.4 to 0.7 s here, and the container's own change signal starts one within a few hundred milliseconds of a write, which is exactly when a user who just saved clicks Refresh. The probe writes and clicks at once, so it measures that worst case.

**Investigation.** Measured with `e2e/agent-testing/change-to-visible-latency.spec.ts` (two runs of 15 refreshes each, random offsets in the 15 s scan interval). The samples of the second run, sorted: 317 to 635 ms for 14, then 1304 ms. Not traced per sample: which outliers followed a signal-started scan rather than a poll. The waiting is deliberate (a running scan may predate the click, so its answer cannot satisfy the fence), so this is a budget question, not a correctness bug.

**Decisions.**

- **What to do about the tail?**
  - **Accept it: amend the budget row to "≤ 1 s, or one scan longer when a scan is already running" and record the measured p95 (recommended, done).**
    - Pros: no scheduling change; the fence that makes a refresh trustworthy stays; the extra wait is bounded by one scan.
    - Cons: the budget becomes conditional; a slow container makes the tail longer.
  - **Abort the running scan on an explicit refresh and start a fresh one.**
    - Pros: one scan's latency at most.
    - Cons: aborting a `docker exec` mid-read wastes it; repeated clicks could starve scans; touches the admission pool and the scan fences.
  - **Run a second scan concurrently instead of following.**
    - Pros: the refresh starts at once.
    - Cons: two scans of one container at a time, which the admission design avoids (`git-docker-scan` keyed by container).

## Assumptions and decisions

### R1. The budget row and its measurement (task 1)

The Files panel row of the [latency budgets](../../architecture/recurring-work.md#latency-budgets)
now reads "≤ 6 s; ≤ 1 s after an explicit action, or one scan longer when a
scan is already running", with the measured figures in its notes (p50 425 to
543 ms, p95 1.30 s and 2.23 s over two runs of 15; All files max 881 ms). The
data-saving paragraph below the table says the same for an explicit action.
No scheduling changed: `ChangeTrackingService.refresh` and
`DiffStatsService.request(entry, "refresh")` still follow a running scan, so
a refresh never settles on a scan that may predate the click.

### R2. How the qualification check encodes "one scan longer" (task 1)

`e2e/agent-testing/latency-budget.ts` used to exempt the Changes refresh by
label, as an open exception. It now has a per-series `scanAllowance`: the row's
effective p95 budget is its budget plus one scan, and the spec sets the
allowance only on the container Changes refresh
(`change-to-visible-latency.spec.ts`); All files and every other row keep
their plain budget. The spec cannot see scan durations, so one scan is
estimated by the series' own median: most refreshes do not land behind a
running scan, so a typical refresh costs one scan plus rendering, never less
than the scan alone. A series that misses that bound still fails
qualification. Alternatives: a fixed allowance (no evidence for a value that
holds across hosts, and a slow host would fail a compliant run) or reading
scan durations from backend diagnostics (no per-scan duration is exposed for
`git-docker-scan`; a new metric only for this check). Tests:
`tests/unit/change-to-visible-latency.test.ts`.

## Needs verification

- Under R2's bound the second macOS run passes (p95 1,304 ms against
  1,000 + 425 ms), but the first run's p95 of 2.23 s is over 1,000 + 543 ms.
  That run kept only its summary, so whether its slowest refresh followed an
  unusually slow scan (which the amended budget allows) or something else is
  unknown. The next container run of `change-to-visible-latency.spec.ts`
  ([0048](0048-recurring-work-qualification.md) task 2, which still owns
  client-side latency) applies the new check; if it fails, trace that sample's
  scan before widening anything.

## Related

- [0048](0048-recurring-work-qualification.md) task 2: the measurement.
- [0048](0048-recurring-work-qualification.md) task 12: measured candidates, where an accepted budget change is recorded.
