import {
  claudeBackgroundCommandTimeouts,
  formatClaudeCommandDuration,
} from "@orkestrator/protocol/claude-background-commands";

/**
 * The system-prompt line describing how long a background shell command may
 * run. Since Claude Code 2.1.285 an Agent SDK session stops a background
 * command at its `timeout`; the ceiling follows the `BASH_*` variables the
 * query runs with, which the backend sets from the user's settings.
 */
export function backgroundCommandInstruction(env: NodeJS.ProcessEnv): string {
  const { defaultMs, maxMs } = claudeBackgroundCommandTimeouts(env);
  const defaultText = formatClaudeCommandDuration(defaultMs);
  const maxText = formatClaudeCommandDuration(maxMs);
  return `Background shell commands in this session are stopped when they reach their timeout (${defaultText} by default, ${maxText} at most). Pass a longer \`timeout\` when a background command needs more than ${defaultText}. For a dev server or watcher that must keep running longer than ${maxText}, tell the user to start it in an Orkestrator terminal tab instead of running it yourself.`;
}
