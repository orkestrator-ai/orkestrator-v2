# External preview forward refuses a restricted-port fetch as cross-origin

- **ID:** 3570
- **Status:** resolved
- **Date observed:** 2026-11-03
- **Test:** `PreviewExternalForward > browser-restricted service ports select a usable HTTP port`
- **File:** `apps/desktop/tests/preview-external-forward.test.ts:306`
- **Original command:** from `apps/desktop`, `mise run test:logged -- --name desktop-preview-tests -- bun test tests/preview-external-forward.test.ts tests/preview-transport-manager.test.ts tests/preview-tunnel-client.test.ts --parallel=2 --only-failures`. This is a focused invocation: it omits the package's own `--preload ../../tests/setup-node.ts`.
- **Worker configuration:** Bun 1.4.4 on macOS arm64 (arktech-mini, about ten builds running at once), two parallel workers, three files.
- **Failure:** in 37.72 ms, `NetworkError: Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at "http://localhost:52086/"`, preceded by `OPTIONS http://localhost:52086/ 403 (Forbidden)`. The stack runs through happy-dom's `fetch` (`happy-dom@21.0.4/lib/fetch/Fetch.js:185`), not Bun's. Counts: 50 pass, 1 fail, 51 tests across 3 files in 4.87 s.
- **Isolated rerun:** `bun test tests/preview-external-forward.test.ts` from `apps/desktop` passed twice (25 pass each). The same three-file `--parallel=2` command then passed eight more times, and three times with `--preload ../../tests/setup-node.ts` added.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.ClfFE6/desktop-preview-tests.log.gz`.
- **Hypothesis:** the test calls the global `fetch`. In that run the global was happy-dom's (the root `bunfig.toml` preloads `tests/register-dom.ts`), which sends a CORS preflight; the external forward refuses cross-site reads, so the preflight gets 403. Why the global was happy-dom's in only one run of ten was not established. Observed on branch `preview-reconnect-metrics-ca90ec0df07b-r1` (based on `7b48c23fb`), whose changes do not touch the external forward's listen, CORS or Host checks; it adds only a first-byte observation after `forwardPreviewRequest` returns. Not yet tried on `main`.

### Resolution — 2026-11-06

**Root cause.** The test depended on whichever global `fetch` the run had.
From `apps/desktop` without the package preload, the root `bunfig.toml`
preloads happy-dom, whose `fetch` applies browser CORS rules and may send a
preflight; the external forward correctly refuses cross-site reads, so that
fetch fails. The forward's behaviour is not what the test checks: it checks
that a browser-restricted preferred port (6000, 6667, 10080) is not chosen and
that the chosen port serves.

**Fix.** `apps/desktop/tests/preview-external-forward.test.ts` reads the
forward with the file's Node `http` helper (`get`) instead of the global
`fetch`. Same assertions.

**Not reproduced** (the original rate was 1 in 10 focused runs on macOS).

**Verification.**
- `NODE_ENV=test mise run test:logged -- --name pef-fix-rerun -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./tests/preview-external-forward.test.ts --rerun-each=20`: PASS.
- The original focused invocation without the preload, `bun test --cwd apps/desktop ./tests/preview-external-forward.test.ts ./tests/preview-transport-manager.test.ts ./tests/preview-tunnel-client.test.ts --parallel=2 --rerun-each=5` (under `test:logged`): PASS.
