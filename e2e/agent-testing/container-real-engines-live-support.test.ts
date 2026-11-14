import { describe, expect, test } from "bun:test";
import {
  LIVE_CURSOR_MODEL,
  LIVE_CURSOR_SWITCH,
  LIVE_PI_MODEL,
  LIVE_TURN_TIMEOUT,
  curlCallFor,
  curlOutcome,
  isReached,
  isRefused,
  liveContainerCellSettings,
  piModelProblem,
  resolveShellToolOutputs,
  shellToolCalls,
  shellToolPrompt,
} from "./container-real-engines-live-support";

describe("liveContainerCellSettings", () => {
  test("skips both real cells when nothing is set", () => {
    expect(liveContainerCellSettings({})).toEqual({
      cursor: { optedIn: false },
      pi: { optedIn: false },
      turnTimeoutMs: 300_000,
    });
  });

  test("runs the Cursor cell only on an explicit 1", () => {
    expect(liveContainerCellSettings({ [LIVE_CURSOR_SWITCH]: "1" }).cursor.optedIn).toBe(true);
    for (const value of ["0", "true", "yes", ""]) {
      expect(liveContainerCellSettings({ [LIVE_CURSOR_SWITCH]: value }).cursor.optedIn).toBe(false);
    }
    expect(
      liveContainerCellSettings({ [LIVE_CURSOR_SWITCH]: "1", [LIVE_CURSOR_MODEL]: " composer-2 " })
        .cursor,
    ).toEqual({ optedIn: true, model: "composer-2" });
  });

  test("runs the Pi cell when its model is set, and reports a malformed one", () => {
    expect(
      liveContainerCellSettings({ [LIVE_PI_MODEL]: "openrouter/meta/llama-4-scout" }).pi,
    ).toEqual({ optedIn: true, model: "openrouter/meta/llama-4-scout" });
    expect(liveContainerCellSettings({ [LIVE_PI_MODEL]: "   " }).pi).toEqual({ optedIn: false });
    const malformed = liveContainerCellSettings({ [LIVE_PI_MODEL]: "haiku" }).pi;
    expect(malformed.optedIn).toBe(true);
    expect(malformed.problem).toContain("provider/modelId");
  });

  test("keeps a usable turn timeout", () => {
    expect(liveContainerCellSettings({ [LIVE_TURN_TIMEOUT]: "600000" }).turnTimeoutMs).toBe(
      600_000,
    );
    for (const value of ["abc", "10", "-1"]) {
      expect(liveContainerCellSettings({ [LIVE_TURN_TIMEOUT]: value }).turnTimeoutMs).toBe(300_000);
    }
  });
});

test("piModelProblem splits on the first slash", () => {
  expect(piModelProblem("anthropic/claude-haiku-5-5")).toBeUndefined();
  expect(piModelProblem("openrouter/a/b")).toBeUndefined();
  for (const model of ["haiku", "/haiku", "anthropic/"]) {
    expect(piModelProblem(model)).toBeString();
  }
});

describe("shellToolCalls", () => {
  test("reads command and output, including nested cards and failing commands", () => {
    const messages = [
      { parts: [{ type: "text", text: "hello" }] },
      {
        parts: [
          {
            toolName: "shell",
            toolArgs: { command: "curl https://example.com/" },
            toolOutput: "http=000 exit=7",
            toolError: "Command exited with status 7",
            toolState: "error",
          },
          { toolName: "read", toolArgs: { path: "a" }, toolOutput: "x" },
          {
            toolName: "task",
            childTools: [{ toolName: "bash", toolTitle: "ls", toolOutput: "file" }],
          },
        ],
      },
      { content: "no parts" },
    ];
    expect(shellToolCalls(messages, ["shell", "bash"])).toEqual([
      {
        toolName: "shell",
        command: "curl https://example.com/",
        output: "http=000 exit=7\nCommand exited with status 7",
        state: "error",
      },
      { toolName: "bash", command: "ls", output: "file" },
    ]);
    expect(shellToolCalls(messages, ["bash"])).toHaveLength(1);
  });

  test("is bounded in depth", () => {
    let nested: Record<string, unknown> = { toolName: "bash", toolTitle: "deep", toolOutput: "" };
    for (let index = 0; index < 20; index++) nested = { toolName: "task", childTools: [nested] };
    expect(shellToolCalls([{ parts: [nested] }], ["bash"])).toEqual([]);
  });
});

describe("projection-shaped cards", () => {
  // What get_native_agent_projection returns: the backend moves toolOutput
  // and toolError behind detailRef and deletes both from the card.
  const projected = [
    {
      parts: [
        {
          toolName: "shell",
          toolArgs: { command: "curl -sS https://example.com/" },
          toolState: "error",
          detailRef: "ref-blocked",
        },
      ],
    },
    {
      parts: [
        {
          toolName: "shell",
          toolArgs: { command: "curl -sS https://api.github.com/zen" },
          toolState: "success",
          detailRef: "ref-allowed",
        },
        { toolName: "read", toolArgs: { path: "a" }, detailRef: "ref-read" },
      ],
    },
    {
      parts: [
        {
          toolName: "bash",
          toolArgs: { command: "touch /tmp/marker && echo approved" },
          toolState: "success",
          detailRef: "ref-approved",
        },
      ],
    },
  ];
  const details: Record<string, { toolOutput?: string; toolError?: string }> = {
    "ref-blocked": { toolOutput: "curl: (7) refused\nhttp=000 exit=7", toolError: "exit 7" },
    "ref-allowed": { toolOutput: "Keep it simple.\nhttp=200 exit=0" },
    "ref-approved": { toolOutput: "approved" },
  };
  const read = async (detailRef: string) => {
    requested.push(detailRef);
    return details[detailRef];
  };
  let requested: string[] = [];

  test("the cards carry no output until their details are read", () => {
    const calls = shellToolCalls(projected, ["shell"]);
    expect(calls.map((call) => [call.output, call.detailRef])).toEqual([
      ["", "ref-blocked"],
      ["", "ref-allowed"],
    ]);
    expect(curlCallFor(calls, "https://example.com/")).toBeUndefined();
  });

  test("reads both curl outcomes through detailRef", async () => {
    requested = [];
    const calls = await resolveShellToolOutputs(shellToolCalls(projected, ["shell"]), read);
    expect(requested).toEqual(["ref-blocked", "ref-allowed"]);
    const blocked = curlCallFor(calls, "https://example.com/");
    const allowed = curlCallFor(calls, "https://api.github.com/zen");
    expect(blocked?.outcome).toEqual({ http: "000", exit: 7 });
    expect(isRefused(blocked!.outcome)).toBe(true);
    expect(allowed?.outcome).toEqual({ http: "200", exit: 0 });
    expect(isReached(allowed!.outcome)).toBe(true);
  });

  test("reads the approved command's output through detailRef", async () => {
    requested = [];
    const [call] = await resolveShellToolOutputs(
      shellToolCalls(projected, ["bash"]).filter((candidate) =>
        candidate.command.includes("/tmp/marker"),
      ),
      read,
    );
    expect(requested).toEqual(["ref-approved"]);
    expect(call?.output).toContain("approved");
  });

  test("keeps inline output and skips cards without a detailRef", async () => {
    requested = [];
    const calls = await resolveShellToolOutputs(
      [
        { toolName: "bash", command: "a", output: "inline" },
        { toolName: "bash", command: "b", output: "head", detailRef: "ref-allowed" },
        { toolName: "bash", command: "c", output: "", detailRef: "ref-gone" },
      ],
      read,
    );
    expect(requested).toEqual(["ref-allowed", "ref-gone"]);
    expect(calls.map((call) => call.output)).toEqual([
      "inline",
      "head\nKeep it simple.\nhttp=200 exit=0",
      "",
    ]);
  });
});

describe("curl outcomes", () => {
  test("parses the status and exit code curlCommand prints", () => {
    expect(curlOutcome("http=000 exit=7")).toEqual({ http: "000", exit: 7 });
    expect(curlOutcome("curl: (7) refused\nhttp=000 exit=7")).toEqual({ http: "000", exit: 7 });
    expect(curlOutcome("http=200 exit=0")).toEqual({ http: "200", exit: 0 });
    expect(curlOutcome("no outcome")).toBeUndefined();
  });

  test("classifies refused and reached", () => {
    expect(isRefused({ http: "000", exit: 7 })).toBe(true);
    expect(isRefused({ http: "000", exit: 0 })).toBe(false);
    expect(isRefused({ http: "200", exit: 0 })).toBe(false);
    expect(isReached({ http: "200", exit: 0 })).toBe(true);
    expect(isReached({ http: "403", exit: 0 })).toBe(true);
    expect(isReached({ http: "000", exit: 0 })).toBe(false);
    expect(isReached({ http: "200", exit: 1 })).toBe(false);
  });

  test("finds the call for one URL", () => {
    const calls = [
      { toolName: "bash", command: "ls", output: "http=200 exit=0" },
      { toolName: "bash", command: "curl https://example.com/", output: "pending" },
      { toolName: "bash", command: "curl https://example.com/", output: "http=000 exit=6" },
    ];
    expect(curlCallFor(calls, "https://example.com/")?.outcome).toEqual({ http: "000", exit: 6 });
    expect(curlCallFor(calls, "https://api.github.com/zen")).toBeUndefined();
  });
});

test("shellToolPrompt names the tool and carries the command verbatim", () => {
  const prompt = shellToolPrompt("bash", "echo 'a' $?");
  expect(prompt).toContain("Use your bash tool");
  expect(prompt.split("\n")).toContain("echo 'a' $?");
});
