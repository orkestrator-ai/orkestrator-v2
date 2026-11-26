// The terminals domain's public surface: the module other backend code
// imports. Re-export by name (never `export *`) so the surface stays
// reviewable.
//
// The domain is the backend's ownership of interactive terminal sessions:
// `runtime.ts` is its slice of the backend runtime (`runtime.terminals`,
// docs/architecture/backend-runtime.md), which holds every live PTY session,
// its bounded output buffer and its activity settling; `history.ts` keeps
// each terminal's durable history (a headless xterm per terminal, its
// checkpoints and archive pages), fed through the parse budget in
// `parse-scheduler.ts` and the control-sequence scanners in
// `history-scanners.ts`; `size-ownership.ts` decides which client owns a
// shared terminal's size. `history-test-support.ts` is the history tests'
// harness. The terminal command handlers (`commands/terminal*.ts`,
// `commands/registry-terminal.ts`), the PTY wrapper (`pty.ts`), the container
// shell (`containers/terminal-shell.ts`) and the setup terminal
// (`setup-terminal-attempt.ts`) stay with their own groups, and the claude-tmux
// pane terminal is in `tmux/`.
//
// The `apps/backend/src/**` and `tests/unit/**` patterns of `.oxlintrc.json`
// have no exceptions for this domain. Every production importer outside the
// folder imports this file, `backend-runtime.ts` (for `runtime.ts`) and the
// terminal command registry (for `history.ts`) included, and no runtime
// import cycle results. Tests, test support, the `apps/backend/tests` files
// and the scripts that use other internals import the modules directly,
// which the patterns allow. No `tests/unit` file imports the domain.
export type { TerminalHistory } from "./history.js";
export {
  TerminalRuntime,
  type TerminalOutputBuffer,
  type TerminalRuntimeOptions,
  type TerminalSessionConfig,
} from "./runtime.js";
