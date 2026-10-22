# Aggregate process-contention recurrences (credential-isolation follow-up)

- **ID:** 0042
- **Status:** resolved
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name final-full-test -- bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran workspace, root/agent-support, bridges, and protocol-lockfile groups concurrently; the root group used four Bun workers and the bridges group used two.
- **Failures:** `agent completion immediately rechecks and clears a resolved conflict` timed out after 3,028.60 ms waiting for the immediate PR recheck; `runtime helper preserves caller PATH additions in non-interactive bash` timed out after 5,662.98 ms; `rejects malformed container status framing and invalid encoded sections` timed out after 5,009.79 ms and its interrupted fixture produced a follow-on assertion error; `hard-kills a process that exceeds stdout and file-output limits` timed out after 5,511.94 ms.
- **Suite counts:** backend workspace: 1,892 passed and 1 failed across 73 files; root/agent-support: 3,742 passed and 4 failed across 180 files (two are listed here, one is the separately recorded backend-readiness recurrence, and one was an outdated changed-code fixture corrected in this follow-up); bridges: 2,649 passed and 1 failed across 91 files.
- **Isolated reruns:** each exact failed test passed alone through `test:logged`: PR recheck in 0.6 s, runtime environment in 0.7 s, malformed framing in 2.1 s, and Codex title limit in 0.5 s.
- **Second aggregate run:** `bun run test` at `26c100220c905c67fa8efe3a12f606c90e610d1a` passed the complete workspace group, then the six-worker root group reported 3,742 passed and 4 timed-out tests after 268.8 s. The malformed-framing and backend-readiness cases recurred; `stops local merges when draft inspection or readiness fails` and `treats empty, null, and non-boolean draft output as non-draft` were newly observed at 5,017.69 ms and 5,001.10 ms. Those two exact PR tests passed alone in 2.4 s and 3.4 s respectively.
- **Recurrence (2026-08-27):** `bun run test` reported 3,848 passed, one
  skipped, five failed, and three associated errors in the root group. The
  failures were the Linux file-manager fallback; three direct-container Claude
  credential cases in `commands-registry-docker.test.ts`; and backend readiness.
  The three owning files passed alone (61/61, 12/12, and 29/29).
- **Hypothesis:** these cases cross real timer or subprocess boundaries and exhausted generic aggregate budgets while the independently scheduled groups competed for process startup. The isolated passes confirm this observation as contention-shaped; recurrence counts should be gathered before changing product assertions.
