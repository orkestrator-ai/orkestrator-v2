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

- **Recurrence 2026-10-24 (node mbp3, Control MCP voice branch `todo-0041-control-mcp-voice-4a2c0ccc548b`):** failed in both `mise run test` aggregates (artifacts `orkestrator-test-run.SqxFKk` and `orkestrator-test-run.NcXAI6` under `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/`); the unchanged owner `tests/unit/firewall-policy.test.ts` passed alone (24 pass, 0 fail). The branch does not touch this area.

## Recurrence during 0016 validation (2026-10-24)

- **Failure:** every parametrized `policy 2`/`policy 3 allowlist … chooses blocked HTTPS probe` case hit the five-second budget (5,003-5,069 ms).
- **Original command:** `mise run test:logged -- --name full-test-2 -- mise run test`
  on branch `todo-0016-slash-command-catalogue` after rebasing onto `712274379`,
  node mbp3, other worktrees validating on the host.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.CfvSIY/full-test-2.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name firewall-alone -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1` passed (21.1 s).
- **Disposition:** recurrence confirmed by the isolated pass. No assertion,
  deadline or skip was changed.
- **Again after rebasing onto `a5d78cfcd` (full-test-3):** 15 firewall cases hit
  the five-second budget (evidence
  `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.xqyQcT/full-test-3.log.gz`).
  The owning file also failed alone twice while the host load average was 33
  to 98 (3 and more cases at about 5,008 ms), then passed alone (24 passed,
  0 failed) once the one-minute load fell to 10. The branch changes no
  firewall test or `docker/` script.

## Control MCP voice main-merge validation — 2026-10-24

- **Command:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name merge-full-tests -- mise run test`; root used one isolated worker alongside other host work.
- **Root result:** 3,368 passed and 15 failed across 162 files (863.15 s execution, after 460.5 s waiting). Twelve failures were in `firewall-policy.test.ts`, including the bootstrap-range, policy-2, policy-3, probe and GitHub seed/live/cache cases at roughly five seconds. The other failures were two firewall-refresh cases and Pi runtime vendoring.
- **Complete unchanged owner rerun:** the same GNU-tool PATH with `mise run test:logged -- --name merge-0041-firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` reported 14 passed and ten failed (63.5 s); policy-3 tuples, eight probe cases and GitHub seed/live/cache still exhausted five seconds.
- **Evidence:** host temporary-directory `orkestrator-test-run.LK1I3Y/root-and-agent-support-tests.log` (retained from the interrupted aggregate) and `orkestrator-test-run.bXjwa2/merge-0041-firewall-owner.log.gz`.
- **Assessment:** the owner remains non-green, so this observation does not independently confirm a flake or its cause. Host load exceeded 100 during validation. No firewall implementation, assertion, deadline or skip changed.

- **Aggregate disposition:** the outer logged runner reached its 1800000 ms deadline after the workspace and bridge groups waited 1708.7 s and 1782.4 s for host capacity. Those groups are incomplete; the protocol-lockfile check passed. Outer evidence: `orkestrator-test-run.WDZkGn/merge-full-tests.log.gz`. Static checks and all 28 changed owner test files passed separately on the combined merge.
