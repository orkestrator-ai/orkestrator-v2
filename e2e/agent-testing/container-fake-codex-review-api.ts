/**
 * QA stand-in for OpenAI's Responses WebSocket that takes a Multi Review
 * through the real `codex` CLI, with no login and no billed request (to-do
 * 7872 (retired) task 1). It runs on its own: inside an environment container
 * on its loopback, copied in by `container-multi-review-codex-read-only.spec.ts`,
 * or on the host for `live-read-only-reviewer-turn.test.ts` in the Codex
 * bridge.
 *
 *   bun container-fake-codex-review-api.ts --port 47124 [--log <file>]
 *
 * The pinned Codex runs in code mode: the model's only tool is `exec`, a
 * JavaScript cell whose `tools` object holds `exec_command`, `apply_patch`
 * and every MCP tool (`tools.mcp__orkestrator__submit_review_report`). A turn
 * whose prompt names a Multi Review result tool is scripted, one cell per
 * request, following the instructions a real reviewer gets:
 *
 * - Preparation (`submit_validation_plan`, a writable turn): `git rev-parse
 *   HEAD`, then submit a plan with no commands at that HEAD.
 * - A reviewer or consolidation (`submit_review_report`,
 *   `submit_consolidated_review`, read-only turns):
 *   1. `package`: `cat` the review package the prompt names, if it names one.
 *   2. `list`: `ls`. A read-only turn without Codex's command sandbox runs it
 *      through the bridge's exec-policy rules, without asking.
 *   3. `git`: the package's `diffCommand` (or `git rev-parse HEAD`). The
 *      rules leave `git diff` out, so in a sandbox-off turn Codex asks and
 *      the bridge declines it.
 *   4. `diff-file`: when Git did not run and the package names a
 *      `diffArtifact`, `cat` it, as the reviewer instructions say.
 *   5. `write-probe`: `touch <probe>`, which the bridge must decline.
 *   6. `patch`: `apply_patch` adding a file, which the bridge must decline.
 *   7. `submit`: the MCP submit tool, which must run without an approval.
 *
 * Each cell prints one `ORKQA {...}` line saying whether its call ran, its
 * exit code and (for the package only) the fields the script needs, so a
 * step's outcome is known without the fake keeping any file content. A call
 * the bridge declined throws inside the cell (`rejected by user`), so it
 * reads as `ran: false`. Anything else (titles, topic checks) gets a plain
 * text reply.
 *
 * With `--log`, each scripted request appends one JSON line: the kind, the
 * step chosen and the error flag of each answered step (the same shape as
 * `container-fake-claude-review-api.ts`). Never a prompt, a tool's output, a
 * resultKey or a path. No imports: the file runs on its own inside the image.
 */

type ContentPart = { type?: string; text?: string };
type Tool = { type?: string; name?: string; tools?: Tool[] };
type InputItem = {
  type?: string;
  role?: string;
  content?: string | ContentPart[];
  tools?: Tool[];
  call_id?: string;
  output?: unknown;
};
export type ResponsesFrame = {
  type?: string;
  generate?: boolean;
  input?: InputItem[];
  tools?: Tool[];
  prompt_cache_key?: string;
};

export type ReviewKind = "validation-plan" | "review-report" | "consolidated-review";

export const SUBMIT_TOOLS: Record<ReviewKind, string> = {
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
  "patch",
  "submit",
] as const;
export type StepLabel = (typeof STEP_LABELS)[number];

/** Names HEAD; the preparation turn's only command and a report turn's fallback Git command. */
export const HEAD_COMMAND = "git rev-parse HEAD";
/** A read-only command with no Git in it. */
export const LIST_COMMAND = "ls";
/** A write inside the checkout, which the bridge must decline. */
export const WRITE_PROBE_FILE = ".orkestrator-qa-read-only-probe";
export const WRITE_PROBE = `touch ${WRITE_PROBE_FILE}`;
/** A file `apply_patch` would add, which the bridge must decline. */
export const PATCH_PROBE_FILE = ".orkestrator-qa-read-only-patch";
export const PATCH_PROBE = [
  "*** Begin Patch",
  `*** Add File: ${PATCH_PROBE_FILE}`,
  "+written by a read-only turn",
  "*** End Patch",
  "",
].join("\n");
/** Marks a cell's result line in its output. */
export const RESULT_MARKER = "ORKQA ";

export type PackageView = {
  baseRef?: string;
  headRef?: string;
  diffCommand?: string;
  diffArtifact?: string;
};

/** What one scripted cell reported. */
export type StepOutcome = {
  step: StepLabel;
  /** The call ran; false when the bridge declined it or the tool threw. */
  ran: boolean;
  exitCode: number | null;
  /** A submission the tool answered with an error. */
  rejected?: boolean;
  /** `git rev-parse HEAD`'s answer, from the `git` step only. */
  head?: string;
  /** The package's fields, from the `package` step only. */
  pkg?: PackageView;
};

export type ReviewSlot = {
  kind: ReviewKind;
  resultKey: string;
  capability?: string;
  packagePath?: string;
};

export type ReviewStep =
  { kind: "text"; text: string } | { kind: "cell"; step: StepLabel; source: string };

function partsText(content: string | ContentPart[] | undefined): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .map((part) => part.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

/** Which Multi Review result a prompt asks for, its resultKey, capability and package path. */
export function reviewSlot(prompt: string): ReviewSlot | null {
  const kinds = Object.keys(SUBMIT_TOOLS) as ReviewKind[];
  const kind = kinds.find((candidate) => prompt.includes(`\`${SUBMIT_TOOLS[candidate]}\``));
  const key = /resultKey "([0-9a-fA-F-]{36})"/.exec(prompt)?.[1];
  if (!kind || !key) return null;
  const capability = /\band capability "([^"\s]+)"/.exec(prompt)?.[1];
  const packagePath = /Read the review package from `([^`]+)`/.exec(prompt)?.[1];
  return {
    kind,
    resultKey: key,
    ...(capability ? { capability } : {}),
    ...(packagePath ? { packagePath } : {}),
  };
}

/** The slot named by the latest message of a request that names one. */
export function frameSlot(frame: ResponsesFrame): ReviewSlot | null {
  const input = frame.input ?? [];
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]!;
    if (item.type !== "message" && item.role === undefined) continue;
    const slot = reviewSlot(partsText(item.content));
    if (slot) return slot;
  }
  return null;
}

/** The text an `exec` cell's output carries, whether a string, a JSON string or parts. */
function outputText(output: unknown): string {
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output) as unknown;
      if (Array.isArray(parsed)) return partsText(parsed as ContentPart[]);
    } catch {
      // Plain text output.
    }
    return output;
  }
  if (Array.isArray(output)) return partsText(output as ContentPart[]);
  if (output && typeof output === "object") {
    const content = (output as { content?: unknown }).content;
    if (typeof content === "string" || Array.isArray(content)) return outputText(content);
  }
  return "";
}

/** A cell's reported outcome, or a refusal when it printed none (the call never ran). */
export function cellOutcome(step: StepLabel, output: unknown): StepOutcome {
  const text = outputText(output);
  const line = text
    .split("\n")
    .find((entry) => entry.startsWith(RESULT_MARKER))
    ?.slice(RESULT_MARKER.length);
  if (!line) return { step, ran: false, exitCode: null };
  try {
    const value = JSON.parse(line) as Partial<StepOutcome>;
    return {
      step,
      ran: value.ran === true,
      exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
      ...(value.rejected === true ? { rejected: true } : {}),
      ...(typeof value.head === "string" ? { head: value.head } : {}),
      ...(value.pkg && typeof value.pkg === "object" ? { pkg: value.pkg } : {}),
    };
  } catch {
    return { step, ran: false, exitCode: null };
  }
}

/** The step a call id carries (`call_<step>_<n>`), or null for one this fake did not issue. */
export function stepOfCall(callId: string | undefined): StepLabel | null {
  const step = /^call_([a-z-]+)_/.exec(callId ?? "")?.[1];
  return (STEP_LABELS as readonly string[]).includes(step ?? "") ? (step as StepLabel) : null;
}

/** Every step outcome a request carries back. */
export function frameOutcomes(frame: ResponsesFrame): StepOutcome[] {
  return (frame.input ?? []).flatMap((item) => {
    if (typeof item.type !== "string" || !item.type.endsWith("_output")) return [];
    const step = stepOfCall(item.call_id);
    return step ? [cellOutcome(step, item.output)] : [];
  });
}

/** A command or patch is safe to embed only when it is a plain string literal. */
const literal = (value: string) => JSON.stringify(value);

/** Single-quotes a path for the shell; paths holding a quote are not scripted. */
function shellPath(value: string): string | null {
  return /^[^'\n]+$/.test(value) ? `'${value}'` : null;
}

/** A cell running one shell command and printing whether it ran and its exit code. */
export function commandCell(command: string, options: { head?: boolean; pkg?: boolean } = {}) {
  const extract = options.pkg
    ? [
        "  try {",
        "    const p = JSON.parse(String(x.output ?? ''));",
        "    r.pkg = { baseRef: p.baseRef, headRef: p.headRef, diffCommand: p.diffCommand, diffArtifact: p.diffArtifact && p.diffArtifact.path };",
        "  } catch {}",
      ]
    : options.head
      ? [
          "  const h = /\\b[0-9a-f]{40}\\b/.exec(String(x.output ?? ''));",
          "  if (h) r.head = h[0];",
        ]
      : [];
  return [
    "let r;",
    "try {",
    `  const x = await tools.exec_command({ cmd: ${literal(command)}, max_output_tokens: 200000 });`,
    "  r = { ran: true, exitCode: typeof x.exit_code === 'number' ? x.exit_code : null };",
    ...extract,
    "} catch (error) {",
    "  r = { ran: false, exitCode: null };",
    "}",
    `text(${literal(RESULT_MARKER)} + JSON.stringify(r));`,
  ].join("\n");
}

/** A cell asking `apply_patch` to add a file. */
export function patchCell(): string {
  return [
    "let r;",
    "try {",
    `  await tools.apply_patch(${literal(PATCH_PROBE)});`,
    "  r = { ran: true, exitCode: null };",
    "} catch (error) {",
    "  r = { ran: false, exitCode: null };",
    "}",
    `text(${literal(RESULT_MARKER)} + JSON.stringify(r));`,
  ].join("\n");
}

/** A cell calling the Orkestrator MCP submit tool by whatever name code mode gave it. */
export function submitCell(tool: string, args: Record<string, unknown>): string {
  return [
    `const name = Object.keys(tools).find((key) => key === ${literal(tool)} || key.endsWith(${literal(`__${tool}`)}));`,
    "let r;",
    "if (!name) {",
    "  r = { ran: false, exitCode: null };",
    "} else {",
    "  try {",
    `    const x = await tools[name](${JSON.stringify(args)});`,
    "    r = { ran: true, exitCode: null, rejected: Boolean(x && x.isError === true) };",
    "  } catch (error) {",
    "    r = { ran: false, exitCode: null };",
    "  }",
    "}",
    `text(${literal(RESULT_MARKER)} + JSON.stringify(r));`,
  ].join("\n");
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

/**
 * A complete report with no findings: valid for a reviewer and for
 * consolidation. The same payload as the Claude fake's `reviewReport`
 * (`container-fake-codex-review-api.test.ts` keeps them equal).
 */
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

const ranCleanly = (outcome: StepOutcome | undefined) =>
  outcome !== undefined && outcome.ran && outcome.exitCode === 0;

/** The next step of a scripted turn, given what its earlier steps reported. */
export function reviewStep(
  slot: ReviewSlot | null,
  outcomes: ReadonlyMap<StepLabel, StepOutcome>,
): ReviewStep {
  if (!slot) return { kind: "text", text: "PONG" };
  const report = slot.kind !== "validation-plan";
  const outcome = (step: StepLabel) => outcomes.get(step);
  const cell = (step: StepLabel, source: string): ReviewStep => ({ kind: "cell", step, source });

  const packagePath = slot.packagePath ? shellPath(slot.packagePath) : null;
  if (report && packagePath && !outcome("package")) {
    return cell("package", commandCell(`cat ${packagePath}`, { pkg: true }));
  }
  const pkg = outcome("package")?.pkg;
  if (report && !outcome("list")) return cell("list", commandCell(LIST_COMMAND));
  if (!outcome("git")) {
    const command = report && pkg?.diffCommand ? pkg.diffCommand : HEAD_COMMAND;
    return cell("git", commandCell(command, { head: !report }));
  }
  const git = outcome("git")!;
  const head = pkg?.headRef ?? git.head;
  if (!report && (!ranCleanly(git) || !head)) {
    return { kind: "text", text: "Git did not answer, so there is no plan." };
  }
  const diffPath = pkg?.diffArtifact ? shellPath(pkg.diffArtifact) : null;
  if (report && !ranCleanly(git) && diffPath && !outcome("diff-file")) {
    return cell("diff-file", commandCell(`cat ${diffPath}`));
  }
  if (report && !outcome("write-probe")) return cell("write-probe", commandCell(WRITE_PROBE));
  if (report && !outcome("patch")) return cell("patch", patchCell());

  const submitted = outcome("submit");
  if (submitted) {
    return {
      kind: "text",
      text: submitted.ran && !submitted.rejected ? "Submitted." : "The submission was refused.",
    };
  }
  const readDiff = ranCleanly(git) || ranCleanly(outcome("diff-file"));
  return cell(
    "submit",
    submitCell(SUBMIT_TOOLS[slot.kind], {
      resultKey: slot.resultKey,
      ...(slot.capability ? { capability: slot.capability } : {}),
      result: report
        ? reviewReport(pkg?.baseRef ?? head ?? "HEAD", readDiff)
        : validationPlan(head!),
    }),
  );
}

/** Whether an answered step counts as an error, as a Claude tool result's `is_error` would. */
export function stepError(outcome: StepOutcome): boolean {
  if (!outcome.ran) return true;
  if (outcome.step === "submit") return outcome.rejected === true;
  if (outcome.step === "patch") return false;
  return outcome.exitCode !== 0;
}

/** One content-free log line: the step chosen and the error flag of each answered step. */
export function stepRecord(
  slot: ReviewSlot | null,
  outcomes: ReadonlyMap<StepLabel, StepOutcome>,
  step: ReviewStep,
): Record<string, unknown> {
  return {
    kind: slot?.kind ?? "plain",
    step: step.kind === "text" ? "text" : step.step,
    answered: [...outcomes.values()].map((outcome) => ({
      step: outcome.step,
      error: stepError(outcome),
    })),
  };
}

/** One output item for a step: an `exec` cell or the closing message. */
export function outputItem(step: ReviewStep, id: number): Record<string, unknown> {
  if (step.kind === "cell") {
    return {
      type: "custom_tool_call",
      id: `ctc_orkqa_${id}`,
      call_id: `call_${step.step}_${id}`,
      name: "exec",
      input: step.source,
      status: "completed",
    };
  }
  return {
    type: "message",
    id: `msg_orkqa_${id}`,
    role: "assistant",
    content: [{ type: "output_text", text: step.text, annotations: [] }],
    status: "completed",
  };
}

/** The step a scripted request is logged under when it offers no code-mode `exec` tool. */
export const NO_CODE_MODE_STEP = "no-code-mode";
const NO_CODE_MODE_TEXT =
  "This fixture model only scripts Codex code mode, and this turn has no exec tool.";

/**
 * Whether a request lets the model call code mode's `exec` tool. Codex offers
 * it only for a model its catalogue marks `tool_mode = "code_mode_only"`; the
 * pinned 0.167.0 catalogue marks every listed model so except `gpt-5.5`,
 * whose turns get the direct `exec_command` and `apply_patch` tools instead
 * (seen on 2026-11-14, to-do 7872 (retired)). A request that lists no tools is taken
 * at its word, as the unit tests' frames are.
 */
export function offersCodeMode(frame: ResponsesFrame): boolean {
  if (!Array.isArray(frame.tools)) return true;
  return frame.tools.some(
    (tool) => tool.name === "exec" || (tool.tools ?? []).some((inner) => inner.name === "exec"),
  );
}

type Conversation = { slot: ReviewSlot | null; outcomes: Map<StepLabel, StepOutcome> };

/** Bounded: a review has a handful of conversations, each told apart by its cache key. */
const MAX_CONVERSATIONS = 64;

/**
 * The scripted model's state across requests. Codex continues a turn with
 * `previous_response_id` and sends only the new output items, so each
 * conversation (its `prompt_cache_key`, else its socket) keeps its slot and
 * the outcomes reported so far; a request naming a different resultKey
 * starts that conversation over.
 */
export function createReviewScript(log?: (line: string) => void) {
  const conversations = new Map<string, Conversation>();
  let sampled = 0;
  return {
    /** The output item a sampling request gets, or null for a prewarm (`generate: false`). */
    respond(frame: ResponsesFrame, connection: string): Record<string, unknown> | null {
      const key = frame.prompt_cache_key ?? connection;
      let conversation = conversations.get(key);
      if (!conversation) {
        conversation = { slot: null, outcomes: new Map() };
        conversations.set(key, conversation);
        if (conversations.size > MAX_CONVERSATIONS) {
          conversations.delete(conversations.keys().next().value!);
        }
      }
      const slot = frameSlot(frame);
      if (slot && slot.resultKey !== conversation.slot?.resultKey) {
        conversation.slot = slot;
        conversation.outcomes = new Map();
      } else if (slot) {
        conversation.slot = slot;
      }
      for (const outcome of frameOutcomes(frame)) {
        conversation.outcomes.set(outcome.step, outcome);
      }
      if (frame.generate === false) return null;
      sampled += 1;
      if (conversation.slot && !offersCodeMode(frame)) {
        // Every cell below is an `exec` call; a turn without it would answer
        // "unsupported custom tool call" and the review would fail with a
        // missing submission rather than say why.
        const step: ReviewStep = { kind: "text", text: NO_CODE_MODE_TEXT };
        log?.(
          JSON.stringify({
            ...stepRecord(conversation.slot, conversation.outcomes, step),
            step: NO_CODE_MODE_STEP,
          }),
        );
        return outputItem(step, sampled);
      }
      const step = reviewStep(conversation.slot, conversation.outcomes);
      if (log && conversation.slot) {
        log(JSON.stringify(stepRecord(conversation.slot, conversation.outcomes, step)));
      }
      return outputItem(step, sampled);
    },
  };
}

/**
 * Serves the scripted model as a Responses WebSocket on `127.0.0.1:<port>`.
 * Codex reaches it through `openai_base_url = "http://127.0.0.1:<port>/v1"`.
 * Tests under a DOM preload pass Bun's own `Response`.
 */
export function serveFakeCodexReviewApi(
  options: { port?: number; log?: (line: string) => void; ResponseType?: typeof Response } = {},
) {
  const ResponseType = options.ResponseType ?? Response;
  const script = createReviewScript(options.log);
  let connections = 0;
  return Bun.serve<{ connection: string }>({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    idleTimeout: 0,
    fetch(request, bun) {
      if (
        request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
        bun.upgrade(request, { data: { connection: `socket-${(connections += 1)}` } })
      ) {
        return undefined;
      }
      return new ResponseType("not served", { status: 404 });
    },
    websocket: {
      message(socket, message) {
        let frame: ResponsesFrame;
        try {
          frame = JSON.parse(String(message)) as ResponsesFrame;
        } catch {
          return;
        }
        if (frame.type !== "response.create") return;
        const id = `resp_${crypto.randomUUID()}`;
        const send = (event: unknown) => socket.send(JSON.stringify(event));
        send({ type: "response.created", response: { id } });
        const item = script.respond(frame, socket.data.connection);
        if (item) send({ type: "response.output_item.done", output_index: 0, item });
        send({
          type: "response.completed",
          response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        });
      },
    },
  });
}

if ((import.meta as { main?: boolean }).main) {
  const index = process.argv.indexOf("--port");
  const port = Number(index === -1 ? NaN : process.argv[index + 1]);
  if (!Number.isInteger(port) || port <= 0) throw new Error("--port is required");
  const logIndex = process.argv.indexOf("--log");
  const logPath = logIndex === -1 ? undefined : process.argv[logIndex + 1];
  const { appendFileSync } = await import("node:fs");
  const log = logPath ? (line: string) => appendFileSync(logPath, `${line}\n`) : undefined;
  serveFakeCodexReviewApi({ port, ...(log ? { log } : {}) });
}
