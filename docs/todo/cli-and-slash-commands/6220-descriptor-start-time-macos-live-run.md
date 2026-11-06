# Prove the CLI's descriptor start-time check on a real Mac

## Task analysis

Analysed 2026-11-05 against `main` at `2882b30ee`. Run on a real Mac
2026-11-06 against `main` at `c1724ab74`.

### Tasks

1. **Run the start-time check on a real Mac**: the macOS path of the CLI's descriptor start-time check has only run against fakes. Status: done (2026-11-06, macOS 27.2).

### 1. Run the start-time check on a real Mac

**Problem.** The CLI now refuses an instance descriptor whose pid is alive but
whose process start time does not match the descriptor's `startedAt`. On macOS
the start time comes from `/bin/ps -o lstart=` under `LC_ALL=C TZ=UTC0`. That
path has been tested only with a fake `ps`, because the build host and CI's
test shards are Linux. If a real Mac printed `lstart` in another shape, every
descriptor connection on macOS would be refused as "cannot be confirmed".

**Context.** Carried over from security report
`docs/reports/security/0160-l12-descriptor-process-binding.md` (L12, task 1,
"Detect a reused pid"), deleted once its work was built. Its last version,
which ends with the outcome table, is the parent of the commit that deleted it:
`git log -1 --diff-filter=D --format=%H -- docs/reports/security/0160-l12-descriptor-process-binding.md`
names that commit; `git show <commit>^:docs/reports/security/0160-l12-descriptor-process-binding.md`
prints the file.
The report's problem: if a backend dies and its pid is reused by another
process of the same user, the descriptor still looks live, and if someone else
has taken the old port the CLI sends the bearer token to them. Its recommended
option, comparing the process start time with `startedAt` before reading the
token, is built: `descriptorProcessRefusal` in
`packages/cli/src/client/targets.ts`, the reader in
`packages/cli/src/client/process-start.ts`, and the tests in
`packages/cli/tests/client-descriptor-process.test.ts`. The process may have
started up to 30 seconds after `startedAt` and up to one hour before it; an
unreadable start time is refused. The CLI package ships for Linux and macOS
only.

**Investigation.** On Linux the real reader ran against a spawned child and the
whole CLI suite, including the packaged client against a real backend, passed
with the check in place (2026-11-05). The macOS parser accepts
`Thu Nov  5 16:35:38 2026` (BSD `ps` prints `lstart` as `%a %b %e %T %Y`); a
fake covers it. The real-host test "reads a real child's start time on this
host" is not skipped on `darwin`, so running the CLI package tests on a Mac
exercises the real path. No CI job runs those tests on macOS
(`.github/workflows/ci.yml` runs `test-shard` on `ubuntu-latest`; the macOS
runner there only checks preview-worker staging).

**Decisions.**

- **How to get the evidence?**
  - **Run the CLI package tests and one packaged-client connection on a Mac once (recommended).** `bun --cwd packages/cli test --preload ../../tests/setup-node.ts tests/client-descriptor-process.test.ts tests/cli.test.ts --parallel=2` from the repository root after `bun run --cwd packages/cli build`, then `orkestrator connection add` against a throwaway `dev:test` profile's data directory.
    - Pros: cheap; proves the real `ps` output and a real backend's `startedAt` both fit; no code change.
    - Cons: one-off; a later macOS `ps` change would go unnoticed.
  - **Add a macOS job to CI that runs the CLI package tests.**
    - Pros: keeps proving it on every change.
    - Cons: macOS runners are slower and billed at a higher rate; a whole new job for one parser.

## Current state

Done on 2026-11-06 on macOS 27.2 (build 26B123, Darwin 27.2.0, arm64),
against `main` at `c1724ab74`. No defect was found.

- **`ps` output shape.** `LC_ALL=C TZ=UTC0 /bin/ps -o lstart= -p PID` printed
  `Fri Nov  6 05:25:20 2026` followed by four padding spaces and a newline:
  BSD's `%a %b %e %T %Y` with a space-padded day, as the parser expects;
  `parsePsLstart` trims the padding. Without the pinned environment the same
  command prints `Fr.  6 Nov. 05:25:30 2026` under `LC_ALL=de_DE.UTF-8` and
  shifts the hour with `TZ`, so both overrides are needed and both work.
- **CLI package tests.** After `bun run --cwd packages/cli build`,
  `bun --cwd packages/cli test --preload ../../tests/setup-node.ts tests/client-descriptor-process.test.ts tests/cli.test.ts --parallel=2`
  from the repository root: 567 pass, 2 skip, 0 fail across 39 files (the
  filter arguments also match other CLI test files). A JUnit report of the
  descriptor file shows "reads a real child's start time on this host" ran
  with 3 assertions; the two skips are the Linux-only process-identity tests.
- **Packaged client against a real backend.** A throwaway `dev:test` profile
  (`--fixture --no-agent-credentials`, `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`)
  published a descriptor with `startedAt` `05:27:52.791Z` for a backend whose
  `ps` start time was `05:27:51`. With a scratch `ORKESTRATOR_CLI_CONFIG_DIR`,
  `bun packages/cli/bin/orkestrator.js connection add qa6220 --data-dir <profile data>`
  exited 0 with `verified: true`, and `connection check` reported the
  installation, version `2.36.5-beta` and 121 actions. The profile was
  stopped and reset afterwards.
- **Stale descriptors.** Copies of the descriptor in a scratch directory,
  each with only `pid` changed, were refused with exit 4
  (`connection-failed`) and saved nothing:
  - a `sleep` started 32 s after `startedAt`: "is not running: pid 79571
    belongs to a process started at 2026-11-06T05:28:25.000Z, but the backend
    started at 2026-11-06T05:27:52.791Z (its descriptor is stale)";
  - a user process started 16 hours earlier (`distnoted`): the same message
    with its start time `2026-11-05T13:16:13.000Z`;
  - the `sleep` pid once it had exited: "is not running as your user (its
    descriptor is stale)".
- **Tests added.** `client-descriptor-process.test.ts` now pins the padded
  macOS 27.2 shape in "parses ps lstart as UTC", and a macOS-only real-host
  test reads a child's start time with the caller's `LC_ALL`/`LANG` set to
  `de_DE.UTF-8` and `TZ` to `Pacific/Kiritimati`. With the reader's
  `LC_ALL`/`TZ` override removed that test fails (`null`); restored, it passes.

The CI decision stands: no macOS job runs these tests, so a later `ps` change
would surface only on a Mac run.

## Related

- `docs/architecture/public-cli.md` (the instance descriptor section)
- [Security review, §5 Low severity](../../reports/2-26-10-27-security.md#5-low-severity) (L12)

## Assumptions and decisions

### Task 1: real macOS qualification

The review repair ran on Linux, so the real macOS run remains open. Fake BSD ps coverage and the portable real-child test do not substitute for that evidence.

### Task 1: run on macOS 27.2, 2026-11-06

Took the recommended option: one run of the CLI package tests and one
packaged-client connection, with no CI job. The run passed, so the task is
done. Two tests were added although no defect was found, because they pin
what this run observed: the padded `lstart` column, and that the reader's own
`LC_ALL=C TZ=UTC0` is what makes it independent of the caller's locale and
zone (only checkable on a Mac, where `ps` rather than `/proc` is read).
The stale-descriptor check used `connection add --data-dir` on a scratch copy
rather than editing the profile's descriptor, so the live profile was never
pointed at another process.
