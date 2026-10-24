import { expect, test } from "bun:test";
import { resolveControlMcpCapabilities } from "@orkestrator/protocol/control-mcp";
import type { ControlMcpCaller } from "./control-mcp-caller.js";
import { ConfirmTokens } from "./control-mcp-confirm.js";
import { operatorLaunchEnvironment } from "./control-mcp-operator-tools.js";

test.each(["local", "containerized"] as const)(
  "launch adapter maps %s overrides and preserves failures",
  async (environmentType) => {
    const requests: Record<string, unknown>[] = [];
    let fail = false;
    const caller: ControlMcpCaller = {
      credential: {
        id: "default",
        label: "Default",
        profile: "full",
        capabilities: resolveControlMcpCapabilities("full"),
        deniedActions: [],
      },
      profile: "full",
      authority: "control-mcp:default",
      messagingEnabled: true,
      confirmTokens: new ConfirmTokens(),
      invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
        if (command !== "public_action") throw new Error("No advisory options");
        requests.push(args!);
        return (
          fail
            ? {
                schemaVersion: 1,
                action: "environment.launch",
                ok: false,
                error: { code: "setup-failed", message: "Launch failed", exitCode: 1 },
              }
            : {
                schemaVersion: 1,
                action: "environment.launch",
                ok: true,
                result: {
                  environment: { id: "created" },
                  sessionId: "ses_created",
                  runId: "op_created",
                },
                receipt: { operationId: "op_created", resources: { environmentId: "created" } },
              }
        ) as T;
      },
    };
    const input = {
      projectId: "project",
      requestId: "launch-key",
      environmentType,
      name: "Named",
      agent: "claude" as const,
      modelId: "model",
      reasoningId: "high",
      fastMode: false,
      conversationMode: "plan" as const,
      prompt: "Work",
      networkAccessMode: "full" as const,
      baseBranch: "main",
      baseCommit: "a".repeat(40),
    };
    const launched = await operatorLaunchEnvironment(caller, input);
    expect(requests[0]).toMatchObject({
      action: "environment.launch",
      request: { requestId: "launch-key" },
      input: {
        projectId: "project",
        type: environmentType === "local" ? "local" : "container",
        name: "Named",
        agent: "claude",
        model: "model",
        reasoning: "high",
        fastMode: false,
        mode: "plan",
        prompt: "Work",
        networkAccessMode: "full",
        baseBranch: "main",
        baseCommit: input.baseCommit,
      },
    });
    expect(launched.structuredContent).toMatchObject({
      environmentId: "created",
      sessionId: "ses_created",
      runId: "op_created",
      receipt: { operationId: "op_created" },
    });
    fail = true;
    const refused = await operatorLaunchEnvironment(caller, { ...input, requestId: "failed-key" });
    expect(refused).toHaveProperty("isError", true);
    expect(refused.structuredContent).toMatchObject({ ok: false, error: { code: "setup-failed" } });
  },
);
