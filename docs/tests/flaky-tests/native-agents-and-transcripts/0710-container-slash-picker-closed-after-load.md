# Container slash picker stays closed after a load

- **ID:** 0710
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

## After the review fix (2026-10-23)

The Multi Review fix (`35dba0957`) stopped a click inside the composer from
dismissing the picker and made a dismissal end with its token. That is a real
defect, but it is not this case: profile `qa-slash-0015r`, host load average
60 to 72 from other worktrees, container variant, Codex and Claude:

- `slash-review-container`: both failed at the new first picker step, which
  waited Playwright's 5 s default. The page held `/slashq-run` in its last
  discovery and projection payloads (catalogue `stale`, 59 rows) when it typed.
- `slash-review-container2` (that step given the 30 s used by every other
  picker wait): the picker appeared after 14 s (Codex) and 28 s (Claude), and
  the inactive-completion step passed. Both then failed at "returning shows
  the result": after an explicit refresh had answered `reloaded` and the
  backend projection listed `/slashq-added`, the page's
  `get_native_agent_discovery_update` reads each took 4 to 12 s and kept
  returning the pre-refresh `stale` list for about a minute; the first read
  with the new row came back at 11:39:59, after the 5 s wait had expired.
- The same file passed every step on a host worktree in the same profile
  (`slash-review-local`, both providers), and in containers at a load average
  near 10 (Codex 193 s, Claude 284 s and 209 s earlier the same day).

Narrowed hypothesis: under host load, the progressive discovery read for a
container session is slow and serves its previous snapshot well after the
backend's own catalogue has changed, so the tab's picker lags the backend.
Next step: time `get_native_agent_discovery_update` for a container session
against a local one at the same load, and check whether an explicit refresh
invalidates the progressive discovery snapshot as well as the catalogue cache.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** #1215 (0014505ca) and #1223 (d723429d5) changed the slash catalogue on 2026-10-24, but nobody has rerun the container variant under load since, so a fix is not shown.
- **Next step:** as recorded above: time `get_native_agent_discovery_update` for a container session against a local one at the same load, then rerun the container variant.
