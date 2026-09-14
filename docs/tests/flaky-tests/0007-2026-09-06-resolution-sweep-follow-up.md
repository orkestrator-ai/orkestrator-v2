# 2026-09-06 resolution sweep follow-up

- **ID:** 0007
- **Status:** open
This sweep resolves only entries with a concrete owner or shared-harness fix.
It does not close incidents merely because they passed once or because they
may share aggregate contention. Three independent reviews of the same overlay
still found failures in both the root and bridge groups, so those observations
remain open below even when a focused rerun passed.

The aggregate ceiling is now eight. That leaves four root workers on every
host at or above eight logical cores while reserving two workers each for the
bridge and active workspace groups. Individual owners retain narrower fixes
where an ordering, isolation, or outer-budget cause was identified.

| Entries | Root cause and fix |
| --- | --- |
| Project creation, Files panel, Electron server/rename fixtures, Codex delayed retry | Real Git/Docker/bridge work or a descheduled renderer could exhaust Bun's generic five-second outer budget. The affected owners/cases now use the repository's 30-second asynchronous budget. |
| ACP process reaping and large transcript trimming | These two expensive state waits now use the harness's 15-second process/startup budget rather than its five-second ordinary-state default. Other unattributed ACP entries remain open. |
| ActionBar run shortcuts | Both duplicate cases used a one-shot config read even though mount can legitimately re-read, then dispatched before the listener effect for the enabled Run state was guaranteed to commit. They now return the run config for every read, flush that effect, and await the resulting backend job. |
| JSON file cache | Parse instrumentation was process-global. It now counts per file path so unrelated readers cannot change the cold-read assertion. |
| Terminal setup-tab replacement and Multi Review activity | Tests observed one derived field and synchronously asserted a separately committed snapshot. Each wait now requires the complete authoritative state it subsequently asserts. |
| Skills clipboard | Success, failure, selection reset, and exact timer expiry are covered independently; fake timers keep the 1.5-second expiry check deterministic. |
| Standalone lifecycle | The backend printed its ready contract before installing lifecycle observers. It now installs signal handlers and parent-death detection first, with the original parent captured before asynchronous startup. |
| Direct-container credentials | Changing `HOME` was insufficient because Bun can cache `os.homedir()` and inherited Claude config overrides bypass it. The fake-Docker fixture now pins and restores every explicit host credential path. |
| Create Environment attachment encoding and Codex circular output | These owners perform CPU- and allocation-heavy exceptional-path work and now use explicit 30-second outer budgets. Unattributed worker crashes remain open. |

Earlier verification on Bun 1.4.0 included focused passes and one complete
four-group pass, but three later runs of that same overlay failed with 8, 11,
and 12 failures. Those later observations superseded the one-pass closure
claim. After the follow-up fixes, focused validation passed and a fresh
`bun run test` passed all four groups in 70.4 seconds (root/agent-support in
69.2 seconds and bridges in 70.4 seconds). Unattributed historical incidents
remain open because a green run alone does not establish their cause or fix.

New open observations from the later aggregate runs:

- `tests/unit/pi-bridge-vendor.test.ts` and
  `tests/unit/test-diagnostic-bounds.test.ts` exceeded their 30-second budgets.
- `tests/unit/components/CreateEnvironmentDialog.test.tsx` exceeded five
  seconds in large attachment cases and had one follow-on submission failure.
- `bridges/codex-bridge/src/sessions/turn-accumulator.test.ts` and
  `bridges/codex-bridge/src/subagent-transcript.test.ts` exceeded five seconds;
  the three files passed 163/163 in a focused rerun, confirming aggregate-only
  contention.
- `bridges/acp-bridge/src/acp-http.test.ts` and
  `bridges/acp-bridge/src/acp-transcript.test.ts` exceeded ordinary state waits.
- One run also observed isolated `useVirtuosoScrollState` and Codex lifecycle
  assertion failures. Neither has an established cause, so both remain open.
