/**
 * Every `native-sessions` command (plan item 7001; docs/reports/
 * unified-federation.md §11.2, Appendix E): native agent sessions
 * (`commands-agent.ts`), terminal sessions, buffers, pane layouts and host
 * actions (`commands-sessions.ts`), and prompt queues, drafts and handoffs
 * (`commands-prompts.ts`).
 *
 * Browser-safe.
 */
import { NATIVE_AGENT_COMMANDS } from "./commands-agent.js";
import { PROMPT_COMMANDS } from "./commands-prompts.js";
import { SESSION_COMMANDS } from "./commands-sessions.js";

export * from "./commands-agent.js";
export * from "./commands-sessions.js";
export * from "./commands-prompts.js";

export const NATIVE_SESSIONS_COMMANDS = [
  ...NATIVE_AGENT_COMMANDS,
  ...SESSION_COMMANDS,
  ...PROMPT_COMMANDS,
] as const;
