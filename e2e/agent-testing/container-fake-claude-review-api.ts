/**
 * QA stand-in for the Anthropic Messages API that takes a whole Multi Review
 * through the image's real `claude` CLI, with no login and no billed request
 * (to-do 0190, task 3). It runs inside the environment container on its
 * loopback, copied in and started by `container-fake-claude-install.ts`.
 *
 *   bun container-fake-claude-review-api.ts --port 47123 [--log <file>]
 *
 * A turn whose prompt names a Multi Review result tool is scripted, one step
 * per request, following the instructions a real reviewer gets:
 *
 * - Preparation (`submit_validation_plan`, a writable turn): `git rev-parse
 *   HEAD`, then submit a plan with no commands at that HEAD.
 * - A reviewer or consolidation (`submit_review_report`,
 *   `submit_consolidated_review`, read-only turns):
 *   1. `package`: Read the review package the prompt names, if it names one.
 *   2. `list`: `Bash` `ls`, a read-only command with no Git in it. A read-only
 *      turn without the CLI's command sandbox must still run it.
 *   3. `git`: `Bash` with the package's `diffCommand` (or `git rev-parse
 *      HEAD`). Without the sandbox the read-only hook refuses every Git
 *      command, so this is expected to fail in a container.
 *   4. `diff-file`: when Git was refused and the package names a
 *      `diffArtifact`, Read it, as the reviewer instructions say.
 *   5. `write-probe`: `Bash` `touch <probe>`, which the hook must refuse.
 *   6. `tool-search` when the CLI deferred the MCP tools, then `submit`.
 *
 * Every tool call carries its step in its id (`toolu_<step>_<n>`), so the
 * outcome of each step is known without reading any tool output. Anything
 * else (titles, topic checks) gets a plain text reply.
 *
 * With `--log`, each scripted request appends one JSON line: the kind, the
 * step chosen and the error flag of each answered step. Never a prompt, a
 * tool's output, a resultKey or a path. No imports: the file runs on its own
 * inside the image.
 *
 * With `--hold <file>`, a reviewer's request whose answer would be its
 * submission waits while that file exists (at most {@link HOLD_LIMIT_MS}),
 * after logging a `hold` record once, so the turn is still running while a
 * spec reads Agent Info (to-do 0190 task 3). Removing the file
 * releases every held turn.
 */

type Block = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  input?: unknown;
  content?: string | Block[];
  is_error?: boolean;
};
type Message = { role?: string; content?: string | Block[] };
export type ReviewApiBody = {
  model?: string;
  stream?: boolean;
  messages?: Message[];
  tools?: Array<{ name?: string }>;
};

export type ReviewKind = "validation-plan" | "review-report" | "consolidated-review";

const SUBMIT_TOOLS: Record<ReviewKind, string> = {
  "validation-plan": "submit_validation_plan",
  "review-report": "submit_review_report",
  "consolidated-review": "submit_consolidated_review",
};

export const STEP_LABELS = [
  "package",
  "list",
  "git",
  "diff-file",
  "write-probe",
  "tool-search",
  "submit",
] as const;
export type StepLabel = (typeof STEP_LABELS)[number];

/** Names HEAD; the preparation turn's only command and a report turn's fallback Git command. */
export const HEAD_COMMAND = "git rev-parse HEAD";
/** A read-only command with no Git in it. */
export const LIST_COMMAND = "ls";
/** A write inside the checkout, which the read-only hook must refuse. */
export const WRITE_PROBE = "touch .orkestrator-qa-read-only-probe";
const TOOL_SEARCH = "ToolSearch";
const DEFAULT_WORKSPACE = "/workspace";

export type ToolOutcome = { step: StepLabel | null; text: string; isError: boolean };

export type ReviewStep =
  | { kind: "text"; text: string }
  | { kind: "tool"; step: StepLabel; name: string; input: Record<string, unknown> };

type PackageView = {
  baseRef?: string;
  headRef?: string;
  diffCommand?: string;
  diffArtifact?: { path?: string };
};

function blocksText(content: string | Block[] | undefined): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function withoutReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

/** The step a tool-use id carries (`toolu_<step>_<n>`), or null for one this fake did not issue. */
export function stepOfToolUse(id: string | undefined): StepLabel | null {
  const step = /^toolu_([a-z-]+)_/.exec(id ?? "")?.[1];
  return (STEP_LABELS as readonly string[]).includes(step ?? "") ? (step as StepLabel) : null;
}

/** The last real prompt of a request and the outcome of each step answered since. */
export function reviewRequest(body: ReviewApiBody): {
  prompt: string;
  tools: string[];
  outcomes: ToolOutcome[];
} {
  const messages = body.messages ?? [];
  const isToolReturn = (message: Message) =>
    Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result");
  let promptIndex = -1;
  let prompt = "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user" || isToolReturn(message)) continue;
    const raw = blocksText(message.content);
    if (!(withoutReminders(raw) || raw.trim())) continue;
    promptIndex = index;
    prompt = raw;
    break;
  }
  const outcomes: ToolOutcome[] = [];
  for (const message of messages.slice(promptIndex + 1)) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      outcomes.push({
        step: stepOfToolUse(block.tool_use_id),
        text: blocksText(block.content),
        isError: block.is_error === true,
      });
    }
  }
  const tools = (body.tools ?? []).map((tool) => tool.name ?? "").filter(Boolean);
  return { prompt, tools, outcomes };
}

/** Which Multi Review result the prompt asks for, its resultKey and its package path. */
export function reviewSlot(
  prompt: string,
): { kind: ReviewKind; resultKey: string; packagePath?: string } | null {
  const kinds = Object.keys(SUBMIT_TOOLS) as ReviewKind[];
  const kind = kinds.find((candidate) => prompt.includes(`\`${SUBMIT_TOOLS[candidate]}\``));
  const key = /resultKey "([0-9a-fA-F-]{36})"/.exec(prompt)?.[1];
  if (!kind || !key) return null;
  const packagePath = /Read the review package from `([^`]+)`/.exec(prompt)?.[1];
  return { kind, resultKey: key, ...(packagePath ? { packagePath } : {}) };
}

/** The package JSON from a Read result, whose lines carry a line-number prefix. */
export function packageFromRead(text: string): PackageView | null {
  const body = text
    .split("\n")
    .map((line) => line.replace(/^\s*\d+[\t→]/, ""))
    .join("\n")
    .trim();
  try {
    const value = JSON.parse(body) as unknown;
    return value && typeof value === "object" ? (value as PackageView) : null;
  } catch {
    return null;
  }
}

/** A plan with no commands, against the HEAD the turn read. */
export function validationPlan(head: string): Record<string, unknown> {
  return {
    headRef: head,
    commands: [],
    limitations: [
      "QA fixture model: the review runs no validation commands, so nothing was built or tested.",
    ],
  };
}

/** A complete report with no findings: valid for a reviewer and for consolidation. */
export function reviewReport(baseRef: string, readDiff: boolean): Record<string, unknown> {
  return {
    reviewScope: {
      targetBranch: "main",
      baseRef,
      commit: null,
      filesReviewed: [],
      filesSkipped: [],
      filesLeftUncommitted: [],
      commandsRun: [
        {
          command: LIST_COMMAND,
          result: "passed",
          summary: "The read-only listing ran in the review session.",
        },
      ],
      commandsNotRun: [],
      limitations: [
        readDiff
          ? "QA fixture model: the diff was read, but no finding was looked for."
          : "QA fixture model: the diff could not be read and no finding was looked for.",
      ],
      outcome: "reviewed",
      blockedReason: null,
    },
    whatChanged: {
      overview: "The fixture model reviewed the package without judging its content.",
      before: "The branch as it stood before the reviewed change.",
      after: "The branch with the reviewed change applied.",
      keyCodeChanges: [],
      userImpact: "None that this fixture review can state.",
    },
    riskProfile: {
      changeTypes: ["test"],
      riskAreas: [],
      overallRisk: "low",
      reasoning: "A scripted qualification review reports no risk of its own.",
    },
    testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
    strengths: [],
    issues: [],
    testCoverageGaps: [],
    verdict: {
      ready: "yes",
      reasoning: "The scripted qualification review found nothing to fix.",
    },
    summaryOfChange: "A scripted qualification review of the fixture branch.",
    reviewSummary: "No findings: the fixture model looks for none.",
  };
}

function offered(tools: readonly string[], suffix: string): string | undefined {
  return tools.find((name) => name === suffix || name.endsWith(`__${suffix}`));
}

function bash(step: StepLabel, command: string): ReviewStep {
  return { kind: "tool", step, name: "Bash", input: { command, description: "Run the command" } };
}

function read(step: StepLabel, workspace: string, relativePath: string): ReviewStep {
  return { kind: "tool", step, name: "Read", input: { file_path: `${workspace}/${relativePath}` } };
}

/** The next step of a turn. */
export function reviewStep(body: ReviewApiBody, workspace = DEFAULT_WORKSPACE): ReviewStep {
  const { prompt, tools, outcomes } = reviewRequest(body);
  const slot = reviewSlot(prompt);
  if (!slot) return { kind: "text", text: "PONG" };
  const outcome = (step: StepLabel) => outcomes.find((candidate) => candidate.step === step);
  const submitName = SUBMIT_TOOLS[slot.kind];
  const report = slot.kind !== "validation-plan";

  if (report && slot.packagePath && !outcome("package")) {
    return read("package", workspace, slot.packagePath);
  }
  const pkg = packageFromRead(outcome("package")?.text ?? "");
  if (report && !outcome("list")) return bash("list", LIST_COMMAND);
  if (!outcome("git")) {
    return bash("git", report && pkg?.diffCommand ? pkg.diffCommand : HEAD_COMMAND);
  }
  const git = outcome("git")!;
  const head = pkg?.headRef ?? /\b[0-9a-f]{40}\b/.exec(git.text)?.[0];
  if (!report && (git.isError || !head)) {
    return { kind: "text", text: "Git did not answer, so there is no plan." };
  }
  const diffPath = pkg?.diffArtifact?.path;
  if (report && git.isError && diffPath && !outcome("diff-file")) {
    return read("diff-file", workspace, diffPath);
  }
  if (report && !outcome("write-probe")) return bash("write-probe", WRITE_PROBE);

  const submitted = outcome("submit");
  if (submitted) {
    return { kind: "text", text: submitted.isError ? "The submission was refused." : "Submitted." };
  }
  const name = offered(tools, submitName);
  if (name) {
    const readDiff = !git.isError || outcome("diff-file")?.isError === false;
    return {
      kind: "tool",
      step: "submit",
      name,
      input: {
        resultKey: slot.resultKey,
        result: report
          ? reviewReport(pkg?.baseRef ?? head ?? "HEAD", readDiff)
          : validationPlan(head!),
      },
    };
  }
  if (tools.includes(TOOL_SEARCH) && !outcome("tool-search")) {
    return {
      kind: "tool",
      step: "tool-search",
      name: TOOL_SEARCH,
      input: { query: `select:mcp__orkestrator__${submitName}`, max_results: 5 },
    };
  }
  return { kind: "text", text: "The submit tool is not offered." };
}

/** One content-free log line: the step chosen and the error flag of each answered step. */
export function stepRecord(body: ReviewApiBody, step: ReviewStep): Record<string, unknown> {
  const { prompt, outcomes } = reviewRequest(body);
  return {
    kind: reviewSlot(prompt)?.kind ?? "plain",
    step: step.kind === "text" ? "text" : step.step,
    answered: outcomes.map((outcome) => ({ step: outcome.step, error: outcome.isError })),
  };
}

function toolUseId(step: ReviewStep & { kind: "tool" }, id: string): string {
  return `toolu_${step.step}_${id}`;
}

function contentBlocks(step: ReviewStep, id: string): Block[] {
  if (step.kind === "text") return [{ type: "text", text: step.text }];
  return [{ type: "tool_use", id: toolUseId(step, id), name: step.name, input: step.input }];
}

function messageJson(id: string, model: string, step: ReviewStep) {
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: contentBlocks(step, id),
    stop_reason: step.kind === "tool" ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

/** The server-sent event stream the API answers `stream: true` with. */
export function reviewStream(id: string, model: string, step: ReviewStep): string {
  const frames: Array<{ type: string } & Record<string, unknown>> = [
    {
      type: "message_start",
      message: { ...messageJson(id, model, step), content: [], stop_reason: null },
    },
  ];
  if (step.kind === "tool") {
    frames.push(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: toolUseId(step, id), name: step.name, input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(step.input) },
      },
    );
  } else {
    frames.push(
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: step.text } },
    );
  }
  frames.push(
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: step.kind === "tool" ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  );
  return frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
}

/** The longest a held submission waits, so a spec that never releases it cannot wedge a turn. */
export const HOLD_LIMIT_MS = 5 * 60_000;

/**
 * Waits while `hold` exists, logging one `hold` record first. Answers at once
 * when the file is absent.
 */
export async function waitWhileHeld(
  hold: string,
  kind: string,
  log?: (line: string) => void,
  options: { pollMs?: number; limitMs?: number; exists?: (path: string) => Promise<boolean> } = {},
): Promise<boolean> {
  const exists = options.exists ?? ((path: string) => Bun.file(path).exists());
  if (!(await exists(hold))) return false;
  log?.(JSON.stringify({ kind, step: "hold", answered: [] }));
  const deadline = Date.now() + (options.limitMs ?? HOLD_LIMIT_MS);
  while (Date.now() < deadline && (await exists(hold))) {
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 250));
  }
  return true;
}

export async function handleFakeClaudeReviewApi(
  request: Request,
  log?: (line: string) => void,
  hold?: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    return Response.json({ input_tokens: 1 });
  }
  if (request.method !== "POST" || url.pathname !== "/v1/messages") {
    return Response.json(
      { type: "error", error: { type: "not_found_error", message: "fixture" } },
      { status: 404 },
    );
  }
  const body = (await request.json().catch(() => ({}))) as ReviewApiBody;
  const model = body.model ?? "claude-fixture";
  const id = `msg_fixture_${crypto.randomUUID().replaceAll("-", "")}`;
  const step = reviewStep(body);
  const record = stepRecord(body, step);
  if (hold && record.kind === "review-report" && step.kind === "tool" && step.step === "submit") {
    await waitWhileHeld(hold, record.kind, log);
  }
  if (log && record.kind !== "plain") log(JSON.stringify(record));
  if (!body.stream) return Response.json(messageJson(id, model, step));
  return new Response(reviewStream(id, model, step), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

if (import.meta.main) {
  const index = process.argv.indexOf("--port");
  const port = Number(index === -1 ? NaN : process.argv[index + 1]);
  if (!Number.isInteger(port) || port <= 0) throw new Error("--port is required");
  const logIndex = process.argv.indexOf("--log");
  const logPath = logIndex === -1 ? undefined : process.argv[logIndex + 1];
  const { appendFileSync } = await import("node:fs");
  const log = logPath ? (line: string) => appendFileSync(logPath, `${line}\n`) : undefined;
  const holdIndex = process.argv.indexOf("--hold");
  const hold = holdIndex === -1 ? undefined : process.argv[holdIndex + 1];
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    fetch: (request) => handleFakeClaudeReviewApi(request, log, hold),
  });
}
