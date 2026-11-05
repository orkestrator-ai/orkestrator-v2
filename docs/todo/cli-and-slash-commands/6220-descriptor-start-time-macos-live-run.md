# Prove the CLI's descriptor start-time check on a real Mac

## Task analysis

Analysed 2026-11-05 against `main` at `2882b30ee`.

### Tasks

1. **Run the start-time check on a real Mac**: the macOS path of the CLI's descriptor start-time check has only run against fakes. Status: open.

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
  - **Run the CLI package tests and one packaged-client connection on a Mac once (recommended).** `bun test --preload ../../tests/setup-node.ts tests/client-descriptor-process.test.ts tests/cli.test.ts --parallel=2` in `packages/cli` after `bun run build`, then `orkestrator connection add` against a throwaway `dev:test` profile's data directory.
    - Pros: cheap; proves the real `ps` output and a real backend's `startedAt` both fit; no code change.
    - Cons: one-off; a later macOS `ps` change would go unnoticed.
  - **Add a macOS job to CI that runs the CLI package tests.**
    - Pros: keeps proving it on every change.
    - Cons: macOS runners are slower and billed at a higher rate; a whole new job for one parser.

## Related

- `docs/architecture/public-cli.md` (the instance descriptor section)
- [Security review, §5 Low severity](../../reports/2-26-10-27-security.md#5-low-severity) (L12)
