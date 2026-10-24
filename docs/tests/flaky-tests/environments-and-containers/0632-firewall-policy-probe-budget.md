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
- **2026-10-24 (node mbp3, macOS, Apple Silicon):** `mise run test` on the
  0011 runtime-state branch failed five of these cases at 5.0 s. Unlike the
  original observation, the owner also failed alone here:
  `mise run test:logged -- --name firewall -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1`
  → 12 pass, 12 fail (67.4 s), and the same command in a clean `origin/main`
  (`8454d18b`) worktree → 11 pass, 13 fail (70.1 s). On this host it is a
  host condition (slow DNS in the shell harness), not a branch regression and
  not a flake by the register's definition; the branch touches neither the
  test nor `docker/`.
