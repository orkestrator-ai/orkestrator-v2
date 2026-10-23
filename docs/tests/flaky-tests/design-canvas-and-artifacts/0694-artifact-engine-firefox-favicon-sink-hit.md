# Artifact engine qualification: Firefox favicon request reaches the sink

- **ID:** 0694
- **Status:** open
- **Date observed:** 2026-10-23
- **Test:** `executable document policy in firefox > popups, new-window links and top navigation reach the sink zero times`
- **Owner:** `apps/backend/src/core/transcript-artifacts/content-server.engines.test.ts` (assertion at line 924, `expect(sink.hits).toEqual([])`)
- **Scope:** branch `todo-0049-idle-observation-a4c535cb5c84` (base `06297124`). The change does not touch transcript artifacts; the area suite ran because `packages/protocol/src/native-agent.ts` changed (a type-only field).
- **Original command:** `mise run test:logged -- --name backend -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts src tests --only-failures --parallel=4`, on a host at load average about 60 (other worktrees' suites running).
- **Failure:** the sink recorded `GET /favicon.ico` instead of nothing (4481 ms). Every restricted navigation counter was 0; only the favicon fetch reached the sink origin.
- **Suite counts:** backend 10178 tests, 14 fail; the other failures were load timeouts that passed alone.
- **Isolated reruns:** `bun test --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/content-server.engines.test.ts --parallel=1 -t "popups, new-window links"` from `apps/backend`: with the branch's files 0, 1, 1 failures in three runs; with `native-agent.ts` restored to `HEAD` (the only changed file in the test's import graph) 0, 1, 0. The whole owning file once: 38 pass, 1 fail. So it fails intermittently alone and independently of the branch: by the registry's rule it is not yet a confirmed flake, but it is not caused by this change either.
- **Hypothesis:** Firefox (Playwright's `firefox-1555`) sometimes requests the sink page's favicon after a blocked top navigation or popup, which the sink counts as a hit. Not confirmed; the browser build and timing were not varied.
- **Next step:** decide whether a favicon request is an escape the policy must prevent or a request the sink should ignore, then fix the test or the policy accordingly.

## Released Claude wakeup review — 2026-10-23

- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test`, with workspace/root/bridge/protocol reservations 4/1/2/1; the backend used its normal Node preload while isolated browser validation and other worktrees were active.
- **Failure:** the same Firefox popup/navigation test recorded `GET /favicon.ico` (18509.13 ms). The wakeup fix changes only native-agent reconciliation and its tests.
- **Suite counts:** backend 10118 passed, 60 skipped, 1 failed across 587 files (679.88 s). The aggregate exited 1 after 1035.1 s; its other failing group contained three unrelated bridge timing failures, each passing on its unchanged owning-file rerun.
- **Whole owning-file rerun:** `mise run test:logged -- --name artifact-engine-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/content-server.engines.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 190.3 s logged).
- **Evidence:** `orkestrator-test-run.XHMi6K/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** the complete isolated owner pass now confirms an intermittent recurrence under the registry's rule. The existing Firefox favicon hypothesis remains unconfirmed; no implementation, assertion, deadline or skip changed.
