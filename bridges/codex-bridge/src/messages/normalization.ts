/**
 * Thread item → Orkestrator normalized part conversion.
 *
 * Extracted from `index.ts` unchanged so both engines share one renderer: the
 * app-server engine adapts its camelCase items into the SDK shape (see
 * `app-server/item-adapter.ts`) precisely so this file — and its tests — stay
 * engine-neutral. Two engines rendering the same conversation identically is the
 * parity requirement that makes rollback safe.
 *
 * `index.ts` re-exports `itemToParts` and `stringifyUnknown`, so existing
 * importers are unaffected.
 */
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import type { ThreadItem } from "../codex-item-types.js";
import { normalizeTranscriptToolArgs } from "../subagent-transcript.js";
import { mapTodoArgs, summarizeTodoList } from "../todo-helpers.js";
import type { EngineItem } from "../engine/types.js";
import { DEFAULT_MAX_COMMAND_OUTPUT_CHARS } from "../sessions/turn-accumulator.js";
import {
  applyDiffBudget,
  isBaselineWorthKeeping,
  pruneBaselines,
  pruneDiffCache,
  touchBaseline,
} from "./diff-budget.js";
import { rawApplyPatchParts } from "./apply-patch.js";
import type { FileChangeDiffContext, NormalizedPart, ToolDiffMetadata } from "./types.js";

const execFile = promisify(execFileCallback);
const COMMAND_OUTPUT_TRUNCATION_NOTICE = "\n… output truncated";
const INVISIBLE_TEXT_ONLY =
  /^(?:\p{White_Space}|\uFEFF|\p{Default_Ignorable_Code_Point})*$/u;

export function hasVisibleText(value: string): boolean {
  return !INVISIBLE_TEXT_ONLY.test(value);
}

export function capCommandOutput(
  output: string,
  maxChars: number = DEFAULT_MAX_COMMAND_OUTPUT_CHARS,
): string {
  if (output.length <= maxChars) return output;
  // A cap tighter than the notice would make the slice length negative, which
  // slices from the *end* and returns more than the cap instead of less.
  const keep = Math.max(0, maxChars - COMMAND_OUTPUT_TRUNCATION_NOTICE.length);
  return output.slice(0, keep) + COMMAND_OUTPUT_TRUNCATION_NOTICE;
}

export function stringifyUnknown(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Media arrives as a URL, which for tool results is routinely an inline
 * `data:` payload. Emitting those verbatim would push megabytes of base64
 * through SSE and into a `<pre>`, so only referenceable URLs survive.
 */
function describeMediaUrl(url: string, kind: "image" | "audio"): string {
  return url.startsWith("data:") ? `[${kind}]` : url;
}

function stringifyDynamicToolContent(items: unknown[]): string | undefined {
  const content = items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return stringifyUnknown(item);
    }
    const record = item as Record<string, unknown>;
    if (record.type === "inputText" && typeof record.text === "string") {
      return record.text;
    }
    if (record.type === "inputImage" && typeof record.imageUrl === "string") {
      return describeMediaUrl(record.imageUrl, "image");
    }
    if (record.type === "inputAudio" && typeof record.audioUrl === "string") {
      return describeMediaUrl(record.audioUrl, "audio");
    }
    return stringifyUnknown(item);
  }).filter((value): value is string => typeof value === "string" && value.length > 0);

  return content.length > 0 ? content.join("\n") : undefined;
}

export async function readTextFileIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function readGitHeadTextFile(
  cwd: string,
  relativePath: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFile("git", ["show", `HEAD:${relativePath}`], {
      cwd,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

interface GitDiffIo {
  makeTempDir(prefix: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  removeTempDir(path: string): Promise<void>;
  execute(cwd: string, args: string[]): Promise<{ stdout: string }>;
}

const defaultGitDiffIo: GitDiffIo = {
  makeTempDir: (prefix) => mkdtemp(prefix),
  writeTextFile: (path, content) => writeFile(path, content, "utf8"),
  removeTempDir: (path) => rm(path, { recursive: true, force: true }),
  execute: async (cwd, args) => {
    const { stdout } = await execFile("git", args, {
      cwd,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { stdout };
  },
};

async function runGitDiffNoIndexWithIo(
  cwd: string,
  relativePath: string,
  before: string | undefined,
  after: string | undefined,
  io: GitDiffIo,
): Promise<string | undefined> {
  if ((before ?? "") === (after ?? "")) {
    return undefined;
  }

  const tempDir = await io.makeTempDir(join(tmpdir(), "orkestrator-codex-diff-"));
  const beforePath = join(tempDir, "before");
  const afterPath = join(tempDir, "after");
  const normalizeOutput = (output: string) =>
    output
      .split(`a${beforePath}`).join(`a/${relativePath}`)
      .split(`b${afterPath}`).join(`b/${relativePath}`)
      .split(beforePath).join(`a/${relativePath}`)
      .split(afterPath).join(`b/${relativePath}`);

  try {
    await io.writeTextFile(beforePath, before ?? "");
    await io.writeTextFile(afterPath, after ?? "");

    const args = [
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-color",
      "--unified=3",
      beforePath,
      afterPath,
    ];

    try {
      const { stdout } = await io.execute(cwd, args);
      const output = stdout.trimEnd();
      return output.length > 0 ? normalizeOutput(output) : undefined;
    } catch (error) {
      // `git diff --no-index` uses exit code 1 for an ordinary difference.
      // Every other failure is fatal. In particular, maxBuffer failures may
      // carry truncated stdout, which must never be presented as a complete
      // patch.
      if ((error as { code?: unknown }).code !== 1) {
        return undefined;
      }
      const stdout = typeof (error as { stdout?: unknown }).stdout === "string"
        ? (error as { stdout: string }).stdout.trimEnd()
        : "";
      return stdout.length > 0 ? normalizeOutput(stdout) : undefined;
    }
  } finally {
    await io.removeTempDir(tempDir);
  }
}

export async function runGitDiffNoIndex(
  cwd: string,
  relativePath: string,
  before: string | undefined,
  after: string | undefined,
): Promise<string | undefined> {
  return runGitDiffNoIndexWithIo(cwd, relativePath, before, after, defaultGitDiffIo);
}

export const __testing = {
  runGitDiffNoIndexWithIo,
};

export function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }

    // Once inside a hunk, every leading + / - is a body marker. This is the
    // only reliable way to distinguish file headers from body content such as
    // `++ value`, whose encoded diff line is the identical `+++ value`.
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

export async function getFileChangeDiffMetadata(
  cwd: string,
  change: Extract<ThreadItem, { type: "file_change" }>["changes"][number],
  context?: FileChangeDiffContext,
  cacheKey?: string,
): Promise<ToolDiffMetadata> {
  const resolvedPath = isAbsolute(change.path) ? change.path : join(cwd, change.path);
  const relativePath = isAbsolute(change.path) ? relative(cwd, change.path) : change.path;
  const cached = cacheKey ? context?.cache.get(cacheKey) : undefined;
  if (cached) {
    return cached;
  }

  const hasBaseline = context?.baselines.has(relativePath) ?? false;
  const before = hasBaseline
    ? context?.baselines.get(relativePath)
    : change.kind === "add"
      ? undefined
      : await readGitHeadTextFile(cwd, relativePath);
  const after = change.kind === "delete"
    ? undefined
    : await readTextFileIfPresent(resolvedPath);
  const diff = await runGitDiffNoIndex(cwd, relativePath, before, after);
  const { additions, deletions } = diff
    ? countDiffLines(diff)
    : { additions: 0, deletions: 0 };

  // Oversized before/after are dropped here rather than stored and truncated
  // later: they are entire file contents, and this is the bridge's largest
  // in-memory consumer. See messages/diff-budget.ts.
  const metadata = applyDiffBudget({
    filePath: resolvedPath,
    before,
    after,
    diff,
    additions,
    deletions,
  });

  if (context) {
    // Only keep a baseline we can afford; a missing one simply means the next
    // diff for this file is taken against git HEAD, which is still correct.
    if (isBaselineWorthKeeping(after)) {
      context.baselines.set(relativePath, after);
      touchBaseline(context.baselines, relativePath);
    } else {
      context.baselines.delete(relativePath);
    }
    pruneBaselines(context.baselines);
  }
  if (cacheKey && context) {
    context.cache.set(cacheKey, metadata);
    pruneDiffCache(context.cache);
  }

  return metadata;
}

export async function itemToParts(
  item: EngineItem,
  cwd: string,
  fileChangeContext?: FileChangeDiffContext,
): Promise<NormalizedPart[]> {
  switch (item.type) {
    case "agent_message":
      return [{ type: "text", content: item.text }];
    case "reasoning":
      return hasVisibleText(item.text)
        ? [{ type: "thinking", content: item.text }]
        : [];
    case "command_execution": {
      const output = capCommandOutput(item.aggregated_output);
      return [{
        type: "tool-invocation",
        content: item.command,
        toolName: "bash",
        toolArgs: { command: item.command },
        toolState:
          item.status === "failed"
            ? "failure"
            : item.status === "completed"
              ? "success"
              : "pending",
        toolTitle: item.command,
        toolOutput: output || undefined,
        toolError: item.status === "failed" ? output || "Command failed" : undefined,
      }];
    }
    case "file_change":
      return Promise.all(
        item.changes.map(async (change, index) => ({
          type: "tool-invocation" as const,
          content: change.path,
          toolName: "apply_patch",
          toolState: item.status === "failed" ? "failure" : "success",
          toolTitle: `${change.kind}: ${change.path}`,
          toolOutput: `${change.kind}: ${change.path}`,
          toolDiff: await getFileChangeDiffMetadata(
            cwd,
            change,
            fileChangeContext,
            `${item.id}:${index}:${change.kind}:${change.path}`,
          ),
        })),
      );
    case "mcp_tool_call":
      return [{
        type: "tool-invocation",
        content: item.tool,
        toolName: item.tool,
        toolArgs: (item.arguments ?? {}) as Record<string, unknown>,
        toolState:
          item.status === "failed"
            ? "failure"
            : item.status === "completed"
              ? "success"
              : "pending",
        toolTitle: `${item.server}:${item.tool}`,
        toolOutput: stringifyUnknown(item.result),
        toolError: item.error?.message,
      }];
    case "dynamic_tool_call": {
      const output = capCommandOutput(
        stringifyDynamicToolContent(item.content_items) ?? "",
      ) || undefined;
      const toolState =
        item.status === "failed"
          ? "failure"
          : item.status === "completed"
            ? "success"
            : "pending";
      if (item.tool.trim().toLowerCase() === "apply_patch") {
        const patchParts = rawApplyPatchParts(item.arguments, cwd, toolState);
        if (patchParts.length > 0) {
          return patchParts.map((part) => ({
            ...part,
            toolOutput: item.status === "failed" ? undefined : output,
            toolError: item.status === "failed" ? output ?? "Tool failed" : undefined,
          }));
        }
      }
      return [{
        type: "tool-invocation",
        content: item.tool,
        toolName: item.tool,
        toolArgs: normalizeTranscriptToolArgs(item.tool, item.arguments),
        toolState,
        // Dynamic tools are namespaced by the protocol, so two same-named tools
        // are only distinguishable by it. Mirrors the `mcp_tool_call` title.
        toolTitle: item.namespace ? `${item.namespace}:${item.tool}` : item.tool,
        toolOutput: item.status === "failed" ? undefined : output,
        toolError: item.status === "failed" ? output ?? "Tool failed" : undefined,
      }];
    }
    case "web_search":
      return [{
        type: "tool-invocation",
        content: item.query,
        toolName: "web_search",
        toolArgs: { query: item.query },
        toolState: "success",
        toolTitle: item.query,
      }];
    case "todo_list":
      return [{
        type: "tool-invocation",
        content: summarizeTodoList(item.items),
        toolName: "todo_list",
        toolState: "success",
        toolTitle: "Todo List",
        toolArgs: mapTodoArgs(item.items),
        toolOutput: summarizeTodoList(item.items),
      }];
    case "error":
      return [{
        type: "tool-result",
        content: item.message,
        toolName: "error",
        toolState: "failure",
        toolError: item.message,
      }];
    /**
     * app-server only: free-text plan the agent drafts mid-turn.
     *
     * Rendered as a labelled tool invocation rather than plain text so it cannot
     * be mistaken for the assistant's final answer, matching how `todo_list` is
     * grouped.
     */
    case "plan":
      return [{
        type: "tool-invocation",
        content: item.text,
        toolName: "plan",
        toolState: "success",
        toolTitle: "Plan",
        toolOutput: item.text,
      }];
    /**
     * app-server only: sub-agent lifecycle beat. Intentionally renders nothing —
     * the visible sub-agent timeline is assembled from `collab_tool_call` items
     * plus rollout transcripts, which is the same source both engines use.
     */
    case "subagent_activity":
      return [];
    default:
      return [];
  }
}
