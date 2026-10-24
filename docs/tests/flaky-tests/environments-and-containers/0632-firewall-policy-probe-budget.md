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
  headroom. The same class as [0159](../design-canvas-and-artifacts/0159-artifact-sanitizer-aggregate-timeout.md),
  where real subprocess work outgrew the generic budget.
- **Notes:** unrelated to the branch it was observed on (the settings Usage
  tab); nothing in `tests/unit/firewall-policy.test.ts`,
  `docker/firewall-domains.sh` or the network allowlist changed there. The
  likely fix is an explicit outer budget for these cases, as 0159 took.
- **Recurrence (2026-10-24, node mbp3):** the todo-0050 branch's aggregate failed seven firewall cases at the five-second budget. Rerun alone at load average 16 to 35, the owner still failed (10 of 24 failed, then 10 of 24 again). A worktree of `main` at `71227437`, run straight afterwards under the same load, failed the same way (8 of 24). `example.com`, `.net` and `.org` resolved promptly through `dscacheutil`. So host contention alone reproduces it here; the branch touches neither `docker/` nor the test.

- **2026-10-24 (node mbp3, macOS, Apple Silicon):** `mise run test` on the
  0011 runtime-state branch failed five of these cases at 5.0 s. Unlike the
  original observation, the owner also failed alone here:
  `mise run test:logged -- --name firewall -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1`
  → 12 pass, 12 fail (67.4 s), and the same command in a clean `origin/main`
  (`8454d18b`) worktree → 11 pass, 13 fail (70.1 s). On this host it is a
  host condition (slow DNS in the shell harness), not a branch regression and
  not a flake by the register's definition; the branch touches neither the
  test nor `docker/`.

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


## Runtime-state ownership main merge — 2026-10-24

`mise run test:logged -- --name merge-suite -- mise run test` used the default 4/1/2/1 workspace/root/bridge/protocol plan alongside browser suites and other validating worktrees. Root/support ran with one worker after waiting 953.5 s: 3,369 passed, twelve failed and one error across 3,381 tests in 161 files (609.28 s execution). Evidence: host temporary artifact `orkestrator-test-run.BJKk4l/root-and-agent-support-tests.log` (compressed at aggregate completion). Nine firewall-policy cases exceeded five seconds (5004–5221 ms), including tuple application, seven parametrized probe cases and GitHub range fallback. The complete unchanged owner also failed: `mise run test:logged -- --name merge-firewall-policy-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` reported twenty passes and four failures in 51.1 s logged (stored-domain bootstrap, policy 2 host ports, and two example.org/example.com probe cases). Evidence: host temporary artifact `orkestrator-test-run.gK2ocG/merge-firewall-policy-owner.log.gz`. This host-condition recurrence does not establish a flake; the branch changes neither this owner nor its Docker scripts. No assertion, deadline or skip changed.


## Agent accounts and sign-in (0003) validation — 2026-10-24

Recurred in the non-iOS aggregate on node mbp3 (thirteen `container firewall policy` cases at ~5,003 ms); the unchanged owner passed alone (24 passed). Details in [0740](../aggregate-validation-runs/0740-agent-accounts-sign-in-0003-validation.md). No implementation, assertion, timeout or skip changed.

## Agent accounts main merge — 2026-10-24

The broad run and complete unchanged owner both retained five-second failures. This is not newly classified as a flake. Exact commands, counts and artifacts are in [0740](../aggregate-validation-runs/0740-agent-accounts-sign-in-0003-validation.md#merge-through-main-8290f2ca9--2026-10-24). No assertion, deadline or skip changed.
