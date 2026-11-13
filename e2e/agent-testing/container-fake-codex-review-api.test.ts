import { describe, expect, test } from "bun:test";
import { nativeWebPlatform } from "../../tests/register-dom";
import { validateWorkflowResult } from "../../apps/backend/src/core/workflow-result-contracts";
import { workflowResultInstruction } from "@orkestrator/protocol/workflow-results";
import { reviewReport as claudeReviewReport } from "./container-fake-claude-review-api";
import {
  HEAD_COMMAND,
  LIST_COMMAND,
  PATCH_PROBE,
  RESULT_MARKER,
  WRITE_PROBE,
  cellOutcome,
  createReviewScript,
  frameOutcomes,
  frameSlot,
  outputItem,
  reviewReport,
  reviewSlot,
  reviewStep,
  serveFakeCodexReviewApi,
  stepOfCall,
  stepRecord,
  validationPlan,
  type ResponsesFrame,
  type ReviewSlot,
  type ReviewStep,
  type StepLabel,
  type StepOutcome,
} from "./container-fake-codex-review-api";

const KEY = "0b9d4c1e-5a43-4c2f-9d3b-1f7c8e2a6b10";
const HEAD = "b".repeat(40);
const BASE = "a".repeat(40);
const PACKAGE_PATH = ".orkestrator/review-artifacts/p/review-package-x.json";
const DIFF_PATH = ".orkestrator/review-artifacts/p/review-diff-y.patch";
const DIFF_COMMAND = `git diff --no-color --no-ext-diff --no-textconv --no-renames ${BASE}...${HEAD}`;
const PACKAGE = {
  baseRef: BASE,
  headRef: HEAD,
  diffCommand: DIFF_COMMAND,
  diffArtifact: { path: DIFF_PATH, bytes: 10, sha256: "c".repeat(64) },
};

/** The backend's own result instruction, so the slot is read from the real wording. */
const reviewerPrompt = `Read the review package from \`${PACKAGE_PATH}\` in the environment workspace before beginning the review.\n\n${workflowResultInstruction("review-report", KEY, { provisionalFindings: true })}`;

type CellResult = { text: string; commands: string[]; patches: string[]; submitted: unknown[] };

/**
 * Runs a cell the way Codex's code-mode host does: an async body with `tools`
 * and `text`. `declined` commands throw as a declined approval does.
 */
async function runCell(
  source: string,
  options: {
    declined?: (command: string) => boolean;
    output?: (command: string) => string;
    exitCode?: number;
    patchDeclined?: boolean;
    submitTool?: string;
    submitError?: boolean;
  } = {},
): Promise<CellResult> {
  const result: CellResult = { text: "", commands: [], patches: [], submitted: [] };
  const tools: Record<string, (args: unknown) => Promise<unknown>> = {
    exec_command: async (args) => {
      const cmd = (args as { cmd: string }).cmd;
      result.commands.push(cmd);
      if (options.declined?.(cmd)) {
        throw new Error(
          'exec_command failed: CreateProcess { message: "Rejected(\\"rejected by user\\")" }',
        );
      }
      return { exit_code: options.exitCode ?? 0, output: options.output?.(cmd) ?? "" };
    },
    apply_patch: async (patch) => {
      result.patches.push(String(patch));
      if (options.patchDeclined ?? true) throw new Error("patch rejected by user");
      return "Done";
    },
    [options.submitTool ?? "mcp__orkestrator__submit_review_report"]: async (args) => {
      result.submitted.push(args);
      return {
        content: [{ type: "text", text: "ok" }],
        ...(options.submitError ? { isError: true } : {}),
      };
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
    ...args: string[]
  ) => (tools: unknown, text: (value: string) => void) => Promise<void>;
  await new AsyncFunction("tools", "text", source)(tools, (value) => {
    result.text += value;
  });
  return result;
}

/** A cell's output item as Codex returns it: a JSON-encoded list of input_text parts. */
function cellOutput(callId: string, text: string) {
  return {
    type: "custom_tool_call_output",
    call_id: callId,
    output: JSON.stringify([
      { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
      { type: "input_text", text },
    ]),
  };
}

function outcomes(entries: StepOutcome[]): Map<StepLabel, StepOutcome> {
  return new Map(entries.map((entry) => [entry.step, entry]));
}
const ran = (step: StepLabel, extra: Partial<StepOutcome> = {}): StepOutcome => ({
  step,
  ran: true,
  exitCode: 0,
  ...extra,
});
const declined = (step: StepLabel): StepOutcome => ({ step, ran: false, exitCode: null });

const reviewer: ReviewSlot = { kind: "review-report", resultKey: KEY, packagePath: PACKAGE_PATH };
const pkg = { baseRef: BASE, headRef: HEAD, diffCommand: DIFF_COMMAND, diffArtifact: DIFF_PATH };
const cellStep = (step: ReviewStep) => (step.kind === "cell" ? step.step : `text:${step.text}`);

describe("the scripted Codex reviewer", () => {
  test("reads the slot, the capability and the package path from the backend's wording", () => {
    expect(reviewSlot(reviewerPrompt)).toEqual(reviewer);
    expect(
      reviewSlot(workflowResultInstruction("consolidated-review", KEY, { capability: "cap-1" })),
    ).toEqual({ kind: "consolidated-review", resultKey: KEY, capability: "cap-1" });
    expect(reviewSlot("Reply with PONG.")).toBeNull();
    const frame: ResponsesFrame = {
      type: "response.create",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "context" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: reviewerPrompt }] },
      ],
    };
    expect(frameSlot(frame)).toEqual(reviewer);
  });

  test("a reviewer reads, is refused Git, reads the diff file, probes writes and submits", () => {
    const sequence: Array<[StepOutcome[], string]> = [
      [[], "package"],
      [[ran("package", { pkg })], "list"],
      [[ran("package", { pkg }), ran("list")], "git"],
      [[ran("package", { pkg }), ran("list"), declined("git")], "diff-file"],
      [[ran("package", { pkg }), ran("list"), declined("git"), ran("diff-file")], "write-probe"],
      [
        [
          ran("package", { pkg }),
          ran("list"),
          declined("git"),
          ran("diff-file"),
          declined("write-probe"),
        ],
        "patch",
      ],
      [
        [
          ran("package", { pkg }),
          ran("list"),
          declined("git"),
          ran("diff-file"),
          declined("write-probe"),
          declined("patch"),
        ],
        "submit",
      ],
      [
        [
          ran("package", { pkg }),
          ran("list"),
          declined("git"),
          ran("diff-file"),
          declined("write-probe"),
          declined("patch"),
          ran("submit", { exitCode: null }),
        ],
        "text:Submitted.",
      ],
    ];
    for (const [answered, expected] of sequence) {
      expect(cellStep(reviewStep(reviewer, outcomes(answered)))).toBe(expected);
    }
  });

  test("a reviewer whose Git ran skips the diff file", () => {
    const step = reviewStep(reviewer, outcomes([ran("package", { pkg }), ran("list"), ran("git")]));
    expect(cellStep(step)).toBe("write-probe");
  });

  test("a refused submission ends the turn saying so", () => {
    const answered = outcomes([
      ran("package", { pkg }),
      ran("list"),
      ran("git"),
      declined("write-probe"),
      declined("patch"),
      ran("submit", { exitCode: null, rejected: true }),
    ]);
    expect(reviewStep(reviewer, answered)).toEqual({
      kind: "text",
      text: "The submission was refused.",
    });
  });

  test("preparation reads HEAD and submits a plan at it; without an answer it does not submit", () => {
    const plan: ReviewSlot = { kind: "validation-plan", resultKey: KEY };
    expect(cellStep(reviewStep(plan, outcomes([])))).toBe("git");
    const step = reviewStep(plan, outcomes([ran("git", { head: HEAD })]));
    expect(cellStep(step)).toBe("submit");
    expect(step.kind === "cell" && step.source).toContain(JSON.stringify(validationPlan(HEAD)));
    expect(reviewStep(plan, outcomes([declined("git")]))).toEqual({
      kind: "text",
      text: "Git did not answer, so there is no plan.",
    });
    expect(reviewStep(null, outcomes([]))).toEqual({ kind: "text", text: "PONG" });
  });

  test("the payloads pass the backend's own validators, and match the Claude fake's", () => {
    expect(validateWorkflowResult("validation-plan", validationPlan(HEAD))).toEqual([]);
    for (const readDiff of [true, false]) {
      expect(reviewReport(BASE, readDiff)).toEqual(claudeReviewReport(BASE, readDiff));
      expect(validateWorkflowResult("review-report", reviewReport(BASE, readDiff))).toEqual([]);
      expect(
        validateWorkflowResult("consolidated-review", reviewReport(BASE, readDiff), undefined, {
          type: "consolidated-review",
          sources: {},
        }),
      ).toEqual([]);
    }
  });
});

describe("the scripted cells, run the way Codex's code mode runs them", () => {
  test("the package cell reads the package and reports only the fields the script needs", async () => {
    const step = reviewStep(reviewer, outcomes([]));
    const result = await runCell(step.kind === "cell" ? step.source : "", {
      output: () => JSON.stringify(PACKAGE),
    });
    expect(result.commands).toEqual([`cat '${PACKAGE_PATH}'`]);
    expect(cellOutcome("package", result.text)).toEqual(ran("package", { pkg }));
    // Nothing of the package beyond those fields is printed.
    expect(result.text).not.toContain("sha256");
  });

  test("a declined command reads as not run, and an exit code is kept", async () => {
    const git = reviewStep(reviewer, outcomes([ran("package", { pkg }), ran("list")]));
    const refused = await runCell(git.kind === "cell" ? git.source : "", {
      declined: (command) => command.startsWith("git diff"),
    });
    expect(refused.commands).toEqual([DIFF_COMMAND]);
    expect(cellOutcome("git", refused.text)).toEqual(declined("git"));
    const failed = await runCell(git.kind === "cell" ? git.source : "", { exitCode: 128 });
    expect(cellOutcome("git", failed.text)).toEqual({ step: "git", ran: true, exitCode: 128 });
  });

  test("the HEAD cell reports the commit, the probes run what they say", async () => {
    const plan = reviewStep({ kind: "validation-plan", resultKey: KEY }, outcomes([]));
    const head = await runCell(plan.kind === "cell" ? plan.source : "", {
      output: () => `${HEAD}\n`,
    });
    expect(head.commands).toEqual([HEAD_COMMAND]);
    expect(cellOutcome("git", head.text)).toEqual(ran("git", { head: HEAD }));

    const before = [ran("package", { pkg }), ran("list"), ran("git")];
    const probe = reviewStep(reviewer, outcomes(before));
    const write = await runCell(probe.kind === "cell" ? probe.source : "", {
      declined: () => true,
    });
    expect(write.commands).toEqual([WRITE_PROBE]);
    const patch = reviewStep(reviewer, outcomes([...before, declined("write-probe")]));
    const patched = await runCell(patch.kind === "cell" ? patch.source : "");
    expect(patched.patches).toEqual([PATCH_PROBE]);
    expect(cellOutcome("patch", patched.text)).toEqual(declined("patch"));
    expect(LIST_COMMAND).toBe("ls");
  });

  test("the submit cell finds the MCP tool by its code-mode name and passes the slot", async () => {
    const slot: ReviewSlot = { ...reviewer, capability: "cap-1" };
    const step = reviewStep(
      slot,
      outcomes([
        ran("package", { pkg }),
        ran("list"),
        declined("git"),
        ran("diff-file"),
        declined("write-probe"),
        declined("patch"),
      ]),
    );
    const accepted = await runCell(step.kind === "cell" ? step.source : "");
    expect(accepted.submitted).toEqual([
      { resultKey: KEY, capability: "cap-1", result: reviewReport(BASE, true) },
    ]);
    expect(cellOutcome("submit", accepted.text)).toEqual({
      step: "submit",
      ran: true,
      exitCode: null,
    });
    const refused = await runCell(step.kind === "cell" ? step.source : "", { submitError: true });
    expect(cellOutcome("submit", refused.text)).toMatchObject({ ran: true, rejected: true });
    const missing = await runCell(step.kind === "cell" ? step.source : "", {
      submitTool: "something_else",
    });
    expect(missing.submitted).toEqual([]);
    expect(cellOutcome("submit", missing.text)).toEqual({
      step: "submit",
      ran: false,
      exitCode: null,
    });
  });

  test("an output with no result line is a call that never ran", () => {
    expect(cellOutcome("list", "Script failed")).toEqual(declined("list"));
    expect(cellOutcome("list", `${RESULT_MARKER}not json`)).toEqual(declined("list"));
  });
});

describe("the scripted conversation", () => {
  test("keeps each conversation's slot and outcomes across incremental requests", () => {
    const lines: string[] = [];
    const script = createReviewScript((line) => lines.push(line));
    const first: ResponsesFrame = {
      type: "response.create",
      prompt_cache_key: "thread-1",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: reviewerPrompt }] },
      ],
    };
    // A prewarm samples nothing.
    expect(script.respond({ ...first, generate: false }, "socket-1")).toBeNull();
    const package_ = script.respond(first, "socket-1")!;
    expect(package_).toMatchObject({ type: "custom_tool_call", name: "exec" });
    expect(stepOfCall(package_.call_id as string)).toBe("package");
    const next = script.respond(
      {
        type: "response.create",
        prompt_cache_key: "thread-1",
        input: [
          cellOutput(
            package_.call_id as string,
            `${RESULT_MARKER}${JSON.stringify({ ran: true, exitCode: 0, pkg })}`,
          ),
        ],
      },
      "socket-1",
    )!;
    expect(stepOfCall(next.call_id as string)).toBe("list");
    // Another conversation is unaffected.
    expect(
      script.respond({ type: "response.create", prompt_cache_key: "thread-2" }, "socket-1"),
    ).toMatchObject({ type: "message" });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { kind: "review-report", step: "package", answered: [] },
      { kind: "review-report", step: "list", answered: [{ step: "package", error: false }] },
    ]);
  });

  test("reads outcomes only from its own calls, and logs no content", () => {
    const frame: ResponsesFrame = {
      input: [
        cellOutput("call_list_3", `${RESULT_MARKER}{"ran":true,"exitCode":0}`),
        cellOutput("call_unknown_4", `${RESULT_MARKER}{"ran":true,"exitCode":0}`),
        { type: "function_call_output", call_id: "call_patch_5", output: "patch rejected by user" },
      ],
    };
    expect(frameOutcomes(frame)).toEqual([ran("list"), declined("patch")]);
    const record = stepRecord(reviewer, outcomes(frameOutcomes(frame)), {
      kind: "text",
      text: "x",
    });
    expect(record).toEqual({
      kind: "review-report",
      step: "text",
      answered: [
        { step: "list", error: false },
        { step: "patch", error: true },
      ],
    });
    expect(JSON.stringify(record)).not.toContain(KEY);
    expect(outputItem({ kind: "text", text: "Done." }, 9)).toMatchObject({
      type: "message",
      content: [{ type: "output_text", text: "Done." }],
    });
  });
});

type ServerEvent = { type: string; response?: { id?: string }; item?: Record<string, unknown> };

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
  });
  return socket;
}

/** Sends one frame and collects every event up to its `response.completed`. */
function exchange(socket: WebSocket, frame: string): Promise<ServerEvent[]> {
  return new Promise((resolve, reject) => {
    const events: ServerEvent[] = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("no response.completed"));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
    };
    const onMessage = (message: MessageEvent) => {
      const event = JSON.parse(String(message.data)) as ServerEvent;
      events.push(event);
      if (event.type === "response.completed") {
        cleanup();
        resolve(events);
      }
    };
    socket.addEventListener("message", onMessage);
    socket.send(frame);
  });
}

describe("the Responses WebSocket", () => {
  const { fetch, Response } = nativeWebPlatform;

  test("answers each response.create with created, one output item and completed", async () => {
    const lines: string[] = [];
    const server = serveFakeCodexReviewApi({
      log: (line) => lines.push(line),
      ResponseType: Response,
    });
    const url = `ws://127.0.0.1:${server.port}/v1/responses`;
    const first = await openSocket(url);
    const second = await openSocket(url);
    try {
      // Only a WebSocket upgrade is served.
      const plain = await fetch(`http://127.0.0.1:${server.port}/v1/responses`);
      expect(plain.status).toBe(404);
      await plain.text();

      const reviewer = JSON.stringify({
        type: "response.create",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: reviewerPrompt }],
          },
        ],
      });
      // A frame that is not JSON, or not a response.create, is ignored: the
      // next answer belongs to the frame after it.
      first.send("not json");
      first.send(JSON.stringify({ type: "session.update" }));
      const prewarm = await exchange(
        first,
        JSON.stringify({ ...JSON.parse(reviewer), generate: false }),
      );
      expect(prewarm.map((event) => event.type)).toEqual([
        "response.created",
        "response.completed",
      ]);
      expect(prewarm[1]!.response?.id).toBe(prewarm[0]!.response?.id);

      const sampled = await exchange(first, reviewer);
      expect(sampled.map((event) => event.type)).toEqual([
        "response.created",
        "response.output_item.done",
        "response.completed",
      ]);
      expect(sampled[0]!.response?.id).toMatch(/^resp_/);
      expect(sampled[2]!.response?.id).toBe(sampled[0]!.response?.id);
      const item = sampled[1]!.item!;
      expect(item).toMatchObject({ type: "custom_tool_call", name: "exec" });
      expect(stepOfCall(item.call_id as string)).toBe("package");

      // With no prompt_cache_key each socket is its own conversation: the
      // first socket continues to its next step, the second starts with no slot.
      const continued = await exchange(
        first,
        JSON.stringify({
          type: "response.create",
          input: [
            cellOutput(
              item.call_id as string,
              `${RESULT_MARKER}${JSON.stringify({ ran: true, exitCode: 0, pkg })}`,
            ),
          ],
        }),
      );
      expect(stepOfCall(continued[1]!.item!.call_id as string)).toBe("list");
      const other = await exchange(second, JSON.stringify({ type: "response.create" }));
      expect(other[1]!.item).toMatchObject({ type: "message" });

      expect(lines.map((line) => JSON.parse(line))).toEqual([
        { kind: "review-report", step: "package", answered: [] },
        { kind: "review-report", step: "list", answered: [{ step: "package", error: false }] },
      ]);
      expect(lines.join("\n")).not.toContain(KEY);
    } finally {
      first.close();
      second.close();
      await server.stop(true);
    }
  });
});
