# Missing-PAT scratch project leaves its directory in the aggregate

- **ID:** 0690
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `missing PAT "   " prevents registry creation, discovery and private cloning before gh/transfer`
- **Owner:** `apps/backend/src/core/github-project-credentials.integration.test.ts:154`
- **Original command:** `mise run test`, the confirming aggregate for the
  OpenCode and Pi access-only logins change, on a heavily loaded host with
  other worktrees validating.
- **Failure:** `create_project_from_scratch` rejected with "personal access
  token is missing" and `gh` was never called, as expected, but
  `fs.readdir(root)` still listed `scratch` (`[ "bin", "scratch", "data",
  "remote.git" ]`). The case took 82.37 ms. Backend: 9,755 passed, 1 failed of
  9,823 tests across 551 files in 383.53 seconds; every other group passed.
- **Isolated rerun:** `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/github-project-credentials.integration.test.ts`
  passed unchanged (5 pass, 1.0 second).
- **Assessment:** Intermittent. The change under test does not touch project
  creation or GitHub credentials. Either the rejected creation's directory
  cleanup had not finished when the assertion read the directory, or the
  directory was created before the credential check under load; this run does
  not establish which. No test or production code was changed.

## Repository separator validation — 2026-10-25

- **Change:** `146fff6c6` on `repo-group-separators-4be2bb2ba0a0-r1`; sidebar rendering and regression tests only.
- **Original command:** `mise run test:logged -- --name aggregate-tests -- mise run test`. Workspace/root/bridges/protocol reserved 4/1/2/1 worker slots; backend used two isolated workers. Component-browser and isolated-browser checks also ran on the host.
- **Failure:** The empty-token variant (`missing PAT "" prevents registry creation, discovery and private cloning before gh/transfer`) still found `scratch` in the fixture directory at line 154 after 57.42 ms.
- **Owning-file rerun:** `mise run test:logged -- --name github-credentials-owner -- bun test --cwd apps/backend ./src/core/github-project-credentials.integration.test.ts --parallel=1 --only-failures` passed the complete unchanged file, exit 0 in 1.0 seconds logged.
- **Aggregate counts:** Backend 11,012 passed, 79 skipped and three failed across 660 files (642.56 s); root/support 3,405 passed and one failed across 162 files (403.31 s). All other workspace packages, bridges and protocol passed; aggregate exit 1 in 692.6 s logged.
- **Evidence:** `orkestrator-test-run.sQR1xm/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory; the outer aggregate log is `orkestrator-test-run.k2y50g/aggregate-tests.log.gz`.
- **Assessment:** Recurrence of the existing intermittent failure. No backend implementation, assertion, deadline or skip changed; the original aggregate remains non-green.
