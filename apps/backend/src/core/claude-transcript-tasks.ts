import {
  TaskRegistry,
  isTaskListTool,
  type TaskListSnapshot,
} from "@orkestrator/protocol/task-list";

/**
 * Derives the agent task list from Claude Code's JSONL transcript.
 *
 * This is the tmux-mode counterpart to what the claude-bridge does for Native
 * Mode: the same `TaskRegistry`, fed from transcript lines instead of SDK
 * messages, so both modes agree on what the task list is and the renderer never
 * reconstructs it. Keeping this in the backend is what lets a tab that was
 * unmounted while tasks changed rehydrate from an authoritative snapshot.
 *
 * A task tool's *result* is what mutates the list, but only the earlier
 * `tool_use` block carries the tool name and args — so this tracks pending tool
 * uses across lines to pair them up.
 */

interface PendingToolUse {
  toolName: string;
  toolArgs: Record<string, unknown> | undefined;
}

interface TranscriptContentBlock {
  type?: string;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
  text?: unknown;
}

/** The JSONL line shape this cares about; everything else is ignored. */
interface TranscriptLineLike {
  message?: { content?: unknown };
  content?: unknown;
}

function contentBlocks(line: unknown): TranscriptContentBlock[] {
  if (typeof line !== "object" || line === null) return [];
  const candidate = line as TranscriptLineLike;
  const raw = candidate.message?.content ?? candidate.content;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (block): block is TranscriptContentBlock => typeof block === "object" && block !== null,
  );
}

/**
 * Flatten a `tool_result.content` payload to the text the tools actually
 * return. Claude writes it either as a plain string or as an array of text
 * blocks; the registry parses text, so both must arrive as text.
 */
function toolResultText(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return undefined;

  const text = raw
    .map((entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { text?: unknown }).text === "string"
        ? (entry as { text: string }).text
        : "",
    )
    .filter((part) => part.length > 0)
    .join("\n");

  return text.length > 0 ? text : undefined;
}

export class TranscriptTaskTracker {
  private registry = new TaskRegistry();
  private pendingToolUses = new Map<string, PendingToolUse>();

  /**
   * Apply one transcript line, returning the resulting list state for each task
   * tool call the line completed, keyed by `tool_use_id`.
   *
   * Keyed rather than a single value because one line can carry several
   * results: each gets the list as it stood after *that* call, and a result for
   * an unrelated tool gets nothing.
   *
   * Applying the same line twice is harmless — every operation the registry
   * models is idempotent — which is what lets a full transcript read and the
   * live tail overlap without coordination.
   */
  applyLine(line: unknown): Record<string, TaskListSnapshot> | undefined {
    let snapshots: Record<string, TaskListSnapshot> | undefined;

    for (const block of contentBlocks(line)) {
      if (block.type === "tool_use") {
        const id = typeof block.id === "string" ? block.id : undefined;
        const toolName = typeof block.name === "string" ? block.name : undefined;
        // Only task tools are worth remembering; holding every tool use would
        // grow without bound over a long session.
        if (!id || !isTaskListTool(toolName)) continue;
        this.pendingToolUses.set(id, {
          toolName: toolName!,
          toolArgs:
            typeof block.input === "object" && block.input !== null
              ? (block.input as Record<string, unknown>)
              : undefined,
        });
        continue;
      }

      if (block.type !== "tool_result") continue;

      const id = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
      if (!id) continue;

      const pending = this.pendingToolUses.get(id);
      if (!pending) continue;
      this.pendingToolUses.delete(id);

      // A failed call changed nothing, so it must not mutate the list.
      if (block.is_error === true) continue;

      const applied = this.registry.apply(
        pending.toolName,
        pending.toolArgs,
        toolResultText(block.content),
      );
      if (applied) {
        snapshots ??= {};
        snapshots[id] = applied;
      }
    }

    return snapshots;
  }

  /** The current list, for callers rehydrating rather than replaying. */
  snapshot(): TaskListSnapshot {
    return this.registry.snapshot();
  }
}
