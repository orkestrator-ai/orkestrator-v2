# Playwright worker-policy test crashes its child on macOS

- **ID:** 2270
- **Status:** resolved
- **Date observed:** 2026-11-01
- **Test:** `Playwright worker cap and retry policy: %j`, all six cases (`tests/unit/playwright-validation.test.ts:11`)
- **Original command:** the default suite's root and agent-support group, `mise run test:logged -- … mise run test`, on branch `agent-start-failure-28f9b34a1026-r1` (todo 1090), macOS arm64 (arktech-mini). Evidence: `orkestrator-test-run.AzaQ6M/root-and-agent-support-tests.log.gz` under the host temporary directory.
- **Failure:** each case expected the child's exit status 0 and got 1, with no stdout.
- **Not a flake:** it fails every time on macOS, alone and in the aggregate, and on clean `origin/main` (`93b99bfba`): `mise exec -- bun test tests/unit/playwright-validation.test.ts -t "worker cap"` in a detached `origin/main` worktree gave 0 pass, 6 fail.

## Cause

The test loads `e2e/playwright.config.ts` in a child after stubbing
`os.cpus = () => Array(n).fill({})`. Loading `@playwright/test` 1.64.0 runs
`calculatePlatform` in `playwright-core/lib/coreBundle.js`, which on macOS 11
or later calls `os.cpus().some((cpu) => cpu.model.includes("Apple"))`. The
stub's entries have no `model`, so the child throws
`TypeError: undefined is not an object (evaluating 'cpu.model.includes')` and
exits 1 before it prints the config. Linux does not take that branch, which is
why it passes there.

## Fix

The stub repeats the host's first real CPU entry instead of an empty object,
so only the core count changes. All seven tests in the file pass on macOS
(`mise exec -- bun test tests/unit/playwright-validation.test.ts`: 7 pass).
The worker-cap and retry expectations are unchanged.
