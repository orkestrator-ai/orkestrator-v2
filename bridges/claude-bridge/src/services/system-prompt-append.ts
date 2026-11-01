import { agentSystemInstructions } from "@orkestrator/protocol/agent-system-instructions";
import { backgroundCommandInstruction } from "./background-commands.js";

/** Claude Code's Edit and Write tools refuse a file this conversation has not read. */
const READ_BEFORE_EDIT_INSTRUCTION =
  "IMPORTANT: You MUST read a file before editing or writing to it. The Edit and Write tools will fail if you have not first used the Read tool to read the file in this conversation. Always read files before attempting to modify them.";

/**
 * The claude.ai Claude Docs connector and docs skill steer reports into remote
 * docs that only an Artifact tool can open, and Orkestrator has none, so the
 * report never shows up here.
 */
const CLAUDE_DOCS_INSTRUCTION =
  "Write a requested document as that Markdown file rather than as a Claude Doc or claude.ai artifact: Orkestrator cannot open those, so the user would never see it.";

/**
 * What a writable Claude session appends to the `claude_code` preset: the
 * instructions every provider receives, then Claude's own.
 */
export function claudeSystemPromptAppend(env: NodeJS.ProcessEnv): string {
  return agentSystemInstructions([
    // Directly after the general block's document rule, which it refines.
    CLAUDE_DOCS_INSTRUCTION,
    READ_BEFORE_EDIT_INSTRUCTION,
    // Since Claude Code 2.1.285 an Agent SDK session stops a background
    // shell command at its `timeout`, so a dev server Claude starts here
    // does not outlive the ceiling configured in Settings.
    backgroundCommandInstruction(env),
  ]);
}
