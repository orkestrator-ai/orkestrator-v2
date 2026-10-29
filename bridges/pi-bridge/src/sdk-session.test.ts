/**
 * Real Pi SDK sessions over a scripted model stream.
 *
 * The SDK, its agent loop, its tool hooks and its JSONL session files are all
 * real; only the model's stream is substituted, so no provider request or
 * paid inference is made. These pin SDK behaviour the bridge relies on but
 * cannot observe from a fake `AgentSession`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";

// `config.ts` reads its environment once, at import; see `http.test.ts`.
process.env.PORT = "0";
process.env.HOSTNAME = "127.0.0.1";
process.env.PI_BRIDGE_TOKEN = "test-token";
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
delete process.env.PI_BRIDGE_STATE_DIR;

const { server, start, shutdown } = await import("./server.js");
const { authToken: TOKEN } = await import("./config.js");
const { closeSession, detachSession, setAgentSessionTestHooks } =
  await import("./agent-session.js");
const { refreshModels } = await import("./models.js");
const { setModelRuntimeFactoryForTests } = await import("./runtime.js");
const { sessions, clientSessionKeys } = await import("./state.js");
const { setPiMcpTransportForTests } = await import("./mcp.js");
const { resolveApproval } = await import("./interactions.js");
const { nativeFetch } = await import("./testing/native-fetch.js");
const { ModelRuntime } = await import("./pi-sdk.js");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");

type SessionState = NonNullable<ReturnType<typeof sessions.get>>;
type Content = AssistantMessage["content"];

let origin: string;

beforeAll(async () => {
  await start(0);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await shutdown();
});

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return nativeFetch(`${origin}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the expected condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const ASK: NativeAgentExecutionPolicy = {
  id: "interactive-host",
  sandbox: "provider",
  approvals: "ask",
  projectResources: false,
  networkAccess: "full",
};

/**
 * Run `body` against one real SDK session in an isolated agent and session
 * directory. `respond` scripts the model: each call returns the next
 * response's content, and a response with a tool call asks for another.
 */
async function withSdkSession(
  options: { clientSessionKey: string; policy?: NativeAgentExecutionPolicy; mcpTools?: string[] },
  body: (context: {
    state: SessionState;
    script: (responses: Content[]) => void;
    prompt: (text: string) => Promise<void>;
    reattach: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-sdk-session-"));
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousSessionDir = process.env.PI_SESSION_DIR;
  process.env.PI_AGENT_DIR = directory;
  process.env.PI_SESSION_DIR = directory;
  let state: SessionState | undefined;
  let responses: Content[] = [];
  setAgentSessionTestHooks(undefined);
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(directory, "auth.json"),
      modelsPath: join(directory, "models.json"),
      allowModelNetwork: false,
    });
    await runtime.setRuntimeApiKey("anthropic", "test-only-no-provider-requests");
    setModelRuntimeFactoryForTests(async () => runtime);
    refreshModels();
    if (options.mcpTools) {
      const mcpTools = options.mcpTools;
      setPiMcpTransportForTests({
        connect: async () => ({
          tools: mcpTools.map((name) => ({ name, inputSchema: { type: "object" } })),
          call: async () => ({ content: [{ type: "text", text: "ok" }] }),
          close: async () => {},
        }),
      });
    }
    const created = await call("/session/create", {
      method: "POST",
      body: JSON.stringify({
        clientSessionKey: options.clientSessionKey,
        ...(options.policy ? { policy: options.policy } : {}),
        ...(options.mcpTools
          ? { agentMcp: { url: "http://127.0.0.1:4567/mcp", token: "sdk-session-token" } }
          : {}),
      }),
    });
    expect(created.status).toBe(201);
    const current = sessions.get(((await created.json()) as { sessionId: string }).sessionId)!;
    state = current;
    const attach = async () => {
      const attached = await call(`/session/${current.id}/attach`, { method: "POST", body: "{}" });
      expect(attached.status).toBe(200);
      current.session!.agent.streamFunction = (model) => {
        const content = responses.shift() ?? [{ type: "text", text: "Finished." }];
        const toolUse = content.some((block) => block.type === "toolCall");
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: toolUse ? "toolUse" : "stop",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          content,
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: toolUse ? "toolUse" : "stop", message });
        stream.end(message);
        return stream;
      };
    };
    await attach();
    await body({
      state: current,
      script: (next) => {
        responses = [...next];
      },
      prompt: async (text) => {
        const prompted = await call(`/session/${current.id}/prompt`, {
          method: "POST",
          body: JSON.stringify({ prompt: text }),
        });
        expect(prompted.status).toBe(202);
      },
      reattach: async () => {
        await detachSession(current);
        await attach();
      },
    });
  } finally {
    if (state) {
      await closeSession(state);
      sessions.delete(state.id);
      if (state.clientSessionKey) clientSessionKeys.delete(state.clientSessionKey);
    }
    setPiMcpTransportForTests();
    setAgentSessionTestHooks(undefined);
    setModelRuntimeFactoryForTests();
    refreshModels();
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    if (previousSessionDir === undefined) delete process.env.PI_SESSION_DIR;
    else process.env.PI_SESSION_DIR = previousSessionDir;
    await rm(directory, { recursive: true, force: true });
  }
}

function toolPart(state: SessionState, toolCallId: string) {
  for (const message of state.messages) {
    for (const part of message.parts) {
      if (part.type === "tool-invocation" && part.toolUseId === toolCallId) return part;
    }
  }
  return undefined;
}

describe("malformed tool arguments (Pi 1.3+)", () => {
  test("fail before the approval gate, so an asking session never parks them", async () => {
    await withSdkSession({ clientSessionKey: "sdk-malformed", policy: ASK }, async (context) => {
      const { state } = context;
      const malformed: ToolCall = {
        type: "toolCall",
        id: "malformed-call",
        name: "bash",
        arguments: {},
        argumentsError: 'Unterminated string\n\nReceived arguments:\n{"command": "ls',
      };
      const valid: ToolCall = {
        type: "toolCall",
        id: "valid-call",
        name: "bash",
        arguments: { command: "make release" },
      };
      context.script([[malformed, valid]]);
      const parked: string[] = [];
      await context.prompt("Run it.");
      // The well-formed call proves the gate is on; the malformed one never
      // reaches it, because Pi fails it while validating its arguments.
      await waitFor(() => state.approvals.size > 0);
      for (const approval of state.approvals.values()) parked.push(approval.toolCallId);
      expect(parked).toEqual(["valid-call"]);
      resolveApproval(state, [...state.approvals.keys()][0]!, "deny", "not now");
      await state.session!.agent.waitForIdle();

      const part = toolPart(state, "malformed-call");
      expect(part).toMatchObject({ toolName: "bash", toolState: "failure" });
      // The model's own text reaches the card through the shared error field.
      expect(part?.toolError).toContain('Invalid arguments for tool "bash"');
      expect(part?.toolError).toContain('{"command": "ls');
      expect(part?.toolArgs).toBeUndefined();
      // Pi never ran it, so there is no execution time to report.
      expect(part?.toolDurationMs).toBeUndefined();
    });
  });
});

describe("resumed tool loadout (Pi 1.3+)", () => {
  test("an MCP tool added after the session was saved is active once it reattaches", async () => {
    const tools = ["check_inbox"];
    await withSdkSession(
      { clientSessionKey: "sdk-loadout", mcpTools: tools },
      async ({ state, prompt, reattach }) => {
        await prompt("Hello.");
        await state.session!.agent.waitForIdle();
        expect(state.session!.getActiveToolNames()).toContain("check_inbox");
        expect(state.session!.getActiveToolNames()).not.toContain("send_message");

        // A tool the saved transcript never mentioned: Pi activates it on
        // resume like a newly registered tool rather than restoring it off.
        tools.push("send_message");
        const sessionFile = state.sessionFile!;
        // The saved transcript records a loadout, so the reattach restores
        // from it rather than keeping whatever is registered.
        expect(await readFile(sessionFile, "utf8")).toContain('"toolsAdded"');
        await reattach();
        expect(state.sessionFile).toBe(sessionFile);
        expect(state.session!.getActiveToolNames()).toEqual(
          expect.arrayContaining(["check_inbox", "send_message"]),
        );
      },
    );
  });
});

describe("GitHub credential withholding (item 209)", () => {
  const graphPolicy = (extendedDeny: string[]): NativeAgentExecutionPolicy => ({
    id: "pipeline",
    sandbox: "none",
    approvals: "auto-approve",
    projectResources: false,
    networkAccess: "full",
    capabilityPolicy: {
      deny: [],
      ...(extendedDeny.length > 0 ? { extendedDeny: extendedDeny as never } : {}),
    },
  });

  async function envSeenByBash(clientSessionKey: string, policy: NativeAgentExecutionPolicy) {
    let output = "";
    await withSdkSession({ clientSessionKey, policy }, async ({ state, script, prompt }) => {
      const env: ToolCall = {
        type: "toolCall",
        id: `${clientSessionKey}-env`,
        name: "bash",
        arguments: { command: "env" },
      };
      script([[env]]);
      await prompt("Print the environment.");
      await waitFor(() => toolPart(state, env.id)?.toolState === "success");
      await state.session!.agent.waitForIdle();
      // The session's bash is the replacement only when it withholds.
      expect(state.session!.getActiveToolNames()).toContain("bash");
      output = String(toolPart(state, env.id)?.toolOutput ?? "");
    });
    return output;
  }

  test("a graph session's bash runs without the credential; an ordinary session's keeps it", async () => {
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "gho_pi_sdk_probe";
    try {
      const withheld = await envSeenByBash("sdk-gh-withheld", graphPolicy(["github.write"]));
      expect(withheld).not.toContain("gho_pi_sdk_probe");
      expect(withheld).toContain("GH_CONFIG_DIR=");
      expect(withheld).toContain("GIT_CONFIG_KEY_0=credential.helper");

      const ordinary = await envSeenByBash("sdk-gh-ordinary", graphPolicy([]));
      expect(ordinary).toContain("GH_TOKEN=gho_pi_sdk_probe");
    } finally {
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
    }
  });
});
