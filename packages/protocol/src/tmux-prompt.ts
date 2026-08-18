/**
 * Composition of a claude-tmux prompt.
 *
 * tmux has no attachment channel: an image is delivered by typing its path into
 * the pane as prose. Both the interactive send path (renderer) and the backend
 * queue drainer have to produce byte-identical text for the same message, so
 * the rule lives here rather than in either of them.
 *
 * Pure: no I/O, no clocks.
 */

/**
 * Characters a shell-like TUI input would otherwise interpret.
 *
 * The pane is fed through `tmux send-keys -l`, so anything the Claude Code
 * composer treats as syntax has to arrive escaped or the path is truncated at
 * the first space.
 */
const TERMINAL_PATH_ESCAPE_PATTERN = /([\s\\"'`$&|;<>()[\]{}*?!#~])/g;

/** Escape a filesystem path before typing it into a shell-like terminal input. */
export function escapePathForTerminalInput(filePath: string): string {
  return filePath.replace(TERMINAL_PATH_ESCAPE_PATTERN, "\\$1");
}

export interface TmuxPromptAttachment {
  name: string;
  path: string;
}

/**
 * Append staged attachments to a prompt as workspace paths.
 *
 * A container path is already absolute inside the container and is typed as-is;
 * a host path goes through the terminal escape because the pane is a shell.
 */
export function buildTmuxPromptWithAttachments(
  text: string,
  attachments: readonly TmuxPromptAttachment[],
  containerId?: string,
): string {
  if (attachments.length === 0) return text;

  const attachmentList = attachments
    .map((attachment) => {
      const attachmentPath = containerId
        ? attachment.path
        : escapePathForTerminalInput(attachment.path);
      return `- ${attachment.name}: ${attachmentPath}`;
    })
    .join("\n");
  const attachmentText = `Attached images have been saved in the workspace. Use these image paths as task context:\n${attachmentList}`;

  return text ? `${text}\n\n${attachmentText}` : attachmentText;
}

/**
 * Validates the attachment list carried on a queued tmux prompt.
 *
 * A queued message is persisted JSON that outlives the client which wrote it,
 * so the drainer must not trust its shape. Anything malformed is dropped rather
 * than typed into the pane.
 */
export function parseTmuxPromptAttachments(value: unknown): TmuxPromptAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: TmuxPromptAttachment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.name !== "string" || typeof candidate.path !== "string") {
      continue;
    }
    if (!candidate.name.trim() || !candidate.path.trim()) continue;
    attachments.push({ name: candidate.name, path: candidate.path });
  }
  return attachments;
}

/** Key under which a tmux tab's queue and per-tab state are addressed. */
export function createClaudeTmuxStateKey(environmentId: string, tabId: string): string {
  return `env:${environmentId}:tab:${tabId}`;
}

/**
 * The tab a tmux state key addresses.
 *
 * Environment ids never contain `:`, so the environment segment is bounded and
 * everything after `:tab:` is the tab id.
 */
export function parseClaudeTmuxStateKey(
  stateKey: string,
): { environmentId: string; tabId: string } | null {
  const match = stateKey.match(/^env:([^:]+):tab:(.+)$/);
  if (!match?.[1] || !match[2]) return null;
  return { environmentId: match[1], tabId: match[2] };
}
