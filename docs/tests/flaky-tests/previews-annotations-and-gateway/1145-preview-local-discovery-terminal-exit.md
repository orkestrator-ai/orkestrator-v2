# Local preview discovery fixture terminal exits before reporting its port

- **ID:** 1145
- **Status:** open
- **Observed:** 2026-10-27, todo 0223 branch validation
- **Test:** `local preview service discovery on this host > two environments, a restart on the reused port, and an auto-incremented port`
- **File:** `apps/backend/src/core/preview-local-discovery.test.ts:531`

Failed twice in the backend workspace aggregate on the 0223 branch (a focused
`bun test --cwd apps/backend src/core tests --parallel=6` run, then the second
`mise run test`; 468.78 ms), each time with `terminal exited 0`: the fixture
shell exited before its first stdout line reported a port. The 0223 change
does not touch preview discovery or this fixture.

The complete unchanged owner passed alone on the branch and on a detached
worktree of its base `863b57821` (19 passed each):

```sh
bun test --cwd apps/backend --preload ../../tests/setup-node.ts src/core/preview-local-discovery.test.ts
```

Host load during the aggregate is a hypothesis, not an established cause. No
assertion, timeout, skip or implementation changed. Aggregate evidence:
`orkestrator-test-run.38P3gc` under the host temporary directory.


## Storage-maintenance review fixes recurrence (2026-10-27–28)

On `local-env-disk-fccbc2f7869f-r1`, based on `55f7adb3e`,
`mise run test:logged -- --name default-suite -- mise run test` (two backend
workers) failed this same case after 693.88 ms with `terminal exited 0`.
The preceding fixture listener reported `EADDRINUSE` on `127.0.0.1:61856`.

The complete unchanged owner passed alone (19 tests, exit 0, 5.5 s):

```sh
mise run test:logged -- --name preview-discovery-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/preview-local-discovery.test.ts --parallel=1 --only-failures
```

Aggregate evidence is under the host temporary directory in
`orkestrator-test-run.ppPDQr/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
A fixture port-allocation race is a hypothesis; no preview implementation or
fixture changed. The aggregate remains non-green.

The completed aggregate backend group reported 12,711 passed, 25 failed and
123 skipped across 12,859 tests in 779 files (1025.56 s). The complete default
run exited 1 after 1132.9 s; desktop, root and Claude bridge tests added six
failures, all in files outside the storage-maintenance fixes. The new storage
and retention regressions and the focused change-tracking suite passed, as did
formatting, lint and typechecking. The run does not establish that every
aggregate failure is pre-existing. Browser, Electron, Docker and iOS scenario
suites were outside this backend-only follow-up's scope; production-scale
maintenance timing and packaged/cross-platform copy behavior remain unmeasured.
