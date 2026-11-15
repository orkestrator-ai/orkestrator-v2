# Locked native tab worktree-path startup timeout

- **ID:** 6623
- **Status:** resolved
- **Date observed:** 2026-11-05
- **Test:** `a worktree path arriving after mount updates locked file search and attachment resolution`.
- **File:** `apps/web/src/components/native-agent/AgentNativeTab.render-count.test.tsx`.
- **Original command:** `mise run test:logged -- --name findings-owning-units -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.render-count.test.tsx ./src/components/chat/NativeChatShell.test.tsx ./src/lib/transcript-scroll/keep-mounted.test.ts ./src/components/chat/SuborkGroup.test.tsx --parallel=2 --only-failures`.
- **Workers:** two isolated Bun workers, alongside other worktrees' validation on the same host.
- **Failure:** test timed out after its 5000 ms budget, recorded duration 5403.08 ms. Suite: 106 passed, 2 failed, 454 assertions, four files, 35.61 s. The other failure is recorded as 6622.
- **Artifact:** `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.bLQwSI/findings-owning-units.log.gz`.
- **Owning-file rerun:** `mise run test:logged -- --name findings-render-count-alone -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.render-count.test.tsx --parallel=1 --only-failures` had passed all 34 cases unchanged earlier in this session (35.4 s), before the timeout. After the separate read-token fixture repair for 6622, the same isolated command passed again (30.4 s), and the original four-file command passed all 108 cases (30.3 s).
- **Root cause:** not established. The read-token fixture repair removes redundant snapshot work, but these results do not establish that it caused this timeout. The assertion and timeout remain unchanged.

## Resolution (2026-11-15)

- **Root cause:** The worktree-path case timed out at Bun's 5 s default in a two-worker run.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. `apps/web/src/components/native-agent/AgentNativeTab.render-count.test.tsx` also installs `useAsyncUtilHangWatchdog()` so its `waitFor`/`findBy` waits, all for states the tab reaches, are not cut off at Testing Library's 1 s default.
- **Reproduced:** no — the recorded deadline was Bun's default budget on a loaded host; the failing body is fast alone, and a 5 s exhaustion was not re-created per case here.
- **Stress:** `mise run test:logged -- --name nat-6623-stress -- bash -c 'cd apps/web && bun ../../scripts/test-under-contention.ts --core 11 --burners 6 -- bun test ./src/components/native-agent/AgentNativeTab.render-count.test.tsx --rerun-each=3'` passed 3 of 3.
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
