# Container slash picker stays closed after a load

- **ID:** 0694
- **Status:** open
- **Date observed:** 2026-10-23
- **Test:** `live slash commands in an inactive container environment (<provider>) > a selected command completes while inactive, survives reload and restarts, and never runs twice`
- **File:** `e2e/agent-testing/slash-command-inactive.spec.ts`
- **Original commands:**
  - Run 1, Codex and Claude, host load average about 70 from other worktrees:
    `ORKESTRATOR_AGENT_TEST_PROFILE=qa-slash-0015 ORKESTRATOR_AGENT_TEST_LIVE_SLASH=1 ORKESTRATOR_AGENT_TEST_SLASH_PROVIDERS=codex,claude ORKESTRATOR_AGENT_TEST_SLASH_ENVIRONMENT=container mise run test:logged -- --name slash-inactive-container -- mise run test:agent:browser -- e2e/agent-testing/slash-command-inactive.spec.ts`
  - Run 3, the same command (`--name slash-inactive-container3`), host load
    average about 10.
- **Worker configuration:** one Playwright worker, providers run one after the
  other, in the disposable profile `qa-slash-0015` started with
  `--fixture-environments local,container`.
- **Failure:** `selectCommand` (or the narrow-viewport step) typed a command
  name, confirmed the composer held it, then waited 30 s for the
  `Slash commands` listbox. The listbox never rendered. Run 1 hit this at the
  first selection for both providers, right after `page.goto` (209 s in
  total). Run 3 hit it for Claude only, in the narrow-viewport step right after
  `page.reload()` (112 s). Codex passed every step in run 3 (193 s).
- **Evidence:**
  - The page's own `get_native_agent_projection` and
    `get_native_agent_discovery_update` responses held the typed command,
    `ready`, throughout the wait (both traces). So discovery inside the
    container worked and the rows reached the browser.
  - The run 3 screencast shows "Reconnecting to Claude… 44s" and a Stop
    button in the tab while the typed text sat in the composer; about 20 s
    later the composer controls were back, and the picker was still closed.
- **Isolated rerun:** the unchanged owning file, Claude only
  (`--name slash-inactive-container4`, `ORKESTRATOR_AGENT_TEST_SLASH_PROVIDERS=claude`),
  passed: one passed, zero skipped, exit 0, 284 s. Every step ran, including
  the narrow viewport.
- **Hypothesis (unconfirmed):** the picker reads its rows from the tab's
  merged projection. While a freshly loaded container tab is still settling
  (the "Reconnecting" state), the renderer keeps rows out of the merge or the
  menu, and it does not open for text that was typed before they arrived.
  Typing a key again would reopen it. A user who types a command straight
  after opening a container tab could see no menu.
- **Not changed:** no timeout, retry or skip was added for this. The separate
  30 s budget given to the stale-draft refusal in the same change answers a
  different, diagnosed timing (the dispatch's revalidation took 5.7 s under
  load).
- **Owner:** [0015-slash-command-qualification.md](../../../todo/cli-and-slash-commands/0015-slash-command-qualification.md).
