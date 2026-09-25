# Agent mail rehydrate click intercepted by a tooltip

- **ID:** 0162
- **Status:** open
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
