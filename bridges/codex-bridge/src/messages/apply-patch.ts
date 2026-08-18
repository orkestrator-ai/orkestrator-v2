import { isAbsolute, join } from "node:path";
import { applyDiffBudget } from "./diff-budget.js";
import type { NormalizedPart, ToolState } from "./types.js";

export const MAX_RAW_APPLY_PATCH_SCAN_CHARS = 1024 * 1024;
export const MAX_RAW_APPLY_PATCH_CHANGES = 256;

export type RawApplyPatchKind = "add" | "delete" | "update" | "move";

export interface RawApplyPatchChange {
  path: string;
  targetPath: string;
  kind: RawApplyPatchKind;
  diff: string;
  additions: number;
  deletions: number;
}

function patchInputFromRecord(value: object): string | undefined {
  const input = (value as Record<string, unknown>).input;
  return typeof input === "string" && input.trim().length > 0 ? input : undefined;
}

/** The patch text as carried by a `custom_tool_call` or a pre-parsed record. */
function rawPatchInput(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return patchInputFromRecord(value);
}

/**
 * The patch text hiding inside JSON-encoded `function_call` arguments.
 *
 * A `custom_tool_call` carries the patch verbatim, but a `function_call` carries
 * `{"input":"*** Begin Patch\\n…"}` — where the control lines are escaped, so no
 * line-oriented scan can see them. Tried only after a direct parse found
 * nothing, which keeps the common path free of a speculative decode.
 *
 * Bounded like every other read of this untrusted content: an oversized string
 * is refused rather than handed to `JSON.parse`, which would materialise the
 * decoded value with no cap at all.
 */
function decodedPatchInput(input: string): string | undefined {
  if (input.length > MAX_RAW_APPLY_PATCH_SCAN_CHARS) return undefined;
  if (!input.trimStart().startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? patchInputFromRecord(parsed)
    : undefined;
}

function countBodyLines(lines: readonly string[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

/**
 * Parses the bounded control-line subset of Codex's apply_patch format.
 *
 * This does not attempt to apply or validate a patch. It only extracts the file
 * boundaries that Codex already emitted so raw live fallbacks and rollout
 * hydration can retain the same per-file identity as app-server `fileChange`
 * items. The scan and number of retained changes are explicitly bounded because
 * rollout content is untrusted and may be very large.
 */
export function parseRawApplyPatchChanges(value: unknown): RawApplyPatchChange[] {
  const input = rawPatchInput(value);
  if (!input) return [];

  const direct = parseControlLines(input);
  if (direct.length > 0) return direct;
  const decoded = decodedPatchInput(input);
  return decoded ? parseControlLines(decoded) : [];
}

function parseControlLines(input: string): RawApplyPatchChange[] {
  const source = input.slice(0, MAX_RAW_APPLY_PATCH_SCAN_CHARS);
  const lines = source.split(/\r?\n/);
  const changes: RawApplyPatchChange[] = [];
  let current:
    | {
        path: string;
        kind: Exclude<RawApplyPatchKind, "move">;
        movePath?: string;
        body: string[];
      }
    | undefined;

  const finishCurrent = (): void => {
    if (!current || changes.length >= MAX_RAW_APPLY_PATCH_CHANGES) return;
    const targetPath = current.movePath ?? current.path;
    const kind: RawApplyPatchKind = current.movePath ? "move" : current.kind;
    const oldHeader = current.kind === "add" ? "/dev/null" : `a/${current.path}`;
    const newHeader = current.kind === "delete" ? "/dev/null" : `b/${targetPath}`;
    const body = current.body.filter((line) => line !== "*** End of File");
    const { additions, deletions } = countBodyLines(body);
    changes.push({
      path: current.path,
      targetPath,
      kind,
      diff: [`--- ${oldHeader}`, `+++ ${newHeader}`, ...body].join("\n"),
      additions,
      deletions,
    });
  };

  for (const line of lines) {
    const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(line);
    if (header) {
      finishCurrent();
      if (changes.length >= MAX_RAW_APPLY_PATCH_CHANGES) break;
      const path = header[2]!.trim();
      current =
        path.length > 0
          ? {
              path,
              kind: header[1]!.toLowerCase() as Exclude<RawApplyPatchKind, "move">,
              body: [],
            }
          : undefined;
      continue;
    }

    if (line === "*** End Patch") {
      finishCurrent();
      current = undefined;
      break;
    }

    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && current) {
      const movePath = move[1]!.trim();
      if (movePath.length > 0) current.movePath = movePath;
      continue;
    }

    if (current) current.body.push(line);
  }

  if (current) finishCurrent();
  return changes;
}

function rawPatchTitle(change: RawApplyPatchChange): string {
  return change.kind === "move"
    ? `move: ${change.path} → ${change.targetPath}`
    : `${change.kind}: ${change.targetPath}`;
}

/**
 * Produces the same one-part-per-file shape as structured `fileChange` items.
 * Callers add the shared tool output/error after pairing the call result.
 */
export function rawApplyPatchParts(
  value: unknown,
  cwd: string,
  state: ToolState,
): NormalizedPart[] {
  return parseRawApplyPatchChanges(value).map((change) => {
    const filePath = isAbsolute(change.targetPath)
      ? change.targetPath
      : join(cwd, change.targetPath);
    return {
      type: "tool-invocation",
      content: change.targetPath,
      toolName: "apply_patch",
      toolArgs: {
        path: change.path,
        kind: change.kind,
        ...(change.targetPath !== change.path ? { move_path: change.targetPath } : {}),
      },
      toolState: state,
      toolTitle: rawPatchTitle(change),
      toolDiff: applyDiffBudget({
        filePath,
        diff: change.diff,
        additions: change.additions,
        deletions: change.deletions,
      }),
    };
  });
}
