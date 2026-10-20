import { describe, expect, test } from "bun:test";
import {
  RECORDED_ARTIFACT_ERROR_CODE,
  RECORDED_PUBLICATION_ID,
  RECORDED_PUBLISH_ARTIFACT_ARGS,
  RECORDED_PUBLISH_ARTIFACT_ERROR_TEXT,
  RECORDED_PUBLISH_ARTIFACT_RESULT_TEXT,
  SUCCESSFUL_PUBLISH_CONTRACT,
  publishArtifactCallContract,
} from "@orkestrator/protocol/testing/artifact-tool-fixtures";
import {
  normalizeOpenCodeInlineError,
  normalizeOpenCodeInteractiveMessage,
  normalizeOpenCodeTranscriptMessages,
  OPEN_CODE_TOOL_SCHEMA_REJECTION_HINT,
} from "./opencode-messages.js";

function message(parts: unknown[]): unknown {
  return {
    info: { id: "msg-1", role: "assistant", time: { created: 0 } },
    parts,
  };
}

function firstTool(value: ReturnType<typeof normalizeOpenCodeInteractiveMessage>) {
  return (value?.parts as Array<Record<string, unknown>> | undefined)?.[0];
}

describe("normalizeOpenCodeInteractiveMessage edit diffs", () => {
  test("projects OpenCode filediff onto toolDiff so the edit row has a path and counts", () => {
    const normalized = normalizeOpenCodeInteractiveMessage(
      message([
        {
          id: "p1",
          type: "tool",
          tool: "edit",
          state: {
            status: "completed",
            title: "apps/web/src/a.ts",
            input: {},
            output: "Edit applied successfully.",
            metadata: {
              filediff: {
                file: "apps/web/src/a.ts",
                patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
                additions: 1,
                deletions: 1,
              },
            },
          },
        },
      ]),
      0,
    );

    expect(firstTool(normalized)).toMatchObject({
      type: "tool-invocation",
      toolName: "edit",
      toolState: "success",
      toolTitle: "apps/web/src/a.ts",
      toolDiff: {
        filePath: "apps/web/src/a.ts",
        diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
        additions: 1,
        deletions: 1,
      },
    });
  });

  test("recovers the path from a path-like title when metadata is missing", () => {
    const normalized = normalizeOpenCodeInteractiveMessage(
      message([
        {
          id: "p1",
          type: "tool",
          tool: "edit",
          state: {
            status: "completed",
            title: "apps/web/src/app/about/you/decks/actions.test.ts",
            input: {},
            output: "Edit applied successfully.",
          },
        },
      ]),
      0,
    );

    expect(firstTool(normalized)?.toolDiff).toMatchObject({
      filePath: "apps/web/src/app/about/you/decks/actions.test.ts",
    });
  });

  test("does not attach toolDiff to a non-edit tool", () => {
    const normalized = normalizeOpenCodeInteractiveMessage(
      message([
        {
          id: "p1",
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: { command: "ls" }, output: "a.ts" },
        },
      ]),
      0,
    );

    expect(firstTool(normalized)?.toolDiff).toBeUndefined();
  });

  test("overlays a measured shell change by callID, still without a toolDiff", () => {
    const change = {
      additions: 2,
      deletions: 1,
      files: [{ path: "a.ts", additions: 2, deletions: 1 }],
    };
    const bash = (callID: string) => ({
      id: `part-${callID}`,
      type: "tool",
      tool: "bash",
      callID,
      state: { status: "completed", input: { command: "sed -i s/a/b/ a.ts" }, output: "" },
    });
    const normalized = normalizeOpenCodeInteractiveMessage(
      message([bash("call-1"), bash("call-2")]),
      0,
      undefined,
      new Map([["call-1", change]]),
    );
    const parts = normalized?.parts as Array<Record<string, unknown>>;

    expect(parts[0]?.commandChanges).toEqual(change);
    expect(parts[0]?.toolDiff).toBeUndefined();
    expect(parts[1]).not.toHaveProperty("commandChanges");
  });
});

describe("normalizeOpenCodeInlineError", () => {
  function failed(error: unknown) {
    return {
      info: { id: "msg-failed", role: "assistant", time: { created: 10, completed: 20 }, error },
    };
  }

  test("renders a provider API failure as a durable error row after the message", () => {
    expect(
      normalizeOpenCodeInlineError(
        failed({
          name: "APIError",
          data: { message: 'Bad Request: {"model":"deepseek-v4.1-flash"}', statusCode: 400 },
        }),
      ),
    ).toEqual({
      id: "error-opencode-msg-failed",
      role: "assistant",
      content: 'Model request failed (HTTP 400): Bad Request: {"model":"deepseek-v4.1-flash"}',
      parts: [
        {
          type: "text",
          content: 'Model request failed (HTTP 400): Bad Request: {"model":"deepseek-v4.1-flash"}',
        },
      ],
      createdAt: new Date(20).toISOString(),
    });
  });

  test("names the failed message's provider and model, for the sign-in action", () => {
    const message = failed({
      name: "APIError",
      data: { message: "This API key has expired.", statusCode: 401 },
    });
    Object.assign(message.info, { providerID: "opencode-go", modelID: "deepseek-v4-pro" });
    expect(normalizeOpenCodeInlineError(message)).toMatchObject({
      content: "Model request failed (HTTP 401): This API key has expired.",
      modelId: "opencode-go/deepseek-v4-pro",
    });
  });

  test("explains a provider refusing a tool's JSON Schema", () => {
    expect(
      normalizeOpenCodeInlineError(
        failed({
          name: "APIError",
          data: { message: "Recursive JSON schemas are not currently supported", statusCode: 400 },
        }),
      ),
    ).toMatchObject({
      content: `Model request failed (HTTP 400): Recursive JSON schemas are not currently supported${OPEN_CODE_TOOL_SCHEMA_REJECTION_HINT}`,
    });
  });

  test("keeps other failures verbatim", () => {
    expect(
      normalizeOpenCodeInlineError(
        failed({ name: "ProviderAuthError", data: { message: "Invalid API key" } }),
      ),
    ).toMatchObject({ content: "Invalid API key" });
  });

  test("falls back to the created time when completion is outside Date's range", () => {
    const message = failed({ name: "APIError", data: { message: "Unavailable" } });
    message.info.time.completed = 1e20;
    expect(normalizeOpenCodeInlineError(message)).toMatchObject({
      createdAt: new Date(10).toISOString(),
      content: "Model request failed: Unavailable",
    });
  });

  test("ignores user stops, successful messages, and messages without an id", () => {
    expect(normalizeOpenCodeInlineError(failed({ name: "MessageAbortedError" }))).toBeNull();
    expect(normalizeOpenCodeInlineError(failed(undefined))).toBeNull();
    expect(
      normalizeOpenCodeInlineError({ info: { role: "assistant", error: { name: "APIError" } } }),
    ).toBeNull();
  });
});

describe("normalizeOpenCodeInteractiveMessage tool durations", () => {
  const tool = (state: Record<string, unknown>, name = "bash") =>
    firstTool(
      normalizeOpenCodeInteractiveMessage(
        message([{ id: "part-1", type: "tool", tool: name, callID: "call-1", state }]),
        0,
      ),
    );

  test("reports the provider's start-to-end time on settled calls", () => {
    expect(
      tool({ status: "completed", input: {}, output: "ok", time: { start: 1_000, end: 3_400 } })
        ?.toolDurationMs,
    ).toBe(2_400);
    expect(
      tool({ status: "error", input: {}, error: "boom", time: { start: 1_000, end: 1_250 } })
        ?.toolDurationMs,
    ).toBe(250);
  });

  test("omits the duration while running or when the stamps are unusable", () => {
    const running = tool({ status: "running", input: {}, time: { start: 1_000 } });
    expect(running?.toolState).toBe("pending");
    expect(running && "toolDurationMs" in running).toBe(false);
    expect(tool({ status: "completed", input: {}, output: "ok" })?.toolDurationMs).toBeUndefined();
    expect(
      tool({ status: "completed", input: {}, output: "ok", time: { start: 5, end: 4 } })
        ?.toolDurationMs,
    ).toBeUndefined();
  });

  test("never times a background task the envelope still reports as running", () => {
    const running = tool(
      {
        status: "completed",
        input: { description: "Explore" },
        output: '<task id="child-1" state="running">',
        time: { start: 1_000, end: 1_010 },
      },
      "task",
    );
    expect(running?.type).toBe("subagent");
    expect(running?.toolState).toBe("pending");
    expect(running?.toolDurationMs).toBeUndefined();
    expect(
      tool(
        {
          status: "completed",
          input: { description: "Explore" },
          output: '<task id="child-1" state="completed">',
          time: { start: 1_000, end: 61_000 },
        },
        "task",
      )?.toolDurationMs,
    ).toBe(60_000);
  });
});

describe("normalizeOpenCodeInteractiveMessage reasoning and timestamps", () => {
  function reasoning(text: string, time?: Record<string, unknown>) {
    return firstTool(
      normalizeOpenCodeInteractiveMessage(
        message([{ id: "r1", type: "reasoning", text, ...(time ? { time } : {}) }]),
        0,
      ),
    );
  }

  test("removes only OpenCode's balanced outer bold pair from reasoning", () => {
    expect(reasoning("**Planning next changes**")?.content).toBe("Planning next changes");
    expect(reasoning(" \n**Planning next changes** \n")?.content).toBe(
      " \nPlanning next changes \n",
    );
    for (const content of [
      "Use **care** when editing",
      "Planning ends with **care**",
      "**Planning** then inspect",
      "**Planning**\n- inspect files",
      "**Planning** then **care**",
      "Planning next**",
    ]) {
      expect(reasoning(content)?.content).toBe(content);
    }
  });

  test("drops an unmatched opening marker only while the reasoning still streams", () => {
    expect(reasoning("**Planning next", { start: 1 })?.content).toBe("Planning next");
    expect(reasoning("**Planning next", { start: 1, end: 2 })?.content).toBe("**Planning next");
    expect(reasoning("**Planning next")?.content).toBe("**Planning next");
  });

  test("drops reasoning that is empty once the markers are gone", () => {
    for (const content of ["****", "  **  ", " \n\t "]) expect(reasoning(content)).toBeUndefined();
  });

  test("never throws for a message clock outside Date's range", () => {
    for (const created of [1e18, -1e18, Number.NaN, "not a date"]) {
      const normalized = normalizeOpenCodeInteractiveMessage(
        { info: { id: "m1", role: "assistant", time: { created } }, parts: [] },
        0,
      );
      expect(normalized?.createdAt).toBe("1970-01-01T00:00:00.000Z");
    }
  });
});

describe("transcript artifact tool calls", () => {
  /*
   * The web client anchors a published artifact on the successful
   * `publish_artifact` call naming it, by the call's name and arguments.
   * Recorded OpenCode 1.19 tool parts: its MCP adapter joins the server and
   * tool as `orkestrator_publish_artifact`, returns the result text as
   * `output`, and throws an `isError` result's text, which the part keeps as
   * `state.error`.
   */
  function publishMessage(state: Record<string, unknown>): unknown {
    return {
      info: {
        id: "msg_artifact",
        sessionID: "ses_artifact",
        role: "assistant",
        time: { created: 1_760_000_000_000, completed: 1_760_000_002_000 },
        providerID: "anthropic",
        modelID: "claude-sonnet",
      },
      parts: [
        {
          id: "prt_publish",
          sessionID: "ses_artifact",
          messageID: "msg_artifact",
          type: "tool",
          callID: "toolu_publish",
          tool: "orkestrator_publish_artifact",
          state: {
            input: { ...RECORDED_PUBLISH_ARTIFACT_ARGS },
            time: { start: 1_760_000_000_500, end: 1_760_000_001_500 },
            ...state,
          },
        },
      ],
    };
  }

  function publishPart(state: Record<string, unknown>) {
    const [message] = normalizeOpenCodeTranscriptMessages([publishMessage(state)], () => {});
    const part = (message?.parts as Array<Record<string, unknown>> | undefined)?.find(
      (candidate) => candidate.type === "tool-invocation",
    );
    if (!part) throw new Error("missing publish_artifact part");
    return part as Record<string, unknown> & { toolOutput?: string; toolError?: string };
  }

  test("a successful publish projects a recognisable call with its arguments", () => {
    const part = publishPart({
      status: "completed",
      output: RECORDED_PUBLISH_ARTIFACT_RESULT_TEXT,
      title: "",
      metadata: { truncated: false },
    });

    expect(publishArtifactCallContract(part)).toEqual({ ...SUCCESSFUL_PUBLISH_CONTRACT });
    expect(part.toolName).toBe("orkestrator_publish_artifact");
    expect(part.toolOutput).toContain(RECORDED_PUBLICATION_ID);
  });

  test("the shared registration's artifact grant is redacted from the normalized transcript", () => {
    const grant = "oag1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const message = publishMessage({
      status: "completed",
      input: { ...RECORDED_PUBLISH_ARTIFACT_ARGS, scopeCapability: grant },
      output: RECORDED_PUBLISH_ARTIFACT_RESULT_TEXT,
      title: "",
      metadata: { truncated: false },
    });
    const normalized = normalizeOpenCodeTranscriptMessages([message], () => {});
    const parts = (normalized[0]?.parts ?? []) as Array<Record<string, unknown>>;
    const part = parts.find((candidate) => candidate.type === "tool-invocation")!;

    expect(JSON.stringify(normalized)).not.toContain(grant);
    expect((part.toolArgs as Record<string, unknown>).scopeCapability).toBe("[redacted]");
    // Publication anchoring still reads the call's real arguments.
    expect(publishArtifactCallContract(part)).toEqual({ ...SUCCESSFUL_PUBLISH_CONTRACT });
    // The provider's record is untouched.
    expect(JSON.stringify(message)).toContain(grant);
  });

  test("a refused publish is not a success and keeps its error code", () => {
    const part = publishPart({
      status: "error",
      error: `Error: ${RECORDED_PUBLISH_ARTIFACT_ERROR_TEXT}`,
    });
    const contract = publishArtifactCallContract(part);

    expect(contract.tool).toBe("publish_artifact");
    expect(contract.toolState).not.toBe("success");
    expect(part.toolError).toContain(RECORDED_ARTIFACT_ERROR_CODE);
  });
});
