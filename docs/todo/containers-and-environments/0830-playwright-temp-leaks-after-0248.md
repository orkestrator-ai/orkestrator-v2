# Playwright temporary directories 0248 leaves uncontained

Found on 2026-10-28 while implementing
[0248](0248-playwright-profile-dir-leaks.md).

## Task analysis

Analysed 2026-10-28 against `main` at `79f3bc97`.

### Tasks

1. **Private `TMPDIR` for the real-stack and preview Playwright suites**: the `e2e/agent-testing/*` and `e2e/preview` configs still launch browsers in the shared temporary directory. Status: open.
2. **The design renderer's `playwright-artifacts-*` directory**: a killed backend leaves one empty directory per browser that the 0248 ledger cannot record. Status: open.

### 1. Private `TMPDIR` for the real-stack and preview Playwright suites

**Problem.** A killed worker in these suites leaves its browser profile in the
shared temporary directory, where nothing can attribute or remove it.

**Context.** 0248 gave the two `test:browser` configs a private `TMPDIR`
(`tests/private-tmpdir.ts`), because Playwright Test workers owned every live
profile on the macOS host. The other configs start real backends, agents and
fixture servers that inherit the runner's `TMPDIR`.

**Investigation.** Not run: these suites drive live agents for many minutes
and are never part of the default validation (`AGENTS.md`). A backend started
under a private `TMPDIR` puts its own temporary files there too, including any
Unix sockets, so the macOS 104-byte socket path limit has to be checked
against the longest path those backends make.

**Decisions.**

- **Contain them, or leave them to their own cleanup?**
  - **Call `enterPrivateTestTmpdir()` from each config, as 0248 did, after one isolated qualification run per suite (recommended).**
    - Pros: the same containment and sweep as every other test process; a killed run becomes attributable.
    - Cons: needs one live run of each suite; the backends they start move their temporary files too.
  - **Leave them.**
    - Pros: no change to suites that are expensive to requalify.
    - Cons: they stay the uncontained source of the kind of burst 0248 started from.

### 2. The design renderer's `playwright-artifacts-*` directory

**Problem.** Each Playwright launch also makes `playwright-artifacts-XXXXXX` in
the launching process's temporary directory, removed with the profile. A
killed backend leaves it behind, and the 0248 ledger records only the profile.

**Context.** The 0248 ledger reads the profile from Chromium's
`--user-data-dir=` argument. The artifacts directory is not on Chromium's
command line, and its name holds no owner.

**Investigation.** The macOS host held 7 of these on 2026-10-28, against 67
profiles. They are empty for the design renderer, which uses no downloads,
traces or video. `playwright-core` 1.64.0 skips making it when the launch
options carry `artifactsDir` (`_prepareToLaunch`), but that option is not in
the public `launchServer()` type.

**Decisions.**

- **How to contain it?**
  - **Pass `artifactsDir` pointing into a directory the ledger owns, if `launchServer()` honours it at run time, and remove it with the record (recommended).**
    - Pros: nothing left in the shared temporary directory; no change to ownership of the browser process.
    - Cons: relies on an option outside the public type, so a Playwright upgrade must recheck it.
  - **Leave it.**
    - Pros: no change; each is an empty directory.
    - Cons: an unowned entry per killed backend accumulates in the shared temporary directory.

## Related

- [0248-playwright-profile-dir-leaks.md](0248-playwright-profile-dir-leaks.md)
- [0247-test-temp-dir-leaks-from-full-sweep.md](0247-test-temp-dir-leaks-from-full-sweep.md)
