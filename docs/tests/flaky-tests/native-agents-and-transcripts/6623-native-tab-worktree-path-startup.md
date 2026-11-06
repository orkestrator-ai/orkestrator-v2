# Locked native tab worktree-path startup timeout

- **ID:** 6623
- **Status:** open
- **Date observed:** 2026-11-05
- **Test:** `a worktree path arriving after mount updates locked file search and attachment resolution`.
- **File:** `apps/web/src/components/native-agent/AgentNativeTab.render-count.test.tsx`.
- **Original command:** `mise run test:logged -- --name findings-owning-units -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.render-count.test.tsx ./src/components/chat/NativeChatShell.test.tsx ./src/lib/transcript-scroll/keep-mounted.test.ts ./src/components/chat/SuborkGroup.test.tsx --parallel=2 --only-failures`.
- **Workers:** two isolated Bun workers, alongside other worktrees' validation on the same host.
- **Failure:** test timed out after its 5000 ms budget, recorded duration 5403.08 ms. Suite: 106 passed, 2 failed, 454 assertions, four files, 35.61 s. The other failure is recorded as 6622.
- **Artifact:** `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.bLQwSI/findings-owning-units.log.gz`.
- **Owning-file rerun:** `mise run test:logged -- --name findings-render-count-alone -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.render-count.test.tsx --parallel=1 --only-failures` had passed all 34 cases unchanged earlier in this session (35.4 s), before the timeout. After the separate read-token fixture repair for 6622, the same isolated command passed again (30.4 s), and the original four-file command passed all 108 cases (30.3 s).
- **Root cause:** not established. The read-token fixture repair removes redundant snapshot work, but these results do not establish that it caused this timeout. The assertion and timeout remain unchanged.
