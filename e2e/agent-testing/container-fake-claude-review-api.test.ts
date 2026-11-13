import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateWorkflowResult } from "../../apps/backend/src/core/workflow-result-contracts";
import {
  HEAD_COMMAND,
  LIST_COMMAND,
  WRITE_PROBE,
  handleFakeClaudeReviewApi,
  waitWhileHeld,
  packageFromRead,
  reviewReport,
  reviewSlot,
  reviewStep,
  stepRecord,
  validationPlan,
  type ReviewApiBody,
  type ReviewStep,
  type StepLabel,
} from "./container-fake-claude-review-api";

const KEY = "0b9d4c1e-5a43-4c2f-9d3b-1f7c8e2a6b10";
const HEAD = "b".repeat(40);
const BASE = "a".repeat(40);
const PACKAGE_PATH = ".orkestrator/review-artifacts/p/review-package-x.json";
const DIFF_PATH = ".orkestrator/review-artifacts/p/review-diff-y.patch";
const DIFF_COMMAND = `git diff --no-color --no-ext-diff --no-textconv --no-renames ${BASE}...${HEAD}`;

const reviewerPrompt = `Read the review package from \`${PACKAGE_PATH}\` in the environment workspace. When your work is complete, call the Orkestrator \`submit_review_report\` tool with the same resultKey "${KEY}" and complete result.`;
const consolidationPrompt = `Consolidate. Call the Orkestrator \`submit_consolidated_review\` tool with the same resultKey "${KEY}".`;
const preparationPrompt = `Plan validation. Call the Orkestrator \`submit_validation_plan\` tool with the same resultKey "${KEY}".`;

const packageRead = JSON.stringify({
  baseRef: BASE,
  headRef: HEAD,
  diffCommand: DIFF_COMMAND,
  diffArtifact: { path: DIFF_PATH, bytes: 10, sha256: "c".repeat(64) },
})
  .split("\n")
  .map((line, index) => `${String(index + 1).padStart(6)}\t${line}`)
  .join("\n");

type Answer = { step: StepLabel; text?: string; error?: boolean };

/** A request as the CLI sends it after the fake's earlier steps were answered. */
function body(prompt: string, answers: Answer[], tools = ["Bash", "Read", "ToolSearch"]) {
  const messages: ReviewApiBody["messages"] = [{ role: "user", content: prompt }];
  answers.forEach((answer, index) => {
    const id = `toolu_${answer.step}_${index}`;
    messages.push(
      { role: "assistant", content: [{ type: "tool_use", id, name: "X", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content: answer.text ?? "ok",
            ...(answer.error ? { is_error: true } : {}),
          },
        ],
      },
    );
  });
  return { messages, tools: tools.map((name) => ({ name })) } satisfies ReviewApiBody;
}

const toolStep = (step: ReviewStep) => (step.kind === "tool" ? step : null);

describe("container fake Claude review API", () => {
  test("a reviewer without the sandbox reads the sealed diff after Git is refused", () => {
    const answers: Answer[] = [];
    const steps: ReviewStep[] = [];
    const replies: Partial<Record<StepLabel, Answer>> = {
      package: { step: "package", text: packageRead },
      git: {
        step: "git",
        text: "Git commands in this session require the command sandbox",
        error: true,
      },
      "write-probe": { step: "write-probe", text: "refused", error: true },
    };
    const tools = ["Bash", "Read", "ToolSearch"];
    for (let turn = 0; turn < 10; turn += 1) {
      const step = reviewStep(body(reviewerPrompt, answers, tools));
      steps.push(step);
      if (step.kind === "text") break;
      if (step.step === "tool-search") tools.push("mcp__orkestrator__submit_review_report");
      answers.push(replies[step.step] ?? { step: step.step });
    }
    expect(steps.map((step) => (step.kind === "text" ? "text" : step.step))).toEqual([
      "package",
      "list",
      "git",
      "diff-file",
      "write-probe",
      "tool-search",
      "submit",
      "text",
    ]);
    expect(toolStep(steps[0]!)?.input).toEqual({ file_path: `/workspace/${PACKAGE_PATH}` });
    expect(toolStep(steps[1]!)?.input.command).toBe(LIST_COMMAND);
    expect(toolStep(steps[2]!)?.input.command).toBe(DIFF_COMMAND);
    expect(toolStep(steps[3]!)?.input).toEqual({ file_path: `/workspace/${DIFF_PATH}` });
    expect(toolStep(steps[4]!)?.input.command).toBe(WRITE_PROBE);
    const submit = toolStep(steps[6]!)!;
    expect(submit.name).toBe("mcp__orkestrator__submit_review_report");
    expect(submit.input.resultKey).toBe(KEY);
    expect(steps[7]).toEqual({ kind: "text", text: "Submitted." });
  });

  test("a reviewer whose Git works skips the diff file", () => {
    const answers: Answer[] = [
      { step: "package", text: packageRead },
      { step: "list" },
      { step: "git", text: "diff --git a/x b/x" },
    ];
    expect(toolStep(reviewStep(body(reviewerPrompt, answers)))?.step).toBe("write-probe");
  });

  test("preparation reads HEAD and plans at it, with no write probe", () => {
    expect(toolStep(reviewStep(body(preparationPrompt, [])))?.input.command).toBe(HEAD_COMMAND);
    const step = reviewStep(
      body(
        preparationPrompt,
        [{ step: "git", text: `${HEAD}\n` }],
        ["mcp__orkestrator__submit_validation_plan"],
      ),
    );
    expect(toolStep(step)?.input).toEqual({ resultKey: KEY, result: validationPlan(HEAD) });
  });

  test("consolidation has no package: it lists, reads HEAD, probes and submits", () => {
    const first = reviewStep(body(consolidationPrompt, []));
    expect(toolStep(first)?.step).toBe("list");
    expect(reviewSlot(consolidationPrompt)).toEqual({
      kind: "consolidated-review",
      resultKey: KEY,
    });
  });

  test("answers anything that is not a review turn with plain text", () => {
    expect(reviewStep(body("Write a title for this conversation", []))).toEqual({
      kind: "text",
      text: "PONG",
    });
  });

  test("reads a package through the Read tool's line-number prefix", () => {
    expect(packageFromRead(packageRead)?.diffArtifact?.path).toBe(DIFF_PATH);
    expect(packageFromRead('     1→{"headRef":"x"}')?.headRef).toBe("x");
    expect(packageFromRead("File does not exist.")).toBeNull();
  });

  test("its results pass the backend's own contracts", () => {
    expect(validateWorkflowResult("validation-plan", validationPlan(HEAD))).toEqual([]);
    for (const readDiff of [true, false]) {
      expect(validateWorkflowResult("review-report", reviewReport(BASE, readDiff))).toEqual([]);
      expect(
        validateWorkflowResult("consolidated-review", reviewReport(BASE, readDiff), undefined, {
          type: "consolidated-review",
          sources: {},
        }),
      ).toEqual([]);
    }
  });

  test("logs steps and error flags only", () => {
    const request = body(reviewerPrompt, [
      { step: "package", text: packageRead },
      { step: "list", text: "secret-file-name" },
      { step: "git", text: "refused", error: true },
    ]);
    const record = stepRecord(request, reviewStep(request));
    expect(record).toEqual({
      kind: "review-report",
      step: "diff-file",
      answered: [
        { step: "package", error: false },
        { step: "list", error: false },
        { step: "git", error: true },
      ],
    });
    const serialized = JSON.stringify(record);
    for (const leaked of [KEY, PACKAGE_PATH, DIFF_PATH, "secret-file-name", HEAD]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  test("streams a tool call whose id carries its step", async () => {
    const response = await handleFakeClaudeReviewApi(
      new Request("http://127.0.0.1:47123/v1/messages", {
        method: "POST",
        body: JSON.stringify({ ...body(reviewerPrompt, []), stream: true }),
      }),
    );
    const text = await response.text();
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(text).toContain('"type":"tool_use","id":"toolu_package_msg_fixture_');
    expect(text).toContain('"stop_reason":"tool_use"');
    expect(
      (
        await handleFakeClaudeReviewApi(
          new Request("http://127.0.0.1:47123/v1/messages/count_tokens", {
            method: "POST",
            body: "{}",
          }),
        )
      ).status,
    ).toBe(200);
  });
  test("a hold keeps a reviewer's submission waiting until it is released", async () => {
    const lines: string[] = [];
    let checks = 0;
    // Present for three checks, then released.
    const exists = async () => (checks += 1) <= 3;
    expect(
      await waitWhileHeld("/held", "review-report", (line) => lines.push(line), {
        pollMs: 1,
        exists,
      }),
    ).toBe(true);
    expect(checks).toBe(4);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { kind: "review-report", step: "hold", answered: [] },
    ]);
    // Absent: answered at once, nothing logged.
    expect(
      await waitWhileHeld("/held", "review-report", (line) => lines.push(line), {
        exists: async () => false,
      }),
    ).toBe(false);
    expect(lines).toHaveLength(1);
    // A hold never released still ends at its limit.
    expect(
      await waitWhileHeld("/held", "review-report", undefined, {
        pollMs: 1,
        limitMs: 5,
        exists: async () => true,
      }),
    ).toBe(true);
  });

  test("the server holds only a reviewer's submission, and only while the file exists", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ork-fake-review-hold-"));
    const hold = path.join(directory, "hold");
    try {
      const atSubmit = body(
        reviewerPrompt,
        [
          { step: "package", text: packageRead },
          { step: "list" },
          { step: "git", text: "refused", error: true },
          { step: "diff-file" },
          { step: "write-probe", text: "refused", error: true },
        ],
        ["Bash", "Read", "mcp__orkestrator__submit_review_report"],
      );
      expect(toolStep(reviewStep(atSubmit))?.step).toBe("submit");
      const post = (payload: ReviewApiBody, lines: string[]) =>
        handleFakeClaudeReviewApi(
          new Request("http://127.0.0.1:47123/v1/messages", {
            method: "POST",
            body: JSON.stringify(payload),
          }),
          (line) => lines.push(line),
          hold,
        );
      await writeFile(hold, "");
      const lines: string[] = [];
      let answered = false;
      const pending = post(atSubmit, lines).then((response) => {
        answered = true;
        return response;
      });
      for (let wait = 0; wait < 100 && !lines.length; wait += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(JSON.parse(lines[0]!)).toMatchObject({ kind: "review-report", step: "hold" });
      // An earlier step is never held.
      const early: string[] = [];
      await post(body(reviewerPrompt, []), early);
      expect(early.map((line) => JSON.parse(line).step)).toEqual(["package"]);
      expect(answered).toBe(false);
      await rm(hold);
      expect((await pending).status).toBe(200);
      expect(lines.map((line) => JSON.parse(line).step)).toEqual(["hold", "submit"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
