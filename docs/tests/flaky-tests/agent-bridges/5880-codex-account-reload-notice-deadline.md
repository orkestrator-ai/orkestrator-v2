# Codex stored-login reload misses its 500 ms notice deadline in the aggregate

- **ID:** 5880
- **Status:** resolved
- **Date observed:** 2026-11-05
- **Test/file:** `stored account reload admission > clears a refused API-key notice after external credential replacement via stored-login with apiKey`, bridges/codex-bridge/src/app-server-runtime-account-reload.test.ts:91.
- **Original command:** `mise run test` during review preparation of the E17 dead code branch (`f0ec7cd14`), Linux, Bun 1.4.4, group `codex-bridge:test:bridge`, `bun test v1.4.4 1x PARALLEL`. The bridges group ran for 1,226.9 s.
- **Failure:** `error: external replacement did not clear refused notice` from `waitUntil` (`app-server-runtime-test-harness.ts:57`, default 500 ms), with the test failing at 511.74 ms.
- **Isolated rerun:** the owning file alone passed once through `test:logged` at `f0ec7cd14` (0.9 s). On the same branch rebased onto `af2e566e5` it passed eight times out of eight in sequence and sixteen times out of sixteen at once, with a host load average of about 50 (11 pass, 0 fail in the run whose counts were read).
- **Hypothesis:** this variant clears the notice only after the engine restarts its child to reload the stored login (`h.children` reaches 2), so it has more work to finish inside the shared 500 ms wall-clock wait than the other variants. The cause is unconfirmed: the parallel stress above did not reproduce the failure.
- **Attribution:** the failure triage marked this related because the test imports `packages/protocol/src/log-vocabulary/bridge.ts`, which that branch changed by removing `raw-log.write-failed`. The test does not use that event.
- **Not measured:** host load and child restart time during the original run.

### Resolution — 2026-11-06

**Root cause (test).** The refused turn makes the engine snapshot the refused
credential's fingerprint with an asynchronous file read
(`refusedLoginFingerprint ??= readStoredLoginFingerprint(codexHome)`), and
`readAccount()` does not wait for the work that consumes it. The test
overwrote `auth.json` with the replacement login right after its own
`readAccount()`/`drain()`. When the fingerprint read was still pending (a busy
file-I/O thread pool), it read the *replacement* file, so the refused and the
stored fingerprints matched, `requestAccountReloadFromStoredLogin` returned
without asking for a reload, the notice never cleared, and the 500 ms wait
expired; `stop()` then finished at once (511 ms total, as observed). Only the
two `stored-login` variants depend on that fingerprint, which is why only they
failed.

**Fix.** `bridges/codex-bridge/src/app-server-runtime-account-reload.test.ts`
awaits the engine's pending refused-credential read (asserting it exists)
before writing the replacement credential, so the test models a replacement
that happens after the refusal was recorded. No assertion or deadline changed.

**Verification.**

- Reproduced before the fix: a temporary 50 ms delay at the start of
  `readStoredLoginFingerprint` failed both `stored-login` variants with
  `external replacement did not clear refused notice` at 503–507 ms
  (`mise run test:logged -- --name br-5880-repro2 -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/app-server-runtime-account-reload.test.ts`, exit 1).
- With the fix and the same delay: passed (exit 0). Delay removed afterwards.
- Fifteen fresh-process runs of the owner passed
  (`mise run test:logged -- --name br-5880-loop -- bash -c 'cd bridges/codex-bridge && for i in $(seq 1 15); do bun test --preload ../../tests/setup-node.ts ./src/app-server-runtime-account-reload.test.ts …; done'`, exit 0).
  The file is not `--rerun-each` safe (the unchanged file fails 6 of 22 at
  `--rerun-each=2`: its shared `CODEX_HOME` keeps the previous run's login), so
  repetitions use fresh processes.

**Ruled out along the way.** The harness's fake children have plausible PIDs
(`2000 + n`), and the supervisor's termination signals `-pid`, the process
*group*. If a real group with that ID exists the signal succeeds, the fake child
never exits, and the restart waits the 1 s SIGKILL grace. Simulating that gave
the same message but a ~1,040 ms duration, not the observed 511 ms, so it is not
this case's cause. It is a host-safety hazard of its own and was reported to the
coordinator, not fixed here.
