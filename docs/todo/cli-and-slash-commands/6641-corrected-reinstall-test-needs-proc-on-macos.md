# The corrected-reinstall test fails on macOS because it needs `/proc`

## Task analysis

Analysed 2026-11-05 against `main` at `41f9eb638`.

### Tasks

1. **Make the corrected-reinstall test independent of the host's `/proc`**: it fakes Linux but reads the real process identity, so it always fails on a Mac. Status: open.

### 1. Make the corrected-reinstall test independent of the host's `/proc`

**Problem.** `same-version old launcher failures during manager reload do not fail a corrected reinstall` in `packages/cli/tests/service-install.test.ts` fails on every macOS run of `mise run test`, with exit code 4 where it expects 0. Any pipeline on a Mac reports it as a failure, even though nothing is wrong with the product.

**Context.** The test sets `process.platform` to `linux` so that it can assert the `systemctl` calls. `descriptorProcessRefusal` in `packages/cli/src/client/targets.ts` then takes its Linux branch and calls `readLinuxProcessIdentity`, which reads `/proc/sys/kernel/random/boot_id` and `/proc/<pid>/stat`. Neither exists on macOS, so the function returns null and the descriptor is refused. The identity check arrived in `042f3e664` (#1848). CI's test shards run on Linux, so CI does not see this.

**Investigation.** On a macOS host at `c6bbbcf6f`, with `process.platform` set to `linux`, `readLinuxProcessIdentity(process.pid)` returned null and `descriptorProcessRefusal` answered "cannot be confirmed: its Linux process identity could not be read". The test file passed with a throwaway preload that faked only those two `/proc` reads, so `/proc` is the only missing condition. The test does not appear in the failure log of `main`'s CI run 42096069100 at `41f9eb638`. It is not a flake: it fails every time on a Mac and has no timing element.

**Decisions.**

- **How should the test get a process identity?**
  - **Spy on `readLinuxProcessIdentity` in this test and return a fixed identity (recommended).** The file already spies on `connection.awaitServiceConnection` through a namespace import. This has not been tried yet.
    - Pros: no production change; the test still asserts the `systemctl` calls and the reinstall result on any host.
    - Cons: this test stops reading real `/proc` on Linux, though `client-descriptor-process.test.ts` covers the real reader.
  - **Skip the test unless the host is Linux.**
    - Pros: one line, and Linux keeps the real read.
    - Cons: a Mac never runs the reinstall path, so a regression there waits for CI.
  - **Add an injectable identity reader to `runClient`.**
    - Pros: an explicit seam with no spying.
    - Cons: widens a security check's production signature for the sake of one test.

## Related

- [6220-descriptor-start-time-macos-live-run.md](6220-descriptor-start-time-macos-live-run.md) (the real macOS path of the same check).
- [4700](../coordinator-and-multi-review/4700-coordinator-steer-missing-on-long-lived-coordinator.md) (the work whose validation found this; its changes do not touch this path).
