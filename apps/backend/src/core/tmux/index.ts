// The tmux domain's public surface: the module other backend code imports.
// Re-export by name (never `export *`) so the surface stays reviewable.
//
// The domain is the claude-tmux mode: Claude Code run as a CLI inside a tmux
// session (docs/architecture/agent-engines.md). `backend.ts` runs tmux and
// `docker exec` for a host or a container, `session-manager.ts` owns one
// tab's session and its poll loop, `hooks.ts` installs and drains the Claude
// hooks, `hook-signal.ts` is the per-container hook doorbell, `poll.ts` the
// per-container Claude state poll, `interactive.ts` and `clipboard.ts` the
// interactive pane terminal, `transcript-reader.ts` and
// `transcript-tool-diffs.ts` the JSONL transcript reads, `shared.ts` and
// `socket-owner.ts` the session naming, exec and process-census helpers,
// `runtime.ts` the domain's slice of the backend runtime (`runtime.tmux`),
// and `commands.ts` the `claude_tmux_*` command handlers and the environment
// teardown. Before the move, the root `tmux.ts` re-exported seven of these
// modules with `export *`. This file replaces it and re-exports only what
// production code outside the folder uses. `claude-state-signal.ts`, which
// installs both doorbells, stays at the root.
//
// The `apps/backend/src/**` and `tests/unit/**` patterns of `.oxlintrc.json`
// have no exceptions for this domain. Every production importer outside the
// folder imports this file, `backend-runtime.ts` (for `runtime.ts`) and the
// command registry (for `commands.ts`) included, and no runtime import cycle
// results. Tests, test support and the `apps/backend/scripts` files that use
// other internals import the modules directly, which the patterns allow. No
// `tests/unit` file imports the domain.
export { registerTmuxBackendCommands, cleanupEnvironmentTmux } from "./commands.js";
export { TMUX_HOOK_SIGNAL_CONFIG_PATH, type TmuxHookSignalInstaller } from "./hook-signal.js";
export { gitExcludeSetupScript } from "./hooks.js";
export {
  shutdownClaudeStatePolling,
  type ClaudeStateSignalInstaller,
  type ClaudeStateSignalSupport,
} from "./poll.js";
export { TmuxRuntime, type TmuxRuntimeOptions } from "./runtime.js";
export {
  claudeTmuxRuntimeRootPrefix,
  confirmTmuxSessionGone,
  containerExecArgs,
  isMissingTmuxSessionError,
  parseTmuxSessionNames,
  RUNTIME_ROOT_PREFIX,
  selectReapableTmuxSessions,
} from "./shared.js";
