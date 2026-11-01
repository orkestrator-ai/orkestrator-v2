# Agent mail rehydrate click intercepted by a tooltip

- **ID:** 0162
- **Status:** resolved
- **Date observed:** 2026-09-25
- **Test:** `agent mail rehydrates after an inactive recipient is opened and the page reloads`
- **File:** `e2e/agent-testing/browser-gateway.spec.ts:186` (click at `:274`)
- **Original command:** `mise run test:agent:browser:isolated` (one-shot
  disposable `qa-browser-*` profile, default Playwright workers).
- **Failure:** the click retried until timeout because a tooltip
  (`div.fixed.z-50 … mail-sender-<id>`) intercepted pointer events over the
  target element.
- **Suite counts:** 10 tests; 5 passed, 1 failed, 4 skipped (Docker and
  live-agent cases) in 2.7 min.
- **Reruns:** the same one-shot command passed immediately before this run
  (58.1 s, exit 0). During web-annotation validation on 2026-09-24 the test
  also failed when run alone against a live `dev:test` profile with the same
  tooltip interception.
- **Context:** observed on branch work for web page annotations, which does
  not change this spec, agent mail or its tooltip.
- **Hypothesis:** a hover tooltip opened by an earlier pointer move stays over
  the click target; the click then depends on whether the tooltip has closed.
  Dismissing the tooltip (move the pointer away or press Escape) before the
  click, or clicking by accessible role on an element the tooltip cannot cover,
  should make it deterministic.

## Agent mail review repair — 2026-11-01

The sender hover tooltip again intercepted the recipient click in the focused
rerun (`browser-gateway.spec.ts:1729`). The existing `dismissSidebarTooltip`
helper now runs before each sender/recipient environment switch in this case.
The helper moves the pointer away and dismisses only a visible tooltip from
the project toggle, so it cannot accidentally stop an agent turn. Assertions,
deadlines and delivery behavior are unchanged. The mail button locator also
accepts its legitimate attention-count suffix.

The repaired complete mail case passed twice with one worker, in 31.9 s and
25.9 s:

```sh
ORKESTRATOR_AGENT_TEST_PROFILE=agent-mail-repair-r1 ORKESTRATOR_AGENT_TEST_RUN_ID=agent-mail-repair-r1-mail-final mise run test:logged -- --name mail-browser-rehydrate -- mise run test:agent:browser -- e2e/agent-testing/browser-gateway.spec.ts --grep 'agent mail rehydrates'
```

An intervening repetition failed at project expansion after reload, not at
the tooltip, while the broader profile suite was also running. It is not
counted as a passing stress result. The final pass ran after that suite ended.
Each passing command reported one passed test. The broad profile run reported
40 passed, 95 skipped, five failed (1244.7 s), including the original badge-free
locator failure before this repair.

Evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.j6UlIV/mail-browser-owner.log.gz`
(the reproduced tooltip interception),
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.FgPPRd/mail-browser-rehydrate.log.gz`
(the distinct expansion failure), and
`output/agent-testing/agent-mail-repair-r1-mail-final/` (the final isolated run).
The disposable profile was stopped and reset afterwards. The separate capped
file-tree failure in the same owner remains outside this repair.
