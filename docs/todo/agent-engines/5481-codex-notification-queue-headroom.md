# Codex notification queue: read a real high-water mark

Carried from efficiency report file `docs/reports/efficiency-logging-database/0140-br-13-serial-queue-bound.md` (batch E-0140, finding BR-13), deleted on 2026-11-05. Its original text is at `69a3b4ca5`; its last version, ending with its outcome table, is the parent of the commit that deleted it (`git log --diff-filter=D -- <path>`). The bound is built and tested; only its open question about a real figure is left.

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`.

### Tasks

2. **Move the bounds if the figure is close to them**: Status: blocked (waits on 7568: 5481 task 1).

### 2. Move the bounds if the figure is close to them

**Problem.** If real work comes near the bound, a burst would restart the child mid-turn.

**Context.** The restart path is tested (`a notification backlog past its bound restarts the child and fails the turn as a restart`, `app-server-runtime-lifecycle.test.ts`).

**Investigation.** Depends on the high-water mark read from real Codex turns (task 1, now in the manual-test checklist). The bounds are `DEFAULT_NOTIFICATION_QUEUE_MAX_DEPTH` and `DEFAULT_NOTIFICATION_QUEUE_MAX_BYTES` in `bridges/codex-bridge/src/app-server/jsonl-rpc-client.ts`; the supervisor's health reports `notificationQueueHighWaterMark` (`app-server/process-supervisor.ts`).

**Decisions.**

- **What headroom is enough?**
  - **Keep the bounds unless the high-water mark exceeds a tenth of either (recommended).**
    - Pros: a clear rule; no change while the reasoning holds.
    - Cons: the tenth is a judgement, not a measurement.
  - **Raise them now.**
    - Pros: no measurement needed.
    - Cons: a larger bound lets a stuck consumer hold more memory before recovery.

## Related

- to-do 1202 task 6 (retired 2026-11-10): what was built for BR-13.
- Efficiency report, C (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`) (BR-13).
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1) moved there on 2026-11-10.

## Replaces

- Report `0140-br-13-serial-queue-bound.md`: its open question, the bound's value.
