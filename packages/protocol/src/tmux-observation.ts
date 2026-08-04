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
  selectedOptionIndex: number;
  inputMode: "navigate" | "number";
}

export interface TmuxAgentObservation {
  revision: number;
  observedAt: string;
  usage: TmuxAgentUsageSummary[];
  prompt: TmuxSelectionPrompt | null;
}

const AGENT_USAGE_RE =
  /^(?<name>.+?)\s*[·•]\s*(?<toolUseCount>\d[\d,]*)\s+tools?\s+uses?\s*[·•]\s*(?<tokens>\d[\d,.]*(?:[kKmMbB])?)\s+tokens?\b/;
const AGENT_TOKEN_USAGE_RE =
  /^(?<label>.+?)\s{2,}(?:(?<duration>(?:\d+\s*[hms]\s*)+)\s*(?:[·•]\s*)?)?[↓↑↕]?\s*(?<tokens>\d[\d,.]*(?:[kKmMbB])?)\s+tokens?\s*$/iu;
const AGENT_ROLE_COLUMN_RE = /^[\p{L}\p{N}_-]+$/u;
const AGENT_HEADER_RE = /\bRunning\s+\d+\s+(?<role>.+?)\s+agents?\b/i;
const SELECTION_PROMPT_HINT =
  /Enter\s+to\s+(?:select|confirm)|Tab\/Arrow\s+keys\s+to\s+navigate|Esc\s+to\s+cancel/i;

export function stripTmuxAnsi(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
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
  for (const rawLine of stripTmuxAnsi(snapshot).split("\n")) {
    const line = stripTreePrefix(rawLine);
    if (!line) continue;
    const headerMatch = AGENT_HEADER_RE.exec(line);
    if (headerMatch?.groups?.role) currentRole = headerMatch.groups.role.trim();

    const match = AGENT_USAGE_RE.exec(line);
    if (match?.groups) {
      const name = match.groups.name;
      const uses = match.groups.toolUseCount;
      const tokens = match.groups.tokens;
      if (!name || !uses || !tokens) continue;
      const toolUseCount = Number(uses.replaceAll(",", ""));
      const tokenCount = parseCompactNumber(tokens);
      if (!Number.isFinite(toolUseCount) || tokenCount === null) continue;
      summaries.push({
        name: name.trim(),
        role: currentRole,
        toolUseCount,
        tokenCount,
        tokenCountText: `${tokens} tokens`,
      });
      continue;
    }

    const tokenOnly = AGENT_TOKEN_USAGE_RE.exec(line);
    if (!tokenOnly?.groups) continue;
    const label = tokenOnly.groups.label?.trim();
    const tokens = tokenOnly.groups.tokens;
    if (!label || !tokens) continue;
    const [first, ...rest] = label.split(/\s{2,}/);
    const hasRole = Boolean(first && rest.length > 0 && AGENT_ROLE_COLUMN_RE.test(first));
    const inlineRole = hasRole ? first!.trim() : undefined;
    const name = hasRole ? rest.join(" ").trim() : label;
    if (!inlineRole && !currentRole && !hasAgentLineMarker(rawLine)) continue;
    const tokenCount = parseCompactNumber(tokens);
    if (!name || tokenCount === null) continue;
    summaries.push({
      name,
      role: inlineRole ?? currentRole,
      tokenCount,
      tokenCountText: `${tokens} tokens`,
    });
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
  if (!SELECTION_PROMPT_HINT.test(snapshot)) return null;
  const lines = snapshot.split(/\r?\n/).map((line) => stripTmuxAnsi(line).trimEnd());
  const hintIndex = findLastIndex(lines, (line) => SELECTION_PROMPT_HINT.test(line));
  if (hintIndex < 0) return null;
  let blockEnd = hintIndex;
  while (blockEnd > 0 && lines[blockEnd - 1]?.trim() === "") blockEnd -= 1;
  let blockStart = blockEnd;
  let sawOption = false;
  while (blockStart > 0) {
    const line = lines[blockStart - 1] ?? "";
    if (parseSelectionOptionLine(line)) {
      sawOption = true;
      blockStart -= 1;
      continue;
    }
    if (sawOption && /^\s+\S/.test(line)) {
      blockStart -= 1;
      continue;
    }
    break;
  }
  const options: TmuxSelectionOption[] = [];
  let selectedOptionIndex = -1;
  for (const line of lines.slice(blockStart, blockEnd)) {
    const parsed = parseSelectionOptionLine(line);
    if (!parsed) {
      const previous = options.at(-1);
      if (previous && line.trim()) previous.label = `${previous.label} ${line.trim()}`;
      continue;
    }
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
  if (options.length === 0) return null;
  const hintLine = lines[hintIndex] ?? "";
  const navigates = /(?:Tab\/Arrow|Arrow\s+keys?|[↑↓].*navigate|navigate)/i.test(hintLine);
  return {
    question: selectionQuestion(lines, blockStart),
    options,
    selectedOptionIndex: selectedOptionIndex >= 0 ? selectedOptionIndex : 0,
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
