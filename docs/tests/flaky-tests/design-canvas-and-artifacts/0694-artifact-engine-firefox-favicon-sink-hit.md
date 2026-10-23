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
