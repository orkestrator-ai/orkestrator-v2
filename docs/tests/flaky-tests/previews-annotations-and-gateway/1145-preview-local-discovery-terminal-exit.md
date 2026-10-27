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
