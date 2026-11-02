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

- **Recurrence 2026-10-24** (0043 known-limitations branch, node mbp3, `mise run test` via `test:logged`): eleven to fourteen `container firewall policy` cases hit the 5 s budget in the root group in both full runs that day; the owner passed alone with firewall-refresh (64.4 s).

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


## Runtime-state ownership main merge — 2026-10-24

`mise run test:logged -- --name merge-suite -- mise run test` used the default 4/1/2/1 workspace/root/bridge/protocol plan alongside browser suites and other validating worktrees. Root/support ran with one worker after waiting 953.5 s: 3,369 passed, twelve failed and one error across 3,381 tests in 161 files (609.28 s execution). Evidence: host temporary artifact `orkestrator-test-run.BJKk4l/root-and-agent-support-tests.log` (compressed at aggregate completion). Nine firewall-policy cases exceeded five seconds (5004–5221 ms), including tuple application, seven parametrized probe cases and GitHub range fallback. The complete unchanged owner also failed: `mise run test:logged -- --name merge-firewall-policy-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` reported twenty passes and four failures in 51.1 s logged (stored-domain bootstrap, policy 2 host ports, and two example.org/example.com probe cases). Evidence: host temporary artifact `orkestrator-test-run.gK2ocG/merge-firewall-policy-owner.log.gz`. This host-condition recurrence does not establish a flake; the branch changes neither this owner nor its Docker scripts. No assertion, deadline or skip changed.


## Agent accounts and sign-in (0003) validation — 2026-10-24

Recurred in the non-iOS aggregate on node mbp3 (thirteen `container firewall policy` cases at ~5,003 ms); the unchanged owner passed alone (24 passed). Details in [0740](../aggregate-validation-runs/0740-agent-accounts-sign-in-0003-validation.md). No implementation, assertion, timeout or skip changed.

## Agent accounts main merge — 2026-10-24

The broad run and complete unchanged owner both retained five-second failures. This is not newly classified as a flake. Exact commands, counts and artifacts are in [0740](../aggregate-validation-runs/0740-agent-accounts-sign-in-0003-validation.md#merge-through-main-8290f2ca9--2026-10-24). No assertion, deadline or skip changed.

## Control MCP voice merge through `95c9cb46a` — 2026-10-24

- **Parents:** `3f04356fd947464d652e31709ac3c3e8a7c45823` and `95c9cb46ae0a2b12fbc10ff73fa7c0614b254a0d`; base `0014505caeed69395b3cc996dd541fcc6df12c23`.
- **Aggregate command:** testing-guide GNU-tool PATH with `ORKESTRATOR_TEST_AREA_BASE=0014505caeed69395b3cc996dd541fcc6df12c23 mise run test:logged -- --name merge95-tests -- mise run test`. Root used one isolated worker: 3,380 passed and two failed across 161 files (241.63 s execution). `policy 2 narrows host access to named ports and records what it applied` timed out at 5006.33 ms; `policy 3 allowlist  EXAMPLE.COM:443/tcp  chooses blocked HTTPS probe example.net` at 5007.44 ms.
- **Complete unchanged owner:** the same GNU-tool PATH with `mise run test:logged -- --name merge95-firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` reported 21 passed and three failed (39.0 s). Policy 2 host ports (5004.52 ms), policy 3 tuples (5020.40 ms), and the policy 2 example.org/example.com probe (5007.94 ms) exhausted five seconds. The aggregate's upper-case probe case passed on this rerun.
- **Evidence:** host temporary artifacts `orkestrator-test-run.N9YUtx/root-and-agent-support-tests.log.gz` and `orkestrator-test-run.YEJsXs/merge95-firewall-owner.log.gz`.
- **Assessment:** this complete owner remains non-green; no new flake classification or cause is established. Neither `tests/unit/firewall-policy.test.ts` nor `docker/firewall-domains.sh` differs from the merge base. No implementation, assertion, deadline or skip changed for this observation.

- **Completed aggregate:** workspace (web, backend, desktop, web-public, CLI, protocol, toolchain), bridge and protocol-lockfile groups passed; only the two root firewall timeouts remained. The outer command exited 1 after 638.3 s. Full evidence: `orkestrator-test-run.lyZaoe/merge95-tests.log.gz`; group evidence is under `orkestrator-test-run.N9YUtx/`. Static checks and the flake-index contract test passed on the merged result.

## Control MCP voice merge through `ad206c966` — 2026-10-24

- **Parents:** `8407691c4ea2227c1b27c9c8a4fa88b5f104d49c` and `ad206c9662e4306b368e2edea1155312a5b8533f`; base `95c9cb46ae0a2b12fbc10ff73fa7c0614b254a0d`.
- **Aggregate command:** testing-guide GNU-tool PATH with `ORKESTRATOR_TEST_AREA_BASE=95c9cb46ae0a2b12fbc10ff73fa7c0614b254a0d mise run test:logged -- --name mergead-tests -- mise run test`. One isolated root worker reported 3,381 passed and one failed across 161 files (161.70 s execution): `policy 3 allowlist example.com:80 chooses blocked HTTPS probe example.com` exhausted five seconds at 5007.20 ms. The isolated design-canvas check also ran on this host.
- **Complete unchanged owner:** the same GNU-tool PATH with `mise run test:logged -- --name mergead-firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` reported 23 passed and one failed (22.9 s). The aggregate's probe case passed, but `policy 2 narrows host access to named ports and records what it applied` timed out at 5003.54 ms.
- **Evidence:** host temporary-directory `orkestrator-test-run.RvI1ez/root-and-agent-support-tests.log.gz` and `orkestrator-test-run.DP57c6/mergead-firewall-owner.log.gz`.
- **Assessment:** the complete owner remains non-green, so this observation does not independently establish a new flake classification or cause. Neither `tests/unit/firewall-policy.test.ts` nor `docker/firewall-domains.sh` differs from the merge base; no implementation, assertion, deadline or skip changed for this observation.

- **Completed aggregate:** workspace (web, backend, desktop, web-public, CLI, protocol, toolchain), bridge and protocol-lockfile groups passed; only the root probe timeout remained. The logged command exited 1 after 496.1 s; complete evidence is `orkestrator-test-run.3F8HQ0/mergead-tests.log.gz`. Static checks passed, and the credential-free isolated design suite passed both cases (33.8 s); profile `qa-browser-6b014289-52b` was stopped and reset.

## Recurrence during 0050 item 3 validation (2026-10-26)

- **Failure:** `container firewall policy > the root entrypoint runs the firewall itself and records the outcome per mode` hit the five-second budget (5,005.83 ms, `exitCode` `null` at `tests/unit/firewall-policy.test.ts:822`).
- **Original command:** `env -u PORT mise run test` on branch `todo-0050-transcript-history-9f95ba1af36f` (`930189337` plus the change), node mbp3, standard group reservations, other workspaces loading the host (load average 20 to 159 during the preceding hour).
- **Suite counts:** root and agent-support group 3,469 passed, 3 failed across 166 files (328.95 s); the other failures were 0259 and a malformed 0887 case header fixed in the same change.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.ZrjtAX`.
- **Isolated rerun:** `env -u PORT mise run test:logged -- --name firewall-policy -- bun test ./tests/unit/firewall-policy.test.ts` passed (43.0 s).
- **Disposition:** recurrence confirmed by the isolated pass; the branch touches neither the test nor `docker/`. No assertion, deadline or skip changed.
- **Again in a root-only rerun:** `env -u PORT mise run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures` failed the same case (5,004.69 ms; 3,369 passed, 1 failed across 156 files, 104.2 s; evidence `orkestrator-test-run.Jwvudr`). The owner had passed alone minutes before.

## Pi ChatGPT fallback main merge — 2026-10-26

- **Parents:** `8da8c9cc87779451589b106c228e425ef742aa47` and `a51045a4a954d49ae388c0f22535e9b28274279f`.
- **Aggregate command:** `mise run test:logged -- --name merge-tests -- mise run test` (macOS, Bun 1.4.4). Workspace/root/bridge/protocol groups reserved 4/1/2/1 worker slots, with one isolated root worker. Root reported 3,468 passed and four failed across 166 files in 234.43 s.
- **Failures:** policy-3 probes for `example.org,example.com`, `example.com:443`, and `example.com,example.net:443,example.org:443/tcp` exhausted five seconds at 5007.80, 5003.33, and 5004.88 ms. `the root entrypoint runs the firewall itself and records the outcome per mode` also timed out at 5002.69 ms. All received a `null` subprocess exit code.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-firewall-isolated -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` reported 33 passed and one failed in 53.56 s. The three probe cases passed, but the root-entrypoint case still timed out at 5002.22 ms.
- **Evidence:** host temporary directory `orkestrator-test-run.2B615e/root-and-agent-support-tests.log.gz`; isolated evidence `orkestrator-test-run.mprNjR/merge-firewall-isolated.log.gz`; outer aggregate `orkestrator-test-run.Lf5a1a/merge-tests.log.gz`.
- **Assessment:** the complete owner remains non-green, so this observation does not independently establish a new flake classification or cause. The test and `docker/init-firewall.sh`, `docker/firewall-domains.sh`, and `docker/network-policy-entrypoint.sh` match `origin/main`. No implementation, assertion, timeout or skip changed.

The complete aggregate exited 1 after 568.8 s: workspace and protocol-lockfile
groups passed; root and bridges failed only the four firewall timeouts and
one Cursor hook timeout described above. Backend reported 11,749 passed and
zero failed; Pi reported 649 passed and zero failed. Formatting, lint,
typechecking, and the flake-index contract check passed.

## Shared Codex state review fixes — 2026-10-26

`mise run test:logged -- --name repository-tests -- mise run test` on `74841142b` repeated `the root entrypoint runs the firewall itself and records the outcome per mode`: `exitCode` was `null` at the five-second deadline (5005.35 ms). The complete unchanged owner passed alone in 51.5 s: `mise run test:logged -- --name codex-auth-firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures`. Root and workspace groups used one and four reserved worker slots respectively, alongside two bridge slots and one protocol slot. The generic shell-test deadline remains the observed boundary; no new cause is established. Aggregate evidence and results are in [0995](../aggregate-validation-runs/0995-agent-accounts-sign-in-0003-qualification.md).

On 2026-11-02, the shared-logger bridge migration saw `policy 2 allowlist example.org,example.com chooses blocked HTTPS probe example.net`, and alone two other cases, exceed the 5 s timeout at load average 55. With `--timeout=60000` the owner passed (34 pass, 0 fail), so these were timing. The change touches nothing under `docker/`.
