import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseGraphLaunchRequest } from "@orkestrator/protocol/graphs/launch";
import { publicSuccessEnvelope } from "@orkestrator/protocol/public-api";
import { PUBLIC_API_FIXTURES } from "@orkestrator/protocol/testing/public-api-fixtures";
import {
  captureIo,
  createSandbox,
  defaultResponder,
  envelope,
  startFakeGateway,
} from "./support/client-harness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const box = await createSandbox();
  const gateway = await startFakeGateway((request) => {
    const action = request.body.args.action;
    if (action === "schedule.create" || action === "schedule.update") {
      return envelope(
        publicSuccessEnvelope(
          action,
          { scheduleId: "sch_test", nextFireAt: null },
          {
            ...PUBLIC_API_FIXTURES.runCompleted.receipt!,
            action,
            state: "succeeded",
            stage: "completed",
          },
        ),
      );
    }
    return defaultResponder()(request);
  });
  cleanups.push(
    () => box.cleanup(),
    () => gateway.stop(),
  );
  const dir = await box.publishDescriptor(gateway);
  await box.run(["connection", "add", "local", "--data-dir", dir, "--default", "--no-check"]);
  const inputs = (action = "schedule.create") =>
    gateway.requests
      .filter((request) => request.body.args.action === action)
      .map((request) => request.body.args.input);
  return { box, inputs };
}

test("schedule CLI converts durations and constructs mail and timing fields", async () => {
  const { box, inputs } = await fixture();
  const run = await box.run([
    "schedule",
    "create",
    "--every",
    "90m",
    "--start-at",
    "+10m",
    "--time-zone",
    "Europe/London",
    "--catch-up-minutes",
    "20",
    "--name",
    "Morning",
    "--paused",
    "--mail",
    "env-1:tab-1",
    "--body",
    "Wake up",
    "--subject",
    "Reminder",
  ]);
  expect(run.code).toBe(0);
  expect(inputs()).toEqual([
    {
      everySeconds: 5400,
      startAt: "+10m",
      timeZone: "Europe/London",
      catchUpMinutes: 20,
      name: "Morning",
      paused: true,
      action: {
        kind: "action",
        action: "mail.send",
        input: { toEnvironmentId: "env-1", toTabId: "tab-1", body: "Wake up", subject: "Reminder" },
      },
    },
  ]);
});

for (const flags of [
  ["--mail", "env:tab", "--session", "ses_x", "--body", "x", "--prompt", "x"],
  ["--launch-project", "p", "--action", "ticket.comment", "--agent", "claude", "--prompt", "x"],
]) {
  test(`schedule CLI rejects mutually exclusive actions ${flags.join(" ")}`, async () => {
    const { box, inputs } = await fixture();
    const run = await box.run(["schedule", "create", "--at", "+1m", ...flags]);
    expect(run.code).not.toBe(0);
    expect(run.err).toContain("mutually exclusive");
    expect(inputs()).toHaveLength(0);
  });
}

for (const source of ["file", "stdin"] as const) {
  test(`schedule CLI reads ${source} prompts and preserves pinned container launch fields`, async () => {
    const { box, inputs } = await fixture();
    const file = path.join(box.root, "prompt.txt");
    await writeFile(file, "Audit the repository.\n");
    const io = captureIo(box.env, box.root);
    io.stdinBytes = new TextEncoder().encode("Audit the repository.\n");
    const flags = source === "file" ? ["--prompt-file", file] : ["--prompt-stdin"];
    const run = await box.run(
      [
        "schedule",
        "create",
        "--cron",
        "0 3 * * *",
        "--launch-project",
        "project-1",
        "--agent",
        "codex",
        "--type",
        "container",
        "--mode",
        "plan",
        "--model",
        "model-1",
        "--base-branch",
        "main",
        "--base-commit",
        "a".repeat(40),
        ...flags,
      ],
      io,
    );
    expect(run.code).toBe(0);
    expect(inputs()).toEqual([
      {
        cron: "0 3 * * *",
        action: {
          kind: "launch",
          projectId: "project-1",
          agent: "codex",
          type: "container",
          mode: "plan",
          model: "model-1",
          baseBranch: "main",
          baseCommit: "a".repeat(40),
          prompt: "Audit the repository.\n",
        },
      },
    ]);
  });
}

test("schedule CLI constructs a session prompt and JSON action", async () => {
  const { box, inputs } = await fixture();
  expect(
    (
      await box.run([
        "schedule",
        "create",
        "--at",
        "+1m",
        "--session",
        "ses_test",
        "--prompt",
        "Review",
        "--mode",
        "plan",
      ])
    ).code,
  ).toBe(0);
  expect(inputs()[0]).toEqual({
    at: "+1m",
    action: { kind: "prompt", sessionId: "ses_test", prompt: "Review", mode: "plan" },
  });
  expect(
    (
      await box.run([
        "schedule",
        "create",
        "--at",
        "+1m",
        "--action",
        "ticket.comment",
        "--input-json",
        '{"ticketId":"t","text":"Review"}',
      ])
    ).code,
  ).toBe(0);
  expect(inputs()[1]).toEqual({
    at: "+1m",
    action: { kind: "action", action: "ticket.comment", input: { ticketId: "t", text: "Review" } },
  });
});

test("schedule CLI updates timing and revision without rebuilding an omitted action", async () => {
  const { box, inputs } = await fixture();
  expect(
    (
      await box.run([
        "schedule",
        "update",
        "sch_test",
        "--name",
        "Renamed",
        "--every",
        "2m",
        "--expected-revision",
        "7",
      ])
    ).code,
  ).toBe(0);
  expect(inputs("schedule.update")).toEqual([
    { scheduleId: "sch_test", name: "Renamed", everySeconds: 120, expectedRevision: 7 },
  ]);
  expect(
    (
      await box.run([
        "schedule",
        "update",
        "sch_test",
        "--action",
        "ticket.comment",
        "--input-json",
        '{"text":"New"}',
      ])
    ).code,
  ).toBe(0);
  expect(inputs("schedule.update")[1]).toEqual({
    scheduleId: "sch_test",
    action: { kind: "action", action: "ticket.comment", input: { text: "New" } },
  });
});

test("schedule CLI rejects invalid sources, durations and JSON before submission", async () => {
  const { box, inputs } = await fixture();
  for (const flags of [
    ["--every", "1500ms", "--action", "ticket.comment"],
    ["--at", "+1m", "--session", "ses_test", "--prompt", "inline", "--prompt-stdin"],
    ["--at", "+1m", "--action", "ticket.comment", "--input-json", "[]"],
    ["--at", "+1m", "--mail", "missing-tab", "--body", "x"],
  ])
    expect((await box.run(["schedule", "create", ...flags])).code).not.toBe(0);
  expect(inputs()).toHaveLength(0);
});

test("schedule CLI builds a graph launch from the flags of graph launch", async () => {
  const { box, inputs } = await fixture();
  const inputFile = path.join(box.root, "brief.json");
  await writeFile(inputFile, JSON.stringify("Nightly sweep"));
  const run = await box.run([
    "schedule",
    "create",
    "--cron",
    "0 2 * * *",
    "--name",
    "Nightly review",
    "--graph",
    "user:nightly-review",
    "--project",
    "p1",
    "--new-container",
    "--role",
    "builder=codex/gpt-5.5@high",
    "--role",
    "reviewer=claude,opencode/anthropic/claude-sonnet",
    "--focus",
    "reviewer.2=Security\nTrace untrusted input.",
    "--param",
    "rounds=2",
    "--param",
    "strict=true",
    "--input-file",
    `brief=${inputFile}`,
    "--ticket",
    "t1",
    "--ticket-input",
    "ticket",
  ]);
  expect(run.code).toBe(0);
  const request = {
    ref: { scope: "user", id: "nightly-review" },
    projectId: "p1",
    environment: { kind: "new", create: "container" },
    roles: {
      builder: { platform: "codex", model: "gpt-5.5", reasoningEffort: "high" },
      reviewer: [
        { platform: "claude" },
        {
          platform: "opencode",
          model: "anthropic/claude-sonnet",
          lens: { label: "Security", instruction: "Trace untrusted input." },
        },
      ],
    },
    params: { rounds: 2, strict: true },
    inputs: { brief: "Nightly sweep" },
    ticket: { taskId: "t1", input: "ticket" },
  };
  expect(inputs()).toEqual([
    { cron: "0 2 * * *", name: "Nightly review", action: { kind: "graph", request } },
  ]);
  // The backend's own parser accepts it unchanged (what `schedule.create` stores).
  expect(parseGraphLaunchRequest(request)).toEqual(request as never);
});

test("schedule CLI schedules a graph in an existing environment, and on update", async () => {
  const { box, inputs } = await fixture();
  const run = await box.run([
    "schedule",
    "update",
    "sch_test",
    "--graph",
    "project:review.graph.json",
    "--project",
    "p1",
    "--environment",
    "env-1",
  ]);
  expect(run.code).toBe(0);
  expect(inputs("schedule.update")).toEqual([
    {
      scheduleId: "sch_test",
      action: {
        kind: "graph",
        request: {
          ref: { scope: "project", projectId: "p1", path: ".orkestrator/graphs/review.graph.json" },
          projectId: "p1",
          environment: { kind: "existing", environmentId: "env-1" },
        },
      },
    },
  ]);
});

test("schedule CLI refuses a malformed graph schedule before submission", async () => {
  const { box, inputs } = await fixture();
  for (const [flags, message] of [
    [["--graph", "user:x", "--new-worktree"], "--project is required"],
    [["--graph", "user:x", "--project", "p1"], "Pass exactly one of"],
    [["--graph", "nope", "--project", "p1", "--new-worktree"], "TEMPLATE"],
    [
      ["--graph", "user:x", "--project", "p1", "--new-worktree", "--role", "worker=nobody"],
      "names agent",
    ],
    [["--mail", "env:tab", "--body", "x", "--role", "worker=claude"], "--role needs --graph"],
    [["--session", "ses_x", "--prompt", "x", "--project", "p1"], "--project needs --graph"],
    [
      ["--graph", "user:x", "--project", "p1", "--new-worktree", "--action", "ticket.comment"],
      "mutually exclusive",
    ],
  ] as const) {
    const run = await box.run(["schedule", "create", "--at", "+1m", ...flags]);
    expect(run.code).not.toBe(0);
    expect(run.err).toContain(message);
  }
  expect(inputs()).toHaveLength(0);
});
