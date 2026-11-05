# A service-install test and a Codex host-rules spec fail on their own on macOS

## Task analysis

Analysed 2026-11-05 against `main` at `41f9eb638`.

### Tasks

1. **Stop the service-install test depending on a real Linux `/proc`**: it fakes the platform on macOS and then cannot publish a process identity. Status: open.
2. **Find why the managed-network card never appears**: `e2e/CodexHostRules.spec.ts` fails alone on both viewports. Status: open.

### 1. Stop the service-install test depending on a real Linux `/proc`

**Problem.** `same-version old launcher failures during manager reload do not fail a corrected reinstall` in `packages/cli/tests/service-install.test.ts` fails on macOS on every run, in 9 to 136 ms, with `Expected: 0, Received: 4`. It failed 3 of 3 runs alone at load averages from 34 to 50, so it is not a flake and is not load-dependent.

**Context.** The test sets `process.platform` to `linux` and publishes `processIdentity: await readLinuxProcessIdentity(process.pid)`. #1848 (`042f3e664`) added that field and the Linux branch of `descriptorProcessRefusal` (`packages/cli/src/client/targets.ts:266`), which refuses a descriptor with no identity.

**Investigation.** `readLinuxProcessIdentity` reads `/proc/sys/kernel/random/boot_id`; run directly on this Mac it returned `null`. With the faked platform the descriptor therefore has no identity, which the code above refuses. That chain is read from the code: the test's own error text was not captured, and neither a Linux host nor `main` was run. The other 32 tests in the file passed in the same runs.

**Decisions.**

- **How should the test get an identity?**
  - **Run this test only on real Linux, with `test.skipIf(process.platform !== "linux")`, and drop the platform fake (recommended).**
    - Pros: one line; the test then exercises the real identity path it means to; no new production seam.
    - Cons: macOS loses this test; coverage depends on a Linux run, which CI would need to provide.
  - **Inject the identity reader so the test can supply a fixed value on any platform.**
    - Pros: the test keeps running everywhere.
    - Cons: adds a parameter through `runClient` and the connection wait for one test; `process.platform` stays faked; the real `/proc` read is no longer covered here.

### 2. Find why the managed-network card never appears

**Problem.** `managed-network card remembers a host, auto-answers and asks after removal` (`e2e/CodexHostRules.spec.ts:33`) cannot find the text `Approve network access` within 5 s. It failed in the review preparation browser run on both projects, and again on both projects when run alone at a load average of about 43, with two workers on a private port.

**Context.** The spec starts `e2e/fixtures/codex-host-rules-host.ts`, posts `/raise`, then opens `/claude-interactions?session=codex-host`. Its route handler proxies `**/__claude-test/**` to that host. The logs also show `apiRequestContext.fetch: Request context disposed`, which may be a consequence of the failed test ending rather than a cause.

**Investigation.** Not diagnosed: the failure traces were not opened, and the failure has not been compared with `main`. A static import walk from `e2e/fixture/ClaudeInteractionsFixture.tsx` does not reach `apps/web/src/hooks/native-agent-live-head.ts`, so the 4520 change it was seen on does not explain it. One run alone at a similar load is too little to call it deterministic or to rule out load.

**Decisions.**

- **Where to start?**
  - **Run the spec alone on an idle host and read its retained trace, starting with whether `/raise` and the proxied session reads answer (recommended).**
    - Pros: separates load from a real defect first; the trace shows the requests the page made.
    - Cons: needs a quiet host, which this machine often is not.
  - **Compare with a run on `main` first.**
    - Pros: says at once whether a branch caused it.
    - Cons: does not explain the failure, and a shared cause on `main` still needs this same diagnosis.

## Related

- [Flake case 6600](../../tests/flaky-tests/aggregate-validation-runs/6600-live-head-preparation-owners-vary-with-load.md), the run these were separated from.
- [Failure triage](../../architecture/review-preparation.md#failure-triage): the service-install failure was triaged `related` through a doc comment naming `apps/web`, which to-do 6601 fixed on 2026-11-05; [6920](../coordinator-and-multi-review/6920-triage-related-through-a-widely-shared-import.md) carries its follow-up.
