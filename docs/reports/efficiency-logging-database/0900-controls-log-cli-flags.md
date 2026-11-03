# Command-line flags for log levels

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Decide on `--log-level` and `--log-category`**: add them, or settle on the environment variable. Status: open.

### 1. Decide on `--log-level` and `--log-category`

**Problem.** The report's control table lists both flags for headless hosts, and neither exists.

**Context.** The environment half landed under another name: `ORKESTRATOR_LOG_LEVEL` takes `warn`, `updater=debug` or `warn,updater=debug,desktop.dialog=trace` (`docs/architecture/logging.md:528-534`), which is the syntax the report proposed for `ORKESTRATOR_LOG`. A bridge the backend launches inherits it.

**Investigation.** `apps/backend/src/server-flags.ts` has no log flag, and `options.test.ts` fails if `options.ts` parses a flag missing from it. `packages/cli/src/client/argv.ts` has none either. `configureLoggerFromEnvironment` runs at the top of `apps/backend/src/main.ts:56`, before flags are parsed.

**Decisions.**

- **Add flags?**
  - **No: document the environment variable for `orkestrator serve` and stop there (recommended).**
    - Pros: one syntax, which already works everywhere including bridges; no new public surface to keep compatible.
    - Cons: a launcher with no way to set an environment is unserved, and flags appear in `--help` where a variable does not.
  - **Add `--log-level`, mapped to the variable before logging is configured.**
    - Pros: discoverable, and matches other service flags.
    - Cons: flags must be read before `main.ts:56`, and it is one more entry in the public CLI contract for no new ability.

## Related

- [Logging and database report, Proposed user controls](../2026-10-29-logging-and-database-efficiency.md#proposed-user-controls)
- [Public CLI](../../architecture/public-cli.md)
- [0890](0890-controls-presets-and-auto-revert.md)
