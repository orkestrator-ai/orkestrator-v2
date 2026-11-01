# CLI live OpenCode container start exceeds the client request timeout under load

- **ID:** 0440
- **Status:** resolved
- **Resolved:** 2026-11-01, by todo 0014 tasks 2 and 3 (re-run under load through the `lost-response` scenario)
- **Date observed:** 2026-10-18
- **File:** `packages/cli/scenarios/cases.ts` (`live-session`), driven by `packages/cli/scripts/run-scenarios.ts`.
- **Test:** `live-session` with `--provider opencode --environment-type container`.
- **Original command:** `mise run test:cli:scenarios -- --scenario live-session --provider opencode --environment-type container --docker-image orkestrator-v2:dev-e15f47e54b3f`, started together with the Claude and Codex container runs (three isolated backends and three containers at once) on macOS 27.0 with Docker Desktop, host load average about 38, 30 minutes after a reboot.
- **Failure:** `session start --wait` exited 4 with `transport-uncertain` after 60.2 s and printed no receipt state. 60 s is the client's `DEFAULT_REQUEST_TIMEOUT_MS` (`packages/cli/src/client/transport.ts`): the backend had not answered the `session.start` admission by then. The scenario reported `live run ended undefined (transport-uncertain)` and cleaned up (no containers left).
- **Suite result:** 1 of 1 failed (88.7 s); the Claude (60.0 s) and Codex (80.5 s) container runs beside it passed.
- **Owning-file rerun:** the same command alone passed unchanged (98.5 s, file assertion and follow-up turn included).
- **Assessment:** load-dependent. The client is truthful (`transport-uncertain` with a `run get --request-id` recovery, never a false success), but the admission answer waits on work that can take longer than the client's request budget. Follow-up scored in [0014-cli-qualification.md](../../../todo/cli-and-slash-commands/0014-cli-qualification.md) (Code item 4). No implementation, assertion, timeout or skip changed.
- **Follow-up (2026-10-22):** `session start --wait` and `session prompt --wait` now look a lost submission up by its saved request key and keep waiting within `--timeout` (`submitForWait` in `packages/cli/src/client/commands/common.ts`; covered by `packages/cli/tests/client-waits.test.ts`). With that, this failure should become a pass with a recovery warning. Not yet re-run live under load, so the case stays open.

## Resolution — 2026-11-01

- **Re-run under load.** The new credential-free `lost-response` scenario
  (`packages/cli/scenarios/cases.ts`) puts a loopback proxy
  (`packages/cli/scenarios/lossy-proxy.ts`) in front of the real packaged
  backend. It answers `environment start` with a non-JSON 504 at once and
  delivers the submission only after the client's first lookup by request key
  has come back `not-found`: the ordering behind this case, an admission
  slower than the client's request budget. It also loses an `exec` answer after
  admission. Both go through `submitForWait`, the function `session start
  --wait` uses. On arktech-mini (macOS, Docker Desktop 29.9.2, image
  `orkestrator-v2:dev-cc80206a42eb`), with about a dozen other builds running:
  - Local: three concurrent `lost-response` runs beside the full local matrix,
    load average 42.8 to 49.3: 4/4 `lost-response` and 10/10 matrix pass.
  - Container: three concurrent `lost-response` runs beside the full container
    matrix (four backends and their containers at once), load average 44.2 to
    104.8: 4/4 `lost-response` and 8/8 matrix pass. The recovered `start
    --wait ready` took 12.4 to 16.6 s, and the recovered `exec --wait
    --exit-code` returned the child's own exit 3 in 0.4 to 0.6 s. There were
    no cleanup errors and no containers were left.
  - Negative control: the same scenario on the CLI built before todo 0014 task
    3 failed at `[start, response lost] expected exit 0, got 4
    (transport-uncertain)`, this case's symptom.
- **Not re-run:** a live provider `session start --wait` with three live
  container runs, as in the original command. Billed provider turns were out
  of scope for this run, and a live run cannot force the lost response anyway
  (it may pass without exercising recovery). `session start` recovery shares
  the function proved above and keeps its unit coverage in
  `packages/cli/tests/client-waits.test.ts`. Reopen this case if a live run
  again exits 4 with `transport-uncertain` from a `--wait` command.

