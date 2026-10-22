# CLI live OpenCode container start exceeds the client request timeout under load

- **ID:** 0440
- **Status:** open
- **Date observed:** 2026-10-18
- **File:** `packages/cli/scenarios/cases.ts` (`live-session`), driven by `packages/cli/scripts/run-scenarios.ts`.
- **Test:** `live-session` with `--provider opencode --environment-type container`.
- **Original command:** `mise run test:cli:scenarios -- --scenario live-session --provider opencode --environment-type container --docker-image orkestrator-v2:dev-e15f47e54b3f`, started together with the Claude and Codex container runs (three isolated backends and three containers at once) on macOS 27.0 with Docker Desktop, host load average about 38, 30 minutes after a reboot.
- **Failure:** `session start --wait` exited 4 with `transport-uncertain` after 60.2 s and printed no receipt state. 60 s is the client's `DEFAULT_REQUEST_TIMEOUT_MS` (`packages/cli/src/client/transport.ts`): the backend had not answered the `session.start` admission by then. The scenario reported `live run ended undefined (transport-uncertain)` and cleaned up (no containers left).
- **Suite result:** 1 of 1 failed (88.7 s); the Claude (60.0 s) and Codex (80.5 s) container runs beside it passed.
- **Owning-file rerun:** the same command alone passed unchanged (98.5 s, file assertion and follow-up turn included).
- **Assessment:** load-dependent. The client is truthful (`transport-uncertain` with a `run get --request-id` recovery, never a false success), but the admission answer waits on work that can take longer than the client's request budget. Follow-up scored in [0014-cli-qualification.md](../../todo/cli-and-slash-commands/0014-cli-qualification.md) (Code item 4). No implementation, assertion, timeout or skip changed.
