# Skill scanning fixture hook exceeds the aggregate deadline

- **ID:** 0212
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `scanAgentSkills > bounds entries per root and total skills across plugin roots`
- **Owning file:** `apps/backend/src/core/agent-skills.test.ts`.
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`, with the testing guide's macOS GNU-tool PATH.
- **Worker configuration:** workspace group reserved four worker slots; root used one worker, bridges two, and protocol one. Other validations were active on the host.
- **Failure:** a beforeEach/afterEach hook timed out; the case reported 6856.51 ms.
- **Evidence:** `/tmp/orkestrator-test-run.BYvvBs/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Aggregate counts:** backend 7712 passed, 39 skipped, 5 failed across 424 files in 518.91 seconds; root 2945 passed, 1 skipped, 1 failed. Bridge and protocol groups passed.
- **Isolated rerun:** `mise run test:logged -- --name agent-skills-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/agent-skills.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 4.2 seconds).

Concurrent fixture I/O is a possible cause, not a confirmed diagnosis. The
OpenCode auth-status change does not touch skill scanning. No test deadline,
assertion or skip was changed.
