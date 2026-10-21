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
