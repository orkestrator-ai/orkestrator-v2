# `container firewall policy > policy 3 allowlist <entry> chooses blocked HTTPS probe example.net`

- **ID:** 0632
- **Status:** open
- **Date observed:** 2026-10-20
- **Original command:** `mise run test` (as `mise run test:logged -- --name final-suite`)
- **Worker configuration:** root and agent-support group, alongside the workspace, bridges and codex-protocol groups
- **Failure:** both parametrized cases (`example.com:443/tcp` and the
  whitespace/uppercase ` EXAMPLE.COM:443/tcp `) failed at
  `tests/unit/firewall-policy.test.ts:518` with
  `expect(result.exitCode).toBe(0)` receiving `null`, each at ~5,002 ms. A
  `null` exit code at the five-second mark is Bun's generic outer test budget
  killing the spawned `docker/firewall-domains.sh` harness, not a non-zero
  exit from the script. The group had 3,146 passed, 1 skipped, 2 failed across
  148 files in 221.5 s.
- **Isolated rerun:** `mise run test:logged -- --name own-firewall -- bun test
  tests/unit/firewall-policy.test.ts --parallel=2` passed (22.3 s).
- **Hypothesis:** each case spawns the real shell harness, which resolves
  `example.com` and `example.net` through the host resolver. Under aggregate
  load the spawn plus two DNS round trips can exceed Bun's five-second generic
  budget, and the whole file takes 22 s alone, so these cases have little
  headroom. The same class as [0159](0159-artifact-sanitizer-aggregate-timeout.md),
  where real subprocess work outgrew the generic budget.
- **Notes:** unrelated to the branch it was observed on (the settings Usage
  tab); nothing in `tests/unit/firewall-policy.test.ts`,
  `docker/firewall-domains.sh` or the network allowlist changed there. The
  likely fix is an explicit outer budget for these cases, as 0159 took.
- **Recurrence (2026-10-24, node mbp3):** the todo-0050 branch's aggregate failed seven firewall cases at the five-second budget. Rerun alone at load average 16 to 35, the owner still failed (10 of 24 failed, then 10 of 24 again). A worktree of `main` at `71227437`, run straight afterwards under the same load, failed the same way (8 of 24). `example.com`, `.net` and `.org` resolved promptly through `dscacheutil`. So host contention alone reproduces it here; the branch touches neither `docker/` nor the test.
