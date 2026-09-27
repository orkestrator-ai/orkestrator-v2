# First real-stack page load gets 502 for `/@vite/client`

- **ID:** 0168
- **Status:** environmental
- **Date observed:** 2026-09-27
- **Test:** `real browser gateway exercises an authoritative local environment`
  (`e2e/agent-testing/browser-gateway.spec.ts`), the first case of the run
- **Original command:** `mise run test:agent:browser:isolated` (logged as
  `agent-browser-iso`) on branch `implement-efficiency-improvements-7f0993836777-r1`,
  one disposable profile, the machine otherwise idle
- **Failure:** the page stayed blank and
  `getByText(<fixture name>).first()` was not visible within 30 s. The trace
  shows `[vite] connecting…`/`connected`, then a single
  `502 (Bad Gateway)` for `http://127.0.0.1:<gateway>/@vite/client` through the
  gateway proxy; the renderer never started. The other 11 cases of the same run
  passed.
- **Rerun:** the same one-shot command immediately afterwards: 12 passed,
  7 skipped, exit 0.

## Current assessment

The first document load of a fresh profile reached the gateway before the Vite
dev server answered its client module, the same dev-server module-fetch family
as [0167](0167-dev-renderer-entry-dynamic-import-fetch.md). A production build
serves a bundle and has no such fetch. Keep this environmental unless a first
load fails for a reason other than a dev-server module response.
