# Live coordinator async scenario misses the busy, pending and queued overlap

- **ID:** 0920
- **Status:** open
- **Date observed:** 2026-10-25
- **Test:** `live coordinator > delegation on codex is asynchronous: async launch, queued prompt before mail, one carrier, one silent-worker notice, repeated reads refused`, check `queued-before-mail`.
- **File:** `e2e/agent-testing/coordinator-live.spec.ts` (`asyncCase`), judged by `evaluateAsyncScenario` in `apps/desktop/scripts/dev/coordinator-live-delegation.ts`.
- **Original command:** `mise run test:logged -- --name coordinator-live-others -- mise run test:agent:coordinator --credential-source codex --credential-source opencode --credential-source pi --credential-source cursor --credential-source grok --scenario async --scenario status`, on macOS with Codex 0.162.1, while other worktrees ran their suites (load average about 50).
- **Failure:** `queued-before-mail: queued accepted true; busy with the report pending and the prompt queued false; queued row 3, report carrier row 4`. The queued prompt did run before the report, but no harness read (every two seconds) saw the busy turn, the pending report and the queued prompt at once, so the overlap the check exists for was not proven. Every other async check passed, the tile checks included.
- **Evidence:** run `qa-coordinator-2026-10-25T16-31-13-066Z`, profile `qa-coordinator-codex-8c649490`, `coordinator/codex-async.json` and its Playwright trace (local, ignored).
- **Isolated rerun:** `mise run test:agent:coordinator --credential-source codex --scenario async --scenario status` (run `qa-coordinator-2026-10-25T17-24-05-562Z`) passed every check, `queued-before-mail` included ("busy with the report pending and the prompt queued true").
- **Hypothesis:** on a loaded host the busy turn's three reads, or the reporter's turn end after the finish gate, can complete between two harness reads, so the three conditions are never sampled together. Codex passed the same check on 2026-10-18 and Claude, OpenCode, Cursor and Pi passed it on 2026-10-25. Nothing in the check or its timing was changed. If it recurs, lengthen the busy turn (more sequential reads) rather than loosen the check.
