/**
 * The debug button's one-click pipeline environment (`create_debug_build`).
 *
 * With Settings → Debug → "Debug button" on, the bottom bar shows a button
 * that captures the window, asks for a Problem / objective and an optional
 * Expected result, and submits one request. The backend owns everything after
 * that: it reads the source environment's details and agent transcript,
 * writes a ticket whose description and acceptance criteria come from what
 * the user typed, attaches the screenshot and the transcript, and launches
 * exactly one build pipeline (a pipeline environment) on the saved Build
 * defaults. Nothing else is started.
 *
 * The ticket text is built here, deterministically, so the renderer can show
 * what will be filed and the backend files the same thing. No model is asked
 * to rewrite the user's words; the build agent reads them as written.
 *
 * This module is shared with the browser; it must stay free of Node APIs.
 */

export const MAX_DEBUG_BUILD_PROBLEM_LENGTH = 20_000;
export const MAX_DEBUG_BUILD_EXPECTED_LENGTH = 20_000;
/** A base64 PNG of the window; the backend still checks the decoded size. */
export const MAX_DEBUG_BUILD_SCREENSHOT_LENGTH = 12 * 1024 * 1024;
/** The filename the screenshot is attached to the ticket under. */
export const DEBUG_BUILD_SCREENSHOT_FILENAME = "debug-screenshot.webp";
/** How much of the source transcript the ticket carries, across all its tabs. */
export const DEBUG_BUILD_TRANSCRIPT_MAX_CHARS = 80_000;
/** The most any one tab's transcript may take of that budget. */
export const DEBUG_BUILD_TAB_TRANSCRIPT_MAX_CHARS = 60_000;
/** Criteria generated from the Expected result; the rest stay in its text. */
export const MAX_DEBUG_BUILD_CRITERIA = 20;

export interface CreateDebugBuildInput {
  /** The environment the user was looking at when they pressed the button. */
  environmentId: string;
  /** Required: what is wrong, or what the user wants done. */
  problem: string;
  /** Optional: what should happen instead, or how to tell it is done. */
  expectedResult?: string;
  /** Base64 PNG of the window without the dialog; absent when unticked. */
  screenshot?: string;
  /**
   * Idempotency key: a retry of a create whose answer was lost returns the
   * same ticket and pipeline. Bound to the rest of the request.
   */
  requestId: string;
}

export interface CreateDebugBuildResult {
  taskId: string;
  pipelineId: string;
  /** The project the ticket and pipeline belong to (the source's). */
  projectId: string;
  /** Absent until the pipeline has created the environment. */
  environmentId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INPUT_KEYS = new Set([
  "environmentId",
  "problem",
  "expectedResult",
  "screenshot",
  "requestId",
]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

export function isCreateDebugBuildInput(value: unknown): value is CreateDebugBuildInput {
  if (!isRecord(value)) return false;
  if (!Object.keys(value).every((key) => INPUT_KEYS.has(key) || value[key] === undefined)) {
    return false;
  }
  return (
    typeof value.environmentId === "string" &&
    value.environmentId.trim().length > 0 &&
    value.environmentId.length <= 256 &&
    typeof value.problem === "string" &&
    value.problem.trim().length > 0 &&
    value.problem.length <= MAX_DEBUG_BUILD_PROBLEM_LENGTH &&
    (value.expectedResult === undefined ||
      (typeof value.expectedResult === "string" &&
        value.expectedResult.length <= MAX_DEBUG_BUILD_EXPECTED_LENGTH)) &&
    (value.screenshot === undefined ||
      (typeof value.screenshot === "string" &&
        value.screenshot.length > 0 &&
        value.screenshot.length <= MAX_DEBUG_BUILD_SCREENSHOT_LENGTH &&
        BASE64.test(value.screenshot))) &&
    typeof value.requestId === "string" &&
    value.requestId.trim().length > 0 &&
    value.requestId.length <= 256
  );
}

/**
 * What a debug-build idempotency key stands for: the request minus the key.
 * The screenshot is represented by its length and ends, so the identity stays
 * small while a different capture is still a different request.
 */
export function debugBuildRequestIdentity(request: CreateDebugBuildInput): string {
  const screenshot = request.screenshot
    ? `${request.screenshot.length}:${request.screenshot.slice(0, 64)}:${request.screenshot.slice(-64)}`
    : null;
  return JSON.stringify([
    request.environmentId.trim(),
    request.problem.trim(),
    request.expectedResult?.trim() ?? "",
    screenshot,
  ]);
}

/** One agent tab of the source environment, as the ticket describes it. */
export interface DebugBuildSourceTab {
  tabId: string;
  agent: string;
  title: string | null;
  /** The tab the environment had in front. */
  front: boolean;
  /** Whether its transcript is attached (as a ticket comment). */
  transcript: "attached" | "empty" | "unavailable" | "omitted";
}

/** The source environment's details, as written into the ticket. */
export interface DebugBuildSourceDetails {
  environmentId: string;
  name: string;
  projectId: string;
  projectName?: string;
  environmentType: string;
  status?: string;
  branch?: string;
  worktreePath?: string;
  prUrl?: string | null;
  createdAt?: string;
  /** When the debug button was pressed (the request reached the backend). */
  capturedAt: string;
  tabs: DebugBuildSourceTab[];
}

export interface DebugBuildTicket {
  /** Short, derived from the problem; the backend may refine it later. */
  title: string;
  description: string;
  acceptanceCriteria: string;
}

const TITLE_MAX_CHARS = 72;

function collapse(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * The user's text with markdown headings neutralised, so a `## Something`
 * line they typed cannot split the ticket into sections it never meant.
 */
function quoteUserText(text: string): string {
  return text
    .trim()
    .split(/\r\n|\r|\n/u)
    .map((line) => (/^\s{0,3}#/u.test(line) ? line.replace("#", "\\#") : line))
    .join("\n");
}

function truncateOnWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const boundary = slice.search(/\s+\S*$/u);
  return `${(boundary > max / 2 ? slice.slice(0, boundary) : slice).trim()}…`;
}

/** First sentence (or line) of the problem, the ticket's short title. */
export function debugBuildTitle(problem: string): string {
  const firstLine =
    problem
      .trim()
      .split(/\r\n|\r|\n/u)
      .find((line) => line.trim()) ?? "";
  const sentence = collapse(firstLine).split(/(?<=[.!?])\s/u)[0] ?? "";
  const cleaned = sentence.replace(/^[-*•\d.)\s]+/u, "").replace(/[.!?]+$/u, "");
  const title = truncateOnWord(cleaned, TITLE_MAX_CHARS);
  if (!/\p{L}|\p{N}/u.test(title)) return "Debug request";
  return `${title.charAt(0).toUpperCase()}${title.slice(1)}`;
}

/**
 * The acceptance criteria the user's input implies.
 *
 * An Expected result is split into its lines (list markers dropped); a single
 * paragraph is one criterion. Without one, the problem itself is the one
 * criterion. Nothing is invented beyond what the user wrote.
 */
export function debugBuildCriteria(problem: string, expectedResult?: string): string[] {
  const expected = expectedResult?.trim() ?? "";
  if (expected) {
    const lines = expected
      .split(/\r\n|\r|\n/u)
      .map((line) => collapse(line.replace(/^\s*(?:[-*•]|\d+[.)]|\[[ xX]\])\s+/u, "")))
      .filter(Boolean);
    const listed = expected.split(/\r\n|\r|\n/u).filter((line) => line.trim()).length > 1;
    const criteria = listed ? lines : [collapse(expected)];
    const kept = criteria.slice(0, MAX_DEBUG_BUILD_CRITERIA);
    if (criteria.length > kept.length) {
      kept.push("Every other point listed under Expected result in the summary holds.");
    }
    return kept;
  }
  return [
    `The problem or objective in the summary is resolved: ${truncateOnWord(collapse(problem), 500)}`,
  ];
}

function sourceLines(source: DebugBuildSourceDetails, screenshotAttached: boolean): string[] {
  const lines = [
    `- Environment ID: \`${source.environmentId}\``,
    `- Environment name: ${source.name}`,
    `- Project: ${source.projectName ? `${source.projectName} ` : ""}(\`${source.projectId}\`)`,
    `- Type: ${source.environmentType === "local" ? "local worktree" : source.environmentType === "containerized" ? "container" : source.environmentType}`,
  ];
  if (source.status) lines.push(`- Status: ${source.status}`);
  if (source.branch) lines.push(`- Branch: \`${source.branch}\``);
  if (source.worktreePath) lines.push(`- Worktree: \`${source.worktreePath}\``);
  if (source.prUrl) lines.push(`- Pull request: ${source.prUrl}`);
  if (source.createdAt) lines.push(`- Environment created: ${source.createdAt}`);
  lines.push(`- Captured: ${source.capturedAt}`);
  lines.push(
    screenshotAttached
      ? `- Screenshot: attached as \`${DEBUG_BUILD_SCREENSHOT_FILENAME}\`, the window as the user saw it when they pressed the debug button.`
      : "- Screenshot: not attached.",
  );
  if (source.tabs.length === 0) {
    lines.push("- Agent tabs: none.");
  } else {
    lines.push("- Agent tabs:");
    for (const tab of source.tabs) {
      const label = tab.title ? `"${collapse(tab.title)}"` : "untitled";
      const transcript =
        tab.transcript === "attached"
          ? "transcript attached as a ticket comment"
          : tab.transcript === "empty"
            ? "no conversation yet"
            : tab.transcript === "unavailable"
              ? "transcript could not be read"
              : "transcript left out (size limit)";
      lines.push(
        `  - ${label} (${tab.agent}, tab \`${tab.tabId}\`)${tab.front ? ", in front" : ""}: ${transcript}`,
      );
    }
  }
  return lines;
}

/**
 * The ticket the debug button files.
 *
 * - Summary: the Problem / objective as typed, then the Expected result.
 * - Context: the source environment's ID and details, and where the
 *   screenshot and transcript are.
 * - Acceptance criteria: {@link debugBuildCriteria}.
 */
export function debugBuildTicket(options: {
  problem: string;
  expectedResult?: string;
  source: DebugBuildSourceDetails;
  screenshotAttached: boolean;
}): DebugBuildTicket {
  const problem = quoteUserText(options.problem);
  const expected = options.expectedResult?.trim() ? quoteUserText(options.expectedResult) : "";
  const summary = [
    "**Problem / objective** (as reported with the debug button):",
    "",
    problem,
    ...(expected ? ["", "**Expected result**:", "", expected] : []),
  ].join("\n");
  const context = [
    "## Context",
    "",
    `Raised from environment **${collapse(options.source.name)}** with the debug button. The details below, and the screenshot and agent transcripts where attached, are the evidence for this ticket; reproduce or inspect from them before changing code.`,
    "",
    ...sourceLines(options.source, options.screenshotAttached),
  ].join("\n");
  const criteria = debugBuildCriteria(options.problem, options.expectedResult);
  return {
    title: debugBuildTitle(options.problem),
    description: `${summary}\n\n${context}`,
    acceptanceCriteria: criteria.map((criterion) => `- ${criterion}`).join("\n"),
  };
}

/** One transcript message reduced to what a ticket comment carries. */
export interface DebugTranscriptMessage {
  role: string;
  createdAt: string | null;
  text: string;
  textTruncated: boolean;
  parts: Array<{ type: string; toolName?: string; status?: string; title?: string }>;
}

function renderMessage(message: DebugTranscriptMessage, index: number): string {
  const when = message.createdAt ? ` · ${message.createdAt}` : "";
  const lines = [`#### ${index + 1}. ${message.role}${when}`];
  const text = message.text.trim();
  if (text) {
    lines.push("", text.replace(/^(\s{0,3})#/gmu, "$1\\#"));
    if (message.textTruncated) lines.push("", "_[message text truncated]_");
  }
  const tools = message.parts.filter((part) => part.toolName || part.title);
  if (tools.length > 0) {
    lines.push("");
    for (const part of tools.slice(0, 40)) {
      const name = part.toolName ? `\`${part.toolName}\`` : part.type;
      const status = part.status ? ` (${part.status})` : "";
      const title = part.title ? `: ${collapse(part.title)}` : "";
      lines.push(`- ${name}${status}${title}`);
    }
    if (tools.length > 40) lines.push(`- … ${tools.length - 40} more tool calls`);
  }
  return lines.join("\n");
}

/**
 * One tab's transcript as a ticket comment, within `maxChars`.
 *
 * The first message (the task as first given) is kept, then the newest that
 * fit, in order; what was left out is said, never silently dropped. Tool
 * inputs and outputs are not included, only each call's name, status and
 * title.
 */
export function debugTranscriptComment(options: {
  tab: Pick<DebugBuildSourceTab, "tabId" | "agent" | "title">;
  environmentId: string;
  messages: readonly DebugTranscriptMessage[];
  /** The transcript reached its first message; false when older history was not read. */
  complete: boolean;
  maxChars: number;
}): string {
  const label = options.tab.title ? `"${collapse(options.tab.title)}"` : "untitled tab";
  const header = `### Source transcript: ${label} (${options.tab.agent}, environment \`${options.environmentId}\`, tab \`${options.tab.tabId}\`)`;
  const rendered = options.messages.map(renderMessage);
  const budget = Math.max(0, options.maxChars - header.length - 400);
  const keep = new Set<number>();
  let used = 0;
  const take = (index: number): boolean => {
    const size = rendered[index]!.length + 2;
    if (used + size > budget) return false;
    keep.add(index);
    used += size;
    return true;
  };
  if (rendered.length > 0) take(0);
  for (let index = rendered.length - 1; index > 0; index--) {
    if (!take(index)) break;
  }
  const parts: string[] = [header];
  if (!options.complete) {
    parts.push(
      "_Older history than the first message below was not available to read; the transcript starts part-way._",
    );
  }
  let omittedRun = 0;
  for (let index = 0; index < rendered.length; index++) {
    if (keep.has(index)) {
      if (omittedRun > 0) {
        parts.push(`_[${omittedRun} message${omittedRun === 1 ? "" : "s"} omitted for length]_`);
        omittedRun = 0;
      }
      parts.push(rendered[index]!);
    } else {
      omittedRun++;
    }
  }
  if (omittedRun > 0) {
    parts.push(`_[${omittedRun} message${omittedRun === 1 ? "" : "s"} omitted for length]_`);
  }
  if (rendered.length === 0) parts.push("_No messages._");
  return parts.join("\n\n").slice(0, Math.max(options.maxChars, header.length));
}
