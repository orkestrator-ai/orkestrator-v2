# CLI scenario retry-and-retention: empty JSON output

- **ID:** 1001
- **Status:** open
- **Date observed:** 2026-10-26
- **Test:** `packaged client against a real backend > scenario: retry-and-retention`
- **File:** `packages/cli/tests/cli-client.test.ts`
- **Original command:** `mise run test` on branch `todo-0109-rootless-linux-runtime-d03790b22a6c` (omarchy-hp, shared host), CLI package `test:workspace` with two workers.
- **Failure:** `[project add] JSON mode printed 0 lines on stdout` after 2,642 ms.
- **Suite counts:** CLI package 325 pass, 1 fail.
- **Isolated rerun:** `mise run test:logged -- --name a-cli -- bun test --cwd packages/cli --preload ../../tests/setup-node.ts tests/cli-client.test.ts --parallel=1` passed (19.7 s).
- **Hypothesis:** the packaged client's first command against a backend that was still starting under host load; the branch did not change the CLI.
