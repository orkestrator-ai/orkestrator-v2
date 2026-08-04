/** Small, normalized facts parsed from a Claude Code tmux pane. */

export interface TmuxAgentUsageSummary {
  name: string;
  role?: string;
  toolUseCount?: number;
  tokenCount: number;
  tokenCountText: string;
}

export interface TmuxSelectionOption {
  number: number;
  label: string;
  optionIndex: number;
  selected: boolean;
}

export interface TmuxSelectionPrompt {
  question: string | null;
  options: TmuxSelectionOption[];
  selectedOptionIndex: number | null;
  inputMode: "navigate" | "number";
}

export interface TmuxAgentObservation {
  /** Opaque backend session-instance id; revision numbers are scoped to it. */
  generation?: string;
  revision: number;
  observedAt: string;
  usage: TmuxAgentUsageSummary[];
  prompt: TmuxSelectionPrompt | null;
}

const AGENT_ROLE_COLUMN_RE = /^[\p{L}\p{N}_-]+$/u;
const AGENT_HEADER_RE = /\bRunning[ \t]+(?<count>\d+)[ \t]+(?<role>[^\r\n]+?)[ \t]+agents?\b/i;
const TOOL_USE_COLUMN_RE = /^(?<count>\d[\d,]*)[ \t]+tools?[ \t]+uses?$/i;
const TOKEN_COLUMN_RE = /^(?<tokens>\d[\d,.]*(?:[kKmMbB])?)[ \t]+tokens?$/i;
const TOKEN_SUFFIX_RE = /(?<tokens>\d[\d,.]*(?:[kKmMbB])?)[ \t]+tokens?[ \t]*$/i;
const DURATION_SUFFIX_RE = /(?:\d+[ \t]*[hms][ \t]*)+$/i;
const SELECTION_PROMPT_HINT =
  /Enter\s+to\s+(?:select|confirm)|Tab\/Arrow\s+keys\s+to\s+navigate|Esc\s+to\s+cancel/i;

// Pane text is untrusted agent output and is parsed on the backend event loop.
// Keep every scan bounded, and do not run pattern matching against abnormally
// wide lines. Normal Claude TUI rows are far smaller than these limits.
const MAX_SNAPSHOT_CHARS = 256 * 1024;
const MAX_SNAPSHOT_LINES = 4_096;
const MAX_PATTERN_LINE_CHARS = 1_024;
const MAX_PROMPT_BLOCK_LINES = 64;
const MAX_PROMPT_HINT_GAP_LINES = 2;

export function stripTmuxAnsi(text: string): string {
  // A small state machine keeps stripping linear even for unterminated OSC/DCS
  // input. Regexes of the form `[^BEL]*(BEL|ST)` can repeatedly rescan hostile
  // strings and turn terminal observation into a backend-wide CPU stall.
  const result: string[] = [];
  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index);
    if (code === 0x1b) {
      const introducer = text[index + 1];
      if (introducer === "[") {
        index += 2;
        while (index < text.length) {
          const value = text.charCodeAt(index);
          index += 1;
          if (value >= 0x40 && value <= 0x7e) break;
        }
        continue;
      }
      if (introducer === "]") {
        index += 2;
        while (index < text.length) {
          if (text.charCodeAt(index) === 0x07) {
            index += 1;
            break;
          }
          if (text.charCodeAt(index) === 0x1b && text[index + 1] === "\\") {
            index += 2;
            break;
          }
          index += 1;
        }
        continue;
      }
      if (introducer === "P" || introducer === "_" || introducer === "^" || introducer === "X") {
        index += 2;
        while (index < text.length) {
          if (text.charCodeAt(index) === 0x1b && text[index + 1] === "\\") {
            index += 2;
            break;
          }
          index += 1;
        }
        continue;
      }
      // Charset selection sequences such as ESC(B contain one additional byte.
      index += introducer === "(" || introducer === ")"
        ? Math.min(3, text.length - index)
        : Math.min(2, text.length - index);
      continue;
    }
    // tmux captures may contain cursor-return/backspace controls. They are not
    // useful parser input and must not split otherwise visible hint text.
    if (code !== 0x0d && code !== 0x08) result.push(text[index]!);
    index += 1;
  }
  return result.join("");
}

function boundedSnapshotLines(snapshot: string): string[] {
  const bounded = snapshot.length > MAX_SNAPSHOT_CHARS
    ? snapshot.slice(-MAX_SNAPSHOT_CHARS)
    : snapshot;
  const lines = stripTmuxAnsi(bounded).split(/\r?\n/);
  return lines.length > MAX_SNAPSHOT_LINES
    ? lines.slice(-MAX_SNAPSHOT_LINES)
    : lines;
}

function stripTreePrefix(line: string): string {
  return line.trim().replace(/^[│├└┌┐┘┴┬─╭╰╮╯┼┤○●◦∙\s]+/, "").trim();
}

function hasAgentLineMarker(line: string): boolean {
  return /^[│├└┌┐┘┴┬─╭╰╮╯┼┤○●◦∙\s]*[├└○●◦∙]/u.test(line);
}

function parseCompactNumber(value: string): number | null {
  const cleaned = value.trim().replaceAll(",", "");
  const match = /^(?<amount>\d+(?:\.\d+)?)(?<suffix>[kKmMbB])?$/.exec(cleaned);
  if (!match?.groups) return null;
  const amount = Number(match.groups.amount);
  if (!Number.isFinite(amount)) return null;
  const suffix = match.groups.suffix?.toLowerCase();
  const multiplier = suffix === "k"
    ? 1_000
    : suffix === "m"
      ? 1_000_000
      : suffix === "b"
        ? 1_000_000_000
        : 1;
  return Math.round(amount * multiplier);
}

export function parseTmuxAgentUsageSummaries(
  snapshot: string,
): TmuxAgentUsageSummary[] {
  const summaries: TmuxAgentUsageSummary[] = [];
  let currentRole: string | undefined;
  let remainingHeaderRows = 0;
  for (const rawLine of boundedSnapshotLines(snapshot)) {
    if (rawLine.length > MAX_PATTERN_LINE_CHARS) continue;
    const line = stripTreePrefix(rawLine);
    if (!line) continue;
    const headerMatch = AGENT_HEADER_RE.exec(line);
    if (headerMatch?.groups?.role && headerMatch.groups.count) {
      currentRole = headerMatch.groups.role.trim();
      remainingHeaderRows = Number.parseInt(headerMatch.groups.count, 10);
      continue;
    }

    const columns = line.split(/[·•]/u).map((column) => column.trim());
    const toolColumn = columns.length >= 3 ? TOOL_USE_COLUMN_RE.exec(columns[1] ?? "") : null;
    const tokenColumn = columns.length >= 3 ? TOKEN_COLUMN_RE.exec(columns[2] ?? "") : null;
    if (toolColumn?.groups?.count && tokenColumn?.groups?.tokens) {
      const name = columns[0] ?? "";
      const uses = toolColumn.groups.count;
      const tokens = tokenColumn.groups.tokens;
      const toolUseCount = Number(uses.replaceAll(",", ""));
      const tokenCount = parseCompactNumber(tokens);
      if (!name || !Number.isFinite(toolUseCount) || tokenCount === null) continue;
      summaries.push({
        name,
        role: remainingHeaderRows > 0 ? currentRole : undefined,
        toolUseCount,
        tokenCount,
        tokenCountText: `${tokens} tokens`,
      });
      if (remainingHeaderRows > 0 && --remainingHeaderRows === 0) currentRole = undefined;
      continue;
    }

    const tokenOnly = TOKEN_SUFFIX_RE.exec(line);
    const tokens = tokenOnly?.groups?.tokens;
    if (!tokenOnly || !tokens) continue;
    const label = line.slice(0, tokenOnly.index).trimEnd()
      .replace(/[↓↑↕][ \t]*$/u, "")
      .replace(/[·•][ \t]*$/u, "")
      .replace(DURATION_SUFFIX_RE, "")
      .trimEnd();
    if (!label || !tokens) continue;
    const [first, ...rest] = label.split(/\s{2,}/);
    const hasRole = Boolean(first && rest.length > 0 && AGENT_ROLE_COLUMN_RE.test(first));
    const inlineRole = hasRole ? first!.trim() : undefined;
    const name = hasRole ? rest.join(" ").trim() : label;
    const markedAgentRow = hasAgentLineMarker(rawLine);
    if (!inlineRole && !markedAgentRow) continue;
    const tokenCount = parseCompactNumber(tokens);
    if (!name || tokenCount === null) continue;
    summaries.push({
      name,
      role: inlineRole ?? (remainingHeaderRows > 0 ? currentRole : undefined),
      tokenCount,
      tokenCountText: `${tokens} tokens`,
    });
    if (remainingHeaderRows > 0 && --remainingHeaderRows === 0) currentRole = undefined;
  }
  return summaries;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

function parseSelectionOptionLine(
  line: string,
): { prefix: string; number: number; label: string } | null {
  const match = line.match(/^(\s*(?:[>›❯▸➜→]\s*)?)(\d+)\.\s+(.+?)\s*$/);
  if (!match) return null;
  const number = Number.parseInt(match[2] ?? "", 10);
  const label = (match[3] ?? "").trim();
  return Number.isFinite(number) && label
    ? { prefix: match[1] ?? "", number, label }
    : null;
}

function isBoundary(line: string): boolean {
  return /^-{6,}$/.test(line);
}

function isContextParagraph(lines: string[]): boolean {
  if (lines.length === 0) return false;
  const text = lines.join(" ");
  return !lines.every(isBoundary)
    && !/^\[[^\]]+\]/.test(text)
    && !/^[^@\s]+@[^$#]+[$#]\s*$/.test(text)
    && !lines.every((line) => /^\d+\.\s+/.test(line));
}

function selectionQuestion(lines: string[], optionBlockStart: number): string | null {
  let end = optionBlockStart;
  while (end > 0 && lines[end - 1]?.trim() === "") end -= 1;
  let start = end;
  while (start > 0 && lines[start - 1]?.trim() !== "") start -= 1;
  const barePointer = /^https?:\/\/\S+$/i.test(
    lines.slice(start, end).map((line) => line.trim()).filter(Boolean).join(" "),
  );
  if (barePointer) {
    let cursor = start;
    while (cursor > 0) {
      let previousEnd = cursor;
      while (previousEnd > 0 && lines[previousEnd - 1]?.trim() === "") previousEnd -= 1;
      if (previousEnd <= 0) break;
      let previousStart = previousEnd;
      while (previousStart > 0 && lines[previousStart - 1]?.trim() !== "") previousStart -= 1;
      const raw = lines.slice(previousStart, previousEnd).map((line) => line.trim()).filter(Boolean);
      const boundary = findLastIndex(raw, isBoundary);
      const paragraph = boundary >= 0 ? raw.slice(boundary + 1) : raw;
      if (!isContextParagraph(paragraph)) break;
      start = boundary >= 0 ? previousStart + boundary + 1 : previousStart;
      cursor = start;
      if (boundary >= 0) break;
    }
  }
  while (start < end && isBoundary(lines[start]?.trim() ?? "")) start += 1;
  const question = lines.slice(start, end).map((line) => line.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
  return question || null;
}

export function parseTmuxSelectionPrompt(snapshot: string): TmuxSelectionPrompt | null {
  const lines = boundedSnapshotLines(snapshot).map((line) => line.trimEnd());
  const hintIndex = findLastIndex(lines, (line) => line.trim() !== "");
  if (hintIndex < 0) return null;
  const hintLine = lines[hintIndex] ?? "";
  if (hintLine.length > MAX_PATTERN_LINE_CHARS || !SELECTION_PROMPT_HINT.test(hintLine)) {
    return null;
  }
  return parseSelectionPromptAtHint(lines, hintIndex);
}

/** Stable semantic identity used to bind a UI action to one observed prompt. */
export function tmuxSelectionPromptFingerprint(prompt: TmuxSelectionPrompt): string {
  return JSON.stringify({
    question: prompt.question,
    options: prompt.options.map(({ number, label, optionIndex, selected }) => ({
      number,
      label,
      optionIndex,
      selected,
    })),
    selectedOptionIndex: prompt.selectedOptionIndex,
    inputMode: prompt.inputMode,
  });
}

function parseSelectionPromptAtHint(
  lines: string[],
  hintIndex: number,
): TmuxSelectionPrompt | null {
  let blockEnd = hintIndex;
  let gapLines = 0;
  while (blockEnd > 0 && lines[blockEnd - 1]?.trim() === "") {
    gapLines += 1;
    if (gapLines > MAX_PROMPT_HINT_GAP_LINES) return null;
    blockEnd -= 1;
  }
  let blockStart = blockEnd;
  let scannedLines = 0;
  while (blockStart > 0 && scannedLines < MAX_PROMPT_BLOCK_LINES) {
    const line = lines[blockStart - 1] ?? "";
    if (line.length > MAX_PATTERN_LINE_CHARS) break;
    if (parseSelectionOptionLine(line)) {
      blockStart -= 1;
      scannedLines += 1;
      continue;
    }
    // Wrapped Ink labels are indented below their numbered option. This branch
    // must also work before the reverse scan has encountered an option.
    if (/^[ \t]{2,}\S/.test(line)) {
      blockStart -= 1;
      scannedLines += 1;
      continue;
    }
    break;
  }
  const options: TmuxSelectionOption[] = [];
  let selectedOptionIndex: number | null = null;
  let optionBlockStart = -1;
  for (let lineIndex = blockStart; lineIndex < blockEnd; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const parsed = parseSelectionOptionLine(line);
    if (!parsed) {
      const previous = options.at(-1);
      if (previous && line.trim()) previous.label = `${previous.label} ${line.trim()}`;
      continue;
    }
    if (optionBlockStart < 0) optionBlockStart = lineIndex;
    const selected = /[>›❯▸➜→]/.test(parsed.prefix);
    const optionIndex = options.length;
    if (selected) selectedOptionIndex = optionIndex;
    options.push({
      number: parsed.number,
      label: parsed.label,
      optionIndex,
      selected,
    });
  }
  if (options.length === 0 || optionBlockStart < 0) return null;
  if (options.some((option, index) => option.number !== index + 1)) return null;
  const hintLine = lines[hintIndex] ?? "";
  const navigates = /(?:Tab\/Arrow|Arrow\s+keys?|[↑↓].*navigate|navigate)/i.test(hintLine);
  return {
    question: selectionQuestion(lines, optionBlockStart),
    options,
    selectedOptionIndex,
    inputMode: /Enter\s+to\s+confirm/i.test(hintLine) && !navigates
      ? "number"
      : "navigate",
  };
}

export function parseTmuxAgentObservation(
  snapshot: string,
  revision: number,
  observedAt: string,
): TmuxAgentObservation {
  return {
    revision,
    observedAt,
    usage: parseTmuxAgentUsageSummaries(snapshot),
    prompt: parseTmuxSelectionPrompt(snapshot),
  };
}
