/**
 * Orkestrator's own system-level instructions, delivered to every agent
 * provider through its native channel: Claude's appended system prompt, Codex
 * developer instructions, OpenCode's per-prompt `system`, Pi's appended system
 * prompt, Grok's `--rules`, and a system-instructions frame on Cursor prompts
 * (Cursor has no channel that adds to its system prompt).
 *
 * Two blocks, so the providers differ only where they have to:
 *
 * - `GENERAL_AGENT_INSTRUCTIONS` describe Orkestrator itself and are the same
 *   for every provider. Add a rule here unless it only makes sense for one.
 * - Provider-specific lines (Claude's tool and connector rules) live in that
 *   provider's bridge and are passed to `agentSystemInstructions`.
 *
 * Read-only coordinator sessions do not receive the general block: both rules
 * ask the agent to write a file, which a coordinator delegates to a worker.
 *
 * The repository's own AGENTS.md is a third block. Every provider reads it,
 * coordinators included: natively where the provider loads it (OpenCode, Pi,
 * and the others when the session turns project resources on), otherwise
 * from `repositoryInstructionsBlock` through the same channel as the general
 * block. Loading it never trusts the checkout's executable configuration
 * (hooks, MCP servers, settings), which stays behind project resources.
 */

/**
 * Markdown images render inline in the transcript, but only from storage the
 * host preview may read. Project-home checkouts are excluded even when they are
 * the working directory, so the storage boundary is stated explicitly.
 */
export const AGENT_IMAGE_PREVIEW_INSTRUCTION =
  "Orkestrator renders Markdown images inline in the transcript. When you show the user an image in your reply (a screenshot, rendered preview, or chart) using Markdown image syntax, reference it by its absolute path. In a managed worktree or container environment, save the file inside the working directory, preferably in a git-ignored folder so preview files stay out of the change set. Local image previews are limited to Orkestrator-managed workspace storage or the container's /workspace. Project-home checkouts are excluded from host preview reads, even when they are the working directory, so images saved there cannot be previewed from a local Markdown path. Paths outside previewable storage, such as /tmp, also show a placeholder.";

/** Orkestrator shows files in the working directory; it opens no remote document service. */
export const AGENT_DOCUMENT_INSTRUCTION =
  "When the user asks for a document (a report, design doc, plan, analysis, guide, or other writing to keep), prefer writing it as a Markdown file in a `docs/` folder at the root of the working directory, and tell the user the file's path. Project instructions (such as AGENTS.md or CLAUDE.md), local skills, and the user's own request take priority over this default when they say where or how to write documents.";

/** The block every provider receives, in order. */
export const GENERAL_AGENT_INSTRUCTIONS: readonly string[] = [
  AGENT_IMAGE_PREVIEW_INSTRUCTION,
  AGENT_DOCUMENT_INSTRUCTION,
];

/**
 * The general block followed by a provider's own lines, as one text.
 * Blank provider lines are dropped so an optional rule can be passed as "".
 */
export function agentSystemInstructions(providerSpecific: readonly string[] = []): string {
  return [...GENERAL_AGENT_INSTRUCTIONS, ...providerSpecific]
    .filter((line) => line.trim().length > 0)
    .join("\n\n");
}

/** The repository instruction file every provider reads. */
export const REPOSITORY_INSTRUCTIONS_FILE = "AGENTS.md";

/**
 * A repository's AGENTS.md as system-level instructions, for a session whose
 * provider does not load it itself. `truncated` says the file was longer than
 * the channel holds, and the block then tells the agent where the rest is.
 */
export function repositoryInstructionsBlock(
  path: string,
  content: string,
  truncated: boolean,
): string {
  return [
    `# Repository instructions (${REPOSITORY_INSTRUCTIONS_FILE})`,
    `This session does not load the repository's ${REPOSITORY_INSTRUCTIONS_FILE} on its own, so Orkestrator includes it here. Follow it as project instructions. Contents of ${path}:`,
    content.trimEnd(),
    ...(truncated
      ? [
          `[${REPOSITORY_INSTRUCTIONS_FILE} is longer than this session can hold, so it is cut here. Read the rest from ${path} before relying on anything it may say.]`,
        ]
      : []),
  ].join("\n\n");
}
