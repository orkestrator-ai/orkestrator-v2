/**
 * Synthetic, parameterized transcript fixtures for the efficiency harness.
 *
 * Everything is generated from a seed and a size: no fixture is read from a
 * user profile, provider session or checked-in sample, and none is written to
 * the repository. The same parameters always produce byte-identical output,
 * so operation counts are comparable across machines and commits.
 *
 * Shapes follow the normalized message every bridge serves (`id`, `role`,
 * `content`, `parts`, `createdAt`) and the part fields the summarizer and the
 * renderer read (`toolOutput`, `toolDiff`, `fileUrl`, `subagentActions`).
 */

export const FIXTURE_CREATED_AT = "2026-01-01T00:00:00.000Z";

export interface FixturePart {
  type: string;
  content: string;
  sourcePartId?: string;
  [field: string]: unknown;
}

export interface FixtureMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts: FixturePart[];
  createdAt: string;
}

/** Deterministic 32-bit generator (mulberry32). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const ASCII_WORDS = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliet",
  "kilo",
  "lima",
];
/** Two-, three- and four-byte UTF-8 sequences, including an astral code point. */
const MULTIBYTE_WORDS = ["é", "ß", "中文", "日本", "😀", "Ωμέγα", "naïve", "ç"];

export type ProseKind = "ascii" | "multibyte";

/**
 * Prose of exactly `bytes` UTF-8 bytes (never splitting a code point; a
 * multibyte string may end up to three bytes short and is padded with ASCII).
 */
export function prose(bytes: number, kind: ProseKind = "ascii", seed = 1): string {
  if (bytes <= 0) return "";
  const random = seededRandom(seed);
  const words = kind === "ascii" ? ASCII_WORDS : [...MULTIBYTE_WORDS, ...ASCII_WORDS];
  const chunks: string[] = [];
  let length = 0;
  while (length < bytes) {
    const word = `${words[Math.floor(random() * words.length)]!} `;
    const wordBytes = Buffer.byteLength(word);
    if (length + wordBytes > bytes) break;
    chunks.push(word);
    length += wordBytes;
  }
  return chunks.join("") + ".".repeat(bytes - length);
}

export function textMessage(
  index: number,
  contentBytes: number,
  options: { kind?: ProseKind; role?: FixtureMessage["role"]; prefix?: string } = {},
): FixtureMessage {
  return {
    id: `${options.prefix ?? "m"}${index}`,
    role: options.role ?? (index % 2 === 0 ? "user" : "assistant"),
    content: prose(contentBytes, options.kind ?? "ascii", index + 1),
    parts: [],
    createdAt: FIXTURE_CREATED_AT,
  };
}

/** `count` plain prose messages of `contentBytes` each. */
export function textMessages(
  count: number,
  contentBytes: number,
  options: { kind?: ProseKind; prefix?: string } = {},
): FixtureMessage[] {
  return Array.from({ length: count }, (_, index) => textMessage(index, contentBytes, options));
}

export function textPart(id: string, bytes: number, kind: ProseKind = "ascii"): FixturePart {
  return { type: "text", content: prose(bytes, kind, id.length + bytes), sourcePartId: id };
}

/** One message holding `partCount` text parts of `partBytes` each. */
export function manyPartMessage(
  id: string,
  partCount: number,
  partBytes: number,
  kind: ProseKind = "ascii",
): FixtureMessage {
  return {
    id,
    role: "assistant",
    content: "",
    parts: Array.from({ length: partCount }, (_, index) =>
      textPart(`${id}-p${index}`, partBytes, kind),
    ),
    createdAt: FIXTURE_CREATED_AT,
  };
}

/** A completed tool call carrying a large result body. */
export function toolResultPart(id: string, outputBytes: number): FixturePart {
  return {
    type: "tool-invocation",
    content: "",
    sourcePartId: id,
    toolUseId: id,
    toolName: "read",
    toolArgs: { path: `src/file-${id}.ts` },
    toolState: "success",
    toolOutput: prose(outputBytes, "ascii", outputBytes + id.length),
  };
}

/** A completed edit carrying a unified diff of `lines` changed lines. */
export function diffPart(id: string, lines: number): FixturePart {
  const before: string[] = [];
  const after: string[] = [];
  const diff: string[] = [
    `--- a/src/${id}.ts`,
    `+++ b/src/${id}.ts`,
    `@@ -1,${lines} +1,${lines} @@`,
  ];
  for (let index = 0; index < lines; index += 1) {
    const oldLine = `const value${index} = ${index};`;
    const newLine = `const value${index} = ${index + 1};`;
    before.push(oldLine);
    after.push(newLine);
    diff.push(`-${oldLine}`, `+${newLine}`);
  }
  return {
    type: "tool-invocation",
    content: "",
    sourcePartId: id,
    toolUseId: id,
    toolName: "edit",
    toolState: "success",
    toolDiff: {
      filePath: `src/${id}.ts`,
      additions: lines,
      deletions: lines,
      before: before.join("\n"),
      after: after.join("\n"),
      diff: diff.join("\n"),
    },
  };
}

/** An inline image: a `data:` URL whose decoded payload is `bytes` long. */
export function dataUrlImagePart(id: string, bytes: number): FixturePart {
  const random = seededRandom(bytes);
  const payload = Buffer.alloc(bytes);
  for (let index = 0; index < bytes; index += 1) payload[index] = Math.floor(random() * 256);
  return {
    type: "image",
    content: "",
    sourcePartId: id,
    fileUrl: `data:image/png;base64,${payload.toString("base64")}`,
  };
}

/**
 * A sub-agent row whose child activity has `completedActions` finished tool
 * calls of `actionBytes` output each, plus a running one when `running`.
 */
export function nestedAgentPart(
  id: string,
  completedActions: number,
  actionBytes: number,
  running = true,
): FixturePart {
  const actions: FixturePart[] = Array.from({ length: completedActions }, (_, index) =>
    toolResultPart(`${id}-a${index}`, actionBytes),
  );
  if (running) {
    actions.push({
      type: "tool-invocation",
      content: "",
      sourcePartId: `${id}-a${completedActions}`,
      toolUseId: `${id}-a${completedActions}`,
      toolName: "bash",
      toolState: "pending",
    });
  }
  return {
    type: "subagent",
    content: "",
    sourcePartId: id,
    toolUseId: id,
    toolName: "task",
    toolState: running ? "pending" : "success",
    subagentName: "worker",
    subagentActions: actions,
    subagentActionCount: actions.length,
  };
}

/**
 * The same history after a rewind/compaction: messages from `fromIndex` on
 * are replaced by new ids, so no cached position or token may survive it.
 */
export function rewrittenHistory(
  messages: readonly FixtureMessage[],
  fromIndex: number,
  replacementCount: number,
  contentBytes: number,
): FixtureMessage[] {
  return [
    ...messages.slice(0, fromIndex),
    ...Array.from({ length: replacementCount }, (_, index) =>
      textMessage(fromIndex + index, contentBytes, { prefix: "r" }),
    ),
  ];
}

/**
 * A long immutable prefix and one assistant message that changes per step.
 * `tail(step)` returns a fresh object each time, as a streaming bridge does.
 */
export function immutablePrefixWithTail(
  prefixCount: number,
  prefixBytes: number,
  tailStepBytes: number,
): { prefix: FixtureMessage[]; tail: (step: number) => FixtureMessage } {
  const prefix = textMessages(prefixCount, prefixBytes);
  const tailText = prose(tailStepBytes * 256, "ascii", 7);
  return {
    prefix,
    tail: (step) => {
      const content = tailText.slice(0, tailStepBytes * (step + 1));
      return {
        id: `m${prefixCount}`,
        role: "assistant",
        content,
        parts: [{ type: "text", content, sourcePartId: `m${prefixCount}-p0` }],
        createdAt: FIXTURE_CREATED_AT,
      };
    },
  };
}

// --- Codex rollout JSONL ----------------------------------------------------

export const ROLLOUT_EPOCH_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

/** Timestamp of rollout record `index`: one second apart. */
export function rolloutTimestampMs(index: number): number {
  return ROLLOUT_EPOCH_MS + index * 1_000;
}

/** One rollout line: an event record a child fold ignores, with padding. */
export function rolloutLine(index: number, paddingBytes: number): string {
  return `${JSON.stringify({
    timestamp: new Date(rolloutTimestampMs(index)).toISOString(),
    type: "event_msg",
    payload: { type: "token_count", index, padding: prose(paddingBytes, "ascii", index + 1) },
  })}\n`;
}

export function rolloutJsonl(records: number, paddingBytes: number): string {
  return Array.from({ length: records }, (_, index) => rolloutLine(index, paddingBytes)).join("");
}

/**
 * A rollout interrupted mid-write: one corrupt record in the middle and a
 * final record with no terminating newline (a writer that has not finished).
 */
export function interruptedJsonl(records: number, paddingBytes: number): string {
  const lines = Array.from({ length: records }, (_, index) => rolloutLine(index, paddingBytes));
  const middle = Math.floor(records / 2);
  lines[middle] = `${lines[middle]!.slice(0, Math.floor(lines[middle]!.length / 2))}\n`;
  const last = lines[records - 1]!;
  lines[records - 1] = last.slice(0, last.length - Math.floor(last.length / 3));
  return lines.join("");
}

/** Stable, content-free digest of an id list, for parity checks between runs. */
export function idsDigest(ids: readonly string[]): string {
  let hash = 2_166_136_261;
  for (const id of ids) {
    for (let index = 0; index < id.length; index += 1) {
      hash ^= id.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    hash ^= 0x2c;
    hash = Math.imul(hash, 16_777_619);
  }
  return `${ids.length}:${(hash >>> 0).toString(36)}`;
}
