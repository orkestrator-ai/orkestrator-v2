/**
 * Leaf nodes in a self-improvement run (docs/architecture/self-improvement.md,
 * "Leaf nodes"). A run on a command node also reads each connected leaf: its
 * diagnostics bundle, and the unread parts of its conversations. Both travel
 * over the command node's own link (`collect_self_improvement_diagnostics`,
 * `collect_self_improvement_conversations`), never routed or granted.
 *
 * The leaf side only reads: it builds a bundle, or selects and renders
 * conversation parts after read positions the command node sends. The command
 * node keeps those positions, runs the model and files the tickets, so a leaf
 * needs neither the feature switch nor Claude Code.
 *
 * Everything a leaf answers is data. The command node checks every field and
 * bound before using it, and redacts conversation text again.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import {
  incompatibility,
  incompatibilityOfAnyCommand,
} from "@orkestrator/protocol/contract/errors";
import { redactSecrets } from "@orkestrator/protocol/secret-redaction";
import type { BundleData } from "./bundle.js";
import {
  type CursorEntry,
  type InsightCursor,
  MAX_SEGMENT_CHARS,
  MAX_SEGMENTS_PER_RUN,
  type Segment,
  type Selection,
  selectSegments,
  type SkippedPart,
} from "./insights/prepare.js";
import type { TranscriptSources } from "./insights/transcripts.js";

/**
 * The largest leaf bundle a command node accepts, before base64. A bundle
 * without debug logs holds the essential log (at most 4 MiB) and a few JSON
 * files, so this leaves room without trusting a stray answer.
 */
export const MAX_LEAF_ARCHIVE_BYTES = 16 * 1024 * 1024;
/** Read positions sent to a leaf; the cursor keeps 90 days, far below this. */
export const MAX_LEAF_CURSOR_ENTRIES = 20_000;
const MAX_ID_CHARS = 512;
const MAX_PATH_CHARS = 4096;
const MAX_PROJECT_CHARS = 256;
/** Rendering adds a header and markers around the capped body. */
const MAX_LEAF_SEGMENT_CHARS = MAX_SEGMENT_CHARS + 1024;

/** One connected leaf, as a run sees it. */
export interface LeafNode {
  nodeId: string;
  name: string;
  /** The leaf's diagnostics bundle archive. */
  diagnostics(): Promise<Buffer>;
  /** The leaf's unread conversation parts after `cursor`, at most `maxSegments`. */
  conversations(request: { cursor: InsightCursor; maxSegments: number }): Promise<Selection>;
}

/** A leaf whose diagnostics were read, for the digest. */
export interface LeafBundle {
  nodeId: string;
  name: string;
  data: BundleData;
}

/**
 * The prefix a leaf's conversation ids take on the command node, so notes,
 * themes and positions from two machines never share an id.
 */
export function leafConversationId(nodeId: string, conversationId: string): string {
  return `@${nodeId}/${conversationId}`;
}

/** The leaf a prefixed conversation id came from, or null for one of this machine's. */
export function leafOfConversation(conversationId: string): string | null {
  if (!conversationId.startsWith("@")) return null;
  const slash = conversationId.indexOf("/");
  return slash > 1 ? conversationId.slice(1, slash) : null;
}

/** Where a leaf's read positions are kept on the command node, under the insights directory. */
export function leafInsightsDir(insightsDir: string, nodeId: string): string {
  // Node ids may hold `:`; a hash keeps the directory name portable.
  const key = createHash("sha256").update(nodeId).digest("hex").slice(0, 16);
  return path.join(insightsDir, "nodes", key);
}

const LEAF_COMMANDS = [
  "collect_self_improvement_diagnostics",
  "collect_self_improvement_conversations",
] as const;

/** Why a leaf took no part: it predates the commands, or the call failed. */
export function leafFailure(error: unknown): "needs-update" | "failed" {
  // Unknown command, or a `system` version without it: either way, an update brings it.
  // A wrapped answer still names the command.
  const outdated =
    incompatibilityOfAnyCommand(error) !== null ||
    LEAF_COMMANDS.some((command) => incompatibility(error, command) !== null);
  return outdated ? "needs-update" : "failed";
}

// ---------------------------------------------------------------------------
// Leaf side

/** `collect_self_improvement_diagnostics`: the archive as base64, refused when too large. */
export async function answerLeafDiagnostics(
  exportBundle: () => Promise<Buffer>,
): Promise<{ archive: string }> {
  const archive = await exportBundle();
  if (archive.byteLength > MAX_LEAF_ARCHIVE_BYTES) {
    throw new Error("This machine's diagnostics bundle is too large to send.");
  }
  return { archive: archive.toString("base64") };
}

/** `collect_self_improvement_conversations`: parts after the positions sent, read-only. */
export async function answerLeafConversations(options: {
  sources: TranscriptSources;
  excludeDirs: string[];
  cursor: unknown;
  maxSegments: unknown;
  now: number;
}): Promise<{
  segments: Segment[];
  skipped: SkippedPart[];
  waiting: number;
  filesChecked: number;
}> {
  const requested = Number(options.maxSegments);
  const maxSegments = Number.isInteger(requested)
    ? Math.min(Math.max(requested, 0), MAX_SEGMENTS_PER_RUN)
    : MAX_SEGMENTS_PER_RUN;
  let filesChecked = 0;
  const selection = await selectSegments({
    sources: options.sources,
    cursor: parseCursor(options.cursor),
    now: options.now,
    excludeDirs: options.excludeDirs,
    maxSegments,
    onFile: (checked) => {
      filesChecked = checked;
    },
  });
  return { ...selection, filesChecked };
}

// ---------------------------------------------------------------------------
// Parsing what the other side sent

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function time(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Read positions as a leaf receives them: valid entries only, bounded. */
export function parseCursor(value: unknown): InsightCursor {
  const conversations: Record<string, CursorEntry> = {};
  const entries = Object.entries(record(record(value)?.conversations) ?? {}).slice(
    0,
    MAX_LEAF_CURSOR_ENTRIES,
  );
  for (const [id, raw] of entries) {
    const entry = record(raw);
    const analyzedEntries = count(entry?.analyzedEntries);
    const lastAt = time(entry?.lastAt);
    const analyzedAt = time(entry?.analyzedAt);
    if (!entry || id.length > MAX_ID_CHARS || analyzedEntries === null) continue;
    if (lastAt === null || analyzedAt === null) continue;
    const file = text(entry.file, MAX_PATH_CHARS);
    const lastEntryOffset = count(entry.lastEntryOffset);
    const reviewedAt = time(entry.reviewedAt);
    conversations[id] = {
      analyzedEntries,
      ...(file !== null ? { file } : {}),
      ...(lastEntryOffset !== null ? { lastEntryOffset } : {}),
      lastAt,
      project: text(entry.project, MAX_PROJECT_CHARS) ?? "",
      analyzedAt,
      ...(reviewedAt !== null ? { reviewedAt } : {}),
    };
  }
  return { schemaVersion: 1, conversations };
}

function parsePosition(
  entry: Record<string, unknown>,
): { file: string; lastEntryOffset?: number } | null {
  const file = text(entry.file, MAX_PATH_CHARS);
  if (file === null) return null;
  const lastEntryOffset = count(entry.lastEntryOffset);
  return { file, ...(lastEntryOffset !== null ? { lastEntryOffset } : {}) };
}

function parseSegment(value: unknown): Segment | null {
  const entry = record(value);
  if (!entry) return null;
  const conversationId = text(entry.conversationId, MAX_ID_CHARS);
  const provider =
    entry.provider === "claude" || entry.provider === "codex" ? entry.provider : null;
  const startedAt = time(entry.startedAt);
  const lastAt = time(entry.lastAt);
  const from = count(entry.from);
  const to = count(entry.to);
  const key = text(entry.key, MAX_ID_CHARS);
  const body = text(entry.text, MAX_LEAF_SEGMENT_CHARS);
  const typedMessages = count(entry.typedMessages);
  const position = parsePosition(entry);
  if (!conversationId || !provider || startedAt === null || lastAt === null) return null;
  if (from === null || to === null || to <= from || !key || !body || typedMessages === null) {
    return null;
  }
  if (!position) return null;
  return {
    conversationId,
    provider,
    project: text(entry.project, MAX_PROJECT_CHARS) ?? "",
    startedAt,
    lastAt,
    from,
    to,
    ...position,
    key,
    // Redacted on the leaf; again here, so a leaf on an older redactor sends nothing new.
    text: redactSecrets(body),
    typedMessages,
  };
}

function parseSkipped(value: unknown): SkippedPart | null {
  const entry = record(value);
  if (!entry) return null;
  const conversationId = text(entry.conversationId, MAX_ID_CHARS);
  const to = count(entry.to);
  const lastAt = time(entry.lastAt);
  const position = parsePosition(entry);
  if (!conversationId || to === null || lastAt === null || !position) return null;
  return {
    conversationId,
    to,
    ...position,
    lastAt,
    project: text(entry.project, MAX_PROJECT_CHARS) ?? "",
  };
}

/** A leaf's answer to `collect_self_improvement_conversations`, as the command node uses it. */
export function parseLeafSelection(value: unknown, maxSegments: number): Selection {
  const answer = record(value);
  const segments = (Array.isArray(answer?.segments) ? answer.segments : [])
    .map(parseSegment)
    .filter((segment): segment is Segment => segment !== null);
  const skipped = (Array.isArray(answer?.skipped) ? answer.skipped : [])
    .slice(0, MAX_LEAF_CURSOR_ENTRIES)
    .map(parseSkipped)
    .filter((part): part is SkippedPart => part !== null);
  const extra = Math.max(0, segments.length - maxSegments);
  return {
    segments: segments.slice(0, maxSegments),
    skipped,
    waiting: (count(answer?.waiting) ?? 0) + extra,
  };
}

/** A leaf's answer to `collect_self_improvement_diagnostics`: the archive bytes. */
export function parseLeafArchive(value: unknown): Buffer {
  const archive = record(value)?.archive;
  // Base64 is 4 characters for 3 bytes.
  if (typeof archive !== "string" || archive.length > Math.ceil(MAX_LEAF_ARCHIVE_BYTES / 3) * 4) {
    throw new Error("The leaf sent no readable diagnostics bundle.");
  }
  const bytes = Buffer.from(archive, "base64");
  if (bytes.byteLength === 0) throw new Error("The leaf sent no readable diagnostics bundle.");
  return bytes;
}
